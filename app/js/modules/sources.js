// Panneau « Sources » : origine des données, licences, fraîcheur du pack local.

import { enregistrerPanneau } from '../ui/panneaux.js';
import { lireJSON } from '../api.js';
import { html, echapper, entier } from '../ui/format.js';
import { indexBatiments } from '../carte/zone.js';

const DONNEES = [
  ['Fond de carte et emprises des bâtiments', '© contributeurs OpenStreetMap', 'ODbL', 'https://www.openstreetmap.org/copyright'],
  ['Tuiles vectorielles', 'Protomaps (construction quotidienne)', 'ODbL / BSD', 'https://protomaps.com'],
  ['Hauteurs, dates, usages des bâtiments', 'IGN — BD TOPO (Géoplateforme)', 'Licence Ouverte 2.0', 'https://geoservices.ign.fr/bdtopo'],
  ['Météo, archives climatiques, qualité de l\'air', 'Open-Meteo (ECMWF, ERA5, CAMS)', 'CC BY 4.0', 'https://open-meteo.com'],
  ['Hauteur de la Loire', 'Hub\'Eau — Vigicrues (Pont Anne-de-Bretagne)', 'Licence Ouverte 2.0', 'https://hubeau.eaufrance.fr'],
  ['Fluidité du trafic, parkings', 'Nantes Métropole — données ouvertes', 'ODbL', 'https://data.nantesmetropole.fr'],
  ['Transports Naolib (horaires, temps réel)', 'Nantes Métropole / transport.data.gouv.fr', 'ODbL', 'https://transport.data.gouv.fr'],
  ['Vélos en libre-service Naolib', 'JCDecaux (flux GBFS)', 'Licence Ouverte / ODbL', 'https://transport.data.gouv.fr'],
  ['Calendrier scolaire', 'Ministère de l\'Éducation nationale', 'Licence Ouverte 2.0', 'https://data.education.gouv.fr'],
];

async function rendre(conteneur) {
  const idx = indexBatiments();
  let fond = null, versions = {};
  try { fond = await lireJSON('/data/fond/source.json'); } catch { /* facultatif */ }
  try { versions = await lireJSON('/vendor/versions.json'); } catch { /* facultatif */ }
  const el = html(`<div>
    <div class="section">
      <h3>Données</h3>
      <table class="tableau">${DONNEES.map(([quoi, qui, lic, url]) =>
        `<tr><th>${echapper(quoi)}</th><td><a href="${url}" target="_blank" rel="noopener">${echapper(qui)}</a><br><small>${echapper(lic)}</small></td></tr>`).join('')}</table>
    </div>
    <div class="section">
      <h3>Pack local</h3>
      <table class="tableau">
        ${fond ? `<tr><th>Fond de carte</th><td>Construction ${echapper(fond.construction?.replace('.pmtiles', ''))}</td></tr>` : ''}
        ${idx ? `<tr><th>Bâtiments</th><td>${entier(idx.stats.batiments)} bâtiments, préparés le ${new Date(idx.genere).toLocaleDateString('fr-FR')}</td></tr>
        <tr><th>Emprise du pack</th><td>${idx.emprise.map((v) => v.toFixed(2)).join(' ; ')}</td></tr>` : '<tr><th>Bâtiments</th><td>pack absent</td></tr>'}
      </table>
      <p class="note">Pour mettre à jour : <code>npm run donnees</code> (voir LISEZMOI).</p>
    </div>
    <div class="section">
      <h3>Logiciels libres</h3>
      <table class="tableau">${Object.entries(versions).map(([lib, v]) =>
        `<tr><th>${echapper(lib)}</th><td>${echapper(v.version)} — ${echapper(v.licence)}</td></tr>`).join('')}</table>
    </div>
  </div>`);
  conteneur.appendChild(el);
}

export function initSources() {
  enregistrerPanneau('apropos', { titre: 'Sources et crédits', rendre });
}
