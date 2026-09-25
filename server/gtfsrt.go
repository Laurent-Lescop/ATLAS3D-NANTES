package main

// Décodage minimal du format GTFS-RT (protobuf), sans dépendance externe :
// seuls les champs utiles à l'atlas sont lus (mises à jour de courses, alertes).

import (
	"encoding/json"
	"errors"
)

type pb struct {
	b []byte
	i int
}

var errPB = errors.New("protobuf GTFS-RT invalide")

func (r *pb) varint() (uint64, error) {
	var v uint64
	for s := uint(0); s < 64; s += 7 {
		if r.i >= len(r.b) {
			return 0, errPB
		}
		c := r.b[r.i]
		r.i++
		v |= uint64(c&0x7f) << s
		if c < 0x80 {
			return v, nil
		}
	}
	return 0, errPB
}

// champ lit l'en-tête d'un champ : numéro et type de codage.
func (r *pb) champ() (int, int, error) {
	k, err := r.varint()
	return int(k >> 3), int(k & 7), err
}

func (r *pb) octets() ([]byte, error) {
	n, err := r.varint()
	if err != nil || r.i+int(n) > len(r.b) {
		return nil, errPB
	}
	v := r.b[r.i : r.i+int(n)]
	r.i += int(n)
	return v, nil
}

func (r *pb) sauter(codage int) error {
	switch codage {
	case 0:
		_, err := r.varint()
		return err
	case 1:
		r.i += 8
	case 2:
		_, err := r.octets()
		return err
	case 5:
		r.i += 4
	default:
		return errPB
	}
	if r.i > len(r.b) {
		return errPB
	}
	return nil
}

// parcourir appelle fn pour chaque champ du message ; fn renvoie false si elle
// n'a pas consommé le champ (il est alors sauté).
func parcourir(b []byte, fn func(r *pb, num, codage int) (bool, error)) error {
	r := &pb{b: b}
	for r.i < len(r.b) {
		num, codage, err := r.champ()
		if err != nil {
			return err
		}
		lu, err := fn(r, num, codage)
		if err != nil {
			return err
		}
		if !lu {
			if err := r.sauter(codage); err != nil {
				return err
			}
		}
	}
	return nil
}

func sousMessage(r *pb, fn func(r *pb, num, codage int) (bool, error)) error {
	b, err := r.octets()
	if err != nil {
		return err
	}
	return parcourir(b, fn)
}

func chaine(r *pb) (string, error) {
	b, err := r.octets()
	return string(b), err
}

// --- Mises à jour de courses ------------------------------------------------------

type majArret struct {
	Sequence int    `json:"seq"`
	Arret    string `json:"arret"`
	Retard   int32  `json:"retard"` // secondes (arrivée, sinon départ)
	Heure    int64  `json:"heure,omitempty"`
}

type majCourse struct {
	Course  string     `json:"course"`
	Ligne   string     `json:"ligne"`
	Annulee bool       `json:"annulee,omitempty"`
	Arrets  []majArret `json:"arrets"`
}

type flux struct {
	Horodatage int64       `json:"horodatage"`
	Courses    []majCourse `json:"courses,omitempty"`
	Alertes    []alerte    `json:"alertes,omitempty"`
}

func lireEvenement(r *pb) (retard int32, heure int64, aRetard bool, err error) {
	err = sousMessage(r, func(r *pb, num, codage int) (bool, error) {
		switch num {
		case 1:
			v, err := r.varint()
			retard, aRetard = int32(int64(v)), true
			return true, err
		case 2:
			v, err := r.varint()
			heure = int64(v)
			return true, err
		}
		return false, nil
	})
	return
}

func lireCourse(r *pb) (majCourse, error) {
	var c majCourse
	err := sousMessage(r, func(r *pb, num, codage int) (bool, error) {
		switch num {
		case 1: // TripDescriptor
			return true, sousMessage(r, func(r *pb, num, codage int) (bool, error) {
				var err error
				switch num {
				case 1:
					c.Course, err = chaine(r)
					return true, err
				case 4:
					v, err := r.varint()
					c.Annulee = v == 3 // CANCELED
					return true, err
				case 5:
					c.Ligne, err = chaine(r)
					return true, err
				}
				return false, nil
			})
		case 2: // StopTimeUpdate
			var a majArret
			var retArr, retDep int32
			var hArr, hDep int64
			var okArr, okDep bool
			err := sousMessage(r, func(r *pb, num, codage int) (bool, error) {
				var err error
				switch num {
				case 1:
					v, err := r.varint()
					a.Sequence = int(v)
					return true, err
				case 2:
					retArr, hArr, okArr, err = lireEvenement(r)
					return true, err
				case 3:
					retDep, hDep, okDep, err = lireEvenement(r)
					return true, err
				case 4:
					a.Arret, err = chaine(r)
					return true, err
				}
				return false, nil
			})
			if okArr || hArr != 0 {
				a.Retard, a.Heure = retArr, hArr
			} else if okDep || hDep != 0 {
				a.Retard, a.Heure = retDep, hDep
			}
			c.Arrets = append(c.Arrets, a)
			return true, err
		}
		return false, nil
	})
	return c, err
}

func lireEntete(r *pb) (int64, error) {
	var ts int64
	err := sousMessage(r, func(r *pb, num, codage int) (bool, error) {
		if num == 3 {
			v, err := r.varint()
			ts = int64(v)
			return true, err
		}
		return false, nil
	})
	return ts, err
}

func decoderFlux(raw []byte) (*flux, error) {
	f := &flux{}
	err := parcourir(raw, func(r *pb, num, codage int) (bool, error) {
		switch num {
		case 1:
			ts, err := lireEntete(r)
			f.Horodatage = ts
			return true, err
		case 2: // FeedEntity
			return true, sousMessage(r, func(r *pb, num, codage int) (bool, error) {
				switch num {
				case 3:
					c, err := lireCourse(r)
					if err == nil && c.Course != "" {
						f.Courses = append(f.Courses, c)
					}
					return true, err
				case 5:
					a, err := lireAlerte(r)
					if err == nil {
						f.Alertes = append(f.Alertes, a)
					}
					return true, err
				}
				return false, nil
			})
		}
		return false, nil
	})
	return f, err
}

// --- Alertes ------------------------------------------------------------------------

type alerte struct {
	Debut       int64    `json:"debut,omitempty"`
	Fin         int64    `json:"fin,omitempty"`
	Titre       string   `json:"titre"`
	Description string   `json:"description,omitempty"`
	Lignes      []string `json:"lignes,omitempty"`
	Arrets      []string `json:"arrets,omitempty"`
	Effet       int      `json:"effet,omitempty"`
}

func texteTraduit(r *pb) (string, error) {
	var texte, fr string
	err := sousMessage(r, func(r *pb, num, codage int) (bool, error) {
		if num != 1 {
			return false, nil
		}
		var t, lang string
		err := sousMessage(r, func(r *pb, num, codage int) (bool, error) {
			var err error
			switch num {
			case 1:
				t, err = chaine(r)
				return true, err
			case 2:
				lang, err = chaine(r)
				return true, err
			}
			return false, nil
		})
		if texte == "" {
			texte = t
		}
		if lang == "fr" {
			fr = t
		}
		return true, err
	})
	if fr != "" {
		return fr, err
	}
	return texte, err
}

func lireAlerte(r *pb) (alerte, error) {
	var a alerte
	err := sousMessage(r, func(r *pb, num, codage int) (bool, error) {
		var err error
		switch num {
		case 1: // période active
			return true, sousMessage(r, func(r *pb, num, codage int) (bool, error) {
				if num != 1 && num != 2 {
					return false, nil
				}
				v, err := r.varint()
				if num == 1 && (a.Debut == 0 || int64(v) < a.Debut) {
					a.Debut = int64(v)
				} else if num == 2 && int64(v) > a.Fin {
					a.Fin = int64(v)
				}
				return true, err
			})
		case 5: // entité concernée
			return true, sousMessage(r, func(r *pb, num, codage int) (bool, error) {
				switch num {
				case 2:
					l, err := chaine(r)
					a.Lignes = appendUnique(a.Lignes, l)
					return true, err
				case 5:
					s, err := chaine(r)
					a.Arrets = appendUnique(a.Arrets, s)
					return true, err
				}
				return false, nil
			})
		case 7:
			v, err := r.varint()
			a.Effet = int(v)
			return true, err
		case 10:
			a.Titre, err = texteTraduit(r)
			return true, err
		case 11:
			a.Description, err = texteTraduit(r)
			return true, err
		}
		return false, nil
	})
	return a, err
}

func appendUnique(l []string, s string) []string {
	for _, x := range l {
		if x == s {
			return l
		}
	}
	return append(l, s)
}

// Transformations appelées par le relais (/api/proxy/naolib-*).
func decodeTripUpdates(raw []byte) ([]byte, string, error) {
	f, err := decoderFlux(raw)
	if err != nil {
		return nil, "", err
	}
	f.Alertes = nil
	b, err := json.Marshal(f)
	return b, "application/json; charset=utf-8", err
}

func decodeAlerts(raw []byte) ([]byte, string, error) {
	f, err := decoderFlux(raw)
	if err != nil {
		return nil, "", err
	}
	f.Courses = nil
	b, err := json.Marshal(f)
	return b, "application/json; charset=utf-8", err
}
