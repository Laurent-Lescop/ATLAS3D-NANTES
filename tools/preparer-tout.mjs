#!/usr/bin/env node
// Prépare l'ensemble du pack de données local, étape par étape.
// Usage : npm run donnees   (ou : node tools/preparer-tout.mjs fond batiments …)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ETAPES = {
  fond: 'preparer-fond.mjs',
  batiments: 'preparer-batiments.mjs',
  climat: 'preparer-climat.mjs',
  mobilites: 'preparer-mobilites.mjs',
  editorial: 'preparer-editorial.mjs',
};

const demandees = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ETAPES);
for (const nom of demandees) {
  const script = ETAPES[nom];
  if (!script) { console.error(`Étape inconnue : ${nom}`); process.exit(2); }
  const chemin = path.join(ROOT, 'tools', script);
  if (!fs.existsSync(chemin)) { console.log(`— ${nom} : script absent, étape ignorée.`); continue; }
  console.log(`\n=== ${nom} ===`);
  execFileSync(process.execPath, ['--max-old-space-size=6144', chemin], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1' },
  });
}
