// Chargement des bâtiments d'une zone : pack local (cellules compressées),
// complété en ligne (OSM + BD TOPO) pour les secteurs hors du pack.

import { lireJSON, lireSource } from '../api.js';
import { etat } from '../etat.js';
import { contientPoint, emprise, depuisRepereCadre } from '../lib/geo.js';

let index = null;

export async function chargerIndexBatiments() {
  try {
    index = await lireJSON('/data/batiments/index.json');
  } catch {
    index = null;
  }
  return index;
}

export const indexBatiments = () => index;

function dansPack([lon, lat]) {
  if (!index) return false;
  const [o, s, e, n] = index.emprise;
  return lon >= o && lon < e && lat >= s && lat < n;
}

// Part du cadre couverte par le pack local.
export function couverturePack(rect) {
  if (!index) return 0;
  let dedans = 0, total = 0;
  const pas = 14;
  for (let a = 0; a < pas; a++) {
    for (let b = 0; b < pas; b++) {
      total++;
      if (dansPack(depuisRepereCadre(rect, [(-0.5 + (a + 0.5) / pas) * rect.largeur, (-0.5 + (b + 0.5) / pas) * rect.hauteur]))) dedans++;
    }
  }
  return dedans / total;
}

function cellulesPour(rect) {
  const g = index.grille;
  const [o, s, e, n] = emprise(rect, 250);
  const cles = [];
  for (let i = Math.floor((o - g.lon0) / g.dlon); i <= Math.floor((e - g.lon0) / g.dlon); i++) {
    for (let j = Math.floor((s - g.lat0) / g.dlat); j <= Math.floor((n - g.lat0) / g.dlat); j++) {
      const k = `${i}_${j}`;
      if (index.cellules[k]) cles.push(k);
    }
  }
  return cles;
}

let travailleur = null;
function traiterEnLigne(osm, bdtopo) {
  travailleur ??= new Worker(new URL('../travailleurs/zone.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const surMessage = (e) => {
      if (e.data.id !== id) return;
      travailleur.removeEventListener('message', surMessage);
      if (e.data.erreur) reject(new Error(e.data.erreur));
      else resolve(e.data.resultat);
    };
    travailleur.addEventListener('message', surMessage);
    travailleur.postMessage({ id, osm, bdtopo });
  });
}

// Charge les bâtiments contenus dans le cadre (point intérieur dans le cadre).
export async function chargerBatiments(rect, { progres } = {}) {
  const batiments = [];
  let parties = [];
  const sources = new Set();
  const retenus = new Set();

  if (index) {
    const cles = cellulesPour(rect);
    let faits = 0;
    await Promise.all(cles.map(async (k) => {
      const fc = await lireJSON(`/data/batiments/cellules/${k}.json`);
      for (const f of fc.features) {
        if (contientPoint(rect, f.properties.c)) { batiments.push(f); retenus.add(f.properties.id); }
      }
      for (const p of fc.parties || []) if (retenus.has(p.properties.b)) parties.push(p);
      faits++;
      progres?.(`Bâtiments du pack local… ${Math.round((faits / cles.length) * 100)} %`);
    }));
    // Les parties peuvent arriver avant leur bâtiment (cellules chargées en parallèle).
    parties = parties.filter((p) => retenus.has(p.properties.b));
    if (cles.length) sources.add('pack');
  }

  const couverture = couverturePack(rect);
  let horsPack = 0;
  if (couverture < 0.999) {
    if (!etat.enLigne) {
      horsPack = -1; // secteur non disponible hors ligne
    } else {
      const bbox = emprise(rect, 30).map((v) => v.toFixed(6)).join(',');
      progres?.('Téléchargement des bâtiments OpenStreetMap et IGN…');
      const [osm, bdtopo] = await Promise.all([
        lireSource('osm-batiments', { bbox }).then((r) => r.donnees).catch(() => null),
        lireSource('bdtopo-batiments', { bbox }).then((r) => r.donnees).catch(() => null),
      ]);
      if (osm || bdtopo) {
        progres?.('Calcul des hauteurs et des surfaces…');
        const res = await traiterEnLigne(osm, bdtopo);
        const ajoutes = new Set();
        for (const f of res.buildings) {
          const c = f.properties.c;
          if (!dansPack(c) && contientPoint(rect, c) && !retenus.has(f.properties.id)) {
            batiments.push(f); ajoutes.add(f.properties.id); horsPack++;
          }
        }
        for (const p of res.parts) if (ajoutes.has(p.properties.b)) parties.push(p);
        if (osm) sources.add('osm-en-ligne');
        if (bdtopo) sources.add('bdtopo-en-ligne');
      } else {
        horsPack = -1;
      }
    }
  }
  return { batiments, parties, sources: [...sources], couverture, horsPack };
}

// Indicateurs de la zone.
export function statistiquesZone(batiments, rect) {
  const aireZone = rect.largeur * rect.hauteur;
  let emprise = 0, plancher = 0, volume = 0, logements = 0, sommeH = 0, hMax = null;
  const hauteurs = [0, 0, 0, 0, 0, 0, 0];     // <6, 6-12, 12-18, 18-30, 30-50, 50-80, ≥80
  const bornesH = [6, 12, 18, 30, 50, 80];
  const epoques = new Map();
  const usages = new Map();
  const sourcesH = new Map();
  for (const f of batiments) {
    const p = f.properties;
    const a = p.a || 0;
    const h = Math.max(0, (p.h || 0) - (p.mh || 0));
    const niveaux = p.lv || Math.max(1, Math.round((p.h || 3) / 3));
    emprise += a;
    plancher += a * niveaux;
    volume += a * h;
    sommeH += (p.h || 0) * a;
    logements += p.lg || 0;
    if (!hMax || p.h > hMax.properties.h) hMax = f;
    let k = bornesH.findIndex((b) => p.h < b);
    if (k < 0) k = bornesH.length;
    hauteurs[k]++;
    const ep = epoque(p.y);
    epoques.set(ep, (epoques.get(ep) || 0) + a);
    const u = p.u || 'Non renseigné';
    usages.set(u, (usages.get(u) || 0) + a);
    sourcesH.set(p.hs, (sourcesH.get(p.hs) || 0) + 1);
  }
  return {
    nombre: batiments.length,
    aireZone,
    emprise,
    ces: aireZone ? emprise / aireZone : 0,
    plancher,
    cos: aireZone ? plancher / aireZone : 0,
    volume,
    logements,
    hauteurMoyenne: emprise ? sommeH / emprise : 0,
    hMax,
    hauteurs,
    epoques,
    usages,
    sourcesH,
  };
}

export const EPOQUES = [
  ['Avant 1850', [140, 96, 70]],
  ['1850 – 1914', [180, 132, 90]],
  ['1915 – 1945', [214, 178, 120]],
  ['1946 – 1975', [120, 160, 190]],
  ['1976 – 2000', [96, 132, 196]],
  ['2001 – 2015', [120, 104, 190]],
  ['Depuis 2016', [196, 86, 150]],
  ['Inconnue', [205, 202, 196]],
];

export function epoque(annee) {
  if (!annee) return 'Inconnue';
  if (annee < 1850) return 'Avant 1850';
  if (annee <= 1914) return '1850 – 1914';
  if (annee <= 1945) return '1915 – 1945';
  if (annee <= 1975) return '1946 – 1975';
  if (annee <= 2000) return '1976 – 2000';
  if (annee <= 2015) return '2001 – 2015';
  return 'Depuis 2016';
}
