// Panneau « Réglages » : zones enregistrées, enregistrement des données temps réel.

import { etat, emit } from '../etat.js';
import { enregistrerPanneau, rafraichirPanneau } from '../ui/panneaux.js';
import { listerFichiers, lireJSON, supprimerFichier } from '../api.js';
import { html, echapper, surface } from '../ui/format.js';
import { notifier } from '../ui/notifications.js';

// Les modules peuvent ajouter leurs propres sections (ex. enregistreur, lot mobilités).
const sections = [];
export function ajouterSectionReglages(fn) { sections.push(fn); }

async function rendre(conteneur) {
  const zones = (await listerFichiers('zones')).filter((f) => f.nom.endsWith('.geojson'));
  const el = html(`<div>
    <div class="section">
      <h3>Zones enregistrées</h3>
      ${zones.length ? '' : '<p class="aide">Aucune zone enregistrée. Depuis le panneau « Zone », utilisez « Enregistrer la zone ».</p>'}
      <ul class="liste-lieux">${zones.map((z) => `<li style="display:flex;gap:6px">
        <button data-ouvrir="${echapper(z.nom)}"><span class="pastille" style="background:var(--accent)"></span>
          <span>${echapper(z.nom.replace(/\.geojson$/, ''))}<small>${new Date(z.modifie).toLocaleString('fr-FR')}</small></span></button>
        <button class="icone" data-supprimer="${echapper(z.nom)}" title="Supprimer"><svg><use href="#i-fermer"/></svg></button>
      </li>`).join('')}</ul>
    </div>
  </div>`);
  el.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-ouvrir]');
    const s = e.target.closest('[data-supprimer]');
    if (o) {
      try {
        const fc = await lireJSON(`/data/zones/${encodeURIComponent(o.dataset.ouvrir)}`);
        emit('ouvrir-zone-enregistree', fc);
      } catch (err) {
        notifier(`Lecture impossible : ${err.message}`, { type: 'erreur' });
      }
    }
    if (s && confirm(`Supprimer la zone « ${s.dataset.supprimer} » ?`)) {
      await supprimerFichier(`zones/${s.dataset.supprimer}`);
      rafraichirPanneau('reglages');
    }
  });
  conteneur.appendChild(el);
  for (const fn of sections) await fn(conteneur);
  if (etat.zone) {
    conteneur.appendChild(html(`<p class="note">Zone actuelle : ${echapper(etat.zone.nom)} (${surface(etat.zone.stats.aireZone)}).</p>`));
  }
}

export function initReglages() {
  enregistrerPanneau('reglages', { titre: 'Réglages', rendre });
}
