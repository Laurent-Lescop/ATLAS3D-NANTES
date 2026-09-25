// Quartiers de Nantes et des communes voisines (Nantes Métropole, ODbL) :
// contours et noms sur le fond de carte, quartier d'un point, répartition d'une zone.

import { etat, on } from '../etat.js';
import { lireJSON } from '../api.js';
import { obtenirCarte, premierCalqueEtiquettes } from '../carte/fond.js';
import { pointInPolygon, bboxOf } from '../lib/batiments-core.js';

let quartiers = [];

export const listeQuartiers = () => quartiers;

export function quartierDe([lon, lat]) {
  for (const q of quartiers) {
    const [o, s, e, n] = q.bbox;
    if (lon < o || lon > e || lat < s || lat > n) continue;
    if (pointInPolygon(lon, lat, q.geometry)) return q.properties;
  }
  return null;
}

// Part des bâtiments de la zone dans chaque quartier, par ordre décroissant.
export function repartitionZone(zone) {
  const n = new Map();
  for (const b of zone.batiments) {
    const q = quartierDe(b.properties.c);
    const cle = q ? `${q.nom}|${q.commune}` : '|';
    n.set(cle, (n.get(cle) || 0) + 1);
  }
  const total = zone.batiments.length || 1;
  return [...n.entries()].map(([cle, v]) => {
    const [nom, commune] = cle.split('|');
    return { nom: nom || 'Hors quartiers référencés', commune, part: v / total };
  }).sort((a, b) => b.part - a.part);
}

function couleurs() {
  const nuit = document.body.dataset.ambiance === 'nuit';
  return { trait: nuit ? '#9aa6bd' : '#5b6477', texte: nuit ? '#c9d1de' : '#4a5263', halo: nuit ? '#141822' : '#fbfaf7' };
}

function ajouterCouches() {
  const carte = obtenirCarte();
  if (carte.getSource('quartiers')) return;
  const c = couleurs();
  carte.addSource('quartiers', { type: 'geojson', data: { type: 'FeatureCollection', features: quartiers } });
  carte.addSource('quartiers-etiquettes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: quartiers.map((q) => ({ type: 'Feature', properties: q.properties, geometry: { type: 'Point', coordinates: q.properties.etiquette } })) },
  });
  const avant = premierCalqueEtiquettes();
  carte.addLayer({
    id: 'quartiers-contour', type: 'line', source: 'quartiers', minzoom: 10,
    paint: { 'line-color': c.trait, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 15, 1.6], 'line-dasharray': [4, 3], 'line-opacity': 0.55 },
  }, avant);
  carte.addLayer({
    id: 'quartiers-noms', type: 'symbol', source: 'quartiers-etiquettes', minzoom: 11, maxzoom: 15.5,
    layout: {
      'text-field': ['upcase', ['get', 'nom']], 'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 14, 13], 'text-letter-spacing': 0.14,
      'text-max-width': 9, 'text-allow-overlap': false, 'symbol-sort-key': ['-', 0, ['get', 'surface']],
    },
    paint: { 'text-color': c.texte, 'text-halo-color': c.halo, 'text-halo-width': 1.6, 'text-opacity': 0.85 },
  });
}

function appliquer() {
  const carte = obtenirCarte();
  if (!carte?.getLayer('quartiers-contour')) return;
  const v = etat.reglages.quartiers !== false ? 'visible' : 'none';
  for (const id of ['quartiers-contour', 'quartiers-noms']) carte.setLayoutProperty(id, 'visibility', v);
  // En mode étude, les noms laissent la place aux lieux et aux étiquettes de la zone.
  carte.setLayoutProperty('quartiers-noms', 'visibility', v === 'visible' && etat.mode !== 'etude' ? 'visible' : 'none');
  const c = couleurs();
  carte.setPaintProperty('quartiers-contour', 'line-color', c.trait);
  carte.setPaintProperty('quartiers-noms', 'text-color', c.texte);
  carte.setPaintProperty('quartiers-noms', 'text-halo-color', c.halo);
}

export async function initQuartiers() {
  try {
    const fc = await lireJSON('/data/editorial/quartiers.geojson');
    quartiers = fc.features.map((f) => ({ ...f, bbox: bboxOf(f.geometry) }));
  } catch {
    quartiers = [];
    return;
  }
  // Le style est chargé au démarrage de la carte (creerCarte attend son chargement).
  ajouterCouches();
  appliquer();
  // Le changement d'ambiance jour / nuit remplace les couleurs du fond.
  on('reglages', appliquer);
  on('mode', appliquer);
  let ambiance = document.body.dataset.ambiance;
  on('temps', () => {
    if (document.body.dataset.ambiance === ambiance) return;
    ambiance = document.body.dataset.ambiance;
    appliquer();
  });
}
