#!/usr/bin/env node
// Prépare le pack local des bâtiments : OpenStreetMap + IGN BD TOPO (WFS),
// fusionnés puis découpés en cellules GeoJSON compressées (data/batiments/).
//
// Source OSM : extrait départemental d'OpenStreetMap France (Loire-Atlantique),
// lu par l'outil Go tools/osm-batiments ; à défaut, requêtes Overpass par tuiles.
//
// Usage : node tools/preparer-batiments.mjs [ouest sud est nord]
// Les données brutes sont conservées dans tools/.cache/ (relance rapide).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { processBuildings } from '../app/js/lib/batiments-core.js';
import { fetchWithRetry, log, EMPRISE_PACK, USER_AGENT } from './commun.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const OUT = path.join(ROOT, 'data', 'batiments');

const emprise = process.argv.length === 6 ? process.argv.slice(2).map(Number) : EMPRISE_PACK;
const [W, S, E, N] = emprise;

// Grille de stockage (~760 m × 780 m) et grille de densité (~150 m).
const GRILLE = { lon0: W, lat0: S, dlon: 0.01, dlat: 0.007 };
const DENS = { lon0: W, lat0: S, dlon: 0.002, dlat: 0.0014 };

fs.mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attend qu'un créneau soit libre sur le serveur Overpass (limite par adresse IP).
async function waitForOverpassSlot() {
  for (let i = 0; i < 40; i++) {
    let txt = '';
    try {
      txt = await (await fetch('https://overpass-api.de/api/status', { headers: { 'User-Agent': USER_AGENT } })).text();
    } catch { await sleep(10000); continue; }
    const free = txt.match(/(\d+) slots? available now/);
    if (free && parseInt(free[1], 10) > 0) return;
    const waits = [...txt.matchAll(/in (\d+) seconds/g)].map((m) => parseInt(m[1], 10));
    const wait = waits.length ? Math.min(...waits) + 2 : 15;
    log(`Overpass : créneau libre dans ${wait} s`);
    await sleep(wait * 1000);
  }
}

// Exécute une requête Overpass (avec cache disque) ; renvoie null si le service
// reste indisponible (les bâtiments manquants seront complétés par la BD TOPO).
async function overpass(nomCache, query) {
  const file = path.join(CACHE, `${nomCache}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const body = new URLSearchParams({ data: query }).toString();
  for (let attempt = 1; attempt <= 10; attempt++) {
    await waitForOverpassSlot();
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(200000),
      });
      const txt = await res.text();
      if (res.ok && txt.trimStart().startsWith('{')) {
        fs.writeFileSync(file, txt);
        return JSON.parse(txt);
      }
      log(`Overpass ${nomCache} : HTTP ${res.status} (essai ${attempt}/10)`);
    } catch (err) {
      log(`Overpass ${nomCache} : ${err.message} (essai ${attempt}/10)`);
    }
    await sleep(Math.min(10000 * attempt, 90000));
  }
  return null;
}

const boite = (w, s, e, n) => `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
const cleTuile = (w, s, e, n) => `${w.toFixed(4)}_${s.toFixed(4)}_${e.toFixed(4)}_${n.toFixed(4)}`;

// Bâtiments simples (chemins fermés) d'une tuile : requête légère.
function overpassTile(w, s, e, n) {
  const box = boite(w, s, e, n);
  return overpass(`osmw_${cleTuile(w, s, e, n)}`,
    `[out:json][timeout:170];way["building"](${box});out tags geom qt;`);
}

// Multipolygones et parties de bâtiments (plus rares) d'un quart de l'emprise.
function overpassComplements(w, s, e, n) {
  const box = boite(w, s, e, n);
  return overpass(`osmr_${cleTuile(w, s, e, n)}`,
    `[out:json][timeout:170];(relation["building"]["type"="multipolygon"](${box});` +
    `way["building:part"](${box});relation["building:part"]["type"="multipolygon"](${box}););out tags geom qt;`);
}

async function bdtopoAll() {
  const features = [];
  const page = 5000;
  for (let start = 0; ; start += page) {
    const file = path.join(CACHE, `bdtopo_${W}_${S}_${E}_${N}_${start}.json`);
    let fc;
    if (fs.existsSync(file)) {
      fc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      const params = new URLSearchParams({
        SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: 'BDTOPO_V3:batiment',
        OUTPUTFORMAT: 'application/json', COUNT: String(page), STARTINDEX: String(start), SORTBY: 'cleabs',
        PROPERTYNAME: 'geometrie,cleabs,hauteur,nombre_d_etages,date_d_apparition,usage_1,usage_2,' +
          'nombre_de_logements,altitude_minimale_sol,altitude_minimale_toit,altitude_maximale_toit,identifiants_rnb',
        BBOX: `${S},${W},${N},${E},urn:ogc:def:crs:EPSG::4326`,
      });
      const txt = await fetchWithRetry(`https://data.geopf.fr/wfs/ows?${params}`, {},
        { label: `BD TOPO ${start}`, timeoutMs: 180000 });
      fs.writeFileSync(file, txt);
      fc = JSON.parse(txt);
    }
    features.push(...fc.features);
    log(`BD TOPO : ${features.length} bâtiments lus`);
    if (fc.features.length < page) break;
  }
  return { type: 'FeatureCollection', features };
}

const PBF_URL = 'https://download.openstreetmap.fr/extracts/europe/france/pays_de_la_loire/loire_atlantique-latest.osm.pbf';

// Voie principale : extrait .osm.pbf lu par l'outil Go (rapide et sans charger Overpass).
async function osmDepuisExtrait() {
  const pbf = path.join(CACHE, 'loire_atlantique.osm.pbf');
  if (!fs.existsSync(pbf)) {
    log('Téléchargement de l\'extrait OpenStreetMap de Loire-Atlantique…');
    const res = await fetch(PBF_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`extrait OSM : HTTP ${res.status}`);
    fs.writeFileSync(pbf, Buffer.from(await res.arrayBuffer()));
  }
  const outil = path.join(ROOT, 'tools', 'bin', process.platform === 'win32' ? 'osm-batiments.exe' : 'osm-batiments');
  if (!fs.existsSync(outil)) {
    log('Compilation de l\'outil osm-batiments (Go)…');
    execFileSync('go', ['build', '-o', outil, '.'], { cwd: path.join(ROOT, 'tools', 'osm-batiments'), stdio: 'inherit' });
  }
  const sortie = path.join(CACHE, `osm_${W}_${S}_${E}_${N}.json`);
  execFileSync(outil, ['-pbf', pbf, '-bbox', `${W},${S},${E},${N}`, '-sortie', sortie], { stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(sortie, 'utf8'));
}

async function main() {
  log(`Emprise : ${emprise.join(', ')}`);
  const elements = [];
  const seen = new Set();
  const tuilesSansOsm = [];
  let sourceOsm = 'extrait OpenStreetMap France (Loire-Atlantique)';

  try {
    const data = await osmDepuisExtrait();
    for (const el of data.elements) elements.push(el);
    log(`OSM : ${elements.length} objets lus dans l'extrait.`);
  } catch (err) {
    log(`Extrait OSM indisponible (${err.message}) : repli sur Overpass.`);
    sourceOsm = 'API Overpass';
    await osmDepuisOverpass(elements, seen, tuilesSansOsm);
  }

  await suiteTraitement(elements, tuilesSansOsm, sourceOsm);
}

// Voie de secours : Overpass par tuiles (8 × 8) pour ménager le service.
async function osmDepuisOverpass(elements, seen, tuilesSansOsm) {
  const nx = 8, ny = 8;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const w = W + (E - W) * i / nx, e = W + (E - W) * (i + 1) / nx;
      const s = S + (N - S) * j / ny, n = S + (N - S) * (j + 1) / ny;
      const data = await overpassTile(w, s, e, n);
      if (!data) { tuilesSansOsm.push([w, s, e, n]); continue; }
      for (const el of data.elements) {
        const k = el.type + el.id;
        if (!seen.has(k)) { seen.add(k); elements.push(el); }
      }
      log(`OSM : tuile ${i * ny + j + 1}/${nx * ny}, ${elements.length} objets`);
      await sleep(3000);
    }
  }
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const w = W + (E - W) * i / 2, e = W + (E - W) * (i + 1) / 2;
      const s = S + (N - S) * j / 2, n = S + (N - S) * (j + 1) / 2;
      const data = await overpassComplements(w, s, e, n);
      if (!data) { log('Compléments OSM (multipolygones, parties) indisponibles pour un quart de l\'emprise.'); continue; }
      for (const el of data.elements) {
        const k = el.type + el.id;
        if (!seen.has(k)) { seen.add(k); elements.push(el); }
      }
      log(`OSM : compléments ${i * 2 + j + 1}/4, ${elements.length} objets`);
    }
  }
  if (tuilesSansOsm.length) log(`${tuilesSansOsm.length} tuile(s) sans réponse OSM : complétées par la BD TOPO.`);
}

async function suiteTraitement(elements, tuilesSansOsm, sourceOsm) {
  // 2. BD TOPO.
  const bdtopo = await bdtopoAll();

  // 3. Fusion.
  log('Fusion OSM + BD TOPO…');
  const { buildings, parts, stats } = processBuildings({ elements }, bdtopo);
  log(`Bâtiments : ${buildings.length} (${stats.matched} OSM appariés à la BD TOPO, ` +
    `${stats.ajoutes_bdtopo} ajoutés depuis la BD TOPO), parties : ${parts.length}`);

  // 4. Répartition en cellules selon le point intérieur.
  const inside = (c) => c[0] >= W && c[0] < E && c[1] >= S && c[1] < N;
  const cellOf = (c) => `${Math.floor((c[0] - GRILLE.lon0) / GRILLE.dlon)}_${Math.floor((c[1] - GRILLE.lat0) / GRILLE.dlat)}`;
  const cells = new Map();
  const cellById = new Map();
  const densNx = Math.ceil((E - W) / DENS.dlon), densNy = Math.ceil((N - S) / DENS.dlat);
  const densite = new Array(densNx * densNy).fill(0);
  const hs = {};
  for (const f of buildings) {
    const c = f.properties.c;
    if (!inside(c)) continue;
    const key = cellOf(c);
    if (!cells.has(key)) cells.set(key, { features: [], parties: [] });
    cells.get(key).features.push(f);
    cellById.set(f.properties.id, key);
    const di = Math.floor((c[0] - DENS.lon0) / DENS.dlon), dj = Math.floor((c[1] - DENS.lat0) / DENS.dlat);
    densite[dj * densNx + di]++;
    hs[f.properties.hs] = (hs[f.properties.hs] || 0) + 1;
  }
  for (const p of parts) {
    const key = cellById.get(p.properties.b);
    if (key) cells.get(key).parties.push(p);
  }

  // 5. Écriture.
  fs.rmSync(path.join(OUT, 'cellules'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'cellules'), { recursive: true });
  let octets = 0;
  const index = {};
  for (const [key, cell] of cells) {
    const json = JSON.stringify({ type: 'FeatureCollection', features: cell.features, parties: cell.parties });
    const gz = zlib.gzipSync(json, { level: 9 });
    fs.writeFileSync(path.join(OUT, 'cellules', `${key}.json.gz`), gz);
    octets += gz.length;
    index[key] = { n: cell.features.length, p: cell.parties.length };
  }
  const meta = {
    version: 1,
    genere: new Date().toISOString(),
    sources: [
      `© contributeurs OpenStreetMap (ODbL) — emprises, via ${sourceOsm}`,
      '© IGN BD TOPO (Licence Ouverte 2.0) — hauteurs, dates, usages, emprises complémentaires',
    ],
    emprise,
    grille: GRILLE,
    cellules: index,
    densite: { ...DENS, nx: densNx, ny: densNy, valeurs: densite },
    stats: {
      batiments: buildings.length, parties: parts.length, apparies_bdtopo: stats.matched,
      ajoutes_bdtopo: stats.ajoutes_bdtopo, tuiles_sans_osm: tuilesSansOsm, sources_hauteur: hs,
    },
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(meta));
  log(`Écrit : ${cells.size} cellules, ${(octets / 1048576).toFixed(1)} Mo compressés.`);
  log(`Sources des hauteurs : ${JSON.stringify(hs)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
