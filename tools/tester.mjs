#!/usr/bin/env node
// Test de bout en bout dans Chromium sans affichage : démarre le serveur local,
// ouvre l'atlas, valide une zone et enregistre des captures d'écran.
//
// Usage : node tools/tester.mjs [--hors-ligne] [--sortie dossier] [--navigateur chemin]

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const horsLigne = args.includes('--hors-ligne');
const sortie = args.includes('--sortie') ? args[args.indexOf('--sortie') + 1] : path.join(ROOT, 'tools', '.cache', 'captures');
const navigateur = args.includes('--navigateur') ? args[args.indexOf('--navigateur') + 1]
  : (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const port = 8790 + Math.floor(Math.random() * 50);
fs.mkdirSync(sortie, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function demarrerServeur() {
  const bin = path.join(ROOT, 'tools', '.cache', 'atlas-test');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' });
  const opts = ['-racine', ROOT, '-port', String(port), '-sans-navigateur', '-sans-enregistrement'];
  if (horsLigne) opts.push('-hors-ligne');
  const p = spawn(bin, opts, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`[serveur] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[serveur] ${d}`));
  return p;
}

async function main() {
  const serveur = demarrerServeur();
  await sleep(1500);
  const browser = await chromium.launch({
    executablePath: navigateur,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const erreurs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') erreurs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => erreurs.push(`pageerror: ${e.message}`));

  try {
    const url = `http://127.0.0.1:${port}/${args.includes('--etude') ? args[args.indexOf('--etude') + 1] || '' : ''}`;
    await page.goto(url);
    await page.waitForSelector('#chargement', { state: 'detached', timeout: 60000 });
    await sleep(4000);
    await page.screenshot({ path: path.join(sortie, '01-selection.png') });

    await page.click('#btn-zone-valider');
    await page.waitForFunction(() => window.atlas?.etat?.mode === 'etude', null, { timeout: 90000 });
    await sleep(9000);
    await page.screenshot({ path: path.join(sortie, '02-zone-3d.png') });

    const n = await page.evaluate(() => window.atlas.etat.zone.batiments.length);
    console.log(`Bâtiments dans la zone : ${n}`);

    // Fin d'après-midi : ombres longues.
    await page.evaluate(() => {
      const c = document.getElementById('temps-curseur');
      c.value = 17 * 60 + 30;
      c.dispatchEvent(new Event('input'));
    });
    await sleep(3000);
    await page.screenshot({ path: path.join(sortie, '03-fin-apres-midi.png') });

    // Survol d'un bâtiment au centre de l'écran.
    await page.mouse.move(720, 470);
    await sleep(1500);
    await page.screenshot({ path: path.join(sortie, '04-survol.png') });

    // Nuit.
    await page.evaluate(() => {
      const c = document.getElementById('temps-curseur');
      c.value = 22 * 60 + 30;
      c.dispatchEvent(new Event('input'));
    });
    await sleep(3000);
    await page.screenshot({ path: path.join(sortie, '05-nuit.png') });

    // Panneau statistiques.
    await page.click('#rail button[data-panneau="stats"]');
    await sleep(1000);
    await page.screenshot({ path: path.join(sortie, '06-statistiques.png') });
  } finally {
    console.log(erreurs.length ? `Messages de la console :\n${erreurs.join('\n')}` : 'Aucune erreur dans la console.');
    await browser.close();
    serveur.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
