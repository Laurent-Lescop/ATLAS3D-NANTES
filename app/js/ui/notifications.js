// Messages courts en haut de l'écran.

const conteneur = () => document.getElementById('notifications');

export function notifier(message, { type = 'info', duree = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  conteneur().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duree);
}

// Bandeau de progression (chargement d'une zone…). Renvoie { maj(texte), fin() }.
export function progression(texte) {
  const el = document.createElement('div');
  el.className = 'bandeau-progression';
  el.textContent = texte;
  document.body.appendChild(el);
  return {
    maj(t) { el.textContent = t; },
    fin() { el.remove(); },
  };
}

// Écran de démarrage.
export function chargement(message, fraction) {
  const m = document.getElementById('chargement-message');
  const p = document.getElementById('chargement-progression');
  if (m && message) m.textContent = message;
  if (p && fraction != null) p.style.width = `${Math.round(fraction * 100)}%`;
}

export function finChargement() {
  const el = document.getElementById('chargement');
  if (!el) return;
  el.classList.add('fini');
  setTimeout(() => el.remove(), 500);
}
