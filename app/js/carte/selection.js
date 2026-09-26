// Outil de sélection de la zone d'étude : cadre orienté, déplaçable,
// redimensionnable par ses coins et ses bords, orientable par une poignée.

import { etat, emit } from '../etat.js';
import {
  polygoneCadre, coinsCadre, masqueExterieur, dansRepereCadre, depuisRepereCadre, versLocal, echelles, emprise,
} from '../lib/geo.js';
import { entier, surface, longueur } from '../ui/format.js';

const MIN = 120;          // côté minimal (m)
const MAX = 6000;         // côté maximal (m)
const SEUIL_ALERTE = 15000;
const SEUIL_DANGER = 30000;

let carte = null;
let cadre = null;
let densite = null;       // grille de densité des bâtiments (data/batiments/index.json)
let glisse = null;        // opération en cours
let actif = false;

const SOURCE = 'selection';

function poignees(c) {
  const coins = coinsCadre(c);
  const milieu = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const rot = depuisRepereCadre(c, [0, c.hauteur / 2 + Math.max(60, c.hauteur * 0.12)]);
  const pts = [
    ['coin', coins[0], [-1, -1]], ['coin', coins[1], [1, -1]], ['coin', coins[2], [1, 1]], ['coin', coins[3], [-1, 1]],
    ['bord', milieu(coins[0], coins[1]), [0, -1]], ['bord', milieu(coins[1], coins[2]), [1, 0]],
    ['bord', milieu(coins[2], coins[3]), [0, 1]], ['bord', milieu(coins[3], coins[0]), [-1, 0]],
    ['rotation', rot, [0, 0]],
  ];
  return pts.map(([role, coordonnees, sens], i) => ({
    type: 'Feature',
    id: i,
    properties: { role, sx: sens[0], sy: sens[1] },
    geometry: { type: 'Point', coordinates: coordonnees },
  }));
}

function donnees() {
  const haut = depuisRepereCadre(cadre, [0, cadre.hauteur / 2]);
  const rot = depuisRepereCadre(cadre, [0, cadre.hauteur / 2 + Math.max(60, cadre.hauteur * 0.12)]);
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { role: 'cadre' }, geometry: polygoneCadre(cadre) },
      { type: 'Feature', properties: { role: 'tige' }, geometry: { type: 'LineString', coordinates: [haut, rot] } },
      ...poignees(cadre),
    ],
  };
}

function dessiner() {
  carte.getSource(SOURCE)?.setData(donnees());
  carte.getSource(`${SOURCE}-masque`)?.setData(masqueExterieur(cadre));
  majCarteInfo();
}

function ajouterCouches() {
  carte.addSource(SOURCE, { type: 'geojson', data: donnees() });
  carte.addSource(`${SOURCE}-masque`, { type: 'geojson', data: masqueExterieur(cadre) });
  carte.addLayer({ id: 'selection-masque', type: 'fill', source: `${SOURCE}-masque`,
    paint: { 'fill-color': '#141822', 'fill-opacity': 0.38 } });
  carte.addLayer({ id: 'selection-fond', type: 'fill', source: SOURCE, filter: ['==', ['get', 'role'], 'cadre'],
    paint: { 'fill-color': '#d2601a', 'fill-opacity': 0.06 } });
  carte.addLayer({ id: 'selection-contour', type: 'line', source: SOURCE, filter: ['==', ['get', 'role'], 'cadre'],
    paint: { 'line-color': '#d2601a', 'line-width': 2.5 } });
  carte.addLayer({ id: 'selection-tige', type: 'line', source: SOURCE, filter: ['==', ['get', 'role'], 'tige'],
    paint: { 'line-color': '#d2601a', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  carte.addLayer({ id: 'selection-poignees', type: 'circle', source: SOURCE, filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['match', ['get', 'role'], 'rotation', 8, 'coin', 7, 5.5],
      'circle-color': ['match', ['get', 'role'], 'rotation', '#d2601a', '#ffffff'],
      'circle-stroke-color': ['match', ['get', 'role'], 'rotation', '#ffffff', '#d2601a'],
      'circle-stroke-width': 2.5,
    } });
}

function afficherCouches(visible) {
  for (const id of ['selection-masque', 'selection-fond', 'selection-contour', 'selection-tige', 'selection-poignees']) {
    if (carte.getLayer(id)) carte.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

// --- Estimation du nombre de bâtiments --------------------------------------------

export function estimerBatiments(c) {
  if (!densite) return null;
  const d = densite;
  const [ouest, sud, est, nord] = emprise(c);
  let n = 0, couvert = 0, total = 0;
  const i0 = Math.max(0, Math.floor((ouest - d.lon0) / d.dlon)), i1 = Math.min(d.nx - 1, Math.floor((est - d.lon0) / d.dlon));
  const j0 = Math.max(0, Math.floor((sud - d.lat0) / d.dlat)), j1 = Math.min(d.ny - 1, Math.floor((nord - d.lat0) / d.dlat));
  const hw = c.largeur / 2, hh = c.hauteur / 2;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const p = [d.lon0 + (i + 0.5) * d.dlon, d.lat0 + (j + 0.5) * d.dlat];
      const [x, y] = dansRepereCadre(c, p);
      if (Math.abs(x) <= hw && Math.abs(y) <= hh) n += d.valeurs[j * d.nx + i];
    }
  }
  // Part du cadre couverte par le pack local (le reste nécessite une connexion).
  const pas = 12;
  for (let a = 0; a < pas; a++) {
    for (let b = 0; b < pas; b++) {
      const p = depuisRepereCadre(c, [(-0.5 + (a + 0.5) / pas) * c.largeur, (-0.5 + (b + 0.5) / pas) * c.hauteur]);
      total++;
      if (p[0] >= d.lon0 && p[0] <= d.lon0 + d.nx * d.dlon && p[1] >= d.lat0 && p[1] <= d.lat0 + d.ny * d.dlat) couvert++;
    }
  }
  return { n, couverture: couvert / total };
}

function majCarteInfo() {
  const aire = cadre.largeur * cadre.hauteur;
  document.getElementById('selection-dimensions').textContent = `${longueur(cadre.largeur)} × ${longueur(cadre.hauteur)}`;
  document.getElementById('selection-surface').textContent = surface(aire);
  const angle = ((cadre.angle % 360) + 360) % 360;
  document.getElementById('selection-angle').textContent = `${Math.round(angle > 180 ? angle - 360 : angle)}°`;
  const est = estimerBatiments(cadre);
  const jauge = document.getElementById('selection-jauge');
  const note = document.getElementById('selection-note');
  const valider = document.getElementById('btn-zone-valider');
  let niveau = 'ok';
  let texte = '';
  if (est) {
    document.getElementById('selection-batiments').textContent = `≈ ${entier(Math.round(est.n / 10) * 10 || est.n)}`;
    if (est.n > SEUIL_DANGER) { niveau = 'danger'; texte = 'Zone très dense : l\'affichage risque d\'être lent. Réduisez le cadre.'; }
    else if (est.n > SEUIL_ALERTE) { niveau = 'alerte'; texte = 'Zone dense : prévoir quelques secondes de chargement.'; }
    if (est.couverture < 0.999) {
      texte = (etat.enLigne
        ? 'Une partie du cadre sort du pack local : ces bâtiments seront téléchargés (OSM + IGN).'
        : 'Une partie du cadre sort du pack local et vous êtes hors ligne : elle restera vide.') + (texte ? ` ${texte}` : '');
      if (!etat.enLigne && niveau === 'ok') niveau = 'alerte';
    }
    jauge.firstElementChild.style.width = `${Math.min(100, (est.n / SEUIL_DANGER) * 100)}%`;
  } else {
    document.getElementById('selection-batiments').textContent = '—';
  }
  jauge.dataset.niveau = niveau;
  note.textContent = texte;
  note.className = `note ${niveau === 'ok' ? '' : niveau}`;
  valider.disabled = false;
}

// --- Interactions -------------------------------------------------------------------

function debutGlisse(e, role, props) {
  e.preventDefault();
  glisse = {
    role,
    sx: props?.sx ?? 0,
    sy: props?.sy ?? 0,
    depart: e.lngLat.toArray(),
    cadre: { ...cadre, centre: [...cadre.centre] },
  };
  carte.dragPan.disable();
  carte.getCanvas().style.cursor = role === 'deplacer' ? 'grabbing' : 'crosshair';
  document.getElementById('selection-secteur').value = '';
}

function surDeplacement(e) {
  if (!glisse) return;
  const p = e.lngLat.toArray();
  const c0 = glisse.cadre;
  if (glisse.role === 'deplacer') {
    const [dx, dy] = versLocal(p, glisse.depart);
    const k = echelles(c0.centre[1]);
    cadre.centre = [c0.centre[0] + dx / k.kx, c0.centre[1] + dy / k.ky];
  } else if (glisse.role === 'rotation') {
    const [x, y] = versLocal(p, c0.centre);
    let a = (Math.atan2(y, x) * 180) / Math.PI - 90;
    const pas = e.originalEvent?.shiftKey ? 15 : 0;
    if (pas) a = Math.round(a / pas) * pas;
    else for (const cible of [-90, 0, 90, 180, -180]) if (Math.abs(a - cible) < 2.5) a = cible;
    cadre.angle = a;
  } else {
    // Redimensionnement : le coin ou le bord opposé reste fixe.
    const [x, y] = dansRepereCadre(c0, p);
    const hw = c0.largeur / 2, hh = c0.hauteur / 2;
    let x0 = -hw, x1 = hw, y0 = -hh, y1 = hh;
    if (glisse.sx < 0) x0 = Math.min(x, hw - MIN);
    if (glisse.sx > 0) x1 = Math.max(x, -hw + MIN);
    if (glisse.sy < 0) y0 = Math.min(y, hh - MIN);
    if (glisse.sy > 0) y1 = Math.max(y, -hh + MIN);
    const largeur = Math.min(MAX, x1 - x0), hauteur = Math.min(MAX, y1 - y0);
    if (glisse.sx < 0) x0 = x1 - largeur; else x1 = x0 + largeur;
    if (glisse.sy < 0) y0 = y1 - hauteur; else y1 = y0 + hauteur;
    cadre.largeur = largeur;
    cadre.hauteur = hauteur;
    cadre.centre = depuisRepereCadre(c0, [(x0 + x1) / 2, (y0 + y1) / 2]);
  }
  dessiner();
}

function finGlisse() {
  if (!glisse) return;
  glisse = null;
  carte.dragPan.enable();
  carte.getCanvas().style.cursor = '';
  emit('cadre', cadre);
}

function installerInteractions() {
  const surPoignee = (e) => {
    if (!actif) return;
    const f = e.features?.[0];
    if (!f) return;
    debutGlisse(e, f.properties.role === 'rotation' ? 'rotation' : 'redimensionner', f.properties);
  };
  const surFond = (e) => {
    if (!actif || glisse) return;
    const surP = carte.queryRenderedFeatures(e.point, { layers: ['selection-poignees'] });
    if (surP.length) return;
    debutGlisse(e, 'deplacer');
  };
  carte.on('mousedown', 'selection-poignees', surPoignee);
  carte.on('touchstart', 'selection-poignees', surPoignee);
  carte.on('mousedown', 'selection-fond', surFond);
  carte.on('touchstart', 'selection-fond', (e) => { if (e.points?.length === 1) surFond(e); });
  carte.on('mousemove', surDeplacement);
  carte.on('touchmove', surDeplacement);
  carte.on('mouseup', finGlisse);
  carte.on('touchend', finGlisse);
  carte.on('mouseenter', 'selection-poignees', () => { if (actif && !glisse) carte.getCanvas().style.cursor = 'pointer'; });
  carte.on('mouseleave', 'selection-poignees', () => { if (!glisse) carte.getCanvas().style.cursor = ''; });
  carte.on('mouseenter', 'selection-fond', () => { if (actif && !glisse) carte.getCanvas().style.cursor = 'grab'; });
  carte.on('mouseleave', 'selection-fond', () => { if (!glisse) carte.getCanvas().style.cursor = ''; });
  window.addEventListener('mouseup', finGlisse);
}

// --- API ------------------------------------------------------------------------------

export function initSelection(map, { cadreInitial, densiteBatiments }) {
  carte = map;
  cadre = { ...cadreInitial };
  densite = densiteBatiments;
  ajouterCouches();
  installerInteractions();
  majCarteInfo();
}

export function activerSelection(nouveauCadre) {
  if (nouveauCadre) cadre = { ...nouveauCadre, centre: [...nouveauCadre.centre] };
  actif = true;
  afficherCouches(true);
  dessiner();
  const [o, s, e, n] = emprise(cadre);
  carte.fitBounds([[o, s], [e, n]], { padding: { top: 110, bottom: 140, left: 110, right: 360 }, pitch: 0, bearing: 0, duration: 900, maxZoom: 16 });
}

export function desactiverSelection() {
  actif = false;
  afficherCouches(false);
}

export function recentrer() {
  const c = carte.getCenter();
  cadre.centre = [c.lng, c.lat];
  dessiner();
}

export function definirCadre(c) {
  cadre = { ...c, centre: [...c.centre] };
  dessiner();
  activerSelection();
}

export const cadreCourant = () => ({ ...cadre, centre: [...cadre.centre] });
export const densiteChargee = () => densite;
