// Accès au serveur local : état, sources relayées, fichiers.

import { etat, emit } from './etat.js';

export class HorsLigneError extends Error {}

// Lit une source relayée par le serveur (/api/proxy/<nom>).
// Renvoie { donnees, etat: 'direct' | 'cache' | 'perime', date: Date }.
export async function lireSource(nom, params = {}, { format = 'json', signal } = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/proxy/${nom}${qs ? `?${qs}` : ''}`, { signal });
  if (res.status === 503) throw new HorsLigneError(`${nom} : hors ligne, pas de donnée en cache`);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).erreur || msg; } catch { /* réponse non JSON */ }
    throw new Error(`${nom} : ${msg}`);
  }
  const donnees = format === 'json' ? await res.json() : format === 'texte' ? await res.text() : await res.arrayBuffer();
  return {
    donnees,
    etat: res.headers.get('X-Atlas-Etat') || 'direct',
    date: new Date(res.headers.get('X-Atlas-Date') || Date.now()),
  };
}

export async function lireJSON(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.json();
}

export async function etatServeur() {
  const res = await fetch('/api/etat', { cache: 'no-store' });
  if (!res.ok) throw new Error('serveur indisponible');
  return res.json();
}

// Surveille la connexion (via le serveur) et publie « connexion » si elle change.
export function surveillerConnexion() {
  let precedent = null;
  const verifier = async () => {
    let enLigne = false;
    try { enLigne = (await etatServeur()).en_ligne; } catch { enLigne = false; }
    if (enLigne !== precedent) {
      precedent = enLigne;
      etat.enLigne = enLigne;
      emit('connexion', enLigne);
    }
  };
  verifier();
  setInterval(verifier, 20000);
  window.addEventListener('online', verifier);
  window.addEventListener('offline', verifier);
}

// Enregistre un fichier dans data/ (dossiers autorisés : projets, poi, zones, reglages).
export async function enregistrerFichier(chemin, contenu, type = 'application/octet-stream') {
  const corps = typeof contenu === 'string' || contenu instanceof Blob || contenu instanceof ArrayBuffer ||
    ArrayBuffer.isView(contenu) ? contenu : JSON.stringify(contenu, null, 2);
  const res = await fetch(`/api/fichiers/${chemin.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT', body: corps, headers: { 'Content-Type': type },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erreur || `HTTP ${res.status}`);
  return res.json();
}

export async function supprimerFichier(chemin) {
  const res = await fetch(`/api/fichiers/${chemin.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function listerFichiers(dossier) {
  const res = await fetch(`/api/fichiers?dossier=${encodeURIComponent(dossier)}`);
  if (!res.ok) return [];
  return res.json();
}
