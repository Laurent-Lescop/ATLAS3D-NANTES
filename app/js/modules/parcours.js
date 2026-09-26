// Parcours commentés : suite d'étapes (caméra, heure, lieu, commentaire) sur une zone
// d'étude dédiée. Lecture pas à pas ou automatique.

import { etat, emit, on } from '../etat.js';
import { lireJSON } from '../api.js';
import { enregistrerPanneau, ouvrirFiche, fermerFiche } from '../ui/panneaux.js';
import { obtenirCarte } from '../carte/fond.js';
import { definirHeure, heuresSoleil } from '../carte/soleil.js';
import { contientPoint } from '../lib/geo.js';
import { html, echapper } from '../ui/format.js';
import { notifier } from '../ui/notifications.js';
import { markdown } from './fiches.js';
import { listeSites, ouvrirSite } from './lieux.js';

let parcours = [];
let courant = null; // { p, i, auto, minuterie }

const lieuDe = (id) => listeSites().find((s) => s.id === id);

// La zone d'étude doit contenir toutes les étapes du parcours ; sinon on charge celle du parcours.
function zoneAdaptee(p) {
  if (etat.mode !== 'etude' || !etat.zone) return false;
  return p.etapes.every((e) => contientPoint(etat.zone.rect, e.camera.centre));
}

function attendreZone(delai = 120000) {
  return new Promise((resolve, reject) => {
    const arret = on('zone', () => { clearTimeout(fin); arret(); resolve(); });
    const fin = setTimeout(() => { arret(); reject(new Error('zone non chargée')); }, delai);
  });
}

function heureEtape(h) {
  if (h == null) return null;
  if (typeof h === 'number') return h;
  const s = heuresSoleil();
  if (h === 'coucher') return s.coucher - 25;
  if (h === 'lever') return s.lever + 25;
  if (h === 'midi') return s.midi;
  return null;
}

function tempsLecture(texte) {
  const mots = (texte || '').split(/\s+/).length;
  return Math.max(7000, mots * 330) + 3500;
}

function arreterMinuterie() {
  if (courant?.minuterie) clearTimeout(courant.minuterie);
  if (courant) courant.minuterie = null;
}

function programmerSuite() {
  arreterMinuterie();
  if (!courant?.auto) return;
  const e = courant.p.etapes[courant.i];
  courant.minuterie = setTimeout(() => {
    if (courant.i < courant.p.etapes.length - 1) aller(courant.i + 1);
    else { courant.auto = false; afficherEtape(); }
  }, tempsLecture(e.texte));
}

function afficherEtape() {
  const { p, i } = courant;
  // Chaque étape rouvre le panneau : seul le dernier affichage peut clore le parcours.
  const jeton = {};
  courant.jeton = jeton;
  const e = p.etapes[i];
  const lieu = lieuDe(e.lieu);
  ouvrirFiche(p.titre, (c) => {
    const el = html(`<div class="parcours-etape">
      <div class="parcours-progression" role="list">
        ${p.etapes.map((x, k) => `<button role="listitem" data-k="${k}" class="${k === i ? 'actif' : k < i ? 'vu' : ''}" title="${echapper(x.titre)}"></button>`).join('')}
      </div>
      <p class="parcours-numero">Étape ${i + 1} sur ${p.etapes.length}</p>
      <h3>${echapper(e.titre)}</h3>
      <div class="fiche-texte">${markdown(e.texte)}</div>
      <div class="boutons-fiche">
        <button class="bouton" data-action="prec" ${i === 0 ? 'disabled' : ''} aria-label="Étape précédente">‹ Précédente</button>
        <button class="bouton principal" data-action="suiv" ${i === p.etapes.length - 1 ? 'disabled' : ''}>Suivante ›</button>
        <button class="bouton" data-action="auto">${courant.auto ? 'Pause' : 'Lecture automatique'}</button>
        ${lieu ? '<button class="bouton discret" data-action="fiche">Voir la fiche du lieu</button>' : ''}
        <button class="bouton discret" data-action="quitter">Quitter le parcours</button>
      </div>
    </div>`);
    el.querySelector('.parcours-progression').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-k]');
      if (b) aller(+b.dataset.k);
    });
    el.querySelector('[data-action="prec"]').addEventListener('click', () => aller(i - 1));
    el.querySelector('[data-action="suiv"]').addEventListener('click', () => aller(i + 1));
    el.querySelector('[data-action="auto"]').addEventListener('click', () => {
      courant.auto = !courant.auto;
      if (courant.auto && i === p.etapes.length - 1) { aller(0); return; }
      afficherEtape();
      programmerSuite();
    });
    el.querySelector('[data-action="fiche"]')?.addEventListener('click', () => { const l = lieu; quitter(); ouvrirSite(l); });
    el.querySelector('[data-action="quitter"]').addEventListener('click', () => { quitter(); fermerFiche(); });
    c.appendChild(el);
  }, { quitter: () => { if (courant?.jeton === jeton) quitter(); } });
}

function aller(i) {
  if (!courant) return;
  const { p } = courant;
  courant.i = Math.max(0, Math.min(p.etapes.length - 1, i));
  const e = p.etapes[courant.i];
  const h = heureEtape(e.heure);
  if (h != null) definirHeure(h);
  const cam = e.camera;
  obtenirCarte().flyTo({ center: cam.centre, zoom: cam.zoom, pitch: cam.pitch ?? 60, bearing: cam.bearing ?? 0, duration: 3200, essential: true });
  emit('parcours-etape', { parcours: p.id, etape: courant.i, lieu: e.lieu });
  afficherEtape();
  programmerSuite();
}

function quitter() {
  arreterMinuterie();
  courant = null;
}

export async function lancerParcours(id, { auto = false } = {}) {
  const p = parcours.find((x) => x.id === id);
  if (!p) return;
  if (!zoneAdaptee(p)) {
    notifier(`Chargement de la zone du parcours « ${p.titre} »…`);
    const attente = attendreZone();
    emit('etudier-cadre', { cadre: p.cadre, nom: p.titre });
    try { await attente; } catch { notifier('La zone du parcours n\'a pas pu être chargée.', { type: 'erreur' }); return; }
    await new Promise((r) => setTimeout(r, 2400)); // laisse la caméra finir le cadrage
  }
  courant = { p, i: 0, auto, minuterie: null };
  aller(0);
}

function rendre(conteneur) {
  const el = html(`<div>
    <p class="aide">Des visites guidées de la ville en 3D : la caméra, l'heure et la lumière changent à chaque étape.
      Chaque parcours charge sa propre zone d'étude.</p>
    <ul class="liste-parcours">${parcours.map((p) => `<li>
      <h3>${echapper(p.titre)}</h3>
      <p>${echapper(p.resume || '')}</p>
      <p class="note">${p.etapes.length} étapes${p.duree ? ` · environ ${echapper(p.duree)}` : ''}</p>
      <div class="boutons-fiche">
        <button class="bouton principal" data-lancer="${echapper(p.id)}">Commencer</button>
        <button class="bouton" data-auto="${echapper(p.id)}">Lecture automatique</button>
      </div></li>`).join('') || '<li class="aide">Aucun parcours (data/editorial/parcours.json).</li>'}</ul>
  </div>`);
  el.querySelectorAll('[data-lancer]').forEach((b) => b.addEventListener('click', () => lancerParcours(b.dataset.lancer)));
  el.querySelectorAll('[data-auto]').forEach((b) => b.addEventListener('click', () => lancerParcours(b.dataset.auto, { auto: true })));
  conteneur.appendChild(el);
}

export async function initParcours() {
  parcours = await lireJSON('/data/editorial/parcours.json').catch(() => []);
  enregistrerPanneau('parcours', { titre: 'Parcours commentés', rendre });
  // Une interaction manuelle avec la carte met la lecture automatique en pause.
  const carte = obtenirCarte();
  for (const ev of ['dragstart', 'wheel', 'touchstart']) {
    carte.on(ev, (e) => {
      if (!courant?.auto || !e.originalEvent) return;
      courant.auto = false;
      arreterMinuterie();
      afficherEtape();
    });
  }
}
