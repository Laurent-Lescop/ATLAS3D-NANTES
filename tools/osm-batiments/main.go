// osm-batiments extrait les bâtiments (building, building:part) d'un fichier
// OpenStreetMap .osm.pbf dans une emprise, et les écrit au format JSON d'Overpass
// (« out geom ») pour être traités par tools/preparer-batiments.mjs.
//
// Usage : osm-batiments -pbf fichier.osm.pbf -bbox ouest,sud,est,nord -sortie batiments.json
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/paulmach/osm"
	"github.com/paulmach/osm/osmpbf"
)

type point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type member struct {
	Type     string  `json:"type"`
	Ref      int64   `json:"ref"`
	Role     string  `json:"role"`
	Geometry []point `json:"geometry"`
}

type element struct {
	Type     string            `json:"type"`
	ID       int64             `json:"id"`
	Tags     map[string]string `json:"tags"`
	Geometry []point           `json:"geometry,omitempty"`
	Members  []member          `json:"members,omitempty"`
}

func isBuilding(t osm.Tags) bool {
	b := t.Find("building")
	p := t.Find("building:part")
	return (b != "" && b != "no") || (p != "" && p != "no")
}

func main() {
	pbf := flag.String("pbf", "", "fichier .osm.pbf")
	bboxArg := flag.String("bbox", "", "emprise ouest,sud,est,nord")
	out := flag.String("sortie", "batiments-osm.json", "fichier JSON de sortie")
	flag.Parse()
	if *pbf == "" || *bboxArg == "" {
		flag.Usage()
		os.Exit(2)
	}
	var b [4]float64
	for i, s := range strings.Split(*bboxArg, ",") {
		v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			log.Fatalf("emprise invalide : %v", err)
		}
		b[i] = v
	}
	// Marge pour les bâtiments à cheval sur la limite.
	const marge = 0.01
	inBox := func(lon, lat float64, m float64) bool {
		return lon >= b[0]-m && lon <= b[2]+m && lat >= b[1]-m && lat <= b[3]+m
	}

	// 1er passage : relations de bâtiments (multipolygones) et leurs chemins membres.
	relations := []*osm.Relation{}
	membres := map[int64]bool{}
	scan(*pbf, true, true, false, func(o osm.Object) {
		r := o.(*osm.Relation)
		if r.Tags.Find("type") != "multipolygon" || !isBuilding(r.Tags) {
			return
		}
		relations = append(relations, r)
		for _, m := range r.Members {
			if m.Type == osm.TypeWay {
				membres[m.Ref] = true
			}
		}
	})
	log.Printf("%d relations de bâtiments", len(relations))

	// 2e passage : nœuds de l'emprise élargie, puis chemins de bâtiments et membres.
	noeuds := map[osm.NodeID]point{}
	chemins := map[int64][]point{}
	elements := []element{}
	scan(*pbf, false, false, true, func(o osm.Object) {
		switch v := o.(type) {
		case *osm.Node:
			if inBox(v.Lon, v.Lat, 2*marge) {
				noeuds[v.ID] = point{Lat: v.Lat, Lon: v.Lon}
			}
		case *osm.Way:
			bat := isBuilding(v.Tags)
			if !bat && !membres[int64(v.ID)] {
				return
			}
			geom := make([]point, 0, len(v.Nodes))
			dedans := false
			for _, n := range v.Nodes {
				p, ok := noeuds[n.ID]
				if !ok {
					return
				}
				if inBox(p.Lon, p.Lat, 0) {
					dedans = true
				}
				geom = append(geom, p)
			}
			if membres[int64(v.ID)] {
				chemins[int64(v.ID)] = geom
			}
			if bat && dedans {
				elements = append(elements, element{Type: "way", ID: int64(v.ID), Tags: v.Tags.Map(), Geometry: geom})
			}
		}
	})

	for _, r := range relations {
		ms := []member{}
		dedans := false
		for _, m := range r.Members {
			if m.Type != osm.TypeWay {
				continue
			}
			g, ok := chemins[m.Ref]
			if !ok {
				continue
			}
			for _, p := range g {
				if inBox(p.Lon, p.Lat, 0) {
					dedans = true
					break
				}
			}
			ms = append(ms, member{Type: "way", Ref: m.Ref, Role: m.Role, Geometry: g})
		}
		if dedans && len(ms) > 0 {
			elements = append(elements, element{Type: "relation", ID: int64(r.ID), Tags: r.Tags.Map(), Members: ms})
		}
	}

	f, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	fmt.Fprint(w, `{"version":0.6,"generator":"osm-batiments","elements":[`)
	for i := range elements {
		if i > 0 {
			fmt.Fprint(w, ",")
		}
		if err := enc.Encode(elements[i]); err != nil {
			log.Fatal(err)
		}
	}
	fmt.Fprint(w, "]}")
	if err := w.Flush(); err != nil {
		log.Fatal(err)
	}
	f.Close()
	log.Printf("%d éléments écrits dans %s", len(elements), *out)
}

func scan(path string, skipNodes, skipWays, skipRelations bool, fn func(osm.Object)) {
	f, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	s := osmpbf.New(context.Background(), f, runtime.GOMAXPROCS(-1))
	s.SkipNodes = skipNodes
	s.SkipWays = skipWays
	s.SkipRelations = skipRelations
	defer s.Close()
	for s.Scan() {
		fn(s.Object())
	}
	if err := s.Err(); err != nil {
		log.Fatal(err)
	}
}
