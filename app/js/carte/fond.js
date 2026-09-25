// Carte de base MapLibre : tuiles vectorielles locales (PMTiles), styles jour / nuit
// mélangés selon la hauteur du soleil, bâtiments de contexte.

import * as maplibregl from '../../vendor/maplibre-gl/maplibre-gl.mjs';
import { lireJSON } from '../api.js';
import { melangerValeurStyle } from '../lib/couleurs.js';

export { maplibregl };

const ORIGINE = location.origin;

// Protocole « atlas:// » : sert chaque tuile depuis l'archive la plus adaptée
// (Nantes Métropole en détail, Grand Ouest pour les petites échelles).
function installerProtocole() {
  const metropole = new pmtiles.PMTiles(`${ORIGINE}/data/fond/nantes-metropole.pmtiles`);
  const region = new pmtiles.PMTiles(`${ORIGINE}/data/fond/grand-ouest.pmtiles`);
  maplibregl.addProtocol('atlas', async (params, abort) => {
    const m = params.url.match(/(\d+)\/(\d+)\/(\d+)$/);
    const [z, x, y] = m.slice(1).map(Number);
    const ordre = z <= 8 ? [region, metropole] : [metropole];
    for (const archive of ordre) {
      try {
        const t = await archive.getZxy(z, x, y, abort.signal);
        if (t?.data) return { data: new Uint8Array(t.data) };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return { data: new Uint8Array(0) };
  });
}

function preparerStyle(style) {
  return {
    ...style,
    glyphs: `${ORIGINE}/data/fond/${style.glyphs}`,
    sprite: `${ORIGINE}/data/fond/${style.sprite}`,
    sources: {
      protomaps: {
        type: 'vector',
        tiles: ['atlas://fond/{z}/{x}/{y}'],
        minzoom: 0,
        maxzoom: 15,
        attribution: '<a href="https://www.openstreetmap.org/copyright">© contributeurs OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a> · IGN BD TOPO',
      },
    },
  };
}

let carte = null;
let styleJour = null;
let styleNuit = null;
let melangeActuel = 0;
const palette = []; // { couche, prop, jour, nuit }

// Recense les propriétés de couleur qui diffèrent entre les deux styles.
function construirePalette() {
  const nuitParId = new Map(styleNuit.layers.map((l) => [l.id, l]));
  for (const l of styleJour.layers) {
    const n = nuitParId.get(l.id);
    if (!n || !l.paint) continue;
    for (const [prop, val] of Object.entries(l.paint)) {
      if (!/color/.test(prop)) continue;
      const vn = n.paint?.[prop];
      if (vn === undefined || JSON.stringify(vn) === JSON.stringify(val)) continue;
      palette.push({ couche: l.id, prop, jour: val, nuit: vn });
    }
  }
}

// Applique un mélange jour (0) → nuit (1) aux couleurs du fond.
export function appliquerAmbiance(t) {
  if (!carte || Math.abs(t - melangeActuel) < 0.015) return;
  melangeActuel = t;
  for (const p of palette) {
    if (!carte.getLayer(p.couche)) continue;
    carte.setPaintProperty(p.couche, p.prop, t <= 0.001 ? p.jour : t >= 0.999 ? p.nuit : melangerValeurStyle(p.jour, p.nuit, t));
  }
}

export async function creerCarte(conteneur, { centre, zoom }) {
  installerProtocole();
  [styleJour, styleNuit] = await Promise.all([
    lireJSON('/data/fond/style-jour.json'),
    lireJSON('/data/fond/style-nuit.json'),
  ]);
  construirePalette();

  carte = new maplibregl.Map({
    container: conteneur,
    style: preparerStyle(styleJour),
    center: centre,
    zoom,
    pitch: 0,
    maxPitch: 78,
    minZoom: 6,
    maxZoom: 19.5,
    maxBounds: [[-6.5, 44.8], [2.5, 49.8]],
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
    fadeDuration: 150,
  });
  carte.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  carte.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  await new Promise((resolve, reject) => {
    carte.once('load', resolve);
    carte.once('error', (e) => reject(e.error || e));
  });
  ajouterContexte3D();
  return carte;
}

// Bâtiments du fond de carte extrudés en gris léger (contexte hors zone).
function ajouterContexte3D() {
  const avant = carte.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  carte.addLayer({
    id: 'contexte-3d',
    type: 'fill-extrusion',
    source: 'protomaps',
    'source-layer': 'buildings',
    minzoom: 13,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': '#d9d5cc',
      'fill-extrusion-height': ['coalesce', ['get', 'height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
      'fill-extrusion-opacity': 0.55,
    },
  }, avant);
}

export function afficherContexte3D(visible) {
  if (carte?.getLayer('contexte-3d')) carte.setLayoutProperty('contexte-3d', 'visibility', visible ? 'visible' : 'none');
}

// Pictogrammes des commerces et services, et flèches de sens unique.
const CALQUES_PICTOS = ['pois', 'roads_oneway'];

export function afficherEtiquettes(visible) {
  for (const l of carte.getStyle().layers) {
    if (l.type === 'symbol' && l.source === 'protomaps' && !CALQUES_PICTOS.includes(l.id)) {
      carte.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

export function afficherPictogrammes(visible) {
  for (const id of CALQUES_PICTOS) {
    if (carte.getLayer(id)) carte.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

// Premier calque d'étiquettes du fond (pour insérer des couches en dessous).
export function premierCalqueEtiquettes() {
  return carte.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

export const obtenirCarte = () => carte;
