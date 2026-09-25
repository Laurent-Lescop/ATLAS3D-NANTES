// Couche 3D deck.gl superposée à la carte : groupes de couches ordonnés,
// éclairage solaire et ombres portées, survol et clic.

/* global deck */

// Ordre de dessin des groupes (du dessous vers le dessus).
const ORDRE = ['sol', 'mobilites-sol', 'batiments', 'projets', 'mobilites', 'soleil', 'etiquettes', 'outils'];

let overlay = null;
let eclairage = null;         // instance réellement utilisée par deck (réutilisée)
let dernierEclairage = null;
const groupes = new Map();
let rafCouches = 0;
const survols = new Set();
const clics = new Set();

export function initRendu3D(carte) {
  eclairage = nouvelEclairage({ timestamp: Date.now(), intensiteSoleil: 1, ambiance: 1, ombres: true });
  overlay = new deck.MapLibreOverlay({
    interleaved: false,
    layers: [],
    effects: [eclairage],
    pickingRadius: 4,
    onHover: (info, ev) => survols.forEach((fn) => fn(info, ev)),
    onClick: (info, ev) => clics.forEach((fn) => fn(info, ev)),
  });
  carte.addControl(overlay);
  return overlay;
}

export function surSurvol(fn) { survols.add(fn); return () => survols.delete(fn); }
export function surClic(fn) { clics.add(fn); return () => clics.delete(fn); }

// Remplace les couches d'un groupe ; le rendu est regroupé à l'image suivante.
export function definirCouches(groupe, couches) {
  groupes.set(groupe, (couches || []).filter(Boolean));
  if (!rafCouches) {
    rafCouches = requestAnimationFrame(() => {
      rafCouches = 0;
      overlay?.setProps({ layers: ORDRE.flatMap((g) => groupes.get(g) || []) });
    });
  }
}

// La structure des lumières reste identique (ambiance + soleil avec ombres) :
// changer de structure obligerait deck.gl à recompiler ses shaders. La nuit, le
// soleil est simplement éteint et les ombres rendues transparentes.
function nouvelEclairage({ timestamp, intensiteSoleil, couleurSoleil = [255, 250, 240], ambiance, couleurAmbiance = [255, 255, 255] }) {
  return new deck.LightingEffect({
    ambiance: new deck.AmbientLight({ color: couleurAmbiance, intensity: ambiance }),
    soleil: new deck._SunLight({ timestamp, color: couleurSoleil, intensity: intensiteSoleil, _shadow: true }),
  });
}

// Met à jour la lumière (appelé à chaque changement d'heure).
export function definirEclairage(params) {
  const cle = JSON.stringify(params);
  if (cle === dernierEclairage || !overlay) return;
  dernierEclairage = cle;
  const e = nouvelEclairage(params);
  // Même identifiant : deck transfère les lumières à l'effet existant.
  overlay.setProps({ effects: [e] });
  // Couleur d'ombre en composantes 0–1 (convention du module d'ombres de deck.gl).
  eclairage.shadowColor = params.ombres ? (params.couleurOmbre || [0.1, 0.12, 0.2, 0.42]) : [0, 0, 0, 0];
}

export function pick(x, y, opts = {}) {
  return overlay?.pickObject({ x, y, radius: 4, ...opts });
}

export const obtenirOverlay = () => overlay;
