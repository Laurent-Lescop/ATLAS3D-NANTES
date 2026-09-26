// Outils communs aux scripts de préparation des données.

// Emprise du pack de données détaillées : Nantes, Rezé et leurs abords.
export const EMPRISE_PACK = [-1.66, 47.15, -1.46, 47.31];

// Emprise du fond de carte : Nantes Métropole.
export const EMPRISE_FOND = [-1.84, 47.08, -1.36, 47.36];

export const USER_AGENT = 'AtlasNantes/1.0 (préparation des données ; usage non commercial)';

export function log(...args) {
  const t = new Date().toLocaleTimeString('fr-FR');
  console.log(`[${t}]`, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Requête HTTP avec reprises (délai croissant) ; renvoie le texte de la réponse.
export async function fetchWithRetry(url, init = {}, { label = url, tries = 5, timeoutMs = 60000, pauseMs = 3000 } = {}) {
  let delay = pauseMs;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init, signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      return text;
    } catch (e) {
      log(`${label} : échec (${attempt}/${tries}) — ${e.message}`);
      if (attempt === tries) throw e;
      await sleep(delay);
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('inaccessible');
}

export async function fetchJSON(url, init, opts) {
  return JSON.parse(await fetchWithRetry(url, init, opts));
}
