#!/usr/bin/env node
// Copie les librairies open source depuis node_modules vers app/vendor/
// (l'atlas n'utilise aucun CDN : tout fonctionne hors connexion).
// Usage : npm install && npm run vendor

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'app', 'vendor');

const LIBS = {
  'maplibre-gl': ['dist/maplibre-gl.mjs', 'dist/maplibre-gl-shared.mjs', 'dist/maplibre-gl-worker.mjs',
    'dist/maplibre-gl.css', 'LICENSE.txt'],
  'deck.gl': ['dist.min.js', 'LICENSE'],
  pmtiles: ['dist/pmtiles.js'],
  suncalc: ['index.js', 'LICENSE'],
  marked: ['lib/marked.esm.js', 'LICENSE'],
  dompurify: ['dist/purify.es.mjs', 'LICENSE'],
  proj4: ['dist/proj4.js', 'LICENSE.md'],
  'web-ifc': ['web-ifc-api.js', 'web-ifc.wasm', 'LICENSE.md'],
};

const versions = {};
for (const [lib, files] of Object.entries(LIBS)) {
  const pkg = JSON.parse(fs.readFileSync(path.join(NM, lib, 'package.json'), 'utf8'));
  versions[lib] = { version: pkg.version, licence: pkg.license || 'voir LICENSE' };
  const dest = path.join(VENDOR, lib);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const src = path.join(NM, lib, f);
    if (!fs.existsSync(src)) {
      console.warn(`Absent : ${lib}/${f}`);
      continue;
    }
    fs.copyFileSync(src, path.join(dest, path.basename(f)));
  }
  if (!files.some((f) => /LICEN[CS]E/i.test(f))) {
    fs.writeFileSync(path.join(dest, 'LICENCE.txt'),
      `${lib} ${pkg.version} — licence ${pkg.license}\n${pkg.homepage || ''}\n`);
  }
  console.log(`${lib} ${pkg.version}`);
}
fs.writeFileSync(path.join(VENDOR, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
