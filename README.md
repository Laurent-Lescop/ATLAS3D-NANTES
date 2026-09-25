# Atlas 3D · Nantes

Atlas urbain interactif en 3D, qui fonctionne dans le navigateur et **sans connexion Internet**.
On choisit une zone d'étude à l'aide d'un cadre orientable, puis on explore les bâtiments en 3D
avec l'ombrage réel du soleil à l'heure et au jour choisis. Au survol d'un bâtiment, l'atlas affiche
la surface de son emprise au sol.

Toutes les données et les librairies sont stockées dans ce dossier. Quand une connexion est
disponible, l'atlas ajoute les données en temps réel (météo, trafic, transports) ; hors ligne,
il utilise les dernières valeurs connues ou des valeurs indicatives, toujours signalées comme telles.

## Lancer l'atlas

| Système | Fichier à double-cliquer |
|---|---|
| Windows | `Lancer-Atlas.bat` |
| macOS | `Lancer-Atlas.command` |
| Linux | `lancer-atlas.sh` |

Une fenêtre de terminal s'ouvre (c'est le petit serveur local) et le navigateur affiche l'atlas à
l'adresse `http://127.0.0.1:8765/`. **Laissez cette fenêtre ouverte** pendant l'utilisation ;
fermez-la pour arrêter l'atlas.

### Premier lancement

Les exécutables ne sont pas signés, le système peut donc afficher un avertissement :

- **macOS** : clic droit sur `Lancer-Atlas.command` → *Ouvrir* → *Ouvrir*. Si le fichier n'est pas
  exécutable après un téléchargement ZIP, dans le Terminal : `chmod +x Lancer-Atlas.command`.
- **Windows** : dans la fenêtre SmartScreen, *Informations complémentaires* → *Exécuter quand même*.
- **Linux** : `chmod +x lancer-atlas.sh bin/*` si nécessaire.

Le serveur n'écoute que sur `127.0.0.1` : il n'est pas accessible depuis le réseau.

Navigateur conseillé : une version récente de Firefox, Chrome, Edge ou Safari (WebGL 2 requis).

## Utilisation

1. **Choisir la zone** : déplacez le cadre orange, tirez ses coins ou ses bords, faites-le pivoter
   avec la poignée ronde (Maj pour tourner par pas de 15°). Le panneau indique les dimensions,
   la surface et une estimation du nombre de bâtiments. Des secteurs sont proposés dans la liste.
2. **Étudier cette zone** : la caméra passe en 3D, alignée sur le cadre, et les bâtiments s'élèvent.
3. **Heure et date** : la barre du bas règle l'heure (curseur), la date, les solstices et équinoxes.
   Le bouton ▶ anime une journée complète. Les ombres, la lumière et l'ambiance jour / nuit suivent
   la position réelle du soleil à Nantes (heure légale, heure d'été comprise).
4. **Survol d'un bâtiment** : emprise au sol (m²), hauteur, niveaux, surface de plancher estimée,
   année et usage. **Clic** : fiche détaillée. **Maj + clic** : sélection multiple et totaux.
5. **Panneaux** (barre de gauche) : *Affichage* (colorations par hauteur, époque, usage ; ombres ;
   course du soleil ; nuages réels…), *Climat* (voir ci-dessous), *Zone* (indicateurs : CES, COS,
   hauteurs, époques, usages ; export), *Réglages* (zones enregistrées), *Sources*.

### Climat

Le panneau *Climat* suit l'heure et la date choisies :

- **Météo** à l'heure choisie : observation (passé récent) ou prévision (3 jours) Open-Meteo ;
  au-delà, ou hors connexion, **valeurs indicatives** tirées des normales 2016-2025, clairement
  signalées. La nébulosité réelle adoucit la lumière du soleil et les ombres (réglable).
- **Courbe de température** de la journée, comparée à la normale de saison.
- **Rose des vents** climatologique du mois ou de l'année (10 ans de données horaires, réanalyse
  ERA5), avec la flèche du vent à l'heure choisie, et **vent animé** sur la carte (option).
- **Qualité de l'air** (indice européen, particules, NO₂, ozone, pollens — modèle CAMS).
- **Hauteur de la Loire** au pont Anne-de-Bretagne (Hub'Eau / Vigicrues) : la marée y est sensible.
- **Ensoleillement** : lever, coucher, durée du jour, hauteur du soleil à midi.

L'adresse de la page mémorise la zone : elle peut être mise en favori (`#zone=…&etude`).

## Données

| Donnée | Source | Licence |
|---|---|---|
| Fond de carte | OpenStreetMap via Protomaps (fichiers PMTiles) | ODbL |
| Emprises des bâtiments | OpenStreetMap (extrait OSM France, Loire-Atlantique) | ODbL |
| Hauteurs, dates, usages, logements | IGN BD TOPO (Géoplateforme) | Licence Ouverte 2.0 |
| Normales climatiques, roses des vents | Open-Meteo, archives ERA5 / ERA5-Land (Copernicus) | CC BY 4.0 |
| Météo, qualité de l'air (en ligne) | Open-Meteo (prévisions, CAMS) | CC BY 4.0 |
| Hauteur de la Loire (en ligne) | Hub'Eau — Vigicrues | Licence Ouverte 2.0 |

Le pack local couvre **Nantes, Rezé et leurs abords** (emprise −1,66 / 47,15 / −1,46 / 47,31) :
230 760 bâtiments. Hors de cette emprise, les bâtiments sont téléchargés à la demande quand une
connexion est disponible (OpenStreetMap via Overpass + IGN BD TOPO).

**Hauteurs** : balise OSM `height` si elle existe ; sinon hauteur mesurée de la BD TOPO
(à mi-toiture : hauteur à l'égout + moitié du toit) ; sinon niveaux OSM × 3 m ; sinon étages
BD TOPO × 3 m ; sinon une valeur par défaut selon le type. L'infobulle indique toujours l'origine.

**Surfaces** : calculées sur l'ellipsoïde GRS80 (plan tangent local), sur les géométries complètes
(non découpées en tuiles). La surface de plancher est une estimation (emprise × niveaux).

## Organisation du dossier

```
Lancer-Atlas.*        lanceurs (double-clic)
bin/                  serveur local compilé (Windows, macOS, Linux)
app/                  application web (HTML, CSS, JavaScript, librairies dans app/vendor)
data/fond/            fond de carte PMTiles, styles jour / nuit, polices, pictogrammes
data/batiments/       bâtiments en cellules GeoJSON compressées + index et densité
data/climat/          normales et roses des vents (Open-Meteo, 2016-2025)
data/editorial/       secteurs, contenus
data/zones/           zones enregistrées depuis l'atlas
server/               code source du serveur local (Go)
tools/                scripts de préparation des données et de test
```

## Mettre à jour ou reconstruire

Prérequis : [Node.js](https://nodejs.org) ≥ 22 et [Go](https://go.dev) ≥ 1.22.

```sh
npm install                          # librairies et outils
npm run vendor                       # copie les librairies dans app/vendor
node tools/preparer-fond.mjs         # fond de carte (nécessite l'outil pmtiles dans tools/bin ou le PATH)
node tools/preparer-batiments.mjs    # bâtiments OSM + BD TOPO → data/batiments
node tools/preparer-climat.mjs       # normales et roses des vents → data/climat
npm run serveur                      # recompile les exécutables du dossier bin/
npm test                             # test de bout en bout dans Chromium (captures dans tools/.cache)
```

Derrière un proxy d'entreprise, Node.js a besoin de `NODE_USE_ENV_PROXY=1` pour utiliser la
variable `HTTPS_PROXY`.

## Licences

Code de l'atlas : MIT. Librairies : MapLibre GL JS (BSD-3), deck.gl (MIT), PMTiles (BSD-3),
SunCalc (BSD-2), marked (MIT), DOMPurify (MPL-2.0 / Apache-2.0), proj4js (MIT),
web-ifc (MPL-2.0). Les données restent soumises à leurs licences respectives (voir le panneau
*Sources* de l'atlas).
