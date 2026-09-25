package main

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const userAgent = "AtlasNantes/1.0 (atlas 3D local; usage non commercial)"

func init() {
	// Types explicites : sous Windows, le registre peut associer .js à text/plain,
	// ce qui bloque les modules JavaScript.
	types := map[string]string{
		".js":      "text/javascript; charset=utf-8",
		".mjs":     "text/javascript; charset=utf-8",
		".css":     "text/css; charset=utf-8",
		".html":    "text/html; charset=utf-8",
		".json":    "application/json; charset=utf-8",
		".geojson": "application/geo+json; charset=utf-8",
		".md":      "text/markdown; charset=utf-8",
		".svg":     "image/svg+xml",
		".wasm":    "application/wasm",
		".pbf":     "application/x-protobuf",
		".pmtiles": "application/octet-stream",
		".glb":     "model/gltf-binary",
		".ifc":     "application/octet-stream",
		".webp":    "image/webp",
		".png":     "image/png",
		".jpg":     "image/jpeg",
		".jpeg":    "image/jpeg",
		".csv":     "text/csv; charset=utf-8",
		".jsonl":   "application/x-ndjson; charset=utf-8",
	}
	for ext, t := range types {
		_ = mime.AddExtensionType(ext, t)
	}
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/etat", a.handleStatus)
	mux.HandleFunc("GET /api/proxy/{source}", a.proxy.Handle)
	mux.HandleFunc("POST /api/proxy/{source}", a.proxy.Handle)
	mux.HandleFunc("GET /api/fichiers", a.handleList)
	mux.HandleFunc("PUT /api/fichiers/{chemin...}", a.handleSave)
	mux.HandleFunc("DELETE /api/fichiers/{chemin...}", a.handleDelete)
	mux.HandleFunc("GET /api/transports/vehicules", a.transit.HandleVehicles)
	mux.HandleFunc("GET /api/transports/lignes", a.transit.HandleLines)
	mux.HandleFunc("GET /api/enregistrements/etat", a.recorder.HandleStatus)
	mux.HandleFunc("PUT /api/enregistrements/reglages", a.recorder.HandleSettings)
	mux.HandleFunc("GET /api/enregistrements/profil/{source}", a.recorder.HandleProfile)
	mux.HandleFunc("GET /api/enregistrements/export/{source}", a.recorder.HandleExport)

	mux.Handle("/data/", http.StripPrefix("/data", staticHandler(a.dataDir, "public, max-age=300")))
	mux.Handle("/", staticHandler(a.appDir, "no-cache"))

	return a.guard(mux)
}

// guard protège le serveur local : seuls les noms d'hôte locaux sont acceptés
// (protection contre le « DNS rebinding ») et les écritures doivent venir de
// la page de l'atlas elle-même.
func (a *App) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if i := strings.LastIndex(host, ":"); i >= 0 {
			host = host[:i]
		}
		if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
			http.Error(w, "hôte non autorisé", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" && !a.isLocalOrigin(o) {
				http.Error(w, "origine non autorisée", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func (a *App) isLocalOrigin(o string) bool {
	for _, h := range []string{"127.0.0.1", "localhost"} {
		if o == "http://"+h+":"+itoa(a.port) {
			return true
		}
	}
	return false
}

// staticHandler sert un dossier. Si un fichier « x.gz » précompressé existe à
// côté de « x », il est servi avec Content-Encoding: gzip.
func staticHandler(dir, cacheControl string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean("/" + r.URL.Path)
		w.Header().Set("Cache-Control", cacheControl)

		full := filepath.Join(dir, filepath.FromSlash(clean))
		if _, err := os.Stat(full); os.IsNotExist(err) {
			gz := full + ".gz"
			if st, err := os.Stat(gz); err == nil && !st.IsDir() {
				serveGzip(w, r, gz, clean)
				return
			}
			if strings.HasSuffix(clean, ".pbf") && strings.Contains(clean, "/polices/") {
				// Plage de glyphes absente : réponse vide valide (aucun glyphe).
				w.Header().Set("Content-Type", "application/x-protobuf")
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		fs.ServeHTTP(w, r)
	})
}

func serveGzip(w http.ResponseWriter, r *http.Request, gzPath, logical string) {
	f, err := os.Open(gzPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()
	ctype := mime.TypeByExtension(path.Ext(logical))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Vary", "Accept-Encoding")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		st, _ := f.Stat()
		w.Header().Set("Content-Encoding", "gzip")
		http.ServeContent(w, r, "", st.ModTime(), f)
		return
	}
	zr, err := gzip.NewReader(f)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer zr.Close()
	_, _ = io.Copy(w, zr)
}

func (a *App) isOnline() bool {
	return !a.forceOffline && a.online.Load()
}

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":          version,
		"en_ligne":         a.isOnline(),
		"hors_ligne_force": a.forceOffline,
		"heure_serveur":    time.Now().Format(time.RFC3339),
		"enregistrement":   a.recorder.Enabled(),
		"transports":       a.transit.Status(),
	})
}

// Dossiers de data/ dans lesquels l'atlas a le droit d'écrire.
var writableDirs = []string{"projets", "poi", "zones", "reglages"}

// safeDataPath valide un chemin relatif à data/ pour l'écriture.
func (a *App) safeDataPath(rel string) (string, bool) {
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if rel == "" || strings.Contains(rel, "..") {
		return "", false
	}
	first := strings.SplitN(rel, "/", 2)[0]
	allowed := false
	for _, d := range writableDirs {
		if first == d {
			allowed = true
		}
	}
	if !allowed || !strings.Contains(rel, "/") {
		return "", false
	}
	return filepath.Join(a.dataDir, filepath.FromSlash(rel)), true
}

const maxUpload = 1 << 30 // 1 Gio

func (a *App) handleSave(w http.ResponseWriter, r *http.Request) {
	dst, ok := a.safeDataPath(r.PathValue("chemin"))
	if !ok {
		writeJSON(w, http.StatusForbidden, map[string]string{"erreur": "écriture interdite à cet emplacement"})
		return
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"erreur": err.Error()})
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".ecriture-*")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"erreur": err.Error()})
		return
	}
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, maxUpload))
	tmp.Close()
	if err != nil {
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusBadRequest, map[string]string{"erreur": err.Error()})
		return
	}
	if err := replaceFile(tmp.Name(), dst); err != nil {
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusInternalServerError, map[string]string{"erreur": err.Error()})
		return
	}
	log.Printf("Fichier enregistré : data/%s (%s)", r.PathValue("chemin"), humanBytes(n))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "octets": n})
}

func (a *App) handleDelete(w http.ResponseWriter, r *http.Request) {
	dst, ok := a.safeDataPath(r.PathValue("chemin"))
	if !ok {
		writeJSON(w, http.StatusForbidden, map[string]string{"erreur": "suppression interdite à cet emplacement"})
		return
	}
	if err := os.RemoveAll(dst); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"erreur": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleList liste le contenu d'un sous-dossier de data/ (lecture seule).
func (a *App) handleList(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Query().Get("dossier")), "/")
	if strings.Contains(rel, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"erreur": "chemin invalide"})
		return
	}
	dir := filepath.Join(a.dataDir, filepath.FromSlash(rel))
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	type entry struct {
		Nom     string `json:"nom"`
		Dossier bool   `json:"dossier"`
		Octets  int64  `json:"octets"`
		Modifie string `json:"modifie"`
	}
	out := []entry{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, entry{e.Name(), e.IsDir(), info.Size(), info.ModTime().Format(time.RFC3339)})
	}
	writeJSON(w, http.StatusOK, out)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
