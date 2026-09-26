// Panneau « Affichage » : coloration des bâtiments, ombres, contexte, étiquettes.

import { etat, emit, ecrirePreference } from '../etat.js';
import { enregistrerPanneau, rafraichirPanneau } from '../ui/panneaux.js';
import { afficherContexte3D, afficherEtiquettes, afficherPictogrammes, obtenirCarte } from '../carte/fond.js';
import { afficherCourseSoleil } from '../carte/soleil.js';
import { RAMPE_HAUTEUR, USAGES, COULEURS_SOURCE } from '../carte/batiments3d.js';
import { EPOQUES } from '../carte/zone.js';
import { SOURCES_HAUTEUR } from '../lib/batiments-core.js';
import { rampeCss, versCss } from '../lib/couleurs.js';
import { html, echapper } from '../ui/format.js';
import { capAligne } from '../lib/geo.js';

const COLORATIONS = [
  ['maquette', 'Maquette'], ['hauteur', 'Hauteur'], ['epoque', 'Époque'], ['usage', 'Usage'], ['source', 'Source'],
];

function legende() {
  switch (etat.reglages.coloration) {
    case 'hauteur':
      return `<div class="legende"><div class="rampe" style="background:${rampeCss(RAMPE_HAUTEUR)}"></div>
        <div class="bornes"><span>0 m</span><span>30 m</span><span>90 m et plus</span></div></div>`;
    case 'epoque':
      return `<div class="legende">${EPOQUES.map(([n, c]) => `<div class="item"><i style="background:${versCss(c)}"></i>${n}</div>`).join('')}
        <p class="note">Année de construction : balise OSM « start_date », sinon date d'apparition BD TOPO (souvent issue des fichiers fonciers).</p></div>`;
    case 'usage':
      return `<div class="legende">${USAGES.map(([n, c]) => `<div class="item"><i style="background:${versCss(c)}"></i>${n}</div>`).join('')}
        <p class="note">Usage principal selon la BD TOPO de l'IGN.</p></div>`;
    case 'source':
      return `<div class="legende">${Object.entries(COULEURS_SOURCE).map(([k, c]) =>
        `<div class="item"><i style="background:${versCss(c)}"></i>${echapper(SOURCES_HAUTEUR[k])}</div>`).join('')}</div>`;
    default:
      return '<p class="note">Rendu « maquette blanche ». Les sites remarquables ressortent en cuivre, les projets en bleu.</p>';
  }
}

function interrupteur(cle, libelle, aide = '') {
  return `<label class="interrupteur"><input type="checkbox" data-reglage="${cle}" ${etat.reglages[cle] ? 'checked' : ''}>
    <span>${libelle}${aide ? `<small>${aide}</small>` : ''}</span></label>`;
}

function rendre(conteneur) {
  const el = html(`<div>
    <div class="section">
      <h3>Coloration des bâtiments</h3>
      <div class="segments" id="aff-coloration">
        ${COLORATIONS.map(([k, n]) => `<button data-v="${k}" class="${etat.reglages.coloration === k ? 'actif' : ''}">${n}</button>`).join('')}
      </div>
      ${legende()}
    </div>
    <div class="section">
      <h3>Rendu</h3>
      ${interrupteur('ombres', 'Ombres portées', 'Calculées selon la position réelle du soleil')}
      ${interrupteur('aretes', 'Arêtes des volumes', 'Souligne les volumes façon maquette')}
      ${interrupteur('courseSoleil', 'Course du soleil', 'Trajectoire du jour choisi au-dessus de la zone')}
      ${interrupteur('nuagesReels', 'Nuages réels', 'La nébulosité prévue ou observée adoucit le soleil et les ombres')}
      ${interrupteur('contexte3d', 'Bâtiments hors zone en 3D', 'Volumes simplifiés du fond de carte')}
      ${interrupteur('etiquettes', 'Noms des rues et des lieux')}
      ${interrupteur('etiquettesLieux', 'Sites remarquables et projets', 'Pastilles et noms des lieux de l\'atlas')}
      ${interrupteur('quartiers', 'Limites des quartiers', 'Quartiers de Nantes et des communes voisines')}
      ${interrupteur('pictogrammes', 'Commerces et services', 'Pictogrammes du fond de carte OpenStreetMap')}
    </div>
    <div class="section">
      <h3>Vue</h3>
      <div class="segments" id="aff-vue">
        <button data-vue="dessus">Vue de dessus</button>
        <button data-vue="3d">Vue 3D</button>
        <button data-vue="aligner">Aligner sur la zone</button>
        <button data-vue="soleil">Face au soleil</button>
      </div>
    </div>
  </div>`);
  el.querySelector('#aff-coloration').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    etat.reglages.coloration = b.dataset.v;
    sauver();
    emit('reglages', etat.reglages);
    rafraichirPanneau('affichage');
  });
  el.querySelectorAll('[data-reglage]').forEach((input) => input.addEventListener('change', () => {
    const cle = input.dataset.reglage;
    etat.reglages[cle] = input.checked;
    sauver();
    appliquerReglage(cle);
    emit('reglages', etat.reglages);
  }));
  el.querySelector('#aff-vue').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const carte = obtenirCarte();
    if (!b || !carte) return;
    if (b.dataset.vue === 'dessus') carte.easeTo({ pitch: 0, duration: 800 });
    if (b.dataset.vue === '3d') carte.easeTo({ pitch: 60, duration: 800 });
    if (b.dataset.vue === 'aligner' && etat.zone) carte.easeTo({ bearing: capAligne(etat.zone.rect), duration: 800 });
    if (b.dataset.vue === 'soleil' && etat.soleil) {
      carte.easeTo({ bearing: etat.soleil.azimut, pitch: Math.max(carte.getPitch(), 50), duration: 1000 });
    }
  });
  conteneur.appendChild(el);
}

function sauver() {
  ecrirePreference('reglages', etat.reglages);
}

export function appliquerReglage(cle) {
  const v = etat.reglages[cle];
  if (cle === 'contexte3d') afficherContexte3D(v);
  if (cle === 'etiquettes') afficherEtiquettes(v);
  if (cle === 'pictogrammes') afficherPictogrammes(v);
  if (cle === 'courseSoleil') afficherCourseSoleil(v);
}

export function initAffichage() {
  enregistrerPanneau('affichage', { titre: 'Affichage', rendre });
  for (const cle of ['contexte3d', 'etiquettes', 'pictogrammes', 'courseSoleil']) appliquerReglage(cle);
}
