#!/usr/bin/env node
// Capture une vue 3D de chaque site remarquable depuis l'atlas (Chromium sans affichage) et
// l'ajoute à sa fiche : data/poi/medias/<id>/vue-atlas.jpg.
//
// Usage : node tools/capturer-vignettes.mjs [--date 2026-06-21] [--heure 17:00] [id…]

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lireFiche, ecrireFiche } from '../app/js/lib/fiche-md.js';
import { contientPoint } from '../app/js/lib/geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (nom, defaut) => (args.includes(nom) ? args[args.indexOf(nom) + 1] : defaut);
const date = opt('--date', '2026-06-21');
const [hh, mm] = opt('--heure', '17:00').split(':').map(Number);
const ids = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const navigateur = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const port = 8900 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/poi/index.json'), 'utf8'));
const secteurs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/editorial/secteurs.json'), 'utf8'));
const lieux = index.lieux.filter((l) => !ids.length || ids.includes(l.id));

// Regroupe les sites par secteur pour ne charger chaque zone qu'une fois.
const groupes = new Map();
for (const l of lieux) {
  const s = secteurs.find((x) => x.id === l.secteur && contientPoint(x.cadre, l.position))
    || secteurs.find((x) => contientPoint(x.cadre, l.position));
  if (!s) { console.log(`${l.id} : aucun secteur ne le contient, ignoré`); continue; }
  if (!groupes.has(s.id)) groupes.set(s.id, { secteur: s, lieux: [] });
  groupes.get(s.id).lieux.push(l);
}

const bin = path.join(ROOT, 'tools', '.cache', 'atlas-vignettes');
execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' });
const serveur = spawn(bin, ['-racine', ROOT, '-port', String(port), '-sans-navigateur', '-sans-enregistrement', '-hors-ligne'], { stdio: 'ignore' });
await sleep(1500);

const browser = await chromium.launch({
  executablePath: navigateur,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
// Vue épurée : ni mobilités, ni étiquettes, ni interface.
await page.addInitScript(() => {
  localStorage.setItem('atlas.mobilites', JSON.stringify({ trafic: false, transports: false, parkings: false, velos: false }));
  localStorage.setItem('atlas.reglages', JSON.stringify({ etiquettesLieux: false, quartiers: false, courseSoleil: false, ombres: true, coloration: 'maquette' }));
});

const cacher = '.barre-haut,#rail,#barre-temps,.barre-temps,.panneau,#carte-selection,.maplibregl-ctrl,#notifications,#infobulle{display:none!important}';

try {
  for (const { secteur, lieux: liste } of groupes.values()) {
    console.log(`Zone « ${secteur.nom} »…`);
    // Une page neuve par zone : l'adresse ouvre directement la zone d'étude.
    const c = secteur.cadre;
    await page.goto('about:blank');
    await page.goto(`http://127.0.0.1:${port}/#zone=${c.centre[0]},${c.centre[1]},${c.largeur},${c.hauteur},${c.angle}&etude`);
    await page.waitForFunction(() => window.atlas?.etat?.mode === 'etude', null, { timeout: 120000 });
    await page.addStyleTag({ content: cacher });
    await page.evaluate(([d, minutes]) => {
      const j = document.getElementById('temps-date');
      j.value = d; j.dispatchEvent(new Event('change'));
      const t = document.getElementById('temps-curseur');
      t.value = minutes; t.dispatchEvent(new Event('input'));
    }, [date, hh * 60 + mm]);
    await sleep(6000);
    for (const l of liste) {
      const vue = l.vue || { centre: l.position, zoom: 17.2, pitch: 60, bearing: 30 };
      await page.evaluate((v) => window.atlas.carte.jumpTo({ center: v.centre, zoom: v.zoom, pitch: v.pitch ?? 60, bearing: v.bearing ?? 0 }), vue);
      await sleep(9000);
      const dossier = path.join(ROOT, 'data/poi/medias', l.id);
      fs.mkdirSync(dossier, { recursive: true });
      await page.screenshot({ path: path.join(dossier, 'vue-atlas.jpg'), type: 'jpeg', quality: 80 });
      // Référence dans la fiche (en tête de galerie).
      const fichier = path.join(ROOT, 'data/poi/fiches', `${l.id}.md`);
      if (fs.existsSync(fichier)) {
        const { meta, corps } = lireFiche(fs.readFileSync(fichier, 'utf8'));
        const src = `medias/${l.id}/vue-atlas.jpg`;
        meta.images = (meta.images || []).filter((i) => i.src !== src);
        meta.images.unshift({ src, legende: `Vue de l'atlas, ${new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à ${hh} h${mm ? String(mm).padStart(2, '0') : ''}`, credit: 'Atlas 3D Nantes — OpenStreetMap, IGN BD TOPO' });
        fs.writeFileSync(fichier, ecrireFiche(meta, corps));
      }
      console.log(`  ${l.id}`);
    }
  }
} finally {
  await browser.close();
  serveur.kill();
}
