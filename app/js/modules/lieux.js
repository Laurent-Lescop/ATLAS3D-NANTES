// Panneau « Lieux » : sites remarquables et projets.
//   - Sites : data/poi/index.json + fiches Markdown data/poi/fiches/<id>.md.
//   - Projets IFC : data/projets/<id>/{projet.json, modele.glb, source.ifc}.
// Import d'une maquette IFC (conversion dans un travailleur), calage sur la carte,
// bâtiments existants masqués en mode « avec les projets ».

/* global deck */
import { etat, emit, on, lirePreference, ecrirePreference } from '../etat.js';
import { lireJSON, enregistrerFichier, listerFichiers, supprimerFichier } from '../api.js';
import { enregistrerPanneau, rafraichirPanneau, fermerFiche, ouvrirFiche as ouvrirPanneauDroit } from '../ui/panneaux.js';
import { definirCouches, surSurvol, surClic } from '../carte/rendu3d.js';
import { definirEmblemes, definirMasques, batimentParId } from '../carte/batiments3d.js';
import { obtenirCarte } from '../carte/fond.js';
import { afficherInfobulle } from '../ui/infobulle.js';
import { notifier, progression } from '../ui/notifications.js';
import { html, echapper, entier } from '../ui/format.js';
import { afficherFiche, resumeProjet, STATUTS } from './fiches.js';
import { lireFiche, ecrireFiche } from '../lib/fiche-md.js';
import { ecrireGlb, lireGlb } from '../lib/glb.js';
import { placementIfc, empreinte, versCarte } from '../lib/georef.js';
import { emprise } from '../lib/geo.js';
import { pointInPolygon } from '../lib/batiments-core.js';

const EMBLEME = [222, 124, 62];
const PROJET = [47, 127, 209];

let sites = [];
let projets = [];
let avecProjets = lirePreference('avecProjets', true);
let filtre = lirePreference('filtreLieux', 'tous');
let enCalage = null;      // projet en cours de calage
let placementArme = null; // fonction appelée au prochain clic sur la carte
let majCalage = null;     // met à jour le panneau de calage

// --- Chargement -------------------------------------------------------------------------------

async function chargerSites() {
  try {
    sites = (await lireJSON('/data/poi/index.json')).lieux || [];
  } catch {
    sites = [];
  }
}

async function chargerProjet(id) {
  const p = await lireJSON(`/data/projets/${encodeURIComponent(id)}/projet.json`);
  const glb = await fetch(`/data/projets/${encodeURIComponent(id)}/modele.glb`);
  if (!glb.ok) throw new Error('maquette absente');
  p.maillage = lireGlb(await glb.arrayBuffer());
  return p;
}

async function chargerProjets() {
  const dossiers = (await listerFichiers('projets')).filter((f) => f.dossier);
  const res = await Promise.allSettled(dossiers.map((d) => chargerProjet(d.nom)));
  projets = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// --- Couches 3D ----------------------------------------------------------------------------------

function hauteurSite(s) {
  if (s.hauteur) return s.hauteur;
  const h = (s.batiments || []).map((id) => batimentParId(id)?.properties.h).filter(Boolean);
  return h.length ? Math.max(...h) : 18;
}

function dansZone([lon, lat], marge = 400) {
  if (!etat.zone) return false;
  const [o, s, e, n] = emprise(etat.zone.rect, marge);
  return lon >= o && lon <= e && lat >= s && lat <= n;
}

function sitesVisibles() {
  return sites.filter((s) => dansZone(s.position) && (filtre === 'tous' || s.categorie === filtre || s.statut === filtre));
}

function projetsVisibles() {
  return avecProjets ? projets.filter((p) => dansZone([p.placement.lon, p.placement.lat], 1500)) : [];
}

function mesh(p) {
  const m = p.maillage;
  return {
    attributes: {
      positions: { value: m.positions, size: 3 },
      normals: { value: m.normales, size: 3 },
      colors: { value: m.couleurs, size: 3 },
    },
    indices: { value: m.indices, size: 1 },
  };
}

function dessiner() {
  if (etat.mode !== 'etude') {
    definirCouches('projets', []);
    definirCouches('etiquettes', []);
    return;
  }
  const vp = projetsVisibles();
  const couchesProjets = vp.map((p) => new deck.SimpleMeshLayer({
    id: `projet-${p.id}`,
    data: [p],
    mesh: p.meshDeck ??= mesh(p),
    getPosition: (d) => [d.placement.lon, d.placement.lat, d.placement.alt || 0],
    getOrientation: (d) => [0, d.placement.rotation, 0], // maillage en Est-Nord-Haut
    getScale: (d) => [d.placement.echelle || 1, d.placement.echelle || 1, d.placement.echelle || 1],
    getColor: [255, 255, 255, 255],
    material: { ambient: 0.55, diffuse: 0.6, shininess: 18, specularColor: [40, 40, 44] },
    pickable: true,
    updateTriggers: { getPosition: JSON.stringify(p.placement), getOrientation: p.placement.rotation, getScale: p.placement.echelle },
  }));
  if (enCalage) {
    couchesProjets.push(new deck.PathLayer({
      id: 'projet-empreinte', data: [enCalage],
      getPath: (p) => empreinte(p.maillage.positions, p.placement).map(([x, y]) => [x, y, 0.6]),
      getColor: [...PROJET, 255], getWidth: 3, widthUnits: 'pixels', shadowEnabled: false,
      updateTriggers: { getPath: JSON.stringify(enCalage.placement) },
    }));
  }
  definirCouches('projets', couchesProjets);

  const vs = sitesVisibles();
  const marques = [
    ...vs.map((s) => ({ type: 'site', ref: s, titre: s.titre, p: [...s.position, hauteurSite(s) + 6], couleur: s.statut === 'projet' ? PROJET : EMBLEME })),
    ...vp.map((p) => ({
      type: 'projet', ref: p, titre: p.fiche?.titre || p.id,
      p: [p.placement.lon, p.placement.lat, (p.placement.alt || 0) + (p.dimensions?.[2] || 20) * (p.placement.echelle || 1) + 6], couleur: PROJET,
    })),
  ];
  definirCouches('etiquettes', etat.reglages.etiquettesLieux === false ? [] : [
    new deck.ScatterplotLayer({
      id: 'lieux-pastilles', data: marques, getPosition: (d) => d.p, getRadius: 6, radiusUnits: 'pixels',
      getFillColor: (d) => d.couleur, stroked: true, getLineColor: [255, 255, 255], getLineWidth: 2, lineWidthUnits: 'pixels',
      billboard: true, pickable: true, shadowEnabled: false, parameters: { depthCompare: 'always', depthWriteEnabled: false },
    }),
    new deck.TextLayer({
      id: 'lieux-noms', data: marques, getPosition: (d) => d.p, getText: (d) => d.titre, getSize: 12.5,
      getColor: [27, 33, 48, 255], background: true, getBackgroundColor: [255, 255, 255, 230], backgroundPadding: [6, 3],
      getPixelOffset: [0, -16], fontFamily: 'system-ui, sans-serif', fontWeight: 600, characterSet: 'auto',
      pickable: true, shadowEnabled: false, parameters: { depthCompare: 'always', depthWriteEnabled: false },
      maxWidth: 14, wordBreak: 'break-word',
    }),
  ]);
}

function majEmblemesEtMasques() {
  const emblemes = new Map();
  for (const s of sites) {
    for (const id of s.batiments || []) emblemes.set(id, { couleur: s.statut === 'projet' ? PROJET : EMBLEME, nom: s.titre });
  }
  definirEmblemes(emblemes);
  definirMasques(avecProjets ? projets.flatMap((p) => p.masquer || []) : []);
}

// --- Fiches ----------------------------------------------------------------------------------------

function voirEn3D(vue, position, distance = 400) {
  const carte = obtenirCarte();
  if (vue) carte.flyTo({ center: vue.centre, zoom: vue.zoom, pitch: vue.pitch ?? 60, bearing: vue.bearing ?? carte.getBearing(), duration: 1800 });
  else carte.flyTo({ center: position, zoom: Math.max(16, 18.5 - Math.log2(distance / 60)), pitch: 60, duration: 1800 });
}

export async function ouvrirSite(s) {
  let fiche = { titre: s.titre, statut: s.statut, categorie: s.categorie };
  let corps = '';
  try {
    const r = await fetch(`/data/poi/fiches/${encodeURIComponent(s.id)}.md`);
    if (r.ok) {
      const { meta, corps: c } = lireFiche(await r.text());
      fiche = { ...fiche, ...meta };
      corps = c;
    }
  } catch { /* fiche absente : on affiche le minimum */ }
  const lieu = { id: s.id, type: 'site', titre: fiche.titre, statut: fiche.statut, categorie: fiche.categorie, fiche: { ...fiche, texte: corps } };
  afficherFiche(lieu, {
    base: '/data/poi/',
    dossierMedias: `poi/medias/${s.id}`,
    prefixeMedias: `medias/${s.id}/`,
    voir3d: () => voirEn3D(s.vue, s.position),
    enregistrer: async (meta, texte) => {
      await enregistrerFichier(`poi/fiches/${s.id}.md`, ecrireFiche(meta, texte), 'text/markdown');
      Object.assign(s, { titre: meta.titre, statut: meta.statut, categorie: meta.categorie });
      await enregistrerIndex();
      dessiner();
      rafraichirPanneau('lieux');
      ouvrirSite(s);
    },
    actions: [{ libelle: 'Supprimer ce lieu', fn: () => supprimerSite(s) }],
  });
}

function ouvrirProjet(p) {
  const fiche = p.fiche || {};
  afficherFiche({ id: p.id, type: 'projet', titre: fiche.titre || p.id, statut: fiche.statut || 'projet', categorie: fiche.categorie || 'Projet', fiche, donnees: resumeProjet(p) }, {
    base: `/data/projets/${p.id}/`,
    dossierMedias: `projets/${p.id}/medias`,
    prefixeMedias: 'medias/',
    voir3d: () => voirEn3D(null, [p.placement.lon, p.placement.lat], Math.max(...(p.dimensions || [80]))),
    enregistrer: async (meta, texte) => {
      p.fiche = { ...meta, texte };
      await sauverProjet(p);
      dessiner();
      rafraichirPanneau('lieux');
      ouvrirProjet(p);
    },
    actions: [
      { libelle: 'Caler la maquette', fn: () => caler(p) },
      { libelle: 'Supprimer le projet', fn: () => supprimerProjet(p) },
    ],
  });
}

async function enregistrerIndex() {
  const propres = sites.map(({ id, titre, categorie, statut, position, batiments, secteur, resume, vue, hauteur }) =>
    ({ id, titre, categorie, statut, position, batiments, secteur, resume, vue, hauteur }));
  await enregistrerFichier('poi/index.json', JSON.stringify({ version: 1, lieux: propres }, null, 1), 'application/json');
}

async function supprimerSite(s) {
  if (!confirm(`Supprimer « ${s.titre} » ? La fiche sera effacée.`)) return;
  sites = sites.filter((x) => x !== s);
  await enregistrerIndex();
  await supprimerFichier(`poi/fiches/${s.id}.md`).catch(() => {});
  fermerFiche();
  majEmblemesEtMasques();
  dessiner();
  rafraichirPanneau('lieux');
}

async function supprimerProjet(p) {
  if (!confirm(`Supprimer le projet « ${p.fiche?.titre || p.id} » et sa maquette ?`)) return;
  await supprimerFichier(`projets/${p.id}`);
  projets = projets.filter((x) => x !== p);
  fermerFiche();
  majEmblemesEtMasques();
  dessiner();
  rafraichirPanneau('lieux');
}

// --- Projets IFC -----------------------------------------------------------------------------------

function sansMaillage(p) {
  const { maillage, meshDeck, ...reste } = p;
  void maillage; void meshDeck;
  return reste;
}

async function sauverProjet(p) {
  await enregistrerFichier(`projets/${p.id}/projet.json`, JSON.stringify(sansMaillage(p), null, 1), 'application/json');
}

// Bâtiments existants dont le point intérieur tombe dans l'emprise du projet.
function batimentsRemplaces(p) {
  if (!etat.zone) return p.masquer || [];
  const anneau = empreinte(p.maillage.positions, p.placement);
  const poly = { type: 'Polygon', coordinates: [anneau] };
  return etat.zone.batiments.filter((b) => pointInPolygon(b.properties.c[0], b.properties.c[1], poly)).map((b) => b.properties.id);
}

let travailleur = null;
function convertirIfc(octets, options, progres) {
  travailleur ??= new Worker(new URL('../travailleurs/ifc.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const ecoute = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progres != null) { progres(e.data.progres); return; }
      travailleur.removeEventListener('message', ecoute);
      if (e.data.erreur) reject(new Error(e.data.erreur)); else resolve(e.data.resultat);
    };
    travailleur.addEventListener('message', ecoute);
    travailleur.postMessage({ id, octets, options });
  });
}

function identifiant(nom) {
  const base = nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\.ifc$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projet';
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

export async function importerIfc(fichier) {
  if (etat.mode !== 'etude') {
    notifier('Validez d\'abord une zone d\'étude, puis importez la maquette.', { type: 'erreur' });
    return;
  }
  const niveau = lirePreference('niveauDetailIfc', 'enveloppe');
  const barre = progression(`Lecture de ${fichier.name}…`);
  try {
    const octets = await fichier.arrayBuffer();
    const copie = octets.slice(0);
    const r = await convertirIfc(octets, { niveauDetail: niveau }, (f) => barre.maj(`Conversion de la maquette… ${Math.round(f * 100)} %`));
    const placement = placementIfc(r.infos, r.centre, etat.zone.rect.centre);
    const id = identifiant(r.infos.projet || fichier.name);
    const p = {
      id, version: 1, nomIfc: fichier.name, importe: new Date().toISOString(), niveauDetail: niveau,
      placement, centreIfc: r.centre, dimensions: r.dimensions, classes: r.classes, infos: r.infos,
      fiche: { titre: r.infos.projet || fichier.name.replace(/\.ifc$/i, ''), statut: 'projet', categorie: 'Projet', texte: '' },
      maillage: { positions: r.positions, normales: r.normales, couleurs: r.couleurs, indices: r.indices },
    };
    p.masquer = batimentsRemplaces(p);
    barre.maj('Enregistrement de la maquette…');
    await enregistrerFichier(`projets/${id}/source.ifc`, copie, 'application/octet-stream');
    await enregistrerFichier(`projets/${id}/modele.glb`, ecrireGlb(p.maillage, { nom: p.fiche.titre, source: fichier.name }), 'model/gltf-binary');
    await sauverProjet(p);
    projets.push(p);
    avecProjets = true;
    majEmblemesEtMasques();
    dessiner();
    rafraichirPanneau('lieux');
    notifier(`${fichier.name} importé : ${entier(r.infos.triangles)} triangles, ${Object.values(r.classes).reduce((a, b) => a + b, 0)} éléments. ${placement.note}`, { duree: 8000 });
    voirEn3D(null, [placement.lon, placement.lat], Math.max(...r.dimensions));
    if (placement.mode === 'ifc') ouvrirProjet(p); else caler(p);
  } catch (err) {
    console.error(err);
    notifier(`Import impossible : ${err.message}`, { type: 'erreur', duree: 8000 });
  } finally {
    barre.fin();
  }
}

// --- Calage ------------------------------------------------------------------------------------------

function caler(p) {
  enCalage = p;
  const initial = { ...p.placement };
  dessiner();
  ouvrirPanneauDroit(`Caler : ${p.fiche?.titre || p.id}`, (c) => {
    const el = html(`<div>
      <p class="aide">${echapper(p.placement.note || '')}</p>
      <p class="aide">Déplacez la maquette par clic sur la carte, puis ajustez l'orientation. Clavier : flèches (1 m, Maj : 10 m),
        Page préc. / Page suiv. (rotation 1°, Maj : 5°).</p>
      <button class="bouton" data-action="placer"><svg><use href="#i-cible"/></svg><span>Placer par un clic sur la carte</span></button>
      <label class="champ"><span>Orientation (° depuis l'est, sens trigonométrique)</span>
        <input type="range" min="-180" max="180" step="0.5" name="rotation" value="${p.placement.rotation}">
        <input type="number" step="0.1" name="rotationN" value="${p.placement.rotation.toFixed(1)}"></label>
      <label class="champ"><span>Altitude de la base (m)</span><input type="number" step="0.1" name="alt" value="${(p.placement.alt || 0).toFixed(1)}"></label>
      <label class="champ"><span>Échelle</span><input type="number" step="0.001" min="0.001" name="echelle" value="${p.placement.echelle || 1}"></label>
      <p class="note" data-info></p>
      <div class="boutons-fiche">
        <button class="bouton principal" data-action="enregistrer">Enregistrer le calage</button>
        <button class="bouton" data-action="annuler">Annuler</button>
      </div>
    </div>`);
    const info = el.querySelector('[data-info]');
    const maj = () => {
      info.textContent = `Position : ${p.placement.lat.toFixed(6)}, ${p.placement.lon.toFixed(6)} — rotation ${p.placement.rotation.toFixed(1)}°`;
      el.querySelector('[name="rotation"]').value = p.placement.rotation;
      el.querySelector('[name="rotationN"]').value = p.placement.rotation.toFixed(1);
      dessiner();
    };
    majCalage = maj;
    el.querySelector('[name="rotation"]').addEventListener('input', (e) => { p.placement.rotation = +e.target.value; maj(); });
    el.querySelector('[name="rotationN"]').addEventListener('change', (e) => { p.placement.rotation = +e.target.value; maj(); });
    el.querySelector('[name="alt"]').addEventListener('change', (e) => { p.placement.alt = +e.target.value; maj(); });
    el.querySelector('[name="echelle"]').addEventListener('change', (e) => { p.placement.echelle = Math.max(0.001, +e.target.value); maj(); });
    el.querySelector('[data-action="placer"]').addEventListener('click', () => {
      notifier('Cliquez sur la carte à l\'emplacement du centre de la maquette.');
      placementArme = (lngLat) => { p.placement.lon = lngLat.lng; p.placement.lat = lngLat.lat; p.placement.mode = 'manuel'; maj(); };
    });
    el.querySelector('[data-action="enregistrer"]').addEventListener('click', async () => {
      p.placement.note = p.placement.mode === 'ifc' && JSON.stringify(initial) === JSON.stringify(p.placement)
        ? p.placement.note : 'Calage manuel dans l\'atlas.';
      if (JSON.stringify(initial) !== JSON.stringify(p.placement)) p.placement.mode = 'manuel';
      p.masquer = batimentsRemplaces(p);
      await sauverProjet(p);
      enCalage = null;
      majEmblemesEtMasques();
      dessiner();
      notifier(`Calage enregistré. ${p.masquer.length} bâtiment(s) existant(s) masqué(s) en mode « avec les projets ».`);
      ouvrirProjet(p);
    });
    el.querySelector('[data-action="annuler"]').addEventListener('click', () => {
      p.placement = initial;
      enCalage = null;
      dessiner();
      ouvrirProjet(p);
    });
    maj();
    c.appendChild(el);
  }, { quitter: () => { enCalage = null; placementArme = null; majCalage = null; dessiner(); } });
}

function clavierCalage(e) {
  if (!enCalage || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const pas = e.shiftKey ? 10 : 1;
  const p = enCalage.placement;
  const deplacer = (dx, dy) => { [p.lon, p.lat] = versCarte({ ...p, rotation: 0, echelle: 1 }, [dx, dy]); };
  switch (e.key) {
    case 'ArrowLeft': deplacer(-pas, 0); break;
    case 'ArrowRight': deplacer(pas, 0); break;
    case 'ArrowUp': deplacer(0, pas); break;
    case 'ArrowDown': deplacer(0, -pas); break;
    case 'PageUp': p.rotation += e.shiftKey ? 5 : 1; break;
    case 'PageDown': p.rotation -= e.shiftKey ? 5 : 1; break;
    default: return;
  }
  e.preventDefault();
  p.rotation = ((p.rotation + 540) % 360) - 180;
  p.mode = 'manuel';
  majCalage?.();
  dessiner();
}

// --- Ajout d'un lieu sans maquette ------------------------------------------------------------------

function ajouterLieu() {
  notifier('Cliquez sur la carte à l\'emplacement du lieu ou du projet.');
  placementArme = async (lngLat) => {
    const titre = prompt('Nom du lieu ou du projet :');
    if (!titre) return;
    const s = {
      id: identifiant(titre), titre, categorie: 'Projet', statut: 'projet', position: [lngLat.lng, lngLat.lat],
      batiments: [], secteur: null,
    };
    sites.push(s);
    await enregistrerIndex();
    await enregistrerFichier(`poi/fiches/${s.id}.md`, ecrireFiche({ titre, statut: 'projet', categorie: 'Projet' }, ''), 'text/markdown');
    dessiner();
    rafraichirPanneau('lieux');
    ouvrirSite(s);
  };
}

// --- Panneau ---------------------------------------------------------------------------------------

function rendre(conteneur) {
  const cats = [...new Set(sites.map((s) => s.categorie).filter(Boolean))].sort();
  const vs = etat.mode === 'etude' ? sitesVisibles() : sites.filter((s) => filtre === 'tous' || s.categorie === filtre || s.statut === filtre);
  const parCat = new Map();
  for (const s of vs) {
    if (!parCat.has(s.categorie || 'Autres')) parCat.set(s.categorie || 'Autres', []);
    parCat.get(s.categorie || 'Autres').push(s);
  }
  const el = html(`<div>
    <div class="section">
      <div class="segments" id="lieux-mode">
        <button data-v="actuel" class="${avecProjets ? '' : 'actif'}">État actuel</button>
        <button data-v="projets" class="${avecProjets ? 'actif' : ''}">Avec les projets</button>
      </div>
      <p class="note">« Avec les projets » affiche les maquettes et masque les bâtiments existants qu'elles remplacent.</p>
    </div>
    <div class="section">
      <h3>Projets (maquettes IFC)</h3>
      <ul class="liste-lieux">${projets.map((p, i) => `<li><button data-projet="${i}"><span class="pastille" style="background:rgb(${PROJET})"></span>
        <span>${echapper(p.fiche?.titre || p.id)}<small>${echapper(STATUTS[p.fiche?.statut] || 'Projet')} · ${echapper(p.nomIfc || '')}</small></span></button></li>`).join('')
        || '<li class="aide">Aucune maquette pour l\'instant.</li>'}</ul>
      <label class="bouton principal" style="margin-top:8px">Importer une maquette IFC<input type="file" accept=".ifc" hidden id="lieux-ifc"></label>
      <label class="champ"><span>Niveau de détail à l'import</span><select id="lieux-detail">
        <option value="enveloppe">Enveloppe et structure (recommandé)</option>
        <option value="detaille">Détaillé (mobilier et équipements compris)</option></select></label>
      <p class="note">Vous pouvez aussi glisser-déposer un fichier .ifc sur la carte. La conversion se fait dans le navigateur ;
        la maquette, son fichier IFC et sa fiche sont enregistrés dans data/projets.</p>
    </div>
    <div class="section">
      <h3>Sites et projets sans maquette</h3>
      <div class="segments" id="lieux-filtre">
        <button data-v="tous" class="${filtre === 'tous' ? 'actif' : ''}">Tous</button>
        ${cats.map((c) => `<button data-v="${echapper(c)}" class="${filtre === c ? 'actif' : ''}">${echapper(c)}</button>`).join('')}
        <button data-v="projet" class="${filtre === 'projet' ? 'actif' : ''}">Projets</button>
      </div>
      ${[...parCat.entries()].map(([cat, liste]) => `<h4 class="sous-titre">${echapper(cat)}</h4><ul class="liste-lieux">${liste.map((s) =>
        `<li><button data-site="${echapper(s.id)}"><span class="pastille" style="background:rgb(${s.statut === 'projet' ? PROJET : EMBLEME})"></span>
          <span>${echapper(s.titre)}<small>${echapper(s.resume || STATUTS[s.statut] || '')}</small></span></button></li>`).join('')}</ul>`).join('')
        || `<p class="aide">${etat.mode === 'etude' ? 'Aucun site dans cette zone.' : 'Aucun site.'}</p>`}
      <button class="bouton" id="lieux-ajouter" style="margin-top:8px">Ajouter un lieu ou un projet</button>
    </div>
  </div>`);
  el.querySelector('#lieux-detail').value = lirePreference('niveauDetailIfc', 'enveloppe');
  el.querySelector('#lieux-detail').addEventListener('change', (e) => ecrirePreference('niveauDetailIfc', e.target.value));
  el.querySelector('#lieux-ifc').addEventListener('change', (e) => { if (e.target.files[0]) importerIfc(e.target.files[0]); });
  el.querySelector('#lieux-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    avecProjets = b.dataset.v === 'projets';
    ecrirePreference('avecProjets', avecProjets);
    majEmblemesEtMasques();
    dessiner();
    rafraichirPanneau('lieux');
  });
  el.querySelector('#lieux-filtre').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filtre = b.dataset.v;
    ecrirePreference('filtreLieux', filtre);
    dessiner();
    rafraichirPanneau('lieux');
  });
  el.querySelectorAll('[data-projet]').forEach((b) => b.addEventListener('click', () => {
    const p = projets[+b.dataset.projet];
    ouvrirProjet(p);
    voirEn3D(null, [p.placement.lon, p.placement.lat], Math.max(...(p.dimensions || [80])));
  }));
  el.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => {
    const s = sites.find((x) => x.id === b.dataset.site);
    ouvrirSite(s);
    voirEn3D(s.vue, s.position);
  }));
  el.querySelector('#lieux-ajouter').addEventListener('click', () => {
    if (etat.mode !== 'etude') { notifier('Validez d\'abord une zone d\'étude.'); return; }
    ajouterLieu();
  });
  conteneur.appendChild(el);
}

// --- Interactions carte ------------------------------------------------------------------------------

function survol(info) {
  const id = info.layer?.id;
  if (!info.object || !id) return;
  if (id === 'lieux-pastilles' || id === 'lieux-noms') {
    const d = info.object;
    afficherInfobulle(info.x, info.y, `<h4>${echapper(d.titre)}</h4><div class="indice">${d.type === 'projet' ? 'Projet (maquette IFC)' : echapper(d.ref.categorie || '')} — cliquez pour ouvrir la fiche</div>`);
  } else if (id.startsWith('projet-') && id !== 'projet-empreinte') {
    const p = info.object;
    afficherInfobulle(info.x, info.y, `<h4>${echapper(p.fiche?.titre || p.id)}</h4><div class="indice">Maquette IFC — cliquez pour ouvrir la fiche</div>`);
  }
}

function clic(info) {
  const id = info.layer?.id;
  if (!info.object || !id) return;
  if (id === 'lieux-pastilles' || id === 'lieux-noms') {
    if (info.object.type === 'projet') ouvrirProjet(info.object.ref); else ouvrirSite(info.object.ref);
  } else if (id.startsWith('projet-') && id !== 'projet-empreinte' && !enCalage) {
    ouvrirProjet(info.object);
  }
}

export async function initLieux() {
  await Promise.all([chargerSites(), chargerProjets()]);
  enregistrerPanneau('lieux', { titre: 'Sites et projets', rendre });
  surSurvol(survol);
  surClic(clic);
  on('zone', () => { majEmblemesEtMasques(); dessiner(); rafraichirPanneau('lieux'); });
  on('mode', dessiner);
  on('reglages', dessiner);
  obtenirCarte().on('click', (e) => {
    if (!placementArme) return;
    const f = placementArme;
    placementArme = null;
    f(e.lngLat);
  });
  document.addEventListener('keydown', clavierCalage);
  // Glisser-déposer d'un fichier IFC sur la fenêtre.
  document.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.ifc$/i.test(x.name));
    if (!f) return;
    e.preventDefault();
    importerIfc(f);
  });
  majEmblemesEtMasques();
  emit('lieux', { sites, projets });
}

export const listeSites = () => sites;
