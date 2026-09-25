package main

import (
	"net/http"
)

// Transit calcule la position estimée des véhicules Naolib (lot 3).
type Transit struct {
	app *App
}

func NewTransit(app *App) *Transit { return &Transit{app: app} }

func (t *Transit) Load() {}

func (t *Transit) Status() map[string]any { return map[string]any{"charge": false} }

func (t *Transit) HandleVehicles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"erreur": "transports non disponibles"})
}

func (t *Transit) HandleLines(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"erreur": "transports non disponibles"})
}

func decodeTripUpdates(raw []byte) ([]byte, string, error) {
	return raw, "application/octet-stream", nil
}

func decodeAlerts(raw []byte) ([]byte, string, error) { return raw, "application/octet-stream", nil }
