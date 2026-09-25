// Panneau « Zone » : indicateurs de la zone étudiée, sélection de bâtiments, export.

import { etat, on } from '../etat.js';
import { enregistrerPanneau, rafraichirPanneau, ouvrirFiche, fermerFiche } from '../ui/panneaux.js';
import { EPOQUES, statistiquesZone } from '../carte/zone.js';
import { effacerSelection, htmlInfobulle } from '../carte/batiments3d.js';
import { SOURCES_HAUTEUR } from '../lib/batiments-core.js';
import { versCss } from '../lib/couleurs.js';
import { enregistrerFichier } from '../api.js';
import { notifier } from '../ui/notifications.js';
import { entier, decimal, surface, html, echapper, pluriel } from '../ui/format.js';

function barres(valeurs, libelles, couleur = '#d2601a') {
  const max = Math.max(1, ...valeurs);
  const l = 300, hBar = 18, gap = 5;
  const h = valeurs.length * (hBar + gap);
  return `<svg class="graphique" viewBox="0 0 ${l} ${h}" role="img">
    ${valeurs.map((v, i) => {
      const y = i * (hBar + gap);
      const w = (v / max) * (l - 150);
      return `<text x="0" y="${y + 13}">${echapper(libelles[i])}</text>
        <rect x="92" y="${y + 2}" width="${Math.max(1, w)}" height="${hBar - 4}" rx="3" fill="${couleur}" opacity=".85"/>
        <text x="${96 + w}" y="${y + 13}">${entier(v)}</text>`;
    }).join('')}
  </svg>`;
}

function barreEmpilee(entrees, total) {
  let x = 0;
  const segments = entrees.map(([nom, v, c]) => {
    const w = (v / total) * 100;
    const s = `<rect x="${x}%" y="0" width="${w}%" height="14" fill="${versCss(c)}"><title>${echapper(nom)} : ${Math.round(w)} %</title></rect>`;
    x += w;
    return s;
  }).join('');
  return `<svg class="graphique" viewBox="0 0 300 14" preserveAspectRatio="none" style="height:14px;border-radius:4px">${segments}</svg>`;
}

function rendre(conteneur) {
  if (!etat.zone) {
    conteneur.appendChild(html('<p class="aide">Validez une zone d\'étude pour afficher ses indicateurs.</p>'));
    return;
  }
  const s = etat.zone.stats;
  const epoques = EPOQUES.map(([nom, c]) => [nom, s.epoques.get(nom) || 0, c]).filter((e) => e[1] > 0);
  const usages = [...s.usages.entries()].sort((a, b) => b[1] - a[1]);
  const el = html(`<div>
    <div class="section">
      <h3>${echapper(etat.zone.nom)}</h3>
      <div class="chiffres">
        <div class="chiffre"><strong>${entier(s.nombre)}</strong><span>bâtiments</span></div>
        <div class="chiffre"><strong>${surface(s.aireZone)}</strong><span>surface de la zone</span></div>
        <div class="chiffre"><strong>${surface(s.emprise)}</strong><span>emprise bâtie</span></div>
        <div class="chiffre"><strong>${decimal(s.ces * 100)} %</strong><span>emprise au sol (CES)</span></div>
        <div class="chiffre"><strong>${surface(s.plancher)}</strong><span>plancher estimé</span></div>
        <div class="chiffre"><strong>${decimal(s.cos, 2)}</strong><span>densité bâtie (COS)</span></div>
        <div class="chiffre"><strong>${decimal(s.hauteurMoyenne)} m</strong><span>hauteur moyenne pondérée</span></div>
        <div class="chiffre"><strong>${entier(s.logements)}</strong><span>logements (BD TOPO)</span></div>
      </div>
      ${s.hMax ? `<p class="note">Point culminant : ${echapper(s.hMax.properties.n || 'bâtiment')} — ${decimal(s.hMax.properties.h)} m.</p>` : ''}
      <p class="note">Plancher estimé = emprise × niveaux (connus ou déduits de la hauteur, 3 m par niveau).</p>
    </div>
    <div class="section">
      <h3>Hauteurs</h3>
      ${barres(s.hauteurs, ['< 6 m', '6 – 12 m', '12 – 18 m', '18 – 30 m', '30 – 50 m', '50 – 80 m', '≥ 80 m'])}
    </div>
    <div class="section">
      <h3>Époques de construction (part de l'emprise)</h3>
      ${barreEmpilee(epoques, s.emprise || 1)}
      <div class="legende">${epoques.map(([n, v, c]) => `<div class="item"><i style="background:${versCss(c)}"></i>${n} — ${Math.round((v / (s.emprise || 1)) * 100)} %</div>`).join('')}</div>
    </div>
    <div class="section">
      <h3>Usages (part de l'emprise)</h3>
      <table class="tableau">${usages.map(([u, v]) => `<tr><th>${echapper(u)}</th><td>${Math.round((v / (s.emprise || 1)) * 100)} %</td></tr>`).join('')}</table>
    </div>
    <div class="section">
      <h3>Origine des hauteurs</h3>
      <table class="tableau">${[...s.sourcesH.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        `<tr><th>${echapper(SOURCES_HAUTEUR[k] || k)}</th><td>${pluriel(v, 'bâtiment')}</td></tr>`).join('')}</table>
    </div>
    <div class="section">
      <h3>Exporter</h3>
      <p class="aide">Enregistre les bâtiments de la zone (GeoJSON) dans le dossier data/zones de l'atlas.</p>
      <button class="bouton" id="zone-exporter">Enregistrer la zone</button>
    </div>
  </div>`);
  el.querySelector('#zone-exporter').addEventListener('click', exporterZone);
  conteneur.appendChild(el);
}

async function exporterZone() {
  const z = etat.zone;
  const nomFichier = `${z.nom.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'zone'}.geojson`;
  const contenu = {
    type: 'FeatureCollection',
    atlas: { nom: z.nom, cadre: z.rect, exporte: new Date().toISOString(), sources: z.sources },
    features: z.batiments,
    parties: z.parties,
  };
  try {
    await enregistrerFichier(`zones/${nomFichier}`, JSON.stringify(contenu), 'application/geo+json');
    notifier(`Zone enregistrée : data/zones/${nomFichier}`);
  } catch (e) {
    notifier(`Enregistrement impossible : ${e.message}`, { type: 'erreur' });
  }
}

// Fiche du ou des bâtiments sélectionnés.
function ficheSelection(batiments) {
  if (!batiments.length) { fermerFiche(); return; }
  if (batiments.length === 1) {
    const p = batiments[0].properties;
    ouvrirFiche(p.n || 'Bâtiment', (c) => {
      const lv = p.lv || Math.max(1, Math.round((p.h || 3) / 3));
      const osm = /^[wr]\d+$/.test(p.id) ? `https://www.openstreetmap.org/${p.id[0] === 'w' ? 'way' : 'relation'}/${p.id.slice(1)}` : null;
      c.appendChild(html(`<div>
        <div class="infobulle" style="position:static;box-shadow:none;max-width:none;margin-bottom:12px">${htmlInfobulle(p)}</div>
        <table class="tableau">
          <tr><th>Emprise au sol</th><td>${entier(p.a)} m²</td></tr>
          <tr><th>Hauteur</th><td>${decimal(p.h)} m${p.mh ? ` (base à ${decimal(p.mh)} m)` : ''}</td></tr>
          ${p.hg ? `<tr><th>Hauteur à l'égout (BD TOPO)</th><td>${decimal(p.hg)} m</td></tr>` : ''}
          <tr><th>Niveaux</th><td>${lv}${p.lv ? '' : ' (estimés)'}</td></tr>
          <tr><th>Surface de plancher estimée</th><td>${entier(p.a * lv)} m²</td></tr>
          <tr><th>Volume estimé</th><td>${entier(p.a * ((p.h || 0) - (p.mh || 0)))} m³</td></tr>
          ${p.y ? `<tr><th>Année</th><td>${p.y}</td></tr>` : ''}
          ${p.u ? `<tr><th>Usage</th><td>${echapper(p.u)}</td></tr>` : ''}
          ${p.t ? `<tr><th>Type (OSM)</th><td>${echapper(p.t)}</td></tr>` : ''}
          ${p.lg ? `<tr><th>Logements</th><td>${entier(p.lg)}</td></tr>` : ''}
          <tr><th>Emprise issue de</th><td>${p.fs === 'b' ? 'IGN BD TOPO' : 'OpenStreetMap'}</td></tr>
          <tr><th>Hauteur issue de</th><td>${echapper(SOURCES_HAUTEUR[p.hs] || '—')}</td></tr>
        </table>
        <ul class="liens" style="margin-top:12px">
          ${osm ? `<li><a href="${osm}" target="_blank" rel="noopener" class="${etat.enLigne ? '' : 'hors-ligne'}">Voir dans OpenStreetMap</a></li>` : ''}
          ${p.rnb ? `<li><a href="https://rnb.beta.gouv.fr/carte?q=${encodeURIComponent(p.rnb)}" target="_blank" rel="noopener" class="${etat.enLigne ? '' : 'hors-ligne'}">Référentiel national des bâtiments (${echapper(p.rnb)})</a></li>` : ''}
        </ul>
        <p class="note">Maj+clic pour ajouter d'autres bâtiments à la sélection et additionner leurs surfaces.</p>
      </div>`));
    }, { quitter: () => {} });
    return;
  }
  const somme = (f) => batiments.reduce((acc, b) => acc + f(b.properties), 0);
  const emprise = somme((p) => p.a || 0);
  const plancher = somme((p) => (p.a || 0) * (p.lv || Math.max(1, Math.round((p.h || 3) / 3))));
  ouvrirFiche(`Sélection de ${batiments.length} bâtiments`, (c) => {
    c.appendChild(html(`<div>
      <div class="chiffres">
        <div class="chiffre"><strong>${entier(emprise)} m²</strong><span>emprise totale</span></div>
        <div class="chiffre"><strong>${entier(plancher)} m²</strong><span>plancher estimé</span></div>
        <div class="chiffre"><strong>${entier(somme((p) => (p.a || 0) * ((p.h || 0) - (p.mh || 0))))} m³</strong><span>volume estimé</span></div>
        <div class="chiffre"><strong>${decimal(Math.max(...batiments.map((b) => b.properties.h || 0)))} m</strong><span>hauteur maximale</span></div>
      </div>
      <table class="tableau" style="margin-top:12px">${batiments.map((b) =>
        `<tr><th>${echapper(b.properties.n || b.properties.id)}</th><td>${entier(b.properties.a)} m² · ${decimal(b.properties.h)} m</td></tr>`).join('')}</table>
      <button class="bouton" id="sel-vider" style="margin-top:12px">Vider la sélection</button>
    </div>`));
    c.querySelector('#sel-vider').addEventListener('click', () => effacerSelection());
  });
}

export function calculerStatistiques(zone) {
  zone.stats = statistiquesZone(zone.batiments, zone.rect);
}

export function initZoneStats() {
  enregistrerPanneau('stats', { titre: 'Zone étudiée', rendre });
  on('zone', () => rafraichirPanneau('stats'));
  on('selection-batiments', ficheSelection);
}
