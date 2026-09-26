// Serveur local de l'Atlas 3D de Nantes.
//
// Rôles :
//   - servir l'application (app/) et les données locales (data/), avec les
//     lectures partielles HTTP (Range) nécessaires aux fichiers PMTiles ;
//   - relayer les API externes (météo, mobilités…) avec un cache disque qui
//     prend le relais hors connexion ;
//   - écrire dans le dossier de l'atlas (projets IFC convertis, fiches,
//     zones exportées, enregistrements) ;
//   - ouvrir le navigateur au démarrage.
//
// Le serveur n'écoute que sur 127.0.0.1 : il n'est pas joignable depuis le réseau.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
)

const version = "1.0.0"

// App regroupe l'état partagé du serveur.
type App struct {
	root         string // dossier racine de l'atlas (contient app/ et data/)
	appDir       string
	dataDir      string
	origin       string // http://127.0.0.1:port
	port         int
	forceOffline bool
	online       atomic.Bool
	proxy        *Proxy
	recorder     *Recorder
	transit      *Transit
}

func main() {
	log.SetFlags(log.Ltime)

	rootFlag := flag.String("racine", "", "dossier racine de l'atlas (détecté automatiquement)")
	portFlag := flag.Int("port", 8765, "port d'écoute (le suivant libre est pris si occupé)")
	noBrowser := flag.Bool("sans-navigateur", false, "ne pas ouvrir le navigateur au démarrage")
	offline := flag.Bool("hors-ligne", false, "simuler l'absence de connexion (tests)")
	noRecord := flag.Bool("sans-enregistrement", false, "désactiver l'enregistreur de données temps réel")
	flag.Parse()

	root, err := findRoot(*rootFlag)
	if err != nil {
		fatal(err)
	}

	app := &App{
		root:         root,
		appDir:       filepath.Join(root, "app"),
		dataDir:      filepath.Join(root, "data"),
		forceOffline: *offline,
	}

	ln, port, err := listenFree(*portFlag)
	if err != nil {
		fatal(fmt.Errorf("impossible d'ouvrir un port local : %w", err))
	}
	app.port = port
	app.origin = fmt.Sprintf("http://127.0.0.1:%d", port)

	app.proxy = NewProxy(app)
	app.transit = NewTransit(app)
	app.recorder = NewRecorder(app, !*noRecord)

	srv := &http.Server{
		Handler:           app.routes(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go app.watchConnectivity(ctx)
	go app.transit.Load()
	go app.recorder.Run(ctx)

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal(err)
		}
	}()

	url := app.origin + "/"
	fmt.Println()
	fmt.Println("  Atlas 3D de Nantes — serveur local", version)
	fmt.Println("  Dossier :", root)
	fmt.Println("  Adresse :", url)
	if app.forceOffline {
		fmt.Println("  Mode    : hors ligne forcé (données indicatives)")
	}
	fmt.Println()
	fmt.Println("  Laissez cette fenêtre ouverte pendant l'utilisation de l'atlas.")
	fmt.Println("  Pour arrêter : fermez la fenêtre ou appuyez sur Ctrl+C.")
	fmt.Println()

	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Println("  Ouvrez cette adresse dans votre navigateur :", url)
		}
	}

	<-ctx.Done()
	fmt.Println("\n  Arrêt du serveur…")
	app.recorder.Flush()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

// findRoot cherche le dossier qui contient app/index.html : celui indiqué,
// sinon à côté de l'exécutable ou un niveau au-dessus (bin/), sinon le dossier courant.
func findRoot(explicit string) (string, error) {
	var candidates []string
	if explicit != "" {
		candidates = append(candidates, explicit)
	}
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		dir := filepath.Dir(exe)
		candidates = append(candidates, dir, filepath.Dir(dir))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd, filepath.Dir(wd))
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(abs, "app", "index.html")); err == nil {
			return abs, nil
		}
	}
	return "", errors.New("dossier de l'atlas introuvable (app/index.html manquant) — utilisez -racine")
}

// listenFree ouvre le port demandé sur 127.0.0.1, ou le premier libre parmi les 20 suivants.
func listenFree(port int) (net.Listener, int, error) {
	var lastErr error
	for p := port; p < port+20; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return ln, p, nil
		}
		lastErr = err
	}
	return nil, 0, lastErr
}

// watchConnectivity teste régulièrement l'accès à Internet.
func (a *App) watchConnectivity(ctx context.Context) {
	check := func() {
		if a.forceOffline {
			a.online.Store(false)
			return
		}
		was := a.online.Load()
		now := probeInternet()
		a.online.Store(now)
		if now != was {
			if now {
				log.Println("Connexion Internet disponible : données temps réel actives.")
			} else {
				log.Println("Pas de connexion Internet : l'atlas utilise les données locales et indicatives.")
			}
		}
	}
	check()
	t := time.NewTicker(45 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			check()
		}
	}
}

func probeInternet() bool {
	client := &http.Client{Timeout: 6 * time.Second}
	for _, u := range []string{"https://api.open-meteo.com/", "https://data.nantesmetropole.fr/"} {
		req, _ := http.NewRequest(http.MethodHead, u, nil)
		req.Header.Set("User-Agent", userAgent)
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			return true
		}
	}
	return false
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "\n  Erreur :", err)
	fmt.Fprintln(os.Stderr, "\n  Appuyez sur Entrée pour fermer.")
	_, _ = fmt.Scanln()
	os.Exit(1)
}
