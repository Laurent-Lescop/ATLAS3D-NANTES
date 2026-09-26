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

### Mobilités

Le panneau *Mobilités* affiche, dans la zone étudiée :

- **Trafic routier** : fluidité des axes de Nantes Métropole (fluide, dense, saturé, bloqué),
  avec des particules animées d'autant plus lentes que le trafic est dense.
- **Trams, bus et Navibus** : tracés des lignes et véhicules animés. Naolib ne publie pas la
  position GPS des véhicules : elle est **estimée** à partir des horaires théoriques (GTFS),
  décalés des retards annoncés en temps réel. Pour une autre heure ou une autre date, l'atlas
  affiche les horaires théoriques ; hors de la période couverte, ceux d'un jour type équivalent.
- **Parkings publics** : jauges 3D d'occupation et places libres.
- **Vélos en libre-service** : stations et vélos disponibles.

Chaque donnée porte un badge : **En direct**, **Observé** (moyenne enregistrée par l'atlas pour
le même type de jour et la même demi-heure) ou **Indicatif** (simulation, faute de mieux).

**Enregistrement** : tant que l'atlas est ouvert et connecté, le serveur local relève le trafic,
les parkings, les vélos et les retards (toutes les 2 à 5 minutes). Il conserve les relevés bruts
14 jours (réglable) et construit des profils types — jours ouvrés, vacances scolaires (zone B),
samedis, dimanches et fériés — utilisés ensuite hors connexion. Réglages et export CSV : panneau
*Réglages*. Les données de Nantes Métropole sont sous licence ODbL : si vous diffusez la base
enregistrée, citez les sources et partagez-la sous la même licence.

### Sites et projets

Le panneau *Lieux* rassemble les **sites remarquables** (pastilles orange, bâtiments mis en valeur
en 3D) et les **projets** (en bleu). Un clic ouvre la fiche : texte, galerie d'images (avec
comparaison avant / après), données, liens. **Modifier la fiche** ouvre un éditeur (texte en
Markdown, champs, liens, ajout d'images) ; tout est enregistré dans `data/poi/` ou
`data/projets/`, sous forme de fichiers lisibles et modifiables à la main.

**Maquettes IFC** : bouton *Importer une maquette IFC* ou glisser-déposer d'un fichier `.ifc`
sur la carte (une zone d'étude doit être ouverte).

- La conversion se fait dans le navigateur (web-ifc) : l'atlas garde l'enveloppe et la structure
  (murs, dalles, toitures, façades, menuiseries…) ou, au choix, le détail complet. La maquette
  est enregistrée en glTF (`modele.glb`, lisible par Blender) à côté du fichier IFC d'origine.
- **Géoréférencement** : si le fichier contient un `IfcMapConversion` (IFC4) en Lambert-93, en
  coniques conformes CC42 à CC50, en Lambert II étendu ou en UTM, la maquette est placée
  automatiquement ; la convergence des méridiens est prise en compte. À défaut, l'atlas utilise
  les coordonnées de l'`IfcSite`, ou vous demande de la placer. Le rez-de-chaussée est posé au sol
  de la carte.
- **Calage** : clic sur la carte pour placer le centre, curseur d'orientation, altitude,
  échelle ; au clavier, flèches (1 m, Maj : 10 m) et Page préc. / Page suiv. (1°, Maj : 5°).
- **État actuel / Avec les projets** : dans le second mode, les maquettes s'affichent et les
  bâtiments existants situés sous leur emprise sont masqués. Les maquettes portent et reçoivent
  les ombres.

Un fichier d'essai est fourni : `tools/exemples/projet-demonstration.ifc` (projet **fictif**,
géoréférencé sur l'île de Nantes).

### Quartiers, secteurs et parcours

- **Quartiers** : les limites et les noms des quartiers de Nantes et des communes voisines
  (Nantes Métropole) s'affichent sur la carte (réglable dans *Affichage*). Le panneau *Zone*
  indique la répartition de la zone étudiée entre quartiers, et une zone libre prend le nom du
  quartier où elle se trouve.
- **Secteurs prédéfinis** (liste du cadre de sélection) : centre historique, Graslin – Commerce,
  île de Nantes, Quartier de la Création, Beaulieu, gare – Euronantes – Malakoff, Bas-Chantenay,
  rive sud (Trentemoult – Pirmil), Rezé – Maison radieuse ; ainsi que chacun des quartiers de
  Nantes et de Rezé.
- **Parcours commentés** (panneau *Parcours*) : « Au fil du XVIIIe siècle », « L'île de Nantes, des
  chantiers à la création », « Architectures des XXe et XXIe siècles ». Chaque parcours charge sa
  zone, puis enchaîne les étapes : mouvement de caméra, heure du jour (jusqu'au coucher du
  soleil), commentaire et lien vers la fiche du lieu. Lecture pas à pas ou automatique ; toucher
  la carte met la lecture en pause.
- **Sites remarquables** : 26 fiches (patrimoine, patrimoine industriel, architecture
  contemporaine, parcs, quartiers, projets urbains), chacune illustrée d'une vue de l'atlas.
  Les bâtiments associés ressortent en cuivre dans la maquette. Pour associer d'autres bâtiments
  à un site : sélectionnez-les (Maj + clic), ouvrez la fiche du site, puis *Associer la sélection*.

Les textes des fiches et des parcours sont une **première rédaction, à relire et compléter** :
dates et attributions ont été vérifiées avec soin mais méritent une relecture, notamment pour les
projets en cours (nouveau CHU, Pirmil-les-Isles), dont le calendrier évolue.

L'adresse de la page mémorise la zone : elle peut être mise en favori (`#zone=…&etude`).

### Écrire ou modifier le contenu éditorial

Tout se modifie depuis l'atlas (bouton *Modifier la fiche*) ou directement dans les fichiers :

| Fichier | Contenu |
|---|---|
| `data/poi/index.json` | liste des sites : `id`, `titre`, `etiquette` (nom court sur la carte), `categorie`, `statut` (existant, travaux, projet, abandonne), `position` [lon, lat], `batiments` (identifiants OSM, ex. `w28379422`), `secteur`, `resume`, `vue` (caméra), `hauteur` (m, pour placer la pastille) |
| `data/poi/fiches/<id>.md` | fiche en Markdown, précédée d'un en-tête (`titre`, `architectes`, `maitreOuvrage`, `annee`, `programme`, `surface`, `hauteur`, `adresse`, `liens`, `images`, `sources`) |
| `data/poi/medias/<id>/` | images de la fiche (JPEG, PNG, WebP) |
| `data/editorial/secteurs.json` | secteurs prédéfinis : `cadre` = centre, largeur, hauteur (m), angle (° depuis l'est) |
| `data/editorial/parcours.json` | parcours : `cadre` de la zone, puis `etapes` (`titre`, `texte` en Markdown, `lieu`, `camera` {centre, zoom, pitch, bearing}, `heure` en minutes ou `lever` / `midi` / `coucher`) |

Exemple d'en-tête de fiche :

```
---
titre: Passage Pommeraye
statut: existant
categorie: Patrimoine
architectes: Jean-Baptiste Buron, Hippolyte Durand-Gasselin
annee: 1840-1843
liens:
  - titre: Wikipédia
    url: https://fr.wikipedia.org/wiki/Passage_Pommeraye
images:
  - src: medias/passage-pommeraye/vue-atlas.jpg
    legende: Vue de l'atlas
    credit: Atlas 3D Nantes
---
Texte de la fiche en **Markdown**…
```

## Données

| Donnée | Source | Licence |
|---|---|---|
| Fond de carte | OpenStreetMap via Protomaps (fichiers PMTiles) | ODbL |
| Emprises des bâtiments | OpenStreetMap (extrait OSM France, Loire-Atlantique) | ODbL |
| Hauteurs, dates, usages, logements | IGN BD TOPO (Géoplateforme) | Licence Ouverte 2.0 |
| Normales climatiques, roses des vents | Open-Meteo, archives ERA5 / ERA5-Land (Copernicus) | CC BY 4.0 |
| Météo, qualité de l'air (en ligne) | Open-Meteo (prévisions, CAMS) | CC BY 4.0 |
| Hauteur de la Loire (en ligne) | Hub'Eau — Vigicrues | Licence Ouverte 2.0 |
| Horaires Naolib (GTFS), temps réel (GTFS-RT) | Nantes Métropole / transport.data.gouv.fr | ODbL |
| Fluidité du trafic, parkings | Nantes Métropole — données ouvertes | ODbL |
| Vélos en libre-service | JCDecaux (flux GBFS) | voir le fournisseur |
| Calendrier scolaire | Ministère de l'Éducation nationale | Licence Ouverte 2.0 |
| Quartiers des communes | Nantes Métropole — données ouvertes | ODbL |
| Fiches, secteurs, parcours | Rédaction de l'atlas ; positions et bâtiments OpenStreetMap | textes CC BY-SA 4.0 |

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
data/mobilite/        horaires Naolib (GTFS), tronçons de trafic, parkings, stations vélo
data/enregistrements/ relevés temps réel et profils observés (créés à l'usage)
data/editorial/       quartiers, secteurs prédéfinis, parcours commentés
data/poi/             sites remarquables : index.json, fiches Markdown (fiches/), images (medias/)
data/projets/         projets importés : un dossier par projet (projet.json, modele.glb, source.ifc)
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
node tools/preparer-mobilites.mjs    # GTFS Naolib, trafic, parkings, vélos → data/mobilite
node tools/preparer-editorial.mjs    # quartiers de Nantes Métropole → data/editorial
node tools/capturer-vignettes.mjs    # vues 3D des sites pour les fiches → data/poi/medias
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
