// Panneau « Mobilités » : trafic routier, trams / bus / Navibus Naolib, parkings et
// vélos en libre-service. Trois régimes de données, toujours signalés :
//   - direct : données temps réel (heure actuelle, connexion disponible) ;
//   - observé : profils enregistrés par l'atlas (même type de jour, même créneau) ;
//   - indicatif : valeurs simulées, faute de mieux.
// Les trams et bus suivent les horaires théoriques (GTFS), décalés des retards réels.

/* global deck */
import { etat, on, lirePreference, ecrirePreference } from '../etat.js';
import { lireSource, lireJSON } from '../api.js';
import { enregistrerPanneau, rafraichirPanneau } from '../ui/panneaux.js';
import { ajouterSectionReglages } from './reglages.js';
import { definirCouches, surSurvol } from '../carte/rendu3d.js';
import { afficherInfobulle } from '../ui/infobulle.js';
import { emprise, echelles } from '../lib/geo.js';
import * as sim from '../lib/simulation.js';
import { html, echapper, entier, etatDonnee, pluriel } from '../ui/format.js';
import { depuis } from '../temps.js';
import { lireCouleur } from '../lib/couleurs.js';

const couches = lirePreference('mobilites', { trafic: true, transports: true, parkings: true, velos: false });

// Palette d'état (réservée aux états, toujours accompagnée d'un libellé).
const NIVEAUX = {
  3: { nom: 'Fluide', couleur: [12, 163, 12] },
  4: { nom: 'Dense', couleur: [250, 178, 25] },
  5: { nom: 'Saturé', couleur: [236, 131, 90] },
  6: { nom: 'Bloqué', couleur: [208, 59, 59] },
  2: { nom: 'Indéterminé', couleur: [137, 135, 129] },
};
const ETAT_BON = [12, 163, 12], ETAT_MOYEN = [250, 178, 25], ETAT_CRITIQUE = [208, 59, 59];
const FACTEUR_VITESSE = { 3: 1, 4: 0.6, 5: 0.35, 6: 0.15, 2: 0.8 };
const TYPES_TC = { 0: 'Tram', 3: 'Bus', 4: 'Navibus', 7: 'Téléphérique', 1: 'Métro' };
const PLURIELS_TC = { 0: 'trams', 3: 'bus', 4: 'navettes Navibus', 7: 'téléphériques', 1: 'métros' };

const ref = { troncons: [], parkings: [], stations: [], lignes: null };
const donnees = {
  trafic: { etat: null, date: null, jours: 0, valeurs: new Map() },
  parkings: { etat: null, date: null, jours: 0, valeurs: new Map() },
  velos: { etat: null, date: null, jours: 0, valeurs: new Map() },
};
let vehicules = { mode: null, t0: 0, pas: 5, liste: [] };
let alertes = { etat: null, liste: [] };

// --- Références locales -----------------------------------------------------------------

function preparerTroncon(f) {
  const coords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
  const k = echelles(coords[0][1]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * k.kx, (coords[i][1] - coords[i - 1][1]) * k.ky));
  }
  return { ...f.properties, coords, cum, longueur: cum[cum.length - 1] || 1 };
}

async function chargerReferences() {
  const [t, p, s] = await Promise.all([
    lireJSON('/data/mobilite/fluidite-troncons.geojson').catch(() => null),
    lireJSON('/data/mobilite/parkings.json').catch(() => []),
    lireJSON('/data/mobilite/velos-stations.json').catch(() => []),
  ]);
  ref.troncons = (t?.features || []).map(preparerTroncon);
  ref.parkings = p;
  ref.stations = s;
}

async function chargerLignes() {
  if (ref.lignes) return;
  try {
    const r = await fetch('/api/transports/lignes');
    if (r.ok) ref.lignes = (await r.json()).features;
  } catch { /* horaires encore en chargement : nouvel essai plus tard */ }
}

// --- Régime des données --------------------------------------------------------------------

function instant() {
  return etat.temps?.date || new Date();
}

function procheDuPresent(t = instant()) {
  return Math.abs(t.getTime() - Date.now()) < 10 * 60000;
}

async function profil(source, t) {
  try {
    const r = await fetch(`/api/enregistrements/profil/${source}?t=${t.getTime()}`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// Lit la source temps réel si elle est pertinente (heure actuelle, valeur récente).
async function lireDirect(nom) {
  if (!procheDuPresent()) return null;
  try {
    const r = await lireSource(nom);
    const age = Date.now() - r.date.getTime();
    if (r.etat === 'direct' || age < 30 * 60000) return r;
  } catch { /* hors ligne ou source indisponible */ }
  return null;
}

async function majTrafic() {
  const t = instant();
  const d = donnees.trafic;
  const direct = await lireDirect('fluidite');
  d.valeurs = new Map();
  if (direct) {
    for (const f of direct.donnees.features || []) {
      const p = f.properties;
      d.valeurs.set(String(p.cha_id), { niveau: +p.couleur_tp || 2, vitesse: p.mf1_vit });
    }
    Object.assign(d, { etat: direct.etat, date: direct.date, jours: 0 });
    return;
  }
  const obs = await profil('fluidite', t);
  const nObs = obs ? Object.keys(obs.entites).length : 0;
  for (const tr of ref.troncons) {
    const o = obs?.entites[tr.id];
    if (o && o.n >= 2) {
      const niveau = Math.round(o.mediane);
      d.valeurs.set(tr.id, { niveau, vitesse: tr.vref * (FACTEUR_VITESSE[niveau] ?? 1), observe: true });
    } else {
      d.valeurs.set(tr.id, sim.troncon(tr.id, t, tr.vref));
    }
  }
  Object.assign(d, { etat: nObs ? 'observe' : 'simule', date: null, jours: obs?.jours || 0 });
}

async function majParkings() {
  const t = instant();
  const d = donnees.parkings;
  const direct = await lireDirect('parkings');
  d.valeurs = new Map();
  if (direct) {
    for (const l of direct.donnees) {
      const cap = l.grp_exploitation || 0;
      d.valeurs.set(String(l.grp_identifiant), {
        libres: l.grp_disponible, capacite: cap, occupation: cap ? 100 * (1 - l.grp_disponible / cap) : null,
        ferme: l.grp_statut === 0 || l.grp_statut === 1,
      });
    }
    Object.assign(d, { etat: direct.etat, date: direct.date, jours: 0 });
    return;
  }
  const obs = await profil('parkings', t);
  for (const p of ref.parkings) {
    const o = obs?.entites[p.id];
    const occ = o && o.n >= 2 ? o.mediane : sim.occupationParking(p.id, t);
    d.valeurs.set(p.id, { libres: Math.round(p.capacite * (1 - occ / 100)), capacite: p.capacite, occupation: occ, observe: !!o });
  }
  Object.assign(d, { etat: obs && Object.keys(obs.entites).length ? 'observe' : 'simule', date: null, jours: obs?.jours || 0 });
}

async function majVelos() {
  const t = instant();
  const d = donnees.velos;
  const direct = await lireDirect('velos-etat');
  d.valeurs = new Map();
  if (direct) {
    for (const s of direct.donnees.data?.stations || []) {
      d.valeurs.set(s.station_id, { velos: s.num_vehicles_available, places: s.num_docks_available, active: s.is_renting });
    }
    Object.assign(d, { etat: direct.etat, date: direct.date, jours: 0 });
    return;
  }
  const obs = await profil('velos-etat', t);
  for (const s of ref.stations) {
    const o = obs?.entites[s.id];
    const pct = o && o.n >= 2 ? o.mediane : sim.velosDisponibles(s.id, t);
    const velos = Math.round((s.capacite * pct) / 100);
    d.valeurs.set(s.id, { velos, places: s.capacite - velos, active: true, observe: !!o });
  }
  Object.assign(d, { etat: obs && Object.keys(obs.entites).length ? 'observe' : 'simule', date: null, jours: obs?.jours || 0 });
}

function bboxZone(marge = 800) {
  return etat.zone ? emprise(etat.zone.rect, marge) : null;
}

async function majVehicules({ fenetre = 30 } = {}) {
  const t = instant();
  const b = bboxZone(600);
  if (!b) return;
  try {
    const r = await fetch(`/api/transports/vehicules?t=${t.getTime()}&fenetre=${fenetre}&pas=5&bbox=${b.map((v) => v.toFixed(5)).join(',')}`);
    if (!r.ok) {
      vehicules = { mode: 'indisponible', liste: [], erreur: (await r.json().catch(() => ({}))).erreur };
      return;
    }
    const v = await r.json();
    vehicules = { mode: v.mode, jour: v.jour, t0: v.t0, pas: v.pas, liste: v.vehicules };
  } catch {
    vehicules = { mode: 'indisponible', liste: [] };
  }
}

async function majAlertes() {
  if (!etat.enLigne) { alertes = { etat: null, liste: [] }; return; }
  try {
    const r = await lireSource('naolib-alertes');
    const maintenant = Date.now() / 1000;
    alertes = {
      etat: r.etat,
      liste: (r.donnees.alertes || []).filter((a) => (!a.debut || a.debut <= maintenant) && (!a.fin || a.fin >= maintenant)),
    };
  } catch { alertes = { etat: null, liste: [] }; }
}

// --- Couches statiques (reconstruites quand les données changent) ------------------------

let statiques = [];
let tronconsZone = [];
let particules = [];

function dansBbox([lon, lat], b) {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

function cylindre([lon, lat], rayon, z = 0) {
  const k = echelles(lat);
  const pts = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    pts.push([lon + (Math.cos(a) * rayon) / k.kx, lat + (Math.sin(a) * rayon) / k.ky, z]);
  }
  return pts;
}

function couleurOccupation(occ) {
  return occ == null ? [137, 135, 129] : occ < 70 ? ETAT_BON : occ < 90 ? ETAT_MOYEN : ETAT_CRITIQUE;
}

function reconstruireStatiques() {
  const b = bboxZone();
  statiques = [];
  tronconsZone = [];
  particules = [];
  if (!b || etat.mode !== 'etude') return;

  if (couches.trafic && ref.troncons.length) {
    tronconsZone = ref.troncons.filter((t) => t.coords.some((c) => dansBbox(c, b)));
    const niveau = (t) => donnees.trafic.valeurs.get(t.id)?.niveau ?? 2;
    statiques.push(new deck.PathLayer({
      id: 'trafic-troncons', data: tronconsZone,
      getPath: (t) => t.coords.map(([x, y]) => [x, y, 1.5]),
      getColor: (t) => [...(NIVEAUX[niveau(t)] || NIVEAUX[2]).couleur, 235],
      getWidth: 6, widthUnits: 'pixels', widthMinPixels: 3, capRounded: true, jointRounded: true,
      pickable: true, shadowEnabled: false,
      updateTriggers: { getColor: donnees.trafic.valeurs },
    }));
    // Particules : plus nombreuses et plus lentes quand le trafic se densifie.
    const densite = { 3: 0.6, 4: 1.2, 5: 1.7, 6: 2.1, 2: 0.3 };
    for (const t of tronconsZone) {
      const v = donnees.trafic.valeurs.get(t.id);
      const n = Math.max(1, Math.min(14, Math.round((t.longueur / 70) * (densite[v?.niveau ?? 2] || 0.5))));
      const vitesse = ((v?.vitesse ?? 20) / 3.6) * 5; // accélérée 5 fois
      for (let i = 0; i < n; i++) particules.push({ t, phase: (i + sim.hachage(t.id, i)) / n, vitesse });
    }
  }

  if (couches.transports && ref.lignes) {
    const lignes = ref.lignes.filter((f) => f.geometry.coordinates.some((c) => dansBbox(c, b)));
    statiques.push(new deck.PathLayer({
      id: 'tc-lignes', data: lignes,
      getPath: (f) => f.geometry.coordinates.map(([x, y]) => [x, y, 0.8]),
      getColor: (f) => [...(lireCouleur(f.properties.couleur) || [120, 120, 120]).slice(0, 3), f.properties.type === 0 ? 220 : 120],
      getWidth: (f) => (f.properties.type === 0 ? 5 : f.properties.type === 4 ? 3 : 2),
      widthUnits: 'pixels', capRounded: true, jointRounded: true, pickable: false, shadowEnabled: false,
    }));
  }

  if (couches.parkings && ref.parkings.length) {
    const pk = ref.parkings.filter((p) => dansBbox([p.lon, p.lat], b)).map((p) => ({ ...p, v: donnees.parkings.valeurs.get(p.id) }));
    const H = 36;
    statiques.push(new deck.SolidPolygonLayer({
      id: 'parkings-enveloppe', data: pk, extruded: true, wireframe: true,
      getPolygon: (p) => cylindre([p.lon, p.lat], 15, 0), getElevation: H,
      getFillColor: [255, 255, 255, 50], getLineColor: [90, 96, 110, 120], pickable: true, shadowEnabled: false,
    }));
    statiques.push(new deck.SolidPolygonLayer({
      id: 'parkings-remplissage', data: pk.filter((p) => p.v?.occupation != null), extruded: true,
      getPolygon: (p) => cylindre([p.lon, p.lat], 13.5, 0),
      getElevation: (p) => Math.max(1, (H * p.v.occupation) / 100),
      getFillColor: (p) => [...couleurOccupation(p.v.occupation), 230], pickable: true, shadowEnabled: false,
    }));
    statiques.push(new deck.TextLayer({
      id: 'parkings-libres', data: pk.filter((p) => p.v),
      getPosition: (p) => [p.lon, p.lat, H + 6], getText: (p) => `${entier(p.v.libres)} pl.`,
      getSize: 12, getColor: [27, 33, 48, 255], background: true, getBackgroundColor: [255, 255, 255, 225],
      backgroundPadding: [4, 2], fontFamily: 'system-ui, sans-serif', fontWeight: 700, shadowEnabled: false,
      characterSet: 'auto',
    }));
  }

  if (couches.velos && ref.stations.length) {
    const st = ref.stations.filter((s) => dansBbox([s.lon, s.lat], b)).map((s) => ({ ...s, v: donnees.velos.valeurs.get(s.id) }));
    statiques.push(new deck.ScatterplotLayer({
      id: 'velos-stations', data: st,
      getPosition: (s) => [s.lon, s.lat, 2],
      getRadius: 7, radiusUnits: 'pixels', stroked: true, getLineColor: [255, 255, 255, 255], getLineWidth: 2,
      lineWidthUnits: 'pixels',
      getFillColor: (s) => (!s.v || !s.v.active ? [137, 135, 129] : s.v.velos === 0 ? ETAT_CRITIQUE : s.v.velos < 3 ? ETAT_MOYEN : ETAT_BON),
      pickable: true, shadowEnabled: false,
    }));
  }
}

// --- Animation : particules du trafic et véhicules ------------------------------------------

function pointSur(t, s) {
  const { coords, cum } = t;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const u = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
  return [coords[i - 1][0] + u * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + u * (coords[i][1] - coords[i - 1][1]), 3];
}

function positionVehicule(v, tMs) {
  const p = v.p;
  if (!p?.length) return null;
  const x = (tMs - vehicules.t0) / 1000 / vehicules.pas;
  const i = Math.max(0, Math.min(p.length - 1, Math.floor(x)));
  const j = Math.min(p.length - 1, i + 1);
  const u = Math.max(0, Math.min(1, x - i));
  return [p[i][0] + u * (p[j][0] - p[i][0]), p[i][1] + u * (p[j][1] - p[i][1]), 4];
}

let raf = 0;
let debutAnim = performance.now();

function image(now) {
  raf = requestAnimationFrame(image);
  const dyn = [];
  if (particules.length) {
    const t = (now - debutAnim) / 1000;
    dyn.push(new deck.PathLayer({
      id: 'trafic-particules',
      data: particules.map((p) => {
        const L = p.t.longueur;
        const s = (p.phase * L + t * p.vitesse) % L;
        const queue = Math.max(0, s - Math.min(35, L * 0.3));
        return [pointSur(p.t, queue), pointSur(p.t, s)];
      }),
      getPath: (d) => d, getColor: [255, 255, 255, 230], getWidth: 2.5, widthUnits: 'pixels', capRounded: true,
      shadowEnabled: false,
    }));
  }
  if (couches.transports && vehicules.liste.length) {
    const tMs = etat.temps?.auto ? Date.now() : instant().getTime();
    const pos = vehicules.liste.map((v) => ({ v, p: positionVehicule(v, tMs) })).filter((x) => x.p);
    dyn.push(new deck.ScatterplotLayer({
      id: 'tc-vehicules', data: pos,
      getPosition: (d) => d.p,
      getRadius: (d) => (d.v.type === 0 ? 9 : d.v.type === 4 ? 8 : 6.5), radiusUnits: 'pixels',
      getFillColor: (d) => lireCouleur(d.v.couleur)?.slice(0, 3) || [80, 80, 80],
      stroked: true, getLineColor: (d) => (d.v.tr ? [255, 255, 255] : [235, 235, 235]), getLineWidth: 2, lineWidthUnits: 'pixels',
      pickable: true, billboard: true, shadowEnabled: false,
    }));
    dyn.push(new deck.TextLayer({
      id: 'tc-numeros', data: pos.filter((d) => d.v.type === 0 || d.v.type === 4),
      getPosition: (d) => d.p, getText: (d) => d.v.ligne, getSize: 10, fontWeight: 700,
      getColor: (d) => lireCouleur(d.v.texte)?.slice(0, 3) || [255, 255, 255], fontFamily: 'system-ui, sans-serif',
      billboard: true, shadowEnabled: false, characterSet: 'auto',
    }));
  }
  definirCouches('mobilites', [...statiques, ...dyn]);
}

function demarrerAnimation() {
  const utile = etat.mode === 'etude' && (couches.trafic || couches.transports || couches.parkings || couches.velos);
  if (utile && !raf) {
    debutAnim = performance.now();
    raf = requestAnimationFrame(image);
  } else if (!utile && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
    definirCouches('mobilites', []);
  }
}

// --- Infobulles ------------------------------------------------------------------------------

function survol(info) {
  const id = info.layer?.id;
  if (!id || !info.object) return;
  let contenu = null;
  if (id === 'trafic-troncons') {
    const t = info.object, v = donnees.trafic.valeurs.get(t.id);
    const n = NIVEAUX[v?.niveau ?? 2];
    contenu = `<h4>${echapper(t.nom)}</h4>
      <div class="ligne"><span>État</span><b><span class="statut"><i style="background:rgb(${n.couleur})"></i>${n.nom}</span></b></div>
      ${v?.vitesse != null ? `<div class="ligne"><span>Vitesse</span><b>${entier(v.vitesse)} km/h</b></div>` : ''}
      <div class="ligne"><span>Longueur</span><b>${entier(t.long)} m</b></div>
      <div class="indice">${libelleEtat(donnees.trafic)}</div>`;
  } else if (id.startsWith('parkings')) {
    const p = info.object, v = p.v;
    contenu = `<h4>Parking ${echapper(p.nom)}</h4>
      ${v ? `<div class="grand">${entier(v.libres)} places libres</div>
      <div class="ligne"><span>Capacité</span><b>${entier(v.capacite)}</b></div>
      <div class="ligne"><span>Occupation</span><b>${entier(v.occupation)} %</b></div>` : '<p>Pas de donnée</p>'}
      <div class="indice">${echapper(p.adresse || '')} · ${libelleEtat(donnees.parkings)}</div>`;
  } else if (id === 'velos-stations') {
    const s = info.object, v = s.v;
    contenu = `<h4>${echapper(s.nom)}</h4>
      ${v ? `<div class="ligne"><span>Vélos disponibles</span><b>${entier(v.velos)}</b></div>
      <div class="ligne"><span>Places libres</span><b>${entier(v.places)}</b></div>` : ''}
      <div class="indice">Vélos en libre-service Naolib · ${libelleEtat(donnees.velos)}</div>`;
  } else if (id === 'tc-vehicules') {
    const v = info.object.v;
    const retard = v.retard == null ? '' : v.retard === 0 ? "à l'heure" : `${v.retard > 0 ? 'retard' : 'avance'} ${Math.round(Math.abs(v.retard) / 60) || '< 1'} min`;
    contenu = `<h4>${TYPES_TC[v.type] || 'Ligne'} ${echapper(v.ligne)} → ${echapper(v.destination)}</h4>
      <div class="ligne"><span>${v.tr ? 'Temps réel' : 'Horaire théorique'}</span><b>${retard}</b></div>
      <div class="indice">Position estimée d'après l'horaire${v.tr ? ' et le retard annoncé' : ''}.</div>`;
  }
  if (contenu) afficherInfobulle(info.x, info.y, contenu);
}

function libelleEtat(d) {
  if (d.etat === 'direct') return `en direct, ${depuis(d.date)}`;
  if (d.etat === 'cache' || d.etat === 'perime') return `dernière valeur, ${depuis(d.date)}`;
  if (d.etat === 'observe') return `moyenne observée (${pluriel(d.jours, 'jour')} de ce type)`;
  return 'valeur indicative (simulation)';
}

function badge(d) {
  return etatDonnee(d.etat === 'direct' ? 'direct' : d.etat === 'observe' ? 'observe' : d.etat === 'simule' ? 'simule' : 'cache', d.date);
}

// --- Panneau ---------------------------------------------------------------------------------

const MODES_TC = {
  'temps-reel': 'Temps réel : horaires décalés des retards annoncés.',
  theorique: 'Horaires théoriques du réseau (GTFS Naolib).',
  types: 'Date hors de la période couverte : horaires d\'un jour type équivalent.',
  indisponible: 'Horaires en cours de chargement ou absents.',
};

function interrupteur(cle, titre, aide) {
  return `<label class="interrupteur"><input type="checkbox" data-couche="${cle}" ${couches[cle] ? 'checked' : ''}>
    <span>${titre}<small>${aide}</small></span></label>`;
}

function rendre(conteneur) {
  if (etat.mode !== 'etude') {
    conteneur.appendChild(html('<p class="aide">Validez une zone d\'étude pour afficher les mobilités.</p>'));
    return;
  }
  const b = bboxZone();
  const pk = ref.parkings.filter((p) => dansBbox([p.lon, p.lat], b));
  const st = ref.stations.filter((s) => dansBbox([s.lon, s.lat], b));
  const velosDispo = st.reduce((a, s) => a + (donnees.velos.valeurs.get(s.id)?.velos || 0), 0);
  const parType = {};
  for (const v of vehicules.liste) parType[v.type] = (parType[v.type] || 0) + 1;
  const tr = vehicules.liste.filter((v) => v.tr);
  const retardMoyen = tr.length ? tr.reduce((a, v) => a + v.retard, 0) / tr.length : null;
  const repartition = {};
  for (const t of tronconsZone) {
    const n = donnees.trafic.valeurs.get(t.id)?.niveau ?? 2;
    repartition[n] = (repartition[n] || 0) + t.longueur;
  }
  const totalL = Object.values(repartition).reduce((a, b) => a + b, 0) || 1;

  const el = html(`<div>
    <div class="section">
      <h3>Couches</h3>
      ${interrupteur('trafic', 'Trafic routier', 'Fluidité des axes, particules animées')}
      ${interrupteur('transports', 'Trams, bus et Navibus', 'Lignes et véhicules Naolib')}
      ${interrupteur('parkings', 'Parkings publics', 'Jauges 3D d\'occupation')}
      ${interrupteur('velos', 'Vélos en libre-service', 'Stations et vélos disponibles')}
    </div>
    <div class="section">
      <h3>Trafic routier ${badge(donnees.trafic)}</h3>
      <div class="legende">${[3, 4, 5, 6, 2].map((k) =>
        `<div class="item"><i style="background:rgb(${NIVEAUX[k].couleur})"></i>${NIVEAUX[k].nom}
          <span style="margin-left:auto;color:var(--encre-3)">${Math.round(((repartition[k] || 0) / totalL) * 100)} %</span></div>`).join('')}</div>
      <p class="note">${libelleEtat(donnees.trafic)}. Part de la longueur des ${pluriel(tronconsZone.length, 'tronçon')} suivis dans la zone.
        Les particules circulent d'autant plus lentement que le trafic est dense.</p>
    </div>
    <div class="section">
      <h3>Transports en commun</h3>
      <div class="chiffres">
        ${Object.entries(parType).map(([k, n]) => `<div class="chiffre"><strong>${n}</strong><span>${n > 1 ? (PLURIELS_TC[k] || 'véhicules') : (TYPES_TC[k] || 'véhicule').toLowerCase()} en circulation</span></div>`).join('')
          || '<div class="chiffre"><strong>0</strong><span>véhicule en circulation</span></div>'}
        ${retardMoyen != null ? `<div class="chiffre"><strong>${retardMoyen >= 0 ? '+' : '−'}${entier(Math.abs(retardMoyen) / 60)} min</strong><span>retard moyen (${tr.length} suivis)</span></div>` : ''}
      </div>
      <p class="note">${MODES_TC[vehicules.mode] || ''}${vehicules.mode === 'types' ? ` (${echapper(vehicules.jour)})` : ''}
        La position des véhicules est estimée : Naolib ne publie pas leur position GPS.</p>
      ${alertes.liste.length ? `<details class="tableau-donnees"><summary>${pluriel(alertes.liste.length, 'perturbation')} en cours</summary>
        <ul class="liens">${alertes.liste.slice(0, 30).map((a) => `<li><strong>${echapper(a.titre)}</strong>${a.lignes?.length ? ` — lignes ${echapper(a.lignes.map((l) => l.replace('FR_NAOLIB:Line:', '')).join(', '))}` : ''}</li>`).join('')}</ul></details>` : ''}
    </div>
    <div class="section">
      <h3>Parkings ${badge(donnees.parkings)}</h3>
      ${pk.length ? `<table class="tableau">${pk.map((p) => {
        const v = donnees.parkings.valeurs.get(p.id);
        return `<tr><th>${echapper(p.nom)}</th><td>${v ? `<span class="statut"><i style="background:rgb(${couleurOccupation(v.occupation)})"></i>${entier(v.libres)} / ${entier(v.capacite)}</span>` : '—'}</td></tr>`;
      }).join('')}</table>` : '<p class="aide">Aucun parking public suivi dans la zone.</p>'}
      <p class="note">Places libres / capacité. ${libelleEtat(donnees.parkings)}.</p>
    </div>
    <div class="section">
      <h3>Vélos en libre-service ${badge(donnees.velos)}</h3>
      <p>${pluriel(st.length, 'station')} dans la zone, ${pluriel(velosDispo, 'vélo disponible', 'vélos disponibles')}.</p>
      <p class="note">${libelleEtat(donnees.velos)}.</p>
    </div>
  </div>`);
  el.querySelectorAll('[data-couche]').forEach((i) => i.addEventListener('change', () => {
    couches[i.dataset.couche] = i.checked;
    ecrirePreference('mobilites', couches);
    reconstruireStatiques();
    demarrerAnimation();
  }));
  conteneur.appendChild(el);
}

// --- Réglages de l'enregistreur ---------------------------------------------------------------

async function sectionEnregistreur(conteneur) {
  let e;
  try { e = await (await fetch('/api/enregistrements/etat')).json(); } catch { return; }
  const types = { ouvre: 'jours ouvrés', vacances: 'vacances', samedi: 'samedis', dimanche: 'dimanches et fériés' };
  const el = html(`<div class="section">
    <h3>Enregistrement des données temps réel</h3>
    <p class="aide">Quand l'atlas est ouvert et connecté, il relève le trafic, les parkings, les vélos et les retards,
      pour afficher hors ligne des moyennes réellement observées.</p>
    ${e.desactive_force ? '<p class="note alerte">Désactivé au lancement (option -sans-enregistrement).</p>' : ''}
    <label class="interrupteur"><input type="checkbox" id="enr-actif" ${e.actif ? 'checked' : ''} ${e.desactive_force ? 'disabled' : ''}>
      <span>Enregistrer<small>${(e.octets / 1048576).toFixed(1)} Mo utilisés dans data/enregistrements</small></span></label>
    <table class="tableau">${e.sources.map((s) => `<tr><th><label><input type="checkbox" data-source="${s.nom}" ${s.actif ? 'checked' : ''}> ${echapper(s.libelle)}</label></th>
      <td>${Object.entries(s.jours).map(([k, n]) => `${n} ${types[k] || k}`).join(', ') || 'aucun relevé'}
      <br><a href="/api/enregistrements/export/${s.nom}">Exporter (CSV)</a></td></tr>`).join('')}</table>
    <label class="champ"><span>Conserver les relevés bruts (jours)</span>
      <input type="number" id="enr-retention" min="1" max="365" value="${e.retention_jours}"></label>
    <p class="note">Les profils moyens (par type de jour et par demi-heure) sont conservés sans limite. Données sous licence ODbL :
      la base enregistrée peut être utilisée librement ; si vous la diffusez, citez les sources et partagez-la sous la même licence.</p>
  </div>`);
  const sauver = async () => {
    const sources = {};
    el.querySelectorAll('[data-source]').forEach((i) => { sources[i.dataset.source] = i.checked; });
    await fetch('/api/enregistrements/reglages', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actif: el.querySelector('#enr-actif').checked, sources, retention_jours: +el.querySelector('#enr-retention').value }),
    });
  };
  el.querySelectorAll('input').forEach((i) => i.addEventListener('change', sauver));
  conteneur.appendChild(el);
}

// --- Cycle de mise à jour ----------------------------------------------------------------------

let enCours = false;
let dernierInstant = 0;

async function majTout({ vehiculesSeuls = false } = {}) {
  if (etat.mode !== 'etude' || enCours) return;
  enCours = true;
  try {
    const taches = [];
    if (!vehiculesSeuls) {
      if (couches.trafic) taches.push(majTrafic());
      if (couches.parkings) taches.push(majParkings());
      if (couches.velos) taches.push(majVelos());
      taches.push(majAlertes());
    }
    if (couches.transports) {
      await chargerLignes();
      taches.push(majVehicules({ fenetre: etat.temps?.auto ? 40 : 0 }));
    }
    await Promise.all(taches);
    dernierInstant = instant().getTime();
    reconstruireStatiques();
    demarrerAnimation();
    rafraichirPanneau('mobilites');
  } finally {
    enCours = false;
  }
}

let attente = 0;
function surTemps() {
  clearTimeout(attente);
  // Petits pas de temps : seuls les véhicules sont recalculés ; sinon tout.
  const ecart = Math.abs(instant().getTime() - dernierInstant);
  attente = setTimeout(() => majTout({ vehiculesSeuls: ecart < 20 * 60000 }), 350);
}

export async function initMobilites() {
  await chargerReferences();
  enregistrerPanneau('mobilites', { titre: 'Mobilités', rendre });
  ajouterSectionReglages(sectionEnregistreur);
  surSurvol(survol);
  on('zone', () => majTout());
  on('mode', () => { reconstruireStatiques(); demarrerAnimation(); if (etat.mode === 'etude') majTout(); });
  on('temps', () => { if (etat.mode === 'etude' && !etat.temps.auto) surTemps(); });
  on('connexion', () => majTout());
  // Rythme en direct : véhicules toutes les 20 s, autres données toutes les minutes.
  setInterval(() => { if (etat.temps?.auto) majTout({ vehiculesSeuls: true }); }, 20000);
  setInterval(() => { if (etat.temps?.auto) majTout(); }, 60000);
}
