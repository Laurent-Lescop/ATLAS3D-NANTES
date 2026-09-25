package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Applique un instantané temps réel aux horaires Naolib et vérifie que des
// véhicules « temps réel » sont produits.
// Usage : ATLAS_TU=…/trip-update.bin go test -run TestVehiculesTempsReel -v
func TestVehiculesTempsReel(t *testing.T) {
	chemin := os.Getenv("ATLAS_TU")
	gtfs := filepath.Join("..", "data", "mobilite", "naolib-gtfs.zip")
	if chemin == "" {
		t.Skip("ATLAS_TU non défini")
	}
	if _, err := os.Stat(gtfs); err != nil {
		t.Skip("GTFS absent")
	}
	app := &App{dataDir: filepath.Join(t.TempDir())}
	app.online.Store(true)
	app.proxy = NewProxy(app)
	raw, _ := os.ReadFile(chemin)
	decode, _, err := decodeTripUpdates(raw)
	if err != nil {
		t.Fatal(err)
	}
	var f flux
	_ = json.Unmarshal(decode, &f)
	app.proxy.mem["naolib-retards/"] = &cacheEntry{Data: decode, ContentType: "application/json", Fetched: time.Now()}
	tr := NewTransit(app)
	if err := tr.charger(gtfs); err != nil {
		t.Fatal(err)
	}
	// Le temps réel ne s'applique qu'à moins de 15 min de l'instant présent :
	// on interroge donc l'instant courant (l'instantané doit être récent).
	req := httptest.NewRequest("GET", "/api/transports/vehicules", nil)
	w := httptest.NewRecorder()
	tr.HandleVehicles(w, req)
	var rep struct {
		Mode      string     `json:"mode"`
		Vehicules []vehicule `json:"vehicules"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	n := 0
	var exemples []int32
	for _, v := range rep.Vehicules {
		if v.TempsReel {
			n++
			if len(exemples) < 8 {
				exemples = append(exemples, *v.Retard)
			}
		}
	}
	t.Logf("mode %s : %d véhicules, dont %d avec retard temps réel (ex. %v s)", rep.Mode, len(rep.Vehicules), n, exemples)
	if n == 0 {
		t.Error("aucun véhicule temps réel")
	}
}
