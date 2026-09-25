package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Source décrit une API externe relayée par le serveur.
type Source struct {
	TTL     time.Duration // durée pendant laquelle une réponse est considérée fraîche
	Timeout time.Duration
	// Request construit la requête amont à partir des paramètres reçus.
	// key identifie la réponse dans le cache (vide = une seule entrée).
	Request func(q url.Values) (req *http.Request, key string, err error)
	// Fetch remplace Request pour les sources à plusieurs appels (pagination…).
	Fetch func(ctx context.Context, q url.Values) (data []byte, contentType, key string, err error)
	// KeyOf calcule la clé de cache sans construire la requête (pour Fetch).
	KeyOf func(q url.Values) (string, error)
	// Transform convertit la réponse brute (ex. protobuf → JSON).
	Transform func(raw []byte) ([]byte, string, error)
}

type cacheEntry struct {
	Data        []byte    `json:"-"`
	ContentType string    `json:"type"`
	Fetched     time.Time `json:"date"`
}

// Proxy relaie les sources déclarées, avec cache mémoire + disque.
type Proxy struct {
	app     *App
	sources map[string]*Source
	client  *http.Client

	mu    sync.Mutex
	mem   map[string]*cacheEntry
	locks map[string]*sync.Mutex
}

func NewProxy(app *App) *Proxy {
	p := &Proxy{
		app:     app,
		sources: declareSources(),
		client:  &http.Client{Timeout: 60 * time.Second},
		mem:     map[string]*cacheEntry{},
		locks:   map[string]*sync.Mutex{},
	}
	return p
}

// Result est la réponse fournie par Get.
type Result struct {
	Data        []byte
	ContentType string
	Fetched     time.Time
	State       string // "direct" (frais), "cache" (hors ligne), "perime" (amont en erreur)
}

var errNoData = errors.New("aucune donnée disponible (hors ligne et pas encore en cache)")

// Get renvoie la donnée d'une source, depuis le cache ou l'amont.
func (p *Proxy) Get(ctx context.Context, name string, q url.Values) (*Result, error) {
	src, ok := p.sources[name]
	if !ok {
		return nil, fmt.Errorf("source inconnue : %s", name)
	}
	key, err := p.keyFor(src, q)
	if err != nil {
		return nil, err
	}
	fullKey := name + "/" + key

	lock := p.keyLock(fullKey)
	lock.Lock()
	defer lock.Unlock()

	cached := p.load(fullKey)
	if cached != nil && time.Since(cached.Fetched) < src.TTL {
		return &Result{cached.Data, cached.ContentType, cached.Fetched, "direct"}, nil
	}
	if !p.app.isOnline() {
		if cached != nil {
			return &Result{cached.Data, cached.ContentType, cached.Fetched, "cache"}, nil
		}
		return nil, errNoData
	}

	data, ctype, err := p.fetch(ctx, src, q)
	if err != nil {
		log.Printf("Source %s indisponible : %v", name, err)
		if cached != nil {
			return &Result{cached.Data, cached.ContentType, cached.Fetched, "perime"}, nil
		}
		return nil, err
	}
	entry := &cacheEntry{Data: data, ContentType: ctype, Fetched: time.Now()}
	p.store(fullKey, entry)
	return &Result{entry.Data, entry.ContentType, entry.Fetched, "direct"}, nil
}

func (p *Proxy) keyFor(src *Source, q url.Values) (string, error) {
	if src.KeyOf != nil {
		return src.KeyOf(q)
	}
	if src.Request != nil {
		_, key, err := src.Request(q)
		return key, err
	}
	return "", nil
}

func (p *Proxy) fetch(ctx context.Context, src *Source, q url.Values) ([]byte, string, error) {
	timeout := src.Timeout
	if timeout == 0 {
		timeout = 25 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var raw []byte
	var ctype string
	if src.Fetch != nil {
		d, ct, _, err := src.Fetch(ctx, q)
		if err != nil {
			return nil, "", err
		}
		raw, ctype = d, ct
	} else {
		req, _, err := src.Request(q)
		if err != nil {
			return nil, "", err
		}
		req = req.WithContext(ctx)
		d, ct, err := doRequest(p.client, req)
		if err != nil {
			return nil, "", err
		}
		raw, ctype = d, ct
	}
	if src.Transform != nil {
		return src.Transform(raw)
	}
	return raw, ctype, nil
}

func doRequest(client *http.Client, req *http.Request) ([]byte, string, error) {
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 300 {
		snippet := string(body)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, "", fmt.Errorf("HTTP %d : %s", resp.StatusCode, snippet)
	}
	return body, resp.Header.Get("Content-Type"), nil
}

func (p *Proxy) keyLock(k string) *sync.Mutex {
	p.mu.Lock()
	defer p.mu.Unlock()
	l, ok := p.locks[k]
	if !ok {
		l = &sync.Mutex{}
		p.locks[k] = l
	}
	return l
}

// cachePaths renvoie les fichiers de cache disque : data/cache/<source>/<empreinte>.bin|.json
func (p *Proxy) cachePaths(fullKey string) (string, string) {
	source, _, _ := strings.Cut(fullKey, "/")
	h := sha1.Sum([]byte(fullKey))
	name := hex.EncodeToString(h[:8])
	dir := filepath.Join(p.app.dataDir, "cache", source)
	return filepath.Join(dir, name+".bin"), filepath.Join(dir, name+".json")
}

func (p *Proxy) load(fullKey string) *cacheEntry {
	p.mu.Lock()
	e := p.mem[fullKey]
	p.mu.Unlock()
	if e != nil {
		return e
	}
	binPath, metaPath := p.cachePaths(fullKey)
	meta, err := os.ReadFile(metaPath)
	if err != nil {
		return nil
	}
	var entry cacheEntry
	if json.Unmarshal(meta, &entry) != nil {
		return nil
	}
	data, err := os.ReadFile(binPath)
	if err != nil {
		return nil
	}
	entry.Data = data
	p.mu.Lock()
	p.mem[fullKey] = &entry
	p.mu.Unlock()
	return &entry
}

func (p *Proxy) store(fullKey string, e *cacheEntry) {
	p.mu.Lock()
	p.mem[fullKey] = e
	p.mu.Unlock()
	binPath, metaPath := p.cachePaths(fullKey)
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(binPath, e.Data, 0o644)
	meta, _ := json.Marshal(e)
	_ = os.WriteFile(metaPath, meta, 0o644)
}

// Handle répond à /api/proxy/{source}.
func (p *Proxy) Handle(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("source")
	q := r.URL.Query()
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
		for k, v := range r.PostForm {
			q[k] = v
		}
	}
	res, err := p.Get(r.Context(), name, q)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errNoData) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]any{"erreur": err.Error(), "en_ligne": p.app.isOnline()})
		return
	}
	ctype := res.ContentType
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Atlas-Etat", res.State)
	w.Header().Set("X-Atlas-Date", res.Fetched.Format(time.RFC3339))
	_, _ = w.Write(res.Data)
}
