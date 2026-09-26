#!/usr/bin/env node
// Prépare les données de mobilité locales (data/mobilite/) :
//   - horaires théoriques Naolib (GTFS) : trams, bus, Navibus ;
//   - réseau des tronçons de fluidité routière (géométries, noms, longueurs) ;
//   - liste des parkings publics (capacités, positions) ;
//   - stations de vélos en libre-service (capacités, positions).
// Ces références permettent l'affichage hors connexion (valeurs observées ou indicatives).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJSON, log, USER_AGENT } from './commun.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'mobilite');
const ODS = 'https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets/';
fs.mkdirSync(OUT, { recursive: true });

async function gtfs() {
  // Adresse du GTFS publiée sur le point d'accès national.
  const jeux = await fetchJSON('https://transport.data.gouv.fr/api/datasets?format=gtfs');
  const jeu = jeux.find((d) => d.slug === 'reseau-de-transports-collectifs-naolib');
  const res = jeu?.resources.find((r) => r.format === 'GTFS');
  if (!res) throw new Error('GTFS Naolib introuvable');
  const url = res.original_url || res.url;
  log(`Téléchargement du GTFS Naolib…`);
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!r.ok) throw new Error(`GTFS : HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(OUT, 'naolib-gtfs.zip'), buf);
  log(`GTFS : ${(buf.length / 1048576).toFixed(1)} Mo`);
}

async function fluidite() {
  const lignes = await fetchJSON(`${ODS}244400404_fluidite-axes-routiers-nantes-metropole/exports/json`);
  const features = lignes.filter((l) => l.geo_shape?.geometry).map((l) => ({
    type: 'Feature',
    geometry: l.geo_shape.geometry,
    properties: {
      id: String(l.cha_id),
      nom: l.cha_lib,
      long: l.cha_long,
      // Vitesse de référence : relevée si le tronçon était fluide, sinon 30 km/h.
      vref: l.couleur_tp === '3' && l.mf1_vit > 5 ? l.mf1_vit : 30,
    },
  }));
  fs.writeFileSync(path.join(OUT, 'fluidite-troncons.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  log(`Fluidité : ${features.length} tronçons`);
}

async function parkings() {
  const lignes = await fetchJSON(`${ODS}244400404_parkings-publics-nantes-disponibilites/exports/json`);
  const out = lignes.filter((l) => l.location).map((l) => ({
    id: String(l.grp_identifiant), nom: l.grp_nom, capacite: l.grp_exploitation, adresse: l.adresse,
    lon: l.location.lon, lat: l.location.lat,
  }));
  fs.writeFileSync(path.join(OUT, 'parkings.json'), JSON.stringify(out, null, 1));
  log(`Parkings : ${out.length}`);
}

async function velos() {
  const d = await fetchJSON('https://api.cyclocity.fr/contracts/nantes/gbfs/v3/station_information.json');
  const out = d.data.stations.map((s) => ({
    id: s.station_id,
    nom: (s.name.find((n) => n.language === 'fr') || s.name[0]).text,
    adresse: s.address,
    capacite: s.capacity,
    lon: s.lon, lat: s.lat,
  }));
  fs.writeFileSync(path.join(OUT, 'velos-stations.json'), JSON.stringify(out, null, 1));
  log(`Vélos : ${out.length} stations`);
}

async function main() {
  for (const [nom, fn] of [['fluidité', fluidite], ['parkings', parkings], ['vélos', velos], ['GTFS', gtfs]]) {
    try { await fn(); } catch (e) { log(`${nom} : échec — ${e.message}`); }
  }
  fs.writeFileSync(path.join(OUT, 'source.json'), JSON.stringify({
    prepare: new Date().toISOString(),
    sources: ['Nantes Métropole (ODbL)', 'Naolib / transport.data.gouv.fr (ODbL)', 'JCDecaux GBFS'],
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
