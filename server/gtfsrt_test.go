package main

import (
	"encoding/json"
	"os"
	"testing"
)

// Vérifie le décodage d'un instantané réel du flux Naolib.
// Usage : ATLAS_TU=chemin/vers/trip-update.bin go test -run TestDecoderFlux -v
func TestDecoderFlux(t *testing.T) {
	chemin := os.Getenv("ATLAS_TU")
	if chemin == "" {
		t.Skip("ATLAS_TU non défini")
	}
	raw, err := os.ReadFile(chemin)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := decodeTripUpdates(raw)
	if err != nil {
		t.Fatal(err)
	}
	var f flux
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Courses) == 0 {
		t.Fatal("aucune course décodée")
	}
	n := 0
	for _, c := range f.Courses {
		n += len(c.Arrets)
	}
	t.Logf("horodatage %d, %d courses, %d arrêts ; 1re course %s (%s) : %+v",
		f.Horodatage, len(f.Courses), n, f.Courses[0].Course, f.Courses[0].Ligne, f.Courses[0].Arrets[0])
}

// Varints négatifs (retards en avance) : codés sur 10 octets en complément à deux.
func TestVarintNegatif(t *testing.T) {
	// champ 1 (varint) = -120
	b := []byte{0x08, 0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01}
	var v int32
	err := parcourir(b, func(r *pb, num, codage int) (bool, error) {
		x, err := r.varint()
		v = int32(int64(x))
		return true, err
	})
	if err != nil || v != -120 {
		t.Fatalf("attendu -120, obtenu %d (%v)", v, err)
	}
}
