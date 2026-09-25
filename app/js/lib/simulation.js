// Valeurs indicatives (simulées) des mobilités, utilisées hors connexion quand
// aucun profil observé n'est encore disponible. Déterministes : la même heure
// donne toujours les mêmes valeurs. Toujours signalées « indicatives » à l'écran.

import { partiesParis, joursFeries } from '../temps.js';

// Hachage entier → [0, 1).
export function hachage(chaine, graine = 0) {
  let h = 2166136261 ^ graine;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const gauss = (x, m, s) => Math.exp(-((x - m) ** 2) / (2 * s * s));

export function typeJour(date) {
  const p = partiesParis(date);
  const iso = `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`;
  if (p.jourSemaine === 0 || joursFeries(p.annee).has(iso)) return 'dimanche';
  if (p.jourSemaine === 6) return 'samedi';
  return 'ouvre';
}

function heureDecimale(date) {
  const p = partiesParis(date);
  return p.heure + p.minute / 60;
}

// Intensité du trafic (0 à ~1,2) selon l'heure et le type de jour.
export function intensiteTrafic(date) {
  const h = heureDecimale(date);
  switch (typeJour(date)) {
    case 'samedi': return 0.15 + 0.55 * gauss(h, 16, 2.6) + 0.25 * gauss(h, 11, 1.5);
    case 'dimanche': return 0.1 + 0.25 * gauss(h, 18, 2) + 0.12 * gauss(h, 11.5, 1.5);
    default: return 0.08 + 0.95 * gauss(h, 8.2, 0.85) + 1.0 * gauss(h, 17.6, 1.15) + 0.35 * gauss(h, 12.6, 1.1);
  }
}

// Niveau de fluidité simulé d'un tronçon : 3 fluide, 4 dense, 5 saturé, 6 bloqué.
// La sensibilité des tronçons est asymétrique : la plupart restent fluides, quelques
// axes chargés saturent aux heures de pointe (≈ 60 % fluide, 7 % bloqué à 8 h 30).
export function troncon(id, date, vref = 30) {
  const h = hachage(id, 7);
  const sensibilite = 0.35 + 0.95 * h * h;
  const creneau = Math.floor((heureDecimale(date) * 60) / 15);
  const bruit = (hachage(id, creneau) - 0.5) * 0.12;
  const c = Math.max(0, 0.7 * intensiteTrafic(date) * sensibilite + bruit);
  const niveau = c < 0.5 ? 3 : c < 0.65 ? 4 : c < 0.8 ? 5 : 6;
  return { niveau, vitesse: Math.max(4, vref * (1 - 0.8 * Math.min(1, c))) };
}

// Taux d'occupation simulé d'un parking (%).
export function occupationParking(id, date) {
  const h = heureDecimale(date);
  const base = 0.75 + 0.35 * hachage(id, 3);
  let occ;
  switch (typeJour(date)) {
    case 'samedi': occ = 0.2 + 0.75 * gauss(h, 15.5, 2.8); break;
    case 'dimanche': occ = 0.12 + 0.3 * gauss(h, 16, 3); break;
    default: occ = 0.15 + 0.7 * gauss(h, 11.5, 3.2) + 0.15 * gauss(h, 19.5, 1.5);
  }
  return Math.max(2, Math.min(99, 100 * occ * base));
}

// Part des emplacements occupés par un vélo (%), selon le profil de la station.
export function velosDisponibles(id, date) {
  const h = heureDecimale(date);
  const centre = hachage(id, 11) > 0.5; // stations de centre : se remplissent le matin
  const vague = gauss(h, 9, 1.6) - gauss(h, 18, 2);
  const v = 50 + (centre ? 35 : -35) * vague + (hachage(id, Math.floor(h)) - 0.5) * 20;
  return Math.max(0, Math.min(100, v));
}
