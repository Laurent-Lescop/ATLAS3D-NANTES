package main

import (
	"context"
	"net/http"
)

// Recorder enregistre les données temps réel pour le mode hors ligne (lot 3).
type Recorder struct {
	app     *App
	enabled bool
}

func NewRecorder(app *App, enabled bool) *Recorder { return &Recorder{app: app, enabled: enabled} }

func (r *Recorder) Run(ctx context.Context) {}

func (r *Recorder) Flush() {}

func (r *Recorder) Enabled() bool { return r.enabled }

func (r *Recorder) HandleStatus(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"actif": r.enabled})
}

func (r *Recorder) HandleSettings(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"actif": r.enabled})
}

func (r *Recorder) HandleProfile(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusNotFound, map[string]string{"erreur": "aucun profil"})
}

func (r *Recorder) HandleExport(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusNotFound, map[string]string{"erreur": "aucun enregistrement"})
}
