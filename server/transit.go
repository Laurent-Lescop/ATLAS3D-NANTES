package main

// Transports Naolib : chargement des horaires théoriques (GTFS) et calcul de la
// position estimée des trams, bus et navettes fluviales à un instant donné.
// Le flux temps réel de Naolib ne publie pas la position GPS des véhicules : elle
// est déduite de l'horaire, décalé du retard annoncé, le long du tracé de la ligne.

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // fuseau Europe/Paris embarqué (nécessaire sous Windows)
)

var paris = func() *time.Location {
	l, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		return time.UTC
	}
	return l
}()

type arretGTFS struct {
	id       string
	nom      string
	lon, lat float64
}

type ligneGTFS struct {
	id, court, long string
	typ             int
	couleur, texte  string
}

type serviceGTFS struct {
	jours       [7]bool // dimanche = 0
	debut, fin  int     // AAAAMMJJ
	ajouts      map[int]bool
	suppression map[int]bool
}

type courseGTFS struct {
	ligne       int16
	sens        int8
	destination int32
	premier     int32 // indice du premier passage
	n           int32
	motif       int32
}

type passage struct {
	arret    uint16
	arr, dep int32 // secondes depuis minuit (peuvent dépasser 24 h)
}

type motifGTFS struct {
	forme  int32   // -1 : pas de tracé, on relie les arrêts
	arrets []int32 // indices des arrêts
	dist   []float64
	once   sync.Once
}

type Transit struct {
	app *App

	mu        sync.RWMutex
	pret      bool
	etat      string
	arrets    []arretGTFS
	lignes    []ligneGTFS
	formes    [][][2]float64
	formesCum [][]float64
	services  []serviceGTFS
	parSvc    [][]int32
	courses   []courseGTFS
	idCourses []string
	passages  []passage
	motifs    []*motifGTFS
	textes    []string
	lignesGeo []byte
	debutVal  int
	finVal    int
}

func NewTransit(app *App) *Transit { return &Transit{app: app, etat: "non chargé"} }

func (t *Transit) Status() map[string]any {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return map[string]any{
		"charge":   t.pret,
		"etat":     t.etat,
		"courses":  len(t.courses),
		"validite": []int{t.debutVal, t.finVal},
	}
}

// --- Chargement --------------------------------------------------------------------

func heureGTFS(s string) int32 {
	p := strings.Split(strings.TrimSpace(s), ":")
	if len(p) != 3 {
		return -1
	}
	h, _ := strconv.Atoi(p[0])
	m, _ := strconv.Atoi(p[1])
	sec, _ := strconv.Atoi(p[2])
	return int32(h*3600 + m*60 + sec)
}

func lireCSV(z *zip.ReadCloser, nom string, fn func(col map[string]int, rec []string)) error {
	var f *zip.File
	for _, x := range z.File {
		if filepath.Base(x.Name) == nom {
			f = x
		}
	}
	if f == nil {
		return fmt.Errorf("%s absent du GTFS", nom)
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	r := csv.NewReader(rc)
	r.ReuseRecord = true
	r.FieldsPerRecord = -1
	entete, err := r.Read()
	if err != nil {
		return err
	}
	col := map[string]int{}
	for i, c := range entete {
		col[strings.TrimPrefix(strings.TrimSpace(c), "\ufeff")] = i
	}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		fn(col, rec)
	}
}

func champ(rec []string, col map[string]int, nom string) string {
	if i, ok := col[nom]; ok && i < len(rec) {
		return rec[i]
	}
	return ""
}

func distanceM(a, b [2]float64) float64 {
	lat := (a[1] + b[1]) / 2 * math.Pi / 180
	dx := (b[0] - a[0]) * 111320 * math.Cos(lat)
	dy := (b[1] - a[1]) * 110540
	return math.Hypot(dx, dy)
}

func (t *Transit) Load() {
	chemin := filepath.Join(t.app.dataDir, "mobilite", "naolib-gtfs.zip")
	debut := time.Now()
	t.mu.Lock()
	t.etat = "chargement des horaires"
	t.mu.Unlock()
	err := t.charger(chemin)
	debug.FreeOSMemory() // rend au système la mémoire temporaire du chargement
	if err != nil {
		log.Printf("Transports Naolib indisponibles : %v", err)
		t.mu.Lock()
		t.etat = err.Error()
		t.mu.Unlock()
		return
	}
	t.mu.RLock()
	log.Printf("Transports Naolib : %d courses, %d passages, horaires du %d au %d (chargés en %.1f s).",
		len(t.courses), len(t.passages), t.debutVal, t.finVal, time.Since(debut).Seconds())
	t.mu.RUnlock()
}

func (t *Transit) charger(chemin string) error {
	z, err := zip.OpenReader(chemin)
	if err != nil {
		return fmt.Errorf("fichier %s illisible", filepath.Base(chemin))
	}
	defer z.Close()

	idxArret := map[string]uint16{}
	var arrets []arretGTFS
	err = lireCSV(z, "stops.txt", func(col map[string]int, rec []string) {
		lat, _ := strconv.ParseFloat(champ(rec, col, "stop_lat"), 64)
		lon, _ := strconv.ParseFloat(champ(rec, col, "stop_lon"), 64)
		id := champ(rec, col, "stop_id")
		idxArret[id] = uint16(len(arrets))
		arrets = append(arrets, arretGTFS{id: id, nom: champ(rec, col, "stop_name"), lon: lon, lat: lat})
	})
	if err != nil {
		return err
	}

	idxLigne := map[string]int16{}
	var lignes []ligneGTFS
	err = lireCSV(z, "routes.txt", func(col map[string]int, rec []string) {
		typ, _ := strconv.Atoi(champ(rec, col, "route_type"))
		id := champ(rec, col, "route_id")
		idxLigne[id] = int16(len(lignes))
		lignes = append(lignes, ligneGTFS{id: id, court: champ(rec, col, "route_short_name"),
			long: champ(rec, col, "route_long_name"), typ: typ,
			couleur: champ(rec, col, "route_color"), texte: champ(rec, col, "route_text_color")})
	})
	if err != nil {
		return err
	}

	idxForme := map[string]int32{}
	type pointForme struct {
		seq int
		p   [2]float64
	}
	brut := map[int32][]pointForme{}
	_ = lireCSV(z, "shapes.txt", func(col map[string]int, rec []string) {
		id := champ(rec, col, "shape_id")
		i, ok := idxForme[id]
		if !ok {
			i = int32(len(idxForme))
			idxForme[id] = i
		}
		lat, _ := strconv.ParseFloat(champ(rec, col, "shape_pt_lat"), 64)
		lon, _ := strconv.ParseFloat(champ(rec, col, "shape_pt_lon"), 64)
		seq, _ := strconv.Atoi(champ(rec, col, "shape_pt_sequence"))
		brut[i] = append(brut[i], pointForme{seq, [2]float64{lon, lat}})
	})
	formes := make([][][2]float64, len(idxForme))
	cumuls := make([][]float64, len(idxForme))
	for i, pts := range brut {
		sort.Slice(pts, func(a, b int) bool { return pts[a].seq < pts[b].seq })
		f := make([][2]float64, len(pts))
		c := make([]float64, len(pts))
		for k, p := range pts {
			f[k] = p.p
			if k > 0 {
				c[k] = c[k-1] + distanceM(f[k-1], f[k])
			}
		}
		formes[i], cumuls[i] = f, c
	}

	idxService := map[string]int16{}
	var services []serviceGTFS
	service := func(id string) int16 {
		if i, ok := idxService[id]; ok {
			return i
		}
		idxService[id] = int16(len(services))
		services = append(services, serviceGTFS{ajouts: map[int]bool{}, suppression: map[int]bool{}})
		return idxService[id]
	}
	debutVal, finVal := 99999999, 0
	_ = lireCSV(z, "calendar.txt", func(col map[string]int, rec []string) {
		s := &services[service(champ(rec, col, "service_id"))]
		for j, nom := range []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"} {
			s.jours[j] = champ(rec, col, nom) == "1"
		}
		s.debut, _ = strconv.Atoi(champ(rec, col, "start_date"))
		s.fin, _ = strconv.Atoi(champ(rec, col, "end_date"))
		debutVal, finVal = min(debutVal, s.debut), max(finVal, s.fin)
	})
	_ = lireCSV(z, "calendar_dates.txt", func(col map[string]int, rec []string) {
		s := &services[service(champ(rec, col, "service_id"))]
		d, _ := strconv.Atoi(champ(rec, col, "date"))
		if champ(rec, col, "exception_type") == "1" {
			s.ajouts[d] = true
			debutVal, finVal = min(debutVal, d), max(finVal, d)
		} else {
			s.suppression[d] = true
		}
	})

	idxCourse := map[string]int32{}
	var courses []courseGTFS
	var idCourses []string
	var textes []string
	idxTexte := map[string]int32{}
	serviceCourse := []int16{}
	formeCourse := []int32{}
	err = lireCSV(z, "trips.txt", func(col map[string]int, rec []string) {
		l, ok := idxLigne[champ(rec, col, "route_id")]
		if !ok {
			return
		}
		dest := champ(rec, col, "trip_headsign")
		ti, ok := idxTexte[dest]
		if !ok {
			ti = int32(len(textes))
			idxTexte[dest] = ti
			textes = append(textes, dest)
		}
		sens, _ := strconv.Atoi(champ(rec, col, "direction_id"))
		forme := int32(-1)
		if f, ok := idxForme[champ(rec, col, "shape_id")]; ok {
			forme = f
		}
		id := champ(rec, col, "trip_id")
		idxCourse[id] = int32(len(courses))
		idCourses = append(idCourses, id)
		courses = append(courses, courseGTFS{ligne: l, sens: int8(sens), destination: ti, premier: -1})
		serviceCourse = append(serviceCourse, service(champ(rec, col, "service_id")))
		formeCourse = append(formeCourse, forme)
	})
	if err != nil {
		return err
	}

	// Passages : lus dans l'ordre du fichier, puis regroupés par course.
	type ligneHoraire struct {
		course int32
		seq    int32
		p      passage
	}
	lus := make([]ligneHoraire, 0, 1<<20)
	trie := true // le fichier est-il déjà groupé par course, arrêts dans l'ordre ?
	ferme := make([]bool, len(courses))
	precedente, seqPrecedente := int32(-1), int32(-1)
	err = lireCSV(z, "stop_times.txt", func(col map[string]int, rec []string) {
		c, ok := idxCourse[champ(rec, col, "trip_id")]
		if !ok {
			return
		}
		a, ok := idxArret[champ(rec, col, "stop_id")]
		if !ok {
			return
		}
		seq, _ := strconv.Atoi(champ(rec, col, "stop_sequence"))
		arr := heureGTFS(champ(rec, col, "arrival_time"))
		dep := heureGTFS(champ(rec, col, "departure_time"))
		if arr < 0 {
			arr = dep
		}
		if dep < 0 {
			dep = arr
		}
		if c != precedente {
			if precedente >= 0 {
				ferme[precedente] = true
			}
			if ferme[c] {
				trie = false
			}
		} else if int32(seq) < seqPrecedente {
			trie = false
		}
		precedente, seqPrecedente = c, int32(seq)
		lus = append(lus, ligneHoraire{c, int32(seq), passage{a, arr, dep}})
	})
	if err != nil {
		return err
	}
	if !trie {
		sort.Slice(lus, func(i, j int) bool {
			if lus[i].course != lus[j].course {
				return lus[i].course < lus[j].course
			}
			return lus[i].seq < lus[j].seq
		})
	}
	passages := make([]passage, len(lus))
	for i, l := range lus {
		passages[i] = l.p
		c := &courses[l.course]
		if c.premier < 0 {
			c.premier = int32(i)
		}
		c.n++
	}
	lus = nil

	// Motifs (tracé + suite d'arrêts), partagés entre courses.
	idxMotif := map[string]int32{}
	var motifs []*motifGTFS
	parSvc := make([][]int32, len(services))
	var cle strings.Builder
	for i := range courses {
		c := &courses[i]
		if c.n < 2 {
			continue
		}
		cle.Reset()
		cle.WriteString(strconv.Itoa(int(formeCourse[i])))
		for k := int32(0); k < c.n; k++ {
			cle.WriteByte(',')
			cle.WriteString(strconv.Itoa(int(passages[c.premier+k].arret)))
		}
		m, ok := idxMotif[cle.String()]
		if !ok {
			m = int32(len(motifs))
			idxMotif[cle.String()] = m
			as := make([]int32, c.n)
			for k := int32(0); k < c.n; k++ {
				as[k] = int32(passages[c.premier+k].arret)
			}
			motifs = append(motifs, &motifGTFS{forme: formeCourse[i], arrets: as})
		}
		c.motif = m
		parSvc[serviceCourse[i]] = append(parSvc[serviceCourse[i]], int32(i))
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	t.arrets, t.lignes, t.formes, t.formesCum = arrets, lignes, formes, cumuls
	t.services, t.parSvc, t.courses, t.idCourses = services, parSvc, courses, idCourses
	t.passages, t.motifs, t.textes = passages, motifs, textes
	t.debutVal, t.finVal = debutVal, finVal
	t.lignesGeo = t.construireLignes(formeCourse)
	t.pret = true
	t.etat = "prêt"
	return nil
}

// construireLignes produit le GeoJSON des tracés (un par forme utilisée).
func (t *Transit) construireLignes(formeCourse []int32) []byte {
	type feature struct {
		Type       string         `json:"type"`
		Geometry   map[string]any `json:"geometry"`
		Properties map[string]any `json:"properties"`
	}
	vues := map[int32]bool{}
	var fs []feature
	for i, c := range t.courses {
		f := formeCourse[i]
		if f < 0 || vues[f] || c.n < 2 {
			continue
		}
		vues[f] = true
		l := t.lignes[c.ligne]
		fs = append(fs, feature{"Feature",
			map[string]any{"type": "LineString", "coordinates": t.formes[f]},
			map[string]any{"ligne": l.court, "nom": l.long, "type": l.typ, "couleur": "#" + l.couleur, "texte": "#" + l.texte}})
	}
	b, _ := json.Marshal(map[string]any{"type": "FeatureCollection", "features": fs})
	return b
}

// --- Géométrie des motifs ----------------------------------------------------------

// distances renvoie, pour chaque arrêt du motif, sa position (m) le long du tracé.
func (t *Transit) distances(m *motifGTFS) []float64 {
	m.once.Do(func() {
		if m.forme < 0 || len(t.formes[m.forme]) < 2 {
			m.dist = make([]float64, len(m.arrets))
			for k := 1; k < len(m.arrets); k++ {
				a, b := t.arrets[m.arrets[k-1]], t.arrets[m.arrets[k]]
				m.dist[k] = m.dist[k-1] + distanceM([2]float64{a.lon, a.lat}, [2]float64{b.lon, b.lat})
			}
			return
		}
		f, cum := t.formes[m.forme], t.formesCum[m.forme]
		m.dist = make([]float64, len(m.arrets))
		j0 := 0
		for k, ai := range m.arrets {
			a := t.arrets[ai]
			p := [2]float64{a.lon, a.lat}
			best, bestD, bestJ := math.Inf(1), 0.0, j0
			for j := j0; j < len(f)-1; j++ {
				d, pos := projeter(p, f[j], f[j+1])
				if d < best {
					best, bestD, bestJ = d, cum[j]+pos*(cum[j+1]-cum[j]), j
				}
				if best < 15 && d > best+400 {
					break // l'arrêt est trouvé, inutile de parcourir tout le tracé
				}
			}
			if k > 0 && bestD < m.dist[k-1] {
				bestD = m.dist[k-1]
			}
			m.dist[k], j0 = bestD, bestJ
		}
	})
	return m.dist
}

// projeter renvoie la distance (m) de p au segment [a, b] et la position relative 0–1.
func projeter(p, a, b [2]float64) (float64, float64) {
	k := math.Cos(a[1] * math.Pi / 180)
	ax, ay := a[0]*k, a[1]
	bx, by := b[0]*k, b[1]
	px, py := p[0]*k, p[1]
	dx, dy := bx-ax, by-ay
	l2 := dx*dx + dy*dy
	u := 0.0
	if l2 > 0 {
		u = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/l2))
	}
	qx, qy := ax+u*dx, ay+u*dy
	return math.Hypot(px-qx, py-qy) * 110540, u
}

func (t *Transit) pointA(m *motifGTFS, d float64) [2]float64 {
	if m.forme < 0 || len(t.formes[m.forme]) < 2 {
		dist := m.dist
		k := sort.SearchFloat64s(dist, d)
		if k <= 0 {
			a := t.arrets[m.arrets[0]]
			return [2]float64{a.lon, a.lat}
		}
		if k >= len(dist) {
			a := t.arrets[m.arrets[len(m.arrets)-1]]
			return [2]float64{a.lon, a.lat}
		}
		a, b := t.arrets[m.arrets[k-1]], t.arrets[m.arrets[k]]
		u := 0.0
		if dist[k] > dist[k-1] {
			u = (d - dist[k-1]) / (dist[k] - dist[k-1])
		}
		return [2]float64{a.lon + u*(b.lon-a.lon), a.lat + u*(b.lat-a.lat)}
	}
	f, cum := t.formes[m.forme], t.formesCum[m.forme]
	j := sort.SearchFloat64s(cum, d)
	if j <= 0 {
		return f[0]
	}
	if j >= len(f) {
		return f[len(f)-1]
	}
	u := 0.0
	if cum[j] > cum[j-1] {
		u = (d - cum[j-1]) / (cum[j] - cum[j-1])
	}
	return [2]float64{f[j-1][0] + u*(f[j][0]-f[j-1][0]), f[j-1][1] + u*(f[j][1]-f[j-1][1])}
}

// --- Calendrier ------------------------------------------------------------------------

func aaaammjj(d time.Time) int { return d.Year()*10000 + int(d.Month())*100 + d.Day() }

func (t *Transit) actif(s *serviceGTFS, d time.Time) bool {
	j := aaaammjj(d)
	if s.suppression[j] {
		return false
	}
	if s.ajouts[j] {
		return true
	}
	return j >= s.debut && j <= s.fin && s.jours[int(d.Weekday())]
}

// dateService renvoie la date à utiliser pour les horaires : la date demandée si elle
// est couverte par le GTFS, sinon le même jour de la semaine dans la période couverte.
func (t *Transit) dateService(d time.Time) (time.Time, bool) {
	j := aaaammjj(d)
	if j >= t.debutVal && j <= t.finVal {
		return d, false
	}
	debut, _ := time.ParseInLocation("20060102", strconv.Itoa(t.debutVal), paris)
	for k := 0; k < 21; k++ {
		c := debut.AddDate(0, 0, k)
		if c.Weekday() != d.Weekday() {
			continue
		}
		for i := range t.services {
			if t.actif(&t.services[i], c) {
				return time.Date(c.Year(), c.Month(), c.Day(), d.Hour(), d.Minute(), d.Second(), 0, paris), true
			}
		}
	}
	return d, true
}

// --- Positions des véhicules ------------------------------------------------------------

type vehicule struct {
	ID          string       `json:"id"`
	Ligne       string       `json:"ligne"`
	Type        int          `json:"type"`
	Couleur     string       `json:"couleur"`
	Texte       string       `json:"texte"`
	Destination string       `json:"destination"`
	Retard      *int32       `json:"retard,omitempty"`
	TempsReel   bool         `json:"tr"`
	P           [][2]float64 `json:"p"`
}

type retardsCourse map[string]int32 // arrêt → retard (s)

func (t *Transit) retardsTempsReel(ctx context.Context) (map[string]retardsCourse, map[string]bool, bool) {
	res, err := t.app.proxy.Get(ctx, "naolib-retards", nil)
	if err != nil || res.State == "cache" || time.Since(res.Fetched) > 10*time.Minute {
		return nil, nil, false
	}
	var f flux
	if json.Unmarshal(res.Data, &f) != nil {
		return nil, nil, false
	}
	retards := map[string]retardsCourse{}
	annulees := map[string]bool{}
	for _, c := range f.Courses {
		if c.Annulee {
			annulees[c.Course] = true
			continue
		}
		r := retardsCourse{}
		for _, a := range c.Arrets {
			r[a.Arret] = a.Retard
		}
		retards[c.Course] = r
	}
	return retards, annulees, true
}

// segment renvoie la distance parcourue sur le motif à l'instant s (secondes).
func (t *Transit) distanceA(c *courseGTFS, dist []float64, s float64) float64 {
	ps := t.passages[c.premier : c.premier+c.n]
	if s <= float64(ps[0].dep) {
		return dist[0]
	}
	if s >= float64(ps[len(ps)-1].arr) {
		return dist[len(dist)-1]
	}
	k := sort.Search(len(ps), func(i int) bool { return float64(ps[i].dep) > s }) - 1
	if k < 0 {
		return dist[0]
	}
	if s < float64(ps[k].dep) || k+1 >= len(ps) {
		return dist[k]
	}
	a, b := float64(ps[k].dep), float64(ps[k+1].arr)
	if s >= b {
		return dist[k+1]
	}
	u := (s - a) / math.Max(1, b-a)
	return dist[k] + u*(dist[k+1]-dist[k])
}

func (t *Transit) HandleVehicles(w http.ResponseWriter, r *http.Request) {
	t.mu.RLock()
	pret, etatChargement := t.pret, t.etat
	t.mu.RUnlock()
	if !pret {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"erreur": "horaires Naolib : " + etatChargement})
		return
	}
	q := r.URL.Query()
	instant := time.Now()
	if ms, err := strconv.ParseInt(q.Get("t"), 10, 64); err == nil {
		instant = time.UnixMilli(ms)
	}
	fenetre, pas := 30, 5
	if v, err := strconv.Atoi(q.Get("fenetre")); err == nil && v >= 0 && v <= 300 {
		fenetre = v
	}
	if v, err := strconv.Atoi(q.Get("pas")); err == nil && v >= 1 && v <= 60 {
		pas = v
	}
	var bbox *[4]float64
	if q.Get("bbox") != "" {
		if b, err := parseBBoxLibre(q.Get("bbox")); err == nil {
			bbox = &b
		}
	}

	var retards map[string]retardsCourse
	var annulees map[string]bool
	tempsReel := false
	if math.Abs(time.Since(instant).Minutes()) < 15 && t.app.isOnline() {
		retards, annulees, tempsReel = t.retardsTempsReel(r.Context())
	}

	local := instant.In(paris)
	jour, substitue := t.dateService(local)
	secondes := float64(jour.Hour()*3600+jour.Minute()*60+jour.Second()) + float64(instant.Nanosecond())/1e9
	minuit := time.Date(jour.Year(), jour.Month(), jour.Day(), 0, 0, 0, 0, paris)

	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []vehicule{}
	for decalage := 0; decalage <= 1; decalage++ {
		d := minuit.AddDate(0, 0, -decalage)
		s := secondes + float64(decalage)*86400
		for si := range t.services {
			if !t.actif(&t.services[si], d) {
				continue
			}
			for _, ci := range t.parSvc[si] {
				c := &t.courses[ci]
				ps := t.passages[c.premier : c.premier+c.n]
				debutC, finC := float64(ps[0].dep), float64(ps[len(ps)-1].arr)
				if s+float64(fenetre) < debutC-600 || s > finC+900 {
					continue
				}
				id := t.idCourses[ci]
				if annulees[id] {
					continue
				}
				var retard *int32
				if rc, ok := retards[id]; ok {
					// Retard annoncé pour le prochain arrêt, sinon le dernier connu.
					k := sort.Search(len(ps), func(i int) bool { return float64(ps[i].arr) > s })
					for i := k; i < len(ps) && retard == nil; i++ {
						if v, ok := rc[t.arrets[ps[i].arret].id]; ok {
							v := v
							retard = &v
						}
					}
					if retard == nil {
						for i := len(ps) - 1; i >= 0 && retard == nil; i-- {
							if v, ok := rc[t.arrets[ps[i].arret].id]; ok {
								v := v
								retard = &v
							}
						}
					}
				}
				eff := s
				if retard != nil {
					eff -= float64(*retard)
				}
				if eff+float64(fenetre) < debutC || eff > finC {
					continue
				}
				m := t.motifs[c.motif]
				dist := t.distances(m)
				v := vehicule{ID: id, TempsReel: retard != nil, Retard: retard}
				dedans := bbox == nil
				for k := 0; k <= fenetre; k += pas {
					p := t.pointA(m, t.distanceA(c, dist, eff+float64(k)))
					v.P = append(v.P, [2]float64{math.Round(p[0]*1e6) / 1e6, math.Round(p[1]*1e6) / 1e6})
					if !dedans && p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3] {
						dedans = true
					}
				}
				if !dedans {
					continue
				}
				l := t.lignes[c.ligne]
				v.Ligne, v.Type, v.Couleur, v.Texte = l.court, l.typ, "#"+l.couleur, "#"+l.texte
				v.Destination = t.textes[c.destination]
				out = append(out, v)
			}
		}
	}
	mode := "theorique"
	if tempsReel {
		mode = "temps-reel"
	}
	if substitue {
		mode = "types"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":       mode,
		"jour":       jour.Format("2006-01-02"),
		"t0":         instant.UnixMilli(),
		"pas":        pas,
		"vehicules":  out,
		"validite":   []int{t.debutVal, t.finVal},
		"horodatage": time.Now().UnixMilli(),
	})
}

func (t *Transit) HandleLines(w http.ResponseWriter, r *http.Request) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if !t.pret {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"erreur": "horaires Naolib : " + t.etat})
		return
	}
	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Cache-Control", "max-age=3600")
	_, _ = w.Write(t.lignesGeo)
}

// parseBBoxLibre lit « ouest,sud,est,nord » sans limite de taille.
func parseBBoxLibre(s string) ([4]float64, error) {
	var b [4]float64
	p := strings.Split(s, ",")
	if len(p) != 4 {
		return b, fmt.Errorf("bbox invalide")
	}
	for i := range p {
		v, err := strconv.ParseFloat(strings.TrimSpace(p[i]), 64)
		if err != nil {
			return b, err
		}
		b[i] = v
	}
	return b, nil
}
