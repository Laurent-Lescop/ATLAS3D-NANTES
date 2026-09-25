// État partagé de l'atlas et bus d'événements minimal.

export const etat = {
  mode: 'selection',        // 'selection' (choix du cadre) | 'etude' (zone validée)
  zone: null,               // { nom, rect, batiments, parties, stats, source }
  enLigne: false,
  temps: null,              // { date: Date, auto: bool } — voir soleil.js
  soleil: null,             // { azimut, hauteur, jour: 0..1 }
  reglages: {
    ombres: true,
    coloration: 'maquette', // maquette | hauteur | epoque | usage | source
    contexte3d: false,
    etiquettes: true,
    pictogrammes: false,
    aretes: true,
    courseSoleil: false,
    nuagesReels: true,
  },
};

const ecouteurs = new Map();

export function on(evenement, fn) {
  if (!ecouteurs.has(evenement)) ecouteurs.set(evenement, new Set());
  ecouteurs.get(evenement).add(fn);
  return () => ecouteurs.get(evenement)?.delete(fn);
}

export function emit(evenement, donnees) {
  for (const fn of ecouteurs.get(evenement) || []) {
    try { fn(donnees); } catch (e) { console.error(`Erreur dans « ${evenement} »`, e); }
  }
}

// Préférences mémorisées dans le navigateur (facultatif : l'atlas fonctionne sans).
export function lirePreference(cle, defaut) {
  try {
    const v = localStorage.getItem(`atlas.${cle}`);
    return v == null ? defaut : JSON.parse(v);
  } catch { return defaut; }
}

export function ecrirePreference(cle, valeur) {
  try { localStorage.setItem(`atlas.${cle}`, JSON.stringify(valeur)); } catch { /* stockage indisponible */ }
}
