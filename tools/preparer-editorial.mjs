#!/usr/bin/env node
// Prépare les données éditoriales de référence (data/editorial/) :
//   - quartiers des communes de Nantes Métropole (contours simplifiés et point d'étiquette).
// Les sites, fiches et parcours sont rédigés à la main (data/poi, data/editorial/parcours.json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJSON, log, EMPRISE_FOND } from './commun.mjs';
import { interiorPoint, areaM2 } from '../app/js/lib/batiments-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'editorial');
const ODS = 'https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets/';
fs.mkdirSync(OUT, { recursive: true });

// Douglas-Peucker en mètres (plan tangent local).
function simplifier(anneau, tolerance) {
  if (anneau.length <= 4) return anneau;
  const lat0 = (anneau[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  const pts = anneau.map(([x, y]) => [x * kx, y * ky]);
  const garder = new Uint8Array(pts.length);
  garder[0] = garder[pts.length - 1] = 1;
  const pile = [[0, pts.length - 1]];
  while (pile.length) {
    const [a, b] = pile.pop();
    let dmax = 0, imax = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2));
      const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy);
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > tolerance) { garder[imax] = 1; pile.push([a, imax], [imax, b]); }
  }
  const r = anneau.filter((_, i) => garder[i]);
  return r.length >= 4 ? r : anneau;
}

const arrondir = (anneau) => anneau.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);

function intersecte(geometry, [o, s, e, n]) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return polys.some((p) => p[0].some(([x, y]) => x >= o && x <= e && y >= s && y <= n));
}

async function quartiers() {
  log('Quartiers de Nantes Métropole…');
  const fc = await fetchJSON(`${ODS}244400404_quartiers-communes-nantes-metropole/exports/geojson`);
  const features = fc.features.filter((f) => f.geometry && intersecte(f.geometry, EMPRISE_FOND)).map((f) => {
    const g = f.geometry;
    const polys = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates])
      .map((p) => p.map((a) => arrondir(simplifier(a, 4))));
    const geometry = polys.length > 1 ? { type: 'MultiPolygon', coordinates: polys } : { type: 'Polygon', coordinates: polys[0] };
    const p = f.properties;
    return {
      type: 'Feature',
      geometry,
      properties: {
        id: `${p.codcom}-${p.idobj}`.replace(/\.0\b/, ''),
        nom: p.nom,
        commune: p.libcom,
        surface: Math.round(areaM2(geometry) / 1e4), // hectares
        etiquette: interiorPoint(geometry).map((v) => +v.toFixed(5)),
      },
    };
  }).sort((a, b) => a.properties.commune.localeCompare(b.properties.commune, 'fr') || a.properties.nom.localeCompare(b.properties.nom, 'fr'));
  const sortie = {
    type: 'FeatureCollection',
    source: 'Nantes Métropole — Quartiers des communes de Nantes Métropole (Licence ODbL)',
    date: new Date().toISOString().slice(0, 10),
    features,
  };
  fs.writeFileSync(path.join(OUT, 'quartiers.geojson'), JSON.stringify(sortie));
  log(`Quartiers : ${features.length} (${(fs.statSync(path.join(OUT, 'quartiers.geojson')).size / 1024).toFixed(0)} ko)`);
}

await quartiers();
