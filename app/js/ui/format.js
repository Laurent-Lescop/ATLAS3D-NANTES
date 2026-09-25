// Mise en forme des nombres et textes (français).

const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

export const entier = (v) => (v == null || Number.isNaN(v) ? '—' : nf0.format(v));
export const decimal = (v, n = 1) => (v == null || Number.isNaN(v) ? '—' : (n === 2 ? nf2 : nf1).format(v));

export function surface(m2) {
  if (m2 == null) return '—';
  if (m2 >= 1e6) return `${nf2.format(m2 / 1e6)} km²`;
  if (m2 >= 1e4) return `${nf1.format(m2 / 1e4)} ha`;
  return `${nf0.format(m2)} m²`;
}

export function longueur(m) {
  if (m == null) return '—';
  return m >= 1000 ? `${nf2.format(m / 1000)} km` : `${nf0.format(m)} m`;
}

export function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Construit un élément DOM à partir d'un gabarit HTML (valeurs à échapper par l'appelant).
export function html(chaine) {
  const t = document.createElement('template');
  t.innerHTML = chaine.trim();
  return t.content.childElementCount === 1 ? t.content.firstElementChild : t.content;
}

export function pluriel(n, singulier, plurielMot = `${singulier}s`) {
  return `${entier(n)} ${Math.abs(n) >= 2 ? plurielMot : singulier}`;
}

export function etatDonnee(etat, date) {
  const libelles = { direct: 'En direct', observe: 'Observé', cache: 'Dernière valeur', perime: 'Dernière valeur', simule: 'Indicatif' };
  const titre = date ? ` title="${echapper(date.toLocaleString('fr-FR'))}"` : '';
  return `<span class="etat-donnee" data-etat="${echapper(etat)}"${titre}>${libelles[etat] || etat}</span>`;
}
