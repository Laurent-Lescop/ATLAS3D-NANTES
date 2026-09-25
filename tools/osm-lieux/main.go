// osm-lieux recherche dans un extrait OpenStreetMap (.osm.pbf) les objets
// correspondant à une liste de noms ou de filtres de balises, et écrit leur
// géométrie simplifiée (centre, emprise, contour) en JSON.
// Sert à positionner précisément les sites du contenu éditorial.
//
// Usage : osm-lieux -pbf f.osm.pbf -bbox o,s,e,n -requetes requetes.json -sortie lieux.json
//
// requetes.json : [{"cle": "chateau", "nom": "Château des ducs de Bretagne"},
//                  {"cle": "ile", "balises": {"place": "island", "name": "Île de Nantes"}}]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
	"unicode"

	"github.com/paulmach/osm"
	"github.com/paulmach/osm/osmpbf"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

type requete struct {
	Cle     string            `json:"cle"`
	Nom     string            `json:"nom"`
	Balises map[string]string `json:"balises"`
}

type resultat struct {
	Cle     string            `json:"cle"`
	Type    string            `json:"type"`
	ID      int64             `json:"id"`
	Tags    map[string]string `json:"tags"`
	Centre  [2]float64        `json:"centre"`
	Emprise [4]float64        `json:"emprise"`
	Contour [][][2]float64    `json:"contour,omitempty"`
}

var normaliseur = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)

func simplifier(s string) string {
	r, _, _ := transform.String(normaliseur, strings.ToLower(strings.TrimSpace(s)))
	r = strings.NewReplacer("’", "'", "-", " ", "  ", " ").Replace(r)
	return r
}

func correspond(q requete, t osm.Tags) bool {
	if q.Nom != "" {
		n := simplifier(q.Nom)
		for _, k := range []string{"name", "name:fr", "official_name", "alt_name"} {
			if v := t.Find(k); v != "" && simplifier(v) == n {
				return true
			}
		}
		return false
	}
	for k, v := range q.Balises {
		tv := t.Find(k)
		if k == "name" {
			if simplifier(tv) != simplifier(v) {
				return false
			}
		} else if v == "*" {
			if tv == "" {
				return false
			}
		} else if tv != v {
			return false
		}
	}
	return len(q.Balises) > 0
}

func main() {
	pbf := flag.String("pbf", "", "fichier .osm.pbf")
	bboxArg := flag.String("bbox", "", "emprise ouest,sud,est,nord")
	reqFile := flag.String("requetes", "", "fichier JSON des requêtes")
	out := flag.String("sortie", "lieux.json", "fichier de sortie")
	flag.Parse()

	var b [4]float64
	for i, s := range strings.Split(*bboxArg, ",") {
		b[i], _ = strconv.ParseFloat(strings.TrimSpace(s), 64)
	}
	raw, err := os.ReadFile(*reqFile)
	if err != nil {
		log.Fatal(err)
	}
	var reqs []requete
	if err := json.Unmarshal(raw, &reqs); err != nil {
		log.Fatal(err)
	}
	match := func(t osm.Tags) []string {
		var cles []string
		for _, q := range reqs {
			if correspond(q, t) {
				cles = append(cles, q.Cle)
			}
		}
		return cles
	}

	type relTrouvee struct {
		r    *osm.Relation
		cles []string
	}
	var rels []relTrouvee
	membres := map[osm.WayID]bool{}
	scan(*pbf, true, true, false, func(o osm.Object) {
		r := o.(*osm.Relation)
		if c := match(r.Tags); len(c) > 0 {
			rels = append(rels, relTrouvee{r, c})
			for _, m := range r.Members {
				if m.Type == osm.TypeWay && (m.Role == "outer" || m.Role == "") {
					membres[osm.WayID(m.Ref)] = true
				}
			}
		}
	})

	type wayTrouve struct {
		w    *osm.Way
		cles []string
	}
	var ways []wayTrouve
	cheminsNoeuds := map[osm.WayID][]osm.NodeID{}
	besoin := map[osm.NodeID]bool{}
	scan(*pbf, true, false, true, func(o osm.Object) {
		w := o.(*osm.Way)
		c := match(w.Tags)
		if len(c) == 0 && !membres[w.ID] {
			return
		}
		ids := make([]osm.NodeID, len(w.Nodes))
		for i, n := range w.Nodes {
			ids[i] = n.ID
			besoin[n.ID] = true
		}
		cheminsNoeuds[w.ID] = ids
		if len(c) > 0 {
			ways = append(ways, wayTrouve{w, c})
		}
	})

	coords := map[osm.NodeID][2]float64{}
	var res []resultat
	scan(*pbf, false, true, true, func(o osm.Object) {
		n := o.(*osm.Node)
		if besoin[n.ID] {
			coords[n.ID] = [2]float64{n.Lon, n.Lat}
		}
		if n.Lon < b[0] || n.Lon > b[2] || n.Lat < b[1] || n.Lat > b[3] {
			return
		}
		for _, c := range match(n.Tags) {
			res = append(res, resultat{Cle: c, Type: "node", ID: int64(n.ID), Tags: n.Tags.Map(),
				Centre: [2]float64{n.Lon, n.Lat}, Emprise: [4]float64{n.Lon, n.Lat, n.Lon, n.Lat}})
		}
	})

	anneau := func(ids []osm.NodeID) [][2]float64 {
		r := make([][2]float64, 0, len(ids))
		for _, id := range ids {
			if p, ok := coords[id]; ok {
				r = append(r, p)
			}
		}
		return r
	}
	ajouter := func(cles []string, typ string, id int64, tags map[string]string, contour [][][2]float64) {
		e := [4]float64{180, 90, -180, -90}
		var sx, sy float64
		var n int
		for _, r := range contour {
			for _, p := range r {
				e[0], e[1] = min(e[0], p[0]), min(e[1], p[1])
				e[2], e[3] = max(e[2], p[0]), max(e[3], p[1])
				sx += p[0]
				sy += p[1]
				n++
			}
		}
		if n == 0 || e[2] < b[0] || e[0] > b[2] || e[3] < b[1] || e[1] > b[3] {
			return
		}
		for _, c := range cles {
			res = append(res, resultat{Cle: c, Type: typ, ID: id, Tags: tags,
				Centre: [2]float64{sx / float64(n), sy / float64(n)}, Emprise: e, Contour: contour})
		}
	}
	for _, w := range ways {
		ajouter(w.cles, "way", int64(w.w.ID), w.w.Tags.Map(), [][][2]float64{anneau(cheminsNoeuds[w.w.ID])})
	}
	for _, r := range rels {
		var contour [][][2]float64
		for _, m := range r.r.Members {
			if ids, ok := cheminsNoeuds[osm.WayID(m.Ref)]; ok && m.Type == osm.TypeWay {
				contour = append(contour, anneau(ids))
			}
		}
		ajouter(r.cles, "relation", int64(r.r.ID), r.r.Tags.Map(), contour)
	}

	data, _ := json.MarshalIndent(res, "", " ")
	if err := os.WriteFile(*out, data, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("%d objets trouvés", len(res))
}

func scan(path string, skipNodes, skipWays, skipRelations bool, fn func(osm.Object)) {
	f, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	s := osmpbf.New(context.Background(), f, runtime.GOMAXPROCS(-1))
	s.SkipNodes, s.SkipWays, s.SkipRelations = skipNodes, skipWays, skipRelations
	defer s.Close()
	for s.Scan() {
		fn(s.Object())
	}
	if err := s.Err(); err != nil {
		log.Fatal(err)
	}
}
