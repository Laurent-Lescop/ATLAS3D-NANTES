#!/usr/bin/env node
// Prépare le fond de carte local (data/fond/) :
//   - extrait les tuiles Protomaps (OpenStreetMap) de Nantes Métropole en PMTiles ;
//   - génère les styles « jour » et « nuit » (étiquettes en français) ;
//   - télécharge les polices (glyphes) et pictogrammes utilisés.
// Nécessite l'outil « pmtiles » (https://github.com/protomaps/go-pmtiles) dans le PATH
// ou dans tools/bin/ pour l'extraction.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { EMPRISE_FOND, fetchWithRetry, log } from './commun.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'fond');
const ASSETS = 'https://protomaps.github.io/basemaps-assets';
fs.mkdirSync(OUT, { recursive: true });

// --- 1. Extraction des tuiles -------------------------------------------------
function findPmtilesCli() {
  for (const c of [path.join(ROOT, 'tools', 'bin', 'pmtiles'), path.join(ROOT, 'tools', 'bin', 'go-pmtiles'), 'pmtiles', 'go-pmtiles']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* suivant */ }
  }
  return null;
}

async function extractTiles() {
  const cli = findPmtilesCli();
  if (!cli) {
    log('Outil pmtiles introuvable : extraction des tuiles ignorée.');
    return;
  }
  // Dernière construction quotidienne disponible.
  const builds = JSON.parse(await fetchWithRetry('https://build-metadata.protomaps.dev/builds.json'));
  const last = builds.filter((b) => b.key.endsWith('.pmtiles')).at(-1).key;
  const bbox = EMPRISE_FOND.join(',');
  log(`Extraction ${last} (emprise ${bbox}, zoom ≤ 15)…`);
  execFileSync(cli, ['extract', `https://build.protomaps.com/${last}`, path.join(OUT, 'nantes-metropole.pmtiles'),
    `--bbox=${bbox}`, '--maxzoom=15'], { stdio: 'inherit' });
  // Contexte régional à petite échelle (Grand Ouest), pour la vue d'ensemble.
  execFileSync(cli, ['extract', `https://build.protomaps.com/${last}`, path.join(OUT, 'grand-ouest.pmtiles'),
    '--bbox=-4.8,45.8,0.8,48.8', '--maxzoom=8'], { stdio: 'inherit' });
  fs.writeFileSync(path.join(OUT, 'source.json'), JSON.stringify({
    construction: last, emprise: EMPRISE_FOND, extrait: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL), Protomaps',
  }, null, 2));
}

// --- 2. Styles ----------------------------------------------------------------
// Palette « maquette » : fond clair et neutre pour faire ressortir la 3D.
function flavorJour() {
  const f = { ...namedFlavor('light') };
  Object.assign(f, {
    background: '#eceae4', earth: '#f3f1ec', water: '#b9d3e0', buildings: '#e2dfd8',
    park_a: '#dbe8cf', park_b: '#d3e3c4', wood_a: '#d5e4c9', wood_b: '#cfe0c1',
    industrial: '#ebe8e2', hospital: '#f1e6e6', school: '#efeae0', pedestrian: '#eeebe5',
    minor_a: '#ffffff', minor_b: '#ffffff', major: '#ffffff', highway: '#fff7e6',
  });
  return f;
}

function flavorNuit() {
  const f = { ...namedFlavor('dark') };
  Object.assign(f, {
    background: '#10141c', earth: '#171c26', water: '#0b2233', buildings: '#232a36',
  });
  return f;
}

function styleFor(flavor, spriteName) {
  return {
    version: 8,
    glyphs: 'polices/{fontstack}/{range}.pbf',
    sprite: `sprites/${spriteName}`,
    sources: { protomaps: { type: 'vector', attribution: '© OpenStreetMap, Protomaps' } },
    layers: layers('protomaps', flavor, { lang: 'fr' }),
  };
}

// --- 3. Polices et pictogrammes -------------------------------------------------
function collectFonts(style) {
  const fonts = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string') && v.some((x) => /Noto|Sans|Serif/.test(x))) fonts.add(v.join(','));
      v.forEach(walk);
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const l of style.layers) if (l.layout?.['text-font']) walk(l.layout['text-font']);
  return [...fonts];
}

// Plages Unicode utiles au français (latin, latin étendu, ponctuation, symboles).
const RANGES = [0, 256, 512, 768, 7680, 7936, 8192, 8448, 8704, 9472, 9728];

async function downloadGlyphs(fontstacks) {
  for (const stack of fontstacks) {
    for (const name of stack.split(',')) {
      const dir = path.join(OUT, 'polices', name);
      fs.mkdirSync(dir, { recursive: true });
      for (const start of RANGES) {
        const range = `${start}-${start + 255}`;
        const file = path.join(dir, `${range}.pbf`);
        if (fs.existsSync(file)) continue;
        const res = await fetch(`${ASSETS}/fonts/${encodeURIComponent(name)}/${range}.pbf`);
        if (res.ok) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      log(`Police : ${name}`);
    }
  }
}

async function downloadSprites() {
  const dir = path.join(OUT, 'sprites');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['light', 'dark']) {
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
      const res = await fetch(`${ASSETS}/sprites/v4/${name}${suffix}`);
      if (res.ok) fs.writeFileSync(path.join(dir, `${name}${suffix}`), Buffer.from(await res.arrayBuffer()));
    }
  }
  log('Pictogrammes téléchargés.');
}

async function main() {
  if (!process.argv.includes('--sans-tuiles')) await extractTiles();
  const jour = styleFor(flavorJour(), 'light');
  const nuit = styleFor(flavorNuit(), 'dark');
  fs.writeFileSync(path.join(OUT, 'style-jour.json'), JSON.stringify(jour));
  fs.writeFileSync(path.join(OUT, 'style-nuit.json'), JSON.stringify(nuit));
  const fonts = [...new Set([...collectFonts(jour), ...collectFonts(nuit)])];
  log(`Polices utilisées : ${fonts.join(' | ')}`);
  await downloadGlyphs(fonts);
  await downloadSprites();
  log('Fond de carte prêt.');
}

main().catch((e) => { console.error(e); process.exit(1); });
