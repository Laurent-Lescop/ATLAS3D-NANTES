// Panneau gauche (outils du rail) et panneau droit (fiches, détails).

const modules = new Map(); // nom → { titre, rendre(conteneur), quitter?() }
let actif = null;

export function enregistrerPanneau(nom, def) {
  modules.set(nom, def);
}

export function ouvrirPanneau(nom) {
  const def = modules.get(nom);
  if (!def) return;
  const panneau = document.getElementById('panneau-gauche');
  const contenu = document.getElementById('panneau-gauche-contenu');
  if (actif && actif !== nom) modules.get(actif)?.quitter?.();
  actif = nom;
  document.getElementById('panneau-gauche-titre').textContent = def.titre;
  contenu.innerHTML = '';
  contenu.scrollTop = 0;
  def.rendre(contenu);
  panneau.hidden = false;
  document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('actif', b.dataset.panneau === nom));
}

export function fermerPanneau() {
  if (actif) modules.get(actif)?.quitter?.();
  actif = null;
  document.getElementById('panneau-gauche').hidden = true;
  document.querySelectorAll('#rail button').forEach((b) => b.classList.remove('actif'));
}

// Redessine le panneau s'il est ouvert (données mises à jour).
export function rafraichirPanneau(nom) {
  if (actif !== nom) return;
  const contenu = document.getElementById('panneau-gauche-contenu');
  const defil = contenu.scrollTop;
  contenu.innerHTML = '';
  modules.get(nom).rendre(contenu);
  contenu.scrollTop = defil;
}

export const panneauActif = () => actif;

let fermetureDroite = null;

export function ouvrirFiche(titre, rendre, { quitter } = {}) {
  fermetureDroite?.();
  fermetureDroite = quitter || null;
  document.getElementById('panneau-droit-titre').textContent = titre;
  const contenu = document.getElementById('panneau-droit-contenu');
  contenu.innerHTML = '';
  contenu.scrollTop = 0;
  rendre(contenu);
  document.getElementById('panneau-droit').hidden = false;
}

export function fermerFiche() {
  fermetureDroite?.();
  fermetureDroite = null;
  document.getElementById('panneau-droit').hidden = true;
}

export function initPanneaux() {
  document.getElementById('rail').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-panneau]');
    if (!b) return;
    if (actif === b.dataset.panneau) fermerPanneau();
    else ouvrirPanneau(b.dataset.panneau);
  });
  document.querySelectorAll('[data-fermer]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.fermer === 'panneau-gauche') fermerPanneau();
    else fermerFiche();
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('panneau-droit').hidden) fermerFiche();
    else fermerPanneau();
  });
}
