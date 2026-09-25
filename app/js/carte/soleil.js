// Heure du jour, position du soleil, lumière, ombres et ambiance jour / nuit.

/* global deck */
import * as SunCalc from '../../vendor/suncalc/index.js';
import { etat, emit, on } from '../etat.js';
import { dateParis, minutesParis, isoJourParis, hhmm, heureParis, partiesParis } from '../temps.js';
import { definirEclairage, definirCouches } from './rendu3d.js';
import { appliquerAmbiance, obtenirCarte } from './fond.js';
import { versLonLat } from '../lib/geo.js';
import { melanger, versCss } from '../lib/couleurs.js';

const NANTES = [-1.5534, 47.2173];
const DUREE_JOURNEE_MS = 40000; // durée d'une journée animée

const t = {
  jour: isoJourParis(new Date()),
  minutes: minutesParis(new Date()),
  auto: true,
  lecture: false,
};

const decimalFr = (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

const lisse = (a, b, x) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

export function instantCourant() {
  const [a, m, j] = t.jour.split('-').map(Number);
  return dateParis(a, m, j, t.minutes);
}

function centre() {
  return etat.zone?.rect.centre || NANTES;
}

export function positionSoleil(date, [lon, lat] = centre()) {
  const p = SunCalc.getPosition(date, lat, lon);
  return { azimut: p.azimuth, hauteur: p.altitude };
}

// Couleur de la lumière directe selon la hauteur du soleil.
function couleurSoleil(h) {
  if (h < 3) return melanger([255, 150, 85], [255, 190, 130], lisse(-1, 3, h));
  if (h < 12) return melanger([255, 190, 130], [255, 228, 196], lisse(3, 12, h));
  return melanger([255, 228, 196], [255, 252, 245], lisse(12, 35, h));
}

// Couleur du ciel au zénith et à l'horizon.
function couleursCiel(h) {
  const nuit = { zenith: [8, 12, 28], horizon: [28, 34, 58] };
  const aube = { zenith: [70, 92, 150], horizon: [255, 158, 104] };
  const jour = { zenith: [96, 158, 222], horizon: [214, 232, 246] };
  if (h < -2) {
    const f = lisse(-12, -2, h);
    return { zenith: melanger(nuit.zenith, aube.zenith, f), horizon: melanger(nuit.horizon, aube.horizon, f) };
  }
  const f = lisse(-2, 14, h);
  return { zenith: melanger(aube.zenith, jour.zenith, f), horizon: melanger(aube.horizon, jour.horizon, f) };
}

let derniereAmbiance = null;

function appliquer() {
  const date = instantCourant();
  const { azimut, hauteur } = positionSoleil(date);
  const jour = lisse(-7, 5, hauteur); // 0 = nuit, 1 = plein jour
  const soleilVisible = hauteur > 0.3;

  etat.temps = { date, minutes: t.minutes, jour: t.jour, auto: t.auto };

  // Nébulosité réelle (prévision ou observation) : le ciel couvert adoucit la
  // lumière directe et les ombres. Les normales de saison ne sont pas appliquées.
  const meteo = etat.reglages.nuagesReels !== false ? etat.meteoA?.(date) : null;
  const nuages = meteo && meteo.etat !== 'simule' ? Math.min(1, Math.max(0, meteo.nebulosite / 100)) : 0;
  etat.soleil = { azimut, hauteur, jour, nuages };

  definirEclairage({
    timestamp: date.getTime(),
    intensiteSoleil: soleilVisible ? +((0.6 + 0.7 * lisse(0, 30, hauteur)) * (1 - 0.6 * nuages)).toFixed(3) : 0,
    couleurSoleil: couleurSoleil(hauteur).map(Math.round),
    ambiance: +((1.25 - 0.2 * jour) * (1 + 0.1 * nuages)).toFixed(3),
    couleurAmbiance: melanger([120, 140, 205], [255, 255, 255], jour).map(Math.round),
    ombres: etat.reglages.ombres && soleilVisible,
    couleurOmbre: [0.1, 0.12, 0.2, +(0.42 * (1 - 0.75 * nuages)).toFixed(3)],
  });

  appliquerAmbiance(1 - jour);
  const ambiance = jour < 0.4 ? 'nuit' : 'jour';
  if (ambiance !== derniereAmbiance) {
    document.body.dataset.ambiance = ambiance;
    derniereAmbiance = ambiance;
  }

  const carte = obtenirCarte();
  if (carte) {
    const ciel = couleursCiel(hauteur);
    if (nuages) {
      const gris = melanger([46, 50, 60], [168, 174, 184], jour);
      ciel.zenith = melanger(ciel.zenith, gris, 0.75 * nuages);
      ciel.horizon = melanger(ciel.horizon, gris, 0.6 * nuages);
    }
    carte.setSky({
      'sky-color': versCss(ciel.zenith),
      'horizon-color': versCss(ciel.horizon),
      'fog-color': versCss(melanger(ciel.horizon, [240, 238, 232], 0.4 * jour)),
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.85,
      'atmosphere-blend': 0.8,
    });
    carte.setLight({
      anchor: 'map',
      position: [1.4, azimut, 90 - Math.max(hauteur, 8)],
      color: versCss(couleurSoleil(hauteur)),
      intensity: 0.15 + 0.35 * jour,
    });
  }

  majBarre(date, azimut, hauteur);
  if (etat.reglages.courseSoleil) dessinerCourse(date);
  emit('temps', etat.temps);
}

// --- Barre du temps -----------------------------------------------------------

function majBarre(date, azimut, hauteur) {
  document.getElementById('temps-heure').textContent = hhmm(t.minutes);
  const curseur = document.getElementById('temps-curseur');
  if (+curseur.value !== t.minutes) curseur.value = t.minutes;
  document.getElementById('temps-date').value = t.jour;
  const [lon, lat] = centre();
  const h = SunCalc.getTimes(date, lat, lon);
  const soleil = hauteur > 0
    ? `Soleil ${Math.round(azimut)}° · ${Math.round(hauteur)}° de haut`
    : 'Soleil couché';
  const el = document.getElementById('temps-soleil');
  el.textContent = `${soleil} · ↑ ${heureParis(h.sunrise)} · ↓ ${heureParis(h.sunset)}`;
  el.title = `Azimut ${Math.round(azimut)}° (depuis le nord), hauteur ${decimalFr(hauteur)}°. ` +
    `Lever ${heureParis(h.sunrise)}, midi solaire ${heureParis(h.solarNoon)}, coucher ${heureParis(h.sunset)}.`;
  document.getElementById('temps-maintenant').classList.toggle('actif', t.auto);
}

// Dégradé du ciel sur la journée, dessiné sous le curseur.
function majDegrade() {
  const [a, m, j] = t.jour.split('-').map(Number);
  const arrets = [];
  for (let min = 0; min <= 1440; min += 30) {
    const { hauteur } = positionSoleil(dateParis(a, m, j, min));
    const c = couleursCiel(hauteur).zenith;
    const jour = lisse(-7, 5, hauteur);
    arrets.push(`${versCss(melanger(c, [250, 214, 120], jour * 0.35))} ${(min / 1440) * 100}%`);
  }
  document.getElementById('ciel-degrade').style.background = `linear-gradient(90deg, ${arrets.join(',')})`;
}

// --- Course du soleil en 3D ------------------------------------------------------

function dessinerCourse(date) {
  const [a, m, j] = t.jour.split('-').map(Number);
  const c = centre();
  const rect = etat.zone?.rect;
  const R = rect ? Math.max(350, Math.min(1200, Math.max(rect.largeur, rect.hauteur) * 0.55)) : 700;
  const pointCiel = (az, h) => {
    const r = R * Math.cos((h * Math.PI) / 180);
    const [lon, lat] = versLonLat([r * Math.sin((az * Math.PI) / 180), r * Math.cos((az * Math.PI) / 180)], c);
    return [lon, lat, R * Math.sin((h * Math.PI) / 180)];
  };
  const chemin = [];
  const reperes = [];
  for (let min = 0; min <= 1440; min += 6) {
    const { azimut, hauteur } = positionSoleil(dateParis(a, m, j, min), c);
    if (hauteur < -1) continue;
    chemin.push(pointCiel(azimut, Math.max(hauteur, 0)));
    if (min % 120 === 0 && hauteur > 1) reperes.push({ p: pointCiel(azimut, hauteur), t: `${min / 60} h` });
  }
  const { azimut, hauteur } = positionSoleil(date, c);
  const soleil = hauteur > -1 ? [{ p: pointCiel(azimut, Math.max(hauteur, 0)) }] : [];
  definirCouches('soleil', [
    new deck.PathLayer({
      id: 'course-soleil', data: [{ chemin }], getPath: (d) => d.chemin,
      getColor: [242, 170, 60, 210], getWidth: 3, widthUnits: 'pixels', jointRounded: true, capRounded: true,
      parameters: { depthCompare: 'always', depthWriteEnabled: false }, shadowEnabled: false,
    }),
    new deck.ScatterplotLayer({
      id: 'soleil-halo', data: soleil, getPosition: (d) => d.p, getRadius: 22, radiusUnits: 'pixels',
      getFillColor: [255, 200, 80, 70], billboard: true, parameters: { depthCompare: 'always', depthWriteEnabled: false }, shadowEnabled: false,
    }),
    new deck.ScatterplotLayer({
      id: 'soleil-disque', data: soleil, getPosition: (d) => d.p, getRadius: 10, radiusUnits: 'pixels',
      getFillColor: [255, 214, 90, 255], stroked: true, getLineColor: [255, 255, 255, 230], lineWidthUnits: 'pixels',
      getLineWidth: 2, billboard: true, parameters: { depthCompare: 'always', depthWriteEnabled: false }, shadowEnabled: false,
    }),
    new deck.TextLayer({
      id: 'soleil-heures', data: reperes, getPosition: (d) => d.p, getText: (d) => d.t, getSize: 12,
      getColor: [120, 80, 20, 255], background: true, getBackgroundColor: [255, 246, 225, 220],
      backgroundPadding: [4, 2], fontFamily: 'system-ui, sans-serif', getPixelOffset: [0, -14],
      parameters: { depthCompare: 'always', depthWriteEnabled: false }, shadowEnabled: false,
    }),
  ]);
}

export function afficherCourseSoleil(visible) {
  etat.reglages.courseSoleil = visible;
  if (visible) dessinerCourse(instantCourant());
  else definirCouches('soleil', []);
}

// --- Commandes -------------------------------------------------------------------

export function definirHeure(minutes, { auto = false } = {}) {
  t.minutes = Math.max(0, Math.min(1439, Math.round(minutes)));
  t.auto = auto;
  appliquer();
}

export function definirJour(iso) {
  t.jour = iso;
  t.auto = false;
  majDegrade();
  appliquer();
}

export function maintenant() {
  const d = new Date();
  t.jour = isoJourParis(d);
  t.minutes = minutesParis(d);
  t.auto = true;
  majDegrade();
  appliquer();
}

let rafLecture = 0;
function basculerLecture(forcer) {
  t.lecture = forcer ?? !t.lecture;
  const bouton = document.getElementById('temps-lecture');
  bouton.querySelector('use').setAttribute('href', t.lecture ? '#i-pause' : '#i-lecture');
  bouton.title = t.lecture ? 'Arrêter l\'animation' : 'Animer la journée';
  cancelAnimationFrame(rafLecture);
  if (!t.lecture) return;
  t.auto = false;
  let precedent = performance.now();
  let reste = 0;
  const pas = (now) => {
    const dt = now - precedent;
    precedent = now;
    reste += (dt / DUREE_JOURNEE_MS) * 1440;
    if (reste >= 2) {
      t.minutes = (t.minutes + Math.floor(reste)) % 1440;
      reste -= Math.floor(reste);
      appliquer();
    }
    rafLecture = requestAnimationFrame(pas);
  };
  rafLecture = requestAnimationFrame(pas);
}

export function initSoleil() {
  const curseur = document.getElementById('temps-curseur');
  curseur.addEventListener('input', () => definirHeure(+curseur.value));
  document.getElementById('temps-date').addEventListener('change', (e) => {
    if (e.target.value) definirJour(e.target.value);
  });
  document.getElementById('temps-maintenant').addEventListener('click', () => {
    basculerLecture(false);
    maintenant();
  });
  document.getElementById('temps-lecture').addEventListener('click', () => basculerLecture());
  document.querySelectorAll('.temps-raccourcis [data-date]').forEach((b) => b.addEventListener('click', () => {
    const annee = partiesParis(new Date()).annee;
    definirJour(`${annee}-${b.dataset.date}`);
  }));
  // Suivi de l'heure réelle en mode automatique.
  setInterval(() => { if (t.auto && !t.lecture) maintenant(); }, 60000);
  on('zone', () => { majDegrade(); appliquer(); });
  on('reglages', () => appliquer());
  on('meteo', () => appliquer());
  majDegrade();
  appliquer();
}
