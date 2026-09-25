// Rendu 3D des bâtiments de la zone : extrusions éclairées, ombres portées,
// colorations thématiques, survol (emprise) et sélection.

/* global deck */
import { etat, emit, on } from '../etat.js';
import { definirCouches, surSurvol, surClic } from './rendu3d.js';
import { emprise as empriseCadre } from '../lib/geo.js';
import { rampe } from '../lib/couleurs.js';
import { EPOQUES, epoque } from './zone.js';
import { afficherInfobulle, masquerInfobulle } from '../ui/infobulle.js';
import { entier, decimal, echapper, surface } from '../ui/format.js';
import { SOURCES_HAUTEUR } from '../lib/batiments-core.js';

const MAQUETTE = [240, 237, 230];
const EMBLEME = [222, 124, 62];
const SELECTION = [47, 127, 209];

export const RAMPE_HAUTEUR = [
  [0, [250, 244, 214]], [9, [250, 214, 150]], [18, [240, 160, 96]],
  [30, [214, 96, 70]], [50, [150, 50, 90]], [90, [70, 30, 90]],
];

export const USAGES = [
  ['Résidentiel', [236, 214, 170]],
  ['Commercial et services', [226, 140, 110]],
  ['Industriel', [150, 150, 170]],
  ['Religieux', [170, 130, 200]],
  ['Sportif', [120, 190, 150]],
  ['Agricole', [180, 200, 120]],
  ['Annexe', [210, 206, 198]],
  ['Non renseigné', [225, 222, 216]],
];

export const COULEURS_SOURCE = {
  o: [46, 157, 98], b: [47, 127, 209], n: [120, 190, 150], e: [150, 180, 230], d: [220, 120, 90],
};

let elements = [];         // éléments dessinés (un polygone par entrée)
let parId = new Map();     // id → bâtiment
let emblemes = new Map();  // id → { couleur, nom }
let masques = new Set();   // bâtiments masqués (remplacés par un projet)
let selection = new Set();
let echelle = 1;
let rafMontee = 0;

// Découpe bâtiments et parties en polygones simples, avec hauteur de base.
function preparer(zone) {
  parId = new Map(zone.batiments.map((f) => [f.properties.id, f]));
  const avecParties = new Set(zone.parties.map((p) => p.properties.b));
  const out = [];
  const pousser = (geom, props, ref) => {
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    const base = props.mh || 0;
    const haut = Math.max(0.5, (props.h || 3) - base);
    for (const poly of polys) {
      out.push({ polygone: poly.map((r) => r.map(([x, y]) => [x, y, base])), hauteur: haut, ref });
    }
  };
  for (const f of zone.batiments) if (!avecParties.has(f.properties.id)) pousser(f.geometry, f.properties, f);
  for (const p of zone.parties) {
    const ref = parId.get(p.properties.b);
    if (ref) pousser(p.geometry, p.properties, ref);
  }
  return out;
}

function couleur(ref) {
  const p = ref.properties;
  if (selection.has(p.id)) return SELECTION;
  const emb = emblemes.get(p.id);
  switch (etat.reglages.coloration) {
    case 'hauteur': return rampe(RAMPE_HAUTEUR, p.h || 0);
    case 'epoque': return EPOQUES.find(([nom]) => nom === epoque(p.y))[1];
    case 'usage': return (USAGES.find(([nom]) => nom === p.u) || USAGES[USAGES.length - 1])[1];
    case 'source': return COULEURS_SOURCE[p.hs] || MAQUETTE;
    default: return emb ? emb.couleur : MAQUETTE;
  }
}

function couches() {
  const zone = etat.zone;
  if (!zone || etat.mode !== 'etude') return [];
  const [o, s, e, n] = empriseCadre(zone.rect, 600);
  const visibles = masques.size ? elements.filter((d) => !masques.has(d.ref.properties.id)) : elements;
  const declencheur = `${etat.reglages.coloration}|${selection.size}|${[...selection].join()}|${emblemes.size}`;
  return [
    // Sol invisible qui reçoit les ombres portées.
    new deck.SolidPolygonLayer({
      id: 'sol-ombres',
      data: [{ p: [[o, s], [e, s], [e, n], [o, n]] }],
      getPolygon: (d) => d.p,
      getFillColor: [0, 0, 0, 0],
      pickable: false,
    }),
    new deck.SolidPolygonLayer({
      id: 'batiments',
      data: visibles,
      extruded: true,
      wireframe: etat.reglages.aretes !== false,
      getPolygon: (d) => d.polygone,
      getElevation: (d) => d.hauteur,
      elevationScale: echelle,
      getFillColor: (d) => couleur(d.ref),
      getLineColor: [120, 112, 100, 70],
      material: { ambient: 0.55, diffuse: 0.55, shininess: 20, specularColor: [30, 30, 34] },
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 190, 110, 150],
      updateTriggers: { getFillColor: declencheur },
    }),
  ];
}

function redessiner() {
  definirCouches('batiments', couches());
}

// Animation d'apparition : les bâtiments « poussent ».
function monter() {
  cancelAnimationFrame(rafMontee);
  const debut = performance.now();
  const duree = 1500;
  const pas = (now) => {
    const t = Math.min(1, (now - debut) / duree);
    echelle = Math.max(0.01, 1 - (1 - t) ** 3);
    redessiner();
    if (t < 1) rafMontee = requestAnimationFrame(pas);
  };
  rafMontee = requestAnimationFrame(pas);
}

// --- Infobulle et sélection --------------------------------------------------------

function niveaux(p) {
  return p.lv || Math.max(1, Math.round((p.h || 3) / 3));
}

export function htmlInfobulle(p) {
  const nom = p.n ? `<h4>${echapper(p.n)}</h4>` : '';
  return `${nom}
    <div class="grand">${entier(p.a)} m²</div>
    <div class="ligne"><span>Emprise au sol</span></div>
    <div class="ligne"><span>Hauteur</span><b>${decimal(p.h)} m</b></div>
    <div class="ligne"><span>Niveaux ${p.lv ? '' : '(estimés)'}</span><b>${niveaux(p)}</b></div>
    <div class="ligne"><span>Surface de plancher ≈</span><b>${entier(p.a * niveaux(p))} m²</b></div>
    ${p.y ? `<div class="ligne"><span>Année</span><b>${p.y}</b></div>` : ''}
    ${p.u ? `<div class="ligne"><span>Usage</span><b>${echapper(p.u)}</b></div>` : ''}
    <div class="indice">Hauteur : ${echapper(SOURCES_HAUTEUR[p.hs] || '—')}</div>`;
}

function surSurvolBatiment(info) {
  if (info.layer?.id !== 'batiments' || !info.object) {
    if (info.layer?.id === 'batiments' || !info.layer) masquerInfobulle();
    return;
  }
  // La carte occupe toute la fenêtre : coordonnées du canevas = coordonnées de la page.
  afficherInfobulle(info.x, info.y, htmlInfobulle(info.object.ref.properties));
}

function surClicBatiment(info, ev) {
  if (info.layer?.id !== 'batiments') return;
  const id = info.object?.ref.properties.id;
  if (!id) return;
  const multiple = ev?.srcEvent?.shiftKey;
  if (!multiple) selection = new Set(selection.has(id) && selection.size === 1 ? [] : [id]);
  else if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  redessiner();
  emit('selection-batiments', [...selection].map((i) => parId.get(i)).filter(Boolean));
}

// --- API ---------------------------------------------------------------------------------

export function afficherZone(zone) {
  elements = preparer(zone);
  selection = new Set();
  echelle = 0.01;
  monter();
}

export function viderBatiments() {
  elements = [];
  selection = new Set();
  definirCouches('batiments', []);
}

export function definirEmblemes(map) {
  emblemes = map;
  redessiner();
}

export function definirMasques(ids) {
  masques = new Set(ids);
  redessiner();
}

export function effacerSelection() {
  selection = new Set();
  redessiner();
  emit('selection-batiments', []);
}

export const batimentParId = (id) => parId.get(id);

export function initBatiments3D() {
  surSurvol(surSurvolBatiment);
  surClic(surClicBatiment);
  on('reglages', redessiner);
  on('mode', redessiner);
}
