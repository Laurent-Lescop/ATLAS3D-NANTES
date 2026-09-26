package main

// Enregistreur des données temps réel. Quand l'atlas est en ligne, il relève
// périodiquement le trafic, les parkings, les vélos et les retards Naolib, et
// construit des profils types (jour ouvré, vacances scolaires, samedi, dimanche
// et fériés ; tranches de 30 minutes). Hors connexion, l'atlas affiche ces
// moyennes observées plutôt que des valeurs simulées.
//
// Stockage (data/enregistrements/) :
//   brut/<source>/<AAAA-MM-JJ>.jsonl  relevés bruts, conservés N jours
//   profils/<source>.json             histogrammes par type de jour et créneau

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const pasCreneau = 30 // minutes

type sourceEnreg struct {
	Nom        string `json:"nom"`
	Libelle    string `json:"libelle"`
	intervalle time.Duration
	classes    int
	extraire   func([]byte) (map[string]float64, error)
	classer    func(float64) int
	valeur     func(classe int) float64 // valeur représentative d'une classe
}

var sourcesEnreg = []*sourceEnreg{
	{Nom: "fluidite", Libelle: "Trafic routier (fluidité)", intervalle: 5 * time.Minute, classes: 7,
		extraire: extraireFluidite,
		classer:  func(v float64) int { return int(math.Max(0, math.Min(6, v))) },
		valeur:   func(c int) float64 { return float64(c) }},
	{Nom: "parkings", Libelle: "Parkings (taux d'occupation)", intervalle: 5 * time.Minute, classes: 11,
		extraire: extraireParkings, classer: classePourcent, valeur: valeurPourcent},
	{Nom: "velos-etat", Libelle: "Vélos en libre-service (vélos disponibles)", intervalle: 5 * time.Minute, classes: 11,
		extraire: extraireVelos, classer: classePourcent, valeur: valeurPourcent},
	{Nom: "naolib-retards", Libelle: "Retards des trams et bus", intervalle: 2 * time.Minute, classes: len(bornesRetard) + 1,
		extraire: extraireRetards,
		classer: func(v float64) int {
			return sort.SearchFloat64s(bornesRetard, v+0.001)
		},
		valeur: func(c int) float64 { return milieuxRetard[c] }},
}

func classePourcent(v float64) int { return int(math.Max(0, math.Min(10, math.Floor(v/10)))) }
func valeurPourcent(c int) float64 { return math.Min(100, float64(c)*10+5) }

// Classes de retard (secondes) : < −60, −60…0, 0…60, 60…120, 120…180, 180…300, 300…600, ≥ 600.
var bornesRetard = []float64{-60, 0, 60, 120, 180, 300, 600}
var milieuxRetard = []float64{-90, -30, 30, 90, 150, 240, 450, 720}

// --- Extraction des valeurs --------------------------------------------------------------

func extraireFluidite(b []byte) (map[string]float64, error) {
	var fc struct {
		Features []struct {
			Properties struct {
				ID      any    `json:"cha_id"`
				Couleur string `json:"couleur_tp"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(b, &fc); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for _, f := range fc.Features {
		n, err := strconv.Atoi(f.Properties.Couleur)
		if err != nil || n < 3 { // 2 = indéterminé : non enregistré
			continue
		}
		out[fmt.Sprint(f.Properties.ID)] = float64(n)
	}
	return out, nil
}

func extraireParkings(b []byte) (map[string]float64, error) {
	var lignes []struct {
		ID       any     `json:"grp_identifiant"`
		Dispo    float64 `json:"grp_disponible"`
		Capacite float64 `json:"grp_exploitation"`
	}
	if err := json.Unmarshal(b, &lignes); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for _, l := range lignes {
		if l.Capacite > 0 {
			out[fmt.Sprint(l.ID)] = math.Max(0, math.Min(100, 100*(1-l.Dispo/l.Capacite)))
		}
	}
	return out, nil
}

func extraireVelos(b []byte) (map[string]float64, error) {
	var d struct {
		Data struct {
			Stations []struct {
				ID     string  `json:"station_id"`
				Velos  float64 `json:"num_vehicles_available"`
				Places float64 `json:"num_docks_available"`
				Active bool    `json:"is_renting"`
			} `json:"stations"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for _, s := range d.Data.Stations {
		if s.Active && s.Velos+s.Places > 0 {
			out[s.ID] = 100 * s.Velos / (s.Velos + s.Places)
		}
	}
	return out, nil
}

// Retard médian par ligne, au prochain arrêt de chaque course suivie.
func extraireRetards(b []byte) (map[string]float64, error) {
	var f flux
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	parLigne := map[string][]float64{}
	maintenant := time.Now().Unix()
	for _, c := range f.Courses {
		if c.Annulee || len(c.Arrets) == 0 {
			continue
		}
		a := c.Arrets[len(c.Arrets)-1]
		for _, x := range c.Arrets {
			if x.Heure >= maintenant {
				a = x
				break
			}
		}
		l := strings.TrimPrefix(c.Ligne, "FR_NAOLIB:Line:")
		parLigne[l] = append(parLigne[l], float64(a.Retard))
	}
	out := map[string]float64{}
	for l, v := range parLigne {
		sort.Float64s(v)
		out[l] = v[len(v)/2]
	}
	return out, nil
}

// --- Profils ---------------------------------------------------------------------------------

type profil struct {
	Version int                                    `json:"version"`
	Pas     int                                    `json:"pas"`
	Classes int                                    `json:"classes"`
	Dates   map[string][]string                    `json:"dates"`
	Types   map[string]map[int]map[string][]uint32 `json:"types"`
}

func nouveauProfil(classes int) *profil {
	return &profil{Version: 1, Pas: pasCreneau, Classes: classes, Dates: map[string][]string{},
		Types: map[string]map[int]map[string][]uint32{}}
}

func (p *profil) ajouter(typ, date string, creneau int, valeurs map[string]float64, s *sourceEnreg) {
	if !contient(p.Dates[typ], date) {
		p.Dates[typ] = append(p.Dates[typ], date)
	}
	parCreneau := p.Types[typ]
	if parCreneau == nil {
		parCreneau = map[int]map[string][]uint32{}
		p.Types[typ] = parCreneau
	}
	ent := parCreneau[creneau]
	if ent == nil {
		ent = map[string][]uint32{}
		parCreneau[creneau] = ent
	}
	for id, v := range valeurs {
		h := ent[id]
		if h == nil {
			h = make([]uint32, 1+s.classes)
			ent[id] = h
		}
		h[0]++
		h[1+s.classer(v)]++
	}
}

func contient(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// quantile d'un histogramme (q entre 0 et 1), en indice de classe.
func quantile(h []uint32, q float64) int {
	n := float64(h[0])
	cumul := 0.0
	for i, c := range h[1:] {
		cumul += float64(c)
		if cumul >= q*n {
			return i
		}
	}
	return len(h) - 2
}

// --- Enregistreur -----------------------------------------------------------------------------

type reglagesEnreg struct {
	Actif          bool            `json:"actif"`
	Sources        map[string]bool `json:"sources"`
	RetentionJours int             `json:"retention_jours"`
}

type Recorder struct {
	app      *App
	force    bool // désactivé par l'option -sans-enregistrement
	mu       sync.Mutex
	reglages reglagesEnreg
	profils  map[string]*profil
	sales    map[string]bool
	dernier  map[string]time.Time // date des dernières données relevées (par source)
	releves  map[string]int
	vacances [][2]time.Time
	majVac   time.Time
}

func NewRecorder(app *App, enabled bool) *Recorder {
	r := &Recorder{app: app, force: !enabled, profils: map[string]*profil{}, sales: map[string]bool{},
		dernier: map[string]time.Time{}, releves: map[string]int{}}
	r.reglages = reglagesEnreg{Actif: true, Sources: map[string]bool{}, RetentionJours: 14}
	for _, s := range sourcesEnreg {
		r.reglages.Sources[s.Nom] = true
	}
	if b, err := os.ReadFile(r.cheminReglages()); err == nil {
		_ = json.Unmarshal(b, &r.reglages)
	}
	if r.reglages.RetentionJours <= 0 {
		r.reglages.RetentionJours = 14
	}
	for _, s := range sourcesEnreg {
		r.profils[s.Nom] = r.chargerProfil(s)
	}
	return r
}

func (r *Recorder) dossier(parties ...string) string {
	return filepath.Join(append([]string{r.app.dataDir, "enregistrements"}, parties...)...)
}

func (r *Recorder) cheminReglages() string {
	return filepath.Join(r.app.dataDir, "reglages", "enregistreur.json")
}

func (r *Recorder) chargerProfil(s *sourceEnreg) *profil {
	p := nouveauProfil(s.classes)
	if b, err := os.ReadFile(r.dossier("profils", s.Nom+".json")); err == nil {
		if json.Unmarshal(b, p) != nil || p.Classes != s.classes {
			p = nouveauProfil(s.classes)
		}
	}
	return p
}

func (r *Recorder) Enabled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.force && r.reglages.Actif
}

// Run relève les sources à leur rythme propre tant que l'atlas est en ligne.
func (r *Recorder) Run(ctx context.Context) {
	tic := time.NewTicker(30 * time.Second)
	defer tic.Stop()
	derniereSauvegarde := time.Now()
	dernierMenage := time.Time{}
	for {
		if r.Enabled() && r.app.isOnline() {
			for _, s := range sourcesEnreg {
				r.mu.Lock()
				actif := r.reglages.Sources[s.Nom]
				du := time.Since(r.dernier[s.Nom]) >= s.intervalle
				r.mu.Unlock()
				if actif && du {
					r.relever(ctx, s)
				}
			}
		}
		if time.Since(derniereSauvegarde) > 10*time.Minute {
			r.Flush()
			derniereSauvegarde = time.Now()
		}
		if time.Since(dernierMenage) > time.Hour {
			r.menage()
			dernierMenage = time.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-tic.C:
		}
	}
}

func (r *Recorder) relever(ctx context.Context, s *sourceEnreg) {
	res, err := r.app.proxy.Get(ctx, s.Nom, nil)
	if err != nil || res.State != "direct" {
		return
	}
	r.mu.Lock()
	deja := !res.Fetched.After(r.dernier[s.Nom])
	r.mu.Unlock()
	if deja {
		return
	}
	valeurs, err := s.extraire(res.Data)
	if err != nil || len(valeurs) == 0 {
		return
	}
	t := res.Fetched.In(paris)
	typ := r.typeJour(ctx, t)
	date := t.Format("2006-01-02")
	creneau := (t.Hour()*60 + t.Minute()) / pasCreneau

	r.mu.Lock()
	r.profils[s.Nom].ajouter(typ, date, creneau, valeurs, s)
	r.sales[s.Nom] = true
	r.dernier[s.Nom] = res.Fetched
	r.releves[s.Nom]++
	r.mu.Unlock()

	// Relevé brut (une ligne JSON par relevé).
	dir := r.dossier("brut", s.Nom)
	if os.MkdirAll(dir, 0o755) == nil {
		if f, err := os.OpenFile(filepath.Join(dir, date+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			ligne, _ := json.Marshal(map[string]any{"t": res.Fetched.Unix(), "v": arrondir(valeurs)})
			_, _ = f.Write(append(ligne, '\n'))
			f.Close()
		}
	}
}

func arrondir(m map[string]float64) map[string]float64 {
	for k, v := range m {
		m[k] = math.Round(v*10) / 10
	}
	return m
}

// Flush écrit les profils modifiés sur le disque.
func (r *Recorder) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for nom, sale := range r.sales {
		if !sale {
			continue
		}
		b, err := json.Marshal(r.profils[nom])
		if err != nil {
			continue
		}
		dir := r.dossier("profils")
		if os.MkdirAll(dir, 0o755) != nil {
			continue
		}
		tmp := filepath.Join(dir, "."+nom+".tmp")
		if os.WriteFile(tmp, b, 0o644) == nil && replaceFile(tmp, filepath.Join(dir, nom+".json")) == nil {
			r.sales[nom] = false
		}
	}
}

// menage supprime les relevés bruts plus anciens que la durée de conservation.
func (r *Recorder) menage() {
	r.mu.Lock()
	jours := r.reglages.RetentionJours
	r.mu.Unlock()
	limite := time.Now().AddDate(0, 0, -jours).Format("2006-01-02")
	_ = filepath.WalkDir(r.dossier("brut"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".jsonl") && strings.TrimSuffix(d.Name(), ".jsonl") < limite {
			if os.Remove(p) == nil {
				log.Printf("Enregistreur : relevés supprimés (%s)", d.Name())
			}
		}
		return nil
	})
}

// --- Types de jour ------------------------------------------------------------------------------

func paques(annee int) time.Time {
	a, b, c := annee%19, annee/100, annee%100
	d, e := b/4, b%4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i, k := c/4, c%4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 451
	mois := (h + l - 7*m + 114) / 31
	jour := (h+l-7*m+114)%31 + 1
	return time.Date(annee, time.Month(mois), jour, 0, 0, 0, 0, paris)
}

func ferie(d time.Time) bool {
	md := d.Format("01-02")
	switch md {
	case "01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25":
		return true
	}
	p := paques(d.Year())
	for _, delta := range []int{1, 39, 50} { // lundi de Pâques, Ascension, lundi de Pentecôte
		x := p.AddDate(0, 0, delta)
		if x.Month() == d.Month() && x.Day() == d.Day() {
			return true
		}
	}
	return false
}

func (r *Recorder) typeJour(ctx context.Context, t time.Time) string {
	d := t.In(paris)
	if d.Weekday() == time.Sunday || ferie(d) {
		return "dimanche"
	}
	if d.Weekday() == time.Saturday {
		return "samedi"
	}
	if r.enVacances(ctx, d) {
		return "vacances"
	}
	return "ouvre"
}

// enVacances consulte le calendrier scolaire (zone B, Nantes), mis en cache.
func (r *Recorder) enVacances(ctx context.Context, d time.Time) bool {
	r.mu.Lock()
	aJour := time.Since(r.majVac) < 24*time.Hour && len(r.vacances) > 0
	periodes := r.vacances
	r.mu.Unlock()
	if !aJour {
		if res, err := r.app.proxy.Get(ctx, "calendrier-scolaire", nil); err == nil {
			var lignes []struct {
				Debut string `json:"start_date"`
				Fin   string `json:"end_date"`
			}
			if json.Unmarshal(res.Data, &lignes) == nil {
				periodes = nil
				for _, l := range lignes {
					a, e1 := time.Parse(time.RFC3339, l.Debut)
					b, e2 := time.Parse(time.RFC3339, l.Fin)
					if e1 == nil && e2 == nil {
						periodes = append(periodes, [2]time.Time{a, b})
					}
				}
				r.mu.Lock()
				r.vacances, r.majVac = periodes, time.Now()
				r.mu.Unlock()
			}
		}
	}
	for _, p := range periodes {
		if !d.Before(p[0]) && d.Before(p[1]) {
			return true
		}
	}
	return false
}

// --- API ------------------------------------------------------------------------------------------

func tailleDossier(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

func (r *Recorder) HandleStatus(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	type etatSource struct {
		Nom     string         `json:"nom"`
		Libelle string         `json:"libelle"`
		Actif   bool           `json:"actif"`
		Dernier string         `json:"dernier,omitempty"`
		Releves int            `json:"releves_session"`
		Jours   map[string]int `json:"jours"`
	}
	var sources []etatSource
	for _, s := range sourcesEnreg {
		e := etatSource{Nom: s.Nom, Libelle: s.Libelle, Actif: r.reglages.Sources[s.Nom], Releves: r.releves[s.Nom], Jours: map[string]int{}}
		if !r.dernier[s.Nom].IsZero() {
			e.Dernier = r.dernier[s.Nom].Format(time.RFC3339)
		}
		for typ, dates := range r.profils[s.Nom].Dates {
			e.Jours[typ] = len(dates)
		}
		sources = append(sources, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"actif":           !r.force && r.reglages.Actif,
		"desactive_force": r.force,
		"retention_jours": r.reglages.RetentionJours,
		"octets":          tailleDossier(r.dossier()),
		"sources":         sources,
	})
}

func (r *Recorder) HandleSettings(w http.ResponseWriter, req *http.Request) {
	var nouv reglagesEnreg
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 1<<16)).Decode(&nouv); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"erreur": "réglages invalides"})
		return
	}
	if nouv.RetentionJours < 1 || nouv.RetentionJours > 365 {
		nouv.RetentionJours = 14
	}
	if nouv.Sources == nil {
		nouv.Sources = map[string]bool{}
	}
	r.mu.Lock()
	r.reglages = nouv
	r.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(r.cheminReglages()), 0o755); err == nil {
		b, _ := json.MarshalIndent(nouv, "", "  ")
		_ = os.WriteFile(r.cheminReglages(), b, 0o644)
	}
	r.menage()
	r.HandleStatus(w, req)
}

func sourceParNom(nom string) *sourceEnreg {
	for _, s := range sourcesEnreg {
		if s.Nom == nom {
			return s
		}
	}
	return nil
}

// HandleProfile renvoie, pour un instant donné (?t=ms), les valeurs observées de
// chaque entité : médiane, quartiles et nombre de relevés du créneau.
func (r *Recorder) HandleProfile(w http.ResponseWriter, req *http.Request) {
	s := sourceParNom(req.PathValue("source"))
	if s == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"erreur": "source inconnue"})
		return
	}
	t := time.Now()
	if ms, err := strconv.ParseInt(req.URL.Query().Get("t"), 10, 64); err == nil {
		t = time.UnixMilli(ms)
	}
	d := t.In(paris)
	typ := r.typeJour(req.Context(), d)
	if q := req.URL.Query().Get("type"); q != "" {
		typ = q
	}
	creneau := (d.Hour()*60 + d.Minute()) / pasCreneau
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.profils[s.Nom]
	type stat struct {
		N       uint32  `json:"n"`
		Mediane float64 `json:"mediane"`
		Q1      float64 `json:"q1"`
		Q3      float64 `json:"q3"`
	}
	out := map[string]stat{}
	for id, h := range p.Types[typ][creneau] {
		if h[0] == 0 {
			continue
		}
		out[id] = stat{h[0], s.valeur(quantile(h, 0.5)), s.valeur(quantile(h, 0.25)), s.valeur(quantile(h, 0.75))}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"source":  s.Nom,
		"type":    typ,
		"creneau": creneau,
		"pas":     pasCreneau,
		"jours":   len(p.Dates[typ]),
		"entites": out,
	})
}

// HandleExport renvoie les relevés bruts conservés au format CSV.
func (r *Recorder) HandleExport(w http.ResponseWriter, req *http.Request) {
	s := sourceParNom(req.PathValue("source"))
	if s == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"erreur": "source inconnue"})
		return
	}
	fichiers, _ := filepath.Glob(filepath.Join(r.dossier("brut", s.Nom), "*.jsonl"))
	sort.Strings(fichiers)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"atlas-%s.csv\"", s.Nom))
	bw := bufio.NewWriter(w)
	fmt.Fprintln(bw, "horodatage;entite;valeur")
	for _, chemin := range fichiers {
		f, err := os.Open(chemin)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 16<<20)
		for sc.Scan() {
			var l struct {
				T int64              `json:"t"`
				V map[string]float64 `json:"v"`
			}
			if json.Unmarshal(sc.Bytes(), &l) != nil {
				continue
			}
			h := time.Unix(l.T, 0).In(paris).Format("2006-01-02 15:04:05")
			ids := make([]string, 0, len(l.V))
			for id := range l.V {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				fmt.Fprintf(bw, "%s;%s;%s\n", h, id, strconv.FormatFloat(l.V[id], 'f', -1, 64))
			}
		}
		f.Close()
	}
	_ = bw.Flush()
}
