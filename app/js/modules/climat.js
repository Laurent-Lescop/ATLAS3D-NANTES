// Panneau « Climat » : météo à l'heure choisie (prévision, observation ou normale),
// rose des vents, courbe de température, qualité de l'air, niveau de la Loire,
// ensoleillement ; vent animé sur la carte ; nébulosité appliquée à la lumière.

/* global deck */
import * as SunCalc from '../../vendor/suncalc/index.js';
import { etat, emit, on } from '../etat.js';
import { lireSource, lireJSON, HorsLigneError } from '../api.js';
import { enregistrerPanneau, rafraichirPanneau, panneauActif } from '../ui/panneaux.js';
import { courbe, roseDesVents, tendance } from '../ui/graphiques.js';
import { html, echapper, decimal, entier, etatDonnee } from '../ui/format.js';
import { partiesParis, heureParis, depuis, dateParis } from '../temps.js';
import { definirCouches } from '../carte/rendu3d.js';
import { versLonLat } from '../lib/geo.js';

const NANTES = [-1.5534, 47.2173];

let climat = null;   // normales et roses (data/climat/nantes-climat.json)
let meteo = null;    // { donnees, etat, date }
let air = null;
let loire = null;
let moisRose = 'date'; // 'date' (mois de la date choisie) | 0 (année)
let ventCarte = false;

// --- Codes météo (OMM) -------------------------------------------------------------------

const CODES = {
  0: 'Ciel dégagé', 1: 'Plutôt dégagé', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine légère', 53: 'Bruine', 55: 'Bruine dense', 56: 'Bruine verglaçante', 57: 'Bruine verglaçante',
  61: 'Pluie faible', 63: 'Pluie modérée', 65: 'Pluie forte', 66: 'Pluie verglaçante', 67: 'Pluie verglaçante',
  71: 'Neige faible', 73: 'Neige modérée', 75: 'Neige forte', 77: 'Grains de neige',
  80: 'Averses faibles', 81: 'Averses', 82: 'Averses violentes', 85: 'Averses de neige', 86: 'Averses de neige',
  95: 'Orage', 96: 'Orage avec grêle', 99: 'Orage avec grêle',
};

function iconeCiel(code, nuit) {
  const soleil = nuit
    ? '<path d="M16 4.5a7.5 7.5 0 1 0 3.5 13.9A8.5 8.5 0 0 1 16 4.5Z"/>'
    : '<circle cx="12" cy="11" r="4"/><path d="M12 3v1.5M12 17.5V19M4 11h1.5M18.5 11H20M6.3 5.3l1 1M16.7 15.7l1 1M6.3 16.7l1-1M16.7 6.3l1-1"/>';
  const nuage = '<path d="M7 19h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 6.9 12 3.5 3.5 0 0 0 7 19Z"/>';
  let corps;
  if (code <= 1) corps = soleil;
  else if (code === 2) corps = `<g opacity=".7">${soleil}</g>${nuage}`;
  else if (code === 3) corps = nuage;
  else if (code === 45 || code === 48) corps = '<path d="M4 9h16M3 13h18M5 17h14"/>';
  else if (code >= 95) corps = `${nuage}<path d="m12 19-2 3h3l-2 3"/>`;
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) corps = `${nuage}<path d="M9 22h.01M13 22h.01M11 24h.01"/>`;
  else corps = `${nuage}<path d="m9 21-1 2M13 21l-1 2M17 21l-1 2"/>`;
  return `<svg viewBox="0 0 24 26" style="width:44px;height:44px">${corps}</svg>`;
}

function flecheVent(direction) {
  // Flèche orientée dans le sens où va le vent.
  return `<svg class="fleche-vent" viewBox="0 0 24 24" style="transform:rotate(${direction + 180}deg)"><path d="M12 3v18M6 9l6-6 6 6"/></svg>`;
}

const SECTEURS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const secteur = (deg) => SECTEURS[Math.round(deg / 22.5) % 16];

// --- Valeurs à un instant donné ---------------------------------------------------------

function cleHeure(date) {
  const p = partiesParis(date);
  return `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}T${String(p.heure).padStart(2, '0')}:00`;
}

// Générateur pseudo-aléatoire déterministe (mêmes valeurs indicatives pour la même heure).
function aleatoire(graine) {
  let s = graine >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Normales interpolées entre deux mois selon le jour.
function normaleA(date) {
  if (!climat) return null;
  const p = partiesParis(date);
  const idx = p.mois - 1;
  const frac = (p.jour - 15) / 30;
  const autre = frac >= 0 ? (idx + 1) % 12 : (idx + 11) % 12;
  const w = Math.abs(frac);
  const mix = (cle) => {
    const a = climat.normales[idx][cle][p.heure], b = climat.normales[autre][cle][p.heure];
    return a + (b - a) * w;
  };
  // Vent tiré de la rose du mois (graine : date et tranche de trois heures).
  const rng = aleatoire(p.annee * 10000 + p.mois * 100 + p.jour * 8 + Math.floor(p.heure / 3));
  const rose = climat.vent.roses[p.mois];
  const totaux = rose.secteurs.map((s) => s.reduce((a, b) => a + b, 0));
  let tirage = rng() * totaux.reduce((a, b) => a + b, 0);
  let s = 0;
  while (s < 15 && tirage > totaux[s]) { tirage -= totaux[s]; s++; }
  const vitesseMoy = mix('vent');
  const nebulosite = mix('nebulosite');
  return {
    etat: 'simule',
    nature: 'normale',
    temperature: mix('temperature'),
    ressentie: null,
    humidite: mix('humidite'),
    nebulosite,
    rayonnement: mix('rayonnement'),
    vent: vitesseMoy * (0.75 + rng() * 0.5),
    direction: s * 22.5 + (rng() - 0.5) * 20,
    rafales: null,
    pluie: null,
    code: nebulosite < 25 ? 0 : nebulosite < 50 ? 1 : nebulosite < 80 ? 2 : 3,
  };
}

export function meteoA(date) {
  const h = meteo?.donnees?.hourly;
  if (h) {
    const i = h.time.indexOf(cleHeure(date));
    if (i >= 0) {
      const passe = date.getTime() < Date.now() - 30 * 60000;
      return {
        etat: meteo.etat,
        nature: passe ? 'observation' : 'prevision',
        temperature: h.temperature_2m[i],
        ressentie: h.apparent_temperature[i],
        humidite: h.relative_humidity_2m[i],
        nebulosite: h.cloud_cover[i],
        rayonnement: h.shortwave_radiation[i],
        vent: h.wind_speed_10m[i],
        direction: h.wind_direction_10m[i],
        rafales: h.wind_gusts_10m[i],
        pluie: h.precipitation[i],
        probaPluie: h.precipitation_probability?.[i],
        uv: h.uv_index?.[i],
        code: h.weather_code[i],
      };
    }
  }
  return normaleA(date);
}

// Courbe de température de la journée choisie : prévision/observation et normale.
function serieJournee(date) {
  const p = partiesParis(date);
  const reelle = [], normale = [];
  for (let heure = 0; heure <= 23; heure++) {
    const d = dateParis(p.annee, p.mois, p.jour, heure * 60);
    const v = meteoA(d);
    reelle.push([heure, v && v.etat !== 'simule' ? v.temperature : null]);
    normale.push([heure, normaleA(d)?.temperature ?? null]);
  }
  return { reelle, normale };
}

// --- Chargement des sources ---------------------------------------------------------------

async function lireOuNull(nom) {
  try { return await lireSource(nom); } catch (e) {
    if (!(e instanceof HorsLigneError)) console.warn(e.message);
    return null;
  }
}

async function rafraichir() {
  [meteo, air, loire] = await Promise.all([lireOuNull('meteo'), lireOuNull('air'), lireOuNull('loire')]);
  emit('meteo', meteo);
  rafraichirPanneau('climat');
  dessinerVent();
}

// --- Panneau -----------------------------------------------------------------------------

const NATURES = { observation: 'Observation', prevision: 'Prévision', normale: 'Normale de saison' };

function sectionMaintenant(date) {
  const v = meteoA(date);
  if (!v) return '<p class="aide">Données climatiques indisponibles.</p>';
  const nuit = (etat.soleil?.hauteur ?? 10) < 0;
  const quand = etat.temps?.auto ? 'Maintenant' : `Le ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' })} à ${heureParis(date)}`;
  const note = v.etat === 'simule'
    ? `<p class="note">${meteo ? 'Hors de la période de prévision' : 'Sans connexion'} : valeurs indicatives tirées des normales ${climat.periode.join('–')} (Open-Meteo, ERA5).</p>`
    : `<p class="note">${NATURES[v.nature]} Open-Meteo, mise à jour ${depuis(meteo.date)}.</p>`;
  return `
    <div class="section">
      <h3>${echapper(quand)} ${etatDonnee(v.etat === 'simule' ? 'simule' : v.etat, meteo?.date)}</h3>
      <div class="meteo-principale">
        ${iconeCiel(v.code, nuit)}
        <div class="temperature">${decimal(v.temperature)}°</div>
        <div class="ciel"><strong>${echapper(CODES[v.code] ?? '—')}</strong>
          ${v.ressentie != null ? `Ressenti ${decimal(v.ressentie)}°` : NATURES[v.nature]}</div>
      </div>
      <table class="tableau">
        <tr><th>Vent</th><td>${flecheVent(v.direction)} ${entier(v.vent)} km/h de ${secteur(v.direction)} (${entier(v.direction)}°)${v.rafales != null ? `, rafales ${entier(v.rafales)} km/h` : ''}</td></tr>
        <tr><th>Humidité</th><td>${entier(v.humidite)} %</td></tr>
        <tr><th>Nébulosité</th><td>${entier(v.nebulosite)} %</td></tr>
        <tr><th>Rayonnement solaire</th><td>${entier(v.rayonnement)} W/m²</td></tr>
        ${v.pluie != null ? `<tr><th>Précipitations</th><td>${decimal(v.pluie)} mm/h${v.probaPluie != null ? ` (risque ${entier(v.probaPluie)} %)` : ''}</td></tr>` : ''}
        ${v.uv != null ? `<tr><th>Indice UV</th><td>${decimal(v.uv)}</td></tr>` : ''}
      </table>
      ${note}
    </div>`;
}

function sectionSoleil(date) {
  const [lon, lat] = etat.zone?.rect.centre || NANTES;
  const t = SunCalc.getTimes(date, lat, lon);
  const midi = SunCalc.getPosition(t.solarNoon, lat, lon);
  const duree = (t.sunset - t.sunrise) / 60000;
  return `
    <div class="section">
      <h3>Ensoleillement du jour</h3>
      <table class="tableau">
        <tr><th>Lever / coucher</th><td>${heureParis(t.sunrise)} / ${heureParis(t.sunset)}</td></tr>
        <tr><th>Durée du jour</th><td>${Math.floor(duree / 60)} h ${String(Math.round(duree % 60)).padStart(2, '0')}</td></tr>
        <tr><th>Midi solaire</th><td>${heureParis(t.solarNoon)}, soleil à ${decimal(midi.altitude)}° de hauteur</td></tr>
        <tr><th>Heure dorée</th><td>jusqu'à ${heureParis(t.goldenHourEnd)} et dès ${heureParis(t.goldenHour)}</td></tr>
      </table>
    </div>`;
}

const AQI = [
  [20, 'Bon', 'bon'], [40, 'Assez bon', 'bon'], [60, 'Moyen', 'moyen'],
  [80, 'Médiocre', 'degrade'], [100, 'Très médiocre', 'mauvais'], [Infinity, 'Extrêmement mauvais', 'mauvais'],
];

function sectionAir() {
  if (!air) {
    return `<div class="section"><h3>Qualité de l'air</h3>
      <p class="aide">Indisponible hors connexion (aucune valeur récente en mémoire).</p></div>`;
  }
  const c = air.donnees.current;
  const [, libelle, statut] = AQI.find(([max]) => c.european_aqi <= max);
  const pollens = [['alder_pollen', 'Aulne'], ['birch_pollen', 'Bouleau'], ['grass_pollen', 'Graminées'],
    ['mugwort_pollen', 'Armoise'], ['olive_pollen', 'Olivier'], ['ragweed_pollen', 'Ambroisie']]
    .filter(([k]) => c[k] > 0);
  return `
    <div class="section">
      <h3>Qualité de l'air ${etatDonnee(air.etat, air.date)}</h3>
      <p><span class="statut"><i style="background:var(--statut-${statut})"></i>${libelle}</span>
        — indice européen ${entier(c.european_aqi)}</p>
      <table class="tableau">
        <tr><th>Particules PM2,5</th><td>${decimal(c.pm2_5)} µg/m³</td></tr>
        <tr><th>Particules PM10</th><td>${decimal(c.pm10)} µg/m³</td></tr>
        <tr><th>Dioxyde d'azote</th><td>${decimal(c.nitrogen_dioxide)} µg/m³</td></tr>
        <tr><th>Ozone</th><td>${decimal(c.ozone)} µg/m³</td></tr>
        ${pollens.map(([k, n]) => `<tr><th>Pollen : ${n}</th><td>${decimal(c[k])} grains/m³</td></tr>`).join('')}
      </table>
      <p class="note">Modèle CAMS (Copernicus) via Open-Meteo, ${depuis(air.date)}.</p>
    </div>`;
}

function sectionLoire(conteneurGraphique) {
  if (!loire?.donnees?.data?.length) {
    return `<div class="section"><h3>Hauteur de la Loire</h3>
      <p class="aide">Indisponible hors connexion (aucune mesure récente en mémoire).</p></div>`;
  }
  const mesures = loire.donnees.data
    .map((d) => [new Date(d.date_obs).getTime(), d.resultat_obs / 1000])
    .filter((d) => d[0] > Date.now() - 48 * 3600000)
    .sort((a, b) => a[0] - b[0]);
  const dernier = mesures[mesures.length - 1] || [new Date(loire.donnees.data[0].date_obs).getTime(), loire.donnees.data[0].resultat_obs / 1000];
  const avant = mesures.find((m) => m[0] >= dernier[0] - 40 * 60000);
  const sens = avant && dernier[1] - avant[1] > 0.02 ? 'monte' : avant && dernier[1] - avant[1] < -0.02 ? 'descend' : 'stable';
  conteneurGraphique.points = mesures;
  return `<div class="section"><h3>Hauteur de la Loire ${etatDonnee(loire.etat, loire.date)}</h3>
    <p><strong style="font-size:20px">${decimal(dernier[1], 2)} m</strong> au pont Anne-de-Bretagne — le niveau ${sens}
      (${new Date(dernier[0]).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}).</p>
    <div id="climat-loire"></div>
    <p class="note">À Nantes, la Loire subit la marée : le niveau oscille deux fois par jour. Hauteur à l'échelle de la station (Hub'Eau / Vigicrues).</p>
  </div>`;
}

function rendre(conteneur) {
  if (!climat) {
    conteneur.appendChild(html('<p class="aide">Données climatiques locales absentes (data/climat).</p>'));
    return;
  }
  const date = etat.temps?.date || new Date();
  const p = partiesParis(date);
  const moisIdx = moisRose === 'date' ? p.mois : 0;
  const rose = climat.vent.roses[moisIdx];
  const nomMois = moisIdx ? date.toLocaleDateString('fr-FR', { month: 'long', timeZone: 'Europe/Paris' }) : 'toute l\'année';
  const v = meteoA(date);
  const loireInfo = {};
  const el = html(`<div>
    ${sectionMaintenant(date)}
    <div class="section">
      <h3>Température de la journée</h3>
      <div class="legende-ligne">
        <span><i style="background:var(--serie-1)"></i>${meteo ? 'Prévision / observation' : 'Indisponible hors ligne'}</span>
        <span><i style="background:var(--serie-muette)"></i>Normale ${climat.periode.join('–')}</span>
      </div>
      <div id="climat-temperature"></div>
    </div>
    <div class="section">
      <h3>Rose des vents — ${echapper(nomMois)}</h3>
      <div class="segments" id="climat-rose-mois">
        <button data-v="date" class="${moisRose === 'date' ? 'actif' : ''}">Mois de la date</button>
        <button data-v="0" class="${moisRose === 0 ? 'actif' : ''}">Année</button>
      </div>
      <div id="climat-rose" style="max-width:300px;margin:6px auto 0"></div>
      <div class="legende-ligne">${climat.vent.classes.map(([a, b], k) =>
        `<span><i class="case" style="background:var(--rose-${k + 1})"></i>${b ? `${a}–${b}` : `≥ ${a}`} km/h</span>`).join('')}
        <span><i style="background:var(--encre)"></i>vent à l'heure choisie</span></div>
      <p class="note">Fréquence des vents selon leur provenance (${climat.periode.join('–')}, réanalyse ERA5).
        Dominante : ${secteur(rose.dominante)}, moyenne ${decimal(rose.vitesseMoyenne)} km/h, calme ${decimal(rose.calme)} % du temps.</p>
      <details class="tableau-donnees"><summary>Voir le tableau</summary>
        <table class="tableau">${rose.secteurs.map((s, i) =>
          `<tr><th>${climat.vent.secteurs[i]}</th><td>${decimal(s.reduce((a, b) => a + b, 0))} %</td></tr>`).join('')}</table>
      </details>
      <label class="interrupteur" style="margin-top:8px"><input type="checkbox" id="climat-vent-carte" ${ventCarte ? 'checked' : ''}>
        <span>Vent animé sur la carte<small>Direction et force du vent à l'heure choisie</small></span></label>
    </div>
    ${sectionAir()}
    ${sectionLoire(loireInfo)}
    ${sectionSoleil(date)}
  </div>`);
  conteneur.appendChild(el);

  const { reelle, normale } = serieJournee(date);
  const minutes = p.heure + p.minute / 60;
  courbe(el.querySelector('#climat-temperature'), [
    { nom: 'Prévision / observation', points: reelle, couleur: 'var(--serie-1)', aire: true },
    { nom: 'Normale', points: normale, couleur: 'var(--serie-muette)', epaisseur: 1.5 },
  ], {
    xMin: 0, xMax: 23, unite: ' °C', marqueurX: minutes, titre: 'Température heure par heure',
    xTicks: [[0, '0 h'], [6, '6 h'], [12, '12 h'], [18, '18 h'], [23, '23 h']],
    formatX: (x) => `${x} h`, formatY: (y) => decimal(y),
  });
  const couleurs = [1, 2, 3, 4, 5].map((k) => getComputedStyle(document.body).getPropertyValue(`--rose-${k}`).trim());
  roseDesVents(el.querySelector('#climat-rose'), {
    secteurs: rose.secteurs,
    noms: climat.vent.secteurs,
    classes: climat.vent.classes.map(([a, b]) => (b ? `${a}–${b} km/h` : `≥ ${a} km/h`)),
    couleurs,
    calme: rose.calme,
    courant: v ? { direction: v.direction, vitesse: v.vent } : null,
  });
  if (loireInfo.points?.length > 2) {
    tendance(el.querySelector('#climat-loire'), loireInfo.points, { couleur: 'var(--serie-1)', format: (y) => decimal(y, 2), unite: ' m' });
  }
  el.querySelector('#climat-rose-mois').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    moisRose = b.dataset.v === 'date' ? 'date' : 0;
    rafraichirPanneau('climat');
  });
  el.querySelector('#climat-vent-carte').addEventListener('change', (e) => {
    ventCarte = e.target.checked;
    dessinerVent();
  });
}

// --- Vent animé sur la carte ------------------------------------------------------------

const ACCELERATION = 40; // les particules vont 40 fois plus vite que le vent réel
let particules = [];
let rafVent = 0;
let parametresVent = null;
let debutVent = 0;

// Met à jour la direction et la force du vent affiché ; démarre ou arrête l'animation.
function dessinerVent() {
  const actif = ventCarte && etat.mode === 'etude' && etat.zone;
  const v = actif ? meteoA(etat.temps?.date || new Date()) : null;
  if (!v) {
    cancelAnimationFrame(rafVent);
    rafVent = 0;
    definirCouches('meteo', []);
    return;
  }
  const rect = etat.zone.rect;
  const cap = ((v.direction + 180) * Math.PI) / 180; // vers où souffle le vent
  const vitesse = Math.max(0.5, v.vent / 3.6) * ACCELERATION;
  const nuit = (etat.soleil?.jour ?? 1) < 0.4;
  parametresVent = {
    rect,
    R: Math.max(rect.largeur, rect.hauteur) * 0.6 + 200,
    ux: Math.sin(cap), uy: Math.cos(cap),
    vitesse,
    trainee: Math.min(160, 3 * vitesse),
    couleur: nuit ? [170, 205, 255] : [38, 72, 128],
  };
  if (!particules.length) {
    const rng = aleatoire(12345);
    particules = Array.from({ length: 600 }, () => ({ a: rng() * 2 - 1, b: rng() * 2 - 1, z: 25 + rng() * 60, k: 0.7 + rng() * 0.6 }));
  }
  if (!rafVent) {
    debutVent = performance.now();
    rafVent = requestAnimationFrame(animerVent);
  }
}

function animerVent(now) {
  const { rect, R, ux, uy, vitesse, trainee, couleur } = parametresVent;
  const t = (now - debutVent) / 1000;
  const donnees = particules.map((p) => {
    // Position le long du vent (bouclée sur [-R, R]) et en travers.
    let s = p.a * R + t * vitesse * p.k;
    s = ((s + R) % (2 * R) + 2 * R) % (2 * R) - R;
    const q = p.b * R;
    const x = s * ux + q * uy, y = s * uy - q * ux;
    const tete = versLonLat([x, y], rect.centre);
    const queue = versLonLat([x - ux * trainee, y - uy * trainee], rect.centre);
    return { chemin: [[...queue, p.z], [...tete, p.z]], f: 1 - Math.abs(s) / R };
  });
  // PathLayer plutôt que LineLayer : ce dernier n'est pas dessiné quand les ombres sont actives.
  definirCouches('meteo', [new deck.PathLayer({
    id: 'vent-particules',
    data: donnees,
    getPath: (d) => d.chemin,
    capRounded: true,
    getColor: (d) => [...couleur, Math.round(40 + 170 * d.f)],
    getWidth: 2,
    widthUnits: 'pixels',
    shadowEnabled: false,
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
    updateTriggers: { getColor: couleur.join() },
  })]);
  rafVent = requestAnimationFrame(animerVent);
}

// --- Initialisation -----------------------------------------------------------------------

let attente = 0;
export async function initClimat() {
  climat = await lireJSON('/data/climat/nantes-climat.json').catch(() => null);
  etat.meteoA = meteoA;
  enregistrerPanneau('climat', { titre: 'Climat et météo', rendre });
  on('temps', () => {
    if (panneauActif() === 'climat') {
      clearTimeout(attente);
      attente = setTimeout(() => rafraichirPanneau('climat'), 250);
    }
    if (ventCarte) dessinerVent();
  });
  on('mode', dessinerVent);
  on('connexion', (enLigne) => { if (enLigne) rafraichir(); });
  await rafraichir();
  setInterval(rafraichir, 10 * 60000);
}
