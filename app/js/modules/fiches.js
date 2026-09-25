// Fiches des lieux et des projets : panneau latéral à onglets (présentation,
// galerie, données, liens) et éditeur intégré (texte Markdown, images, liens).

import { marked } from '../../vendor/marked/marked.esm.js';
import DOMPurify from '../../vendor/dompurify/purify.es.mjs';
import { ouvrirFiche as ouvrirPanneau } from '../ui/panneaux.js';
import { etat } from '../etat.js';
import { enregistrerFichier } from '../api.js';
import { notifier } from '../ui/notifications.js';
import { html, echapper, entier, surface } from '../ui/format.js';

export const STATUTS = {
  existant: 'Existant',
  travaux: 'En travaux',
  projet: 'Projet',
  abandonne: 'Abandonné',
};

const CHAMPS = [
  ['architectes', 'Architectes'],
  ['maitreOuvrage', 'Maîtrise d\'ouvrage'],
  ['annee', 'Année(s)'],
  ['programme', 'Programme'],
  ['surface', 'Surface (m²)'],
  ['hauteur', 'Hauteur (m)'],
  ['adresse', 'Adresse'],
];

marked.setOptions({ gfm: true, breaks: false });

export function markdown(texte) {
  return DOMPurify.sanitize(marked.parse(texte || ''), { ADD_ATTR: ['target'] });
}

const lienSur = (url) => /^https?:\/\//i.test(url || '');

function cheminMedia(base, src) {
  if (!src) return '';
  if (/^(https?:)?\/\//.test(src) || src.startsWith('/')) return src;
  return `${base}${src}`;
}

// Visionneuse plein écran.
function agrandir(src, legende) {
  const voile = html(`<div class="visionneuse" role="dialog" aria-label="Image agrandie">
    <figure><img src="${echapper(src)}" alt=""><figcaption></figcaption></figure></div>`);
  voile.querySelector('figcaption').textContent = legende || '';
  const fermer = () => { voile.remove(); document.removeEventListener('keydown', echap); };
  const echap = (e) => { if (e.key === 'Escape') fermer(); };
  voile.addEventListener('click', fermer);
  document.addEventListener('keydown', echap);
  document.body.appendChild(voile);
}

function avantApres(base, avant, apres) {
  const el = html(`<div class="avant-apres">
    <img src="${echapper(cheminMedia(base, avant.src))}" alt="Avant">
    <img class="apres" src="${echapper(cheminMedia(base, apres.src))}" alt="Après">
    <div class="poignee"></div>
    <input type="range" min="0" max="100" value="50" aria-label="Comparer avant et après">
  </div>`);
  const maj = (v) => {
    el.querySelector('.apres').style.clipPath = `inset(0 0 0 ${v}%)`;
    el.querySelector('.poignee').style.left = `${v}%`;
  };
  el.querySelector('input').addEventListener('input', (e) => maj(+e.target.value));
  return el;
}

// lieu : { id, type, titre, statut, categorie, fiche: { …champs, texte, images, liens, sources }, donnees: [[libellé, valeur]] }
// options : { base, voir3d, enregistrer(meta, texte), actions: [{ libelle, fn }] }
export function afficherFiche(lieu, options = {}) {
  const f = lieu.fiche || {};
  const base = options.base || '';
  const images = f.images || [];
  const liens = (f.liens || []).filter((l) => lienSur(l.url));
  ouvrirPanneau(lieu.titre || f.titre || 'Lieu', (c) => {
    const avant = images.find((i) => i.role === 'avant');
    const apres = images.find((i) => i.role === 'apres');
    const principale = images.find((i) => i.role !== 'avant') || images[0];
    const faits = CHAMPS.filter(([k]) => f[k] != null && f[k] !== '');
    const categorie = lieu.categorie || f.categorie || '';
    const statut = lieu.statut || f.statut || '';
    const libelleStatut = STATUTS[statut] || statut;
    const el = html(`<div>
      ${principale ? `<figure class="fiche-image" style="background-image:url('${echapper(cheminMedia(base, principale.src))}')">
        ${principale.credit ? `<figcaption>© ${echapper(principale.credit)}</figcaption>` : ''}</figure>` : ''}
      <div class="fiche-badges">
        ${categorie && categorie.toLowerCase() !== libelleStatut.toLowerCase() ? `<span class="fiche-badge">${echapper(categorie)}</span>` : ''}
        ${statut ? `<span class="fiche-badge statut-${echapper(statut)}">${echapper(libelleStatut)}</span>` : ''}
        ${f.annee ? `<span class="fiche-badge">${echapper(f.annee)}</span>` : ''}
      </div>
      <div class="onglets" role="tablist">
        <button data-onglet="presentation" class="actif">Présentation</button>
        ${images.length ? `<button data-onglet="galerie">Galerie (${images.length})</button>` : ''}
        <button data-onglet="donnees">Données</button>
        ${liens.length || f.sources?.length ? '<button data-onglet="liens">Liens</button>' : ''}
      </div>
      <section data-page="presentation">
        ${faits.length ? `<table class="tableau">${faits.map(([k, n]) => `<tr><th>${n}</th><td>${echapper(k === 'surface' ? `${entier(f[k])} m²` : k === 'hauteur' ? `${f[k]} m` : f[k])}</td></tr>`).join('')}</table>` : ''}
        <div class="fiche-texte">${f.texte ? markdown(f.texte) : '<p class="aide">Pas encore de texte pour ce lieu.</p>'}</div>
      </section>
      <section data-page="galerie" hidden>
        <div class="zone-avant-apres"></div>
        <div class="galerie">${images.map((im, i) => `<figure><img data-i="${i}" src="${echapper(cheminMedia(base, im.src))}" alt="${echapper(im.legende || '')}" loading="lazy">
          <figcaption>${echapper(im.legende || '')}${im.credit ? ` — © ${echapper(im.credit)}` : ''}</figcaption></figure>`).join('')}</div>
      </section>
      <section data-page="donnees" hidden>
        <table class="tableau">
          ${(lieu.donnees || []).map(([k, v]) => `<tr><th>${echapper(k)}</th><td>${echapper(v)}</td></tr>`).join('')}
          ${faits.map(([k, n]) => `<tr><th>${n}</th><td>${echapper(f[k])}</td></tr>`).join('')}
        </table>
      </section>
      <section data-page="liens" hidden>
        <ul class="liens">${liens.map((l) => `<li><a href="${echapper(l.url)}" target="_blank" rel="noopener" class="${etat.enLigne ? '' : 'hors-ligne'}">
          <svg><use href="#i-lien"/></svg>${echapper(l.titre || l.url)}</a></li>`).join('')}</ul>
        ${!etat.enLigne && liens.length ? '<p class="note">Hors connexion : les liens externes s\'ouvriront une fois en ligne.</p>' : ''}
        ${f.sources?.length ? `<h3 class="sous-titre">Sources</h3><ul class="liens">${f.sources.map((s) => `<li>${lienSur(s) ? `<a href="${echapper(s)}" target="_blank" rel="noopener">${echapper(s)}</a>` : echapper(s)}</li>`).join('')}</ul>` : ''}
      </section>
      <div class="boutons-fiche">
        ${options.voir3d ? '<button class="bouton" data-action="voir3d"><svg><use href="#i-camera"/></svg><span>Voir en 3D</span></button>' : ''}
        ${(options.actions || []).map((a, i) => `<button class="bouton" data-action-sup="${i}">${echapper(a.libelle)}</button>`).join('')}
        ${options.enregistrer ? '<button class="bouton discret" data-action="modifier">Modifier la fiche</button>' : ''}
      </div>
    </div>`);
    if (avant && apres) el.querySelector('.zone-avant-apres').appendChild(avantApres(base, avant, apres));
    el.querySelector('.onglets').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-onglet]');
      if (!b) return;
      el.querySelectorAll('.onglets button').forEach((x) => x.classList.toggle('actif', x === b));
      el.querySelectorAll('section[data-page]').forEach((s) => { s.hidden = s.dataset.page !== b.dataset.onglet; });
    });
    el.querySelectorAll('.galerie img').forEach((img) => img.addEventListener('click', () => {
      const im = images[+img.dataset.i];
      agrandir(img.src, [im.legende, im.credit && `© ${im.credit}`].filter(Boolean).join(' — '));
    }));
    el.querySelector('[data-action="voir3d"]')?.addEventListener('click', options.voir3d);
    el.querySelectorAll('[data-action-sup]').forEach((b) => b.addEventListener('click', () => options.actions[+b.dataset.actionSup].fn()));
    el.querySelector('[data-action="modifier"]')?.addEventListener('click', () => editer(lieu, options));
    c.appendChild(el);
  });
}

// --- Éditeur ---------------------------------------------------------------------------------

function editer(lieu, options) {
  const f = { ...(lieu.fiche || {}) };
  const images = [...(f.images || [])];
  const base = options.base || '';
  ouvrirPanneau(`Modifier : ${lieu.titre || f.titre || 'lieu'}`, (c) => {
    const el = html(`<form class="editeur">
      <label class="champ"><span>Titre</span><input type="text" name="titre" required value="${echapper(f.titre || lieu.titre || '')}"></label>
      <label class="champ"><span>Statut</span><select name="statut">
        ${Object.entries(STATUTS).map(([k, n]) => `<option value="${k}" ${(f.statut || lieu.statut) === k ? 'selected' : ''}>${n}</option>`).join('')}
      </select></label>
      <label class="champ"><span>Catégorie</span><input type="text" name="categorie" value="${echapper(f.categorie || lieu.categorie || '')}"></label>
      ${CHAMPS.map(([k, n]) => `<label class="champ"><span>${n}</span><input type="text" name="${k}" value="${echapper(f[k] ?? '')}"></label>`).join('')}
      <label class="champ"><span>Texte (Markdown : **gras**, *italique*, ## titre, listes « - »)</span>
        <textarea name="texte" rows="10">${echapper(f.texte || '')}</textarea></label>
      <label class="champ"><span>Liens (un par ligne : titre | adresse)</span>
        <textarea name="liens" rows="3">${echapper((f.liens || []).map((l) => `${l.titre || ''} | ${l.url}`).join('\n'))}</textarea></label>
      <div class="champ"><span>Images</span><div class="liste-images"></div>
        <label class="bouton" style="margin-top:6px">Ajouter des images<input type="file" accept="image/*" multiple hidden></label></div>
      <div class="boutons-fiche">
        <button class="bouton principal" type="submit">Enregistrer</button>
        <button class="bouton" type="button" data-action="annuler">Annuler</button>
      </div>
    </form>`);
    const liste = el.querySelector('.liste-images');
    const dessinerImages = () => {
      liste.replaceChildren(...images.map((im, i) => {
        const ligne = html(`<div class="ligne-image">
          <img src="${echapper(cheminMedia(base, im.src))}" alt="">
          <div><input type="text" data-k="legende" placeholder="Légende" value="${echapper(im.legende || '')}">
          <input type="text" data-k="credit" placeholder="Crédit" value="${echapper(im.credit || '')}">
          <select data-k="role"><option value="">Illustration</option><option value="avant" ${im.role === 'avant' ? 'selected' : ''}>Avant (comparaison)</option>
            <option value="apres" ${im.role === 'apres' ? 'selected' : ''}>Après (comparaison)</option></select></div>
          <button type="button" class="icone" title="Retirer"><svg><use href="#i-fermer"/></svg></button></div>`);
        ligne.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('input', () => { images[i][inp.dataset.k] = inp.value; }));
        ligne.querySelector('button').addEventListener('click', () => { images.splice(i, 1); dessinerImages(); });
        return ligne;
      }));
    };
    dessinerImages();
    el.querySelector('input[type="file"]').addEventListener('change', async (e) => {
      for (const fichier of e.target.files) {
        const nom = `${Date.now().toString(36)}-${fichier.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-')}`;
        try {
          await enregistrerFichier(`${options.dossierMedias}/${nom}`, fichier, fichier.type);
          images.push({ src: `${options.prefixeMedias}${nom}`, legende: '', credit: '' });
        } catch (err) {
          notifier(`Image non enregistrée : ${err.message}`, { type: 'erreur' });
        }
      }
      dessinerImages();
    });
    el.querySelector('[data-action="annuler"]').addEventListener('click', () => afficherFiche(lieu, options));
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = new FormData(el);
      const meta = { titre: d.get('titre').trim(), statut: d.get('statut'), categorie: d.get('categorie').trim() };
      for (const [k] of CHAMPS) if (d.get(k).trim()) meta[k] = d.get(k).trim();
      meta.liens = d.get('liens').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter(([, u]) => lienSur(u))
        .map(([titre, url]) => ({ titre, url }));
      meta.images = images.filter((i) => i.src);
      try {
        await options.enregistrer(meta, d.get('texte'));
        notifier('Fiche enregistrée.');
      } catch (err) {
        notifier(`Enregistrement impossible : ${err.message}`, { type: 'erreur' });
      }
    });
    c.appendChild(el);
  });
}

export function resumeProjet(p) {
  const i = p.infos || {};
  return [
    ['Maquette', p.nomIfc || 'IFC'],
    ['Schéma IFC', i.schema || '—'],
    ['Niveaux', i.niveaux?.length ? `${i.niveaux.length} (${i.niveaux.slice(0, 3).map((n) => n.nom).join(', ')}${i.niveaux.length > 3 ? '…' : ''})` : '—'],
    ['Surface des espaces', i.surfaceNette ? `${surface(i.surfaceNette)} nets${i.surfaceBrute ? `, ${surface(i.surfaceBrute)} bruts` : ''}` : '—'],
    ['Dimensions', p.dimensions ? `${p.dimensions.map((v) => Math.round(v)).join(' × ')} m` : '—'],
    ['Éléments affichés', Object.values(p.classes || {}).reduce((a, b) => a + b, 0).toString()],
    ['Triangles', entier(i.triangles)],
    ['Calage', p.placement?.note || p.placement?.mode || '—'],
  ];
}
