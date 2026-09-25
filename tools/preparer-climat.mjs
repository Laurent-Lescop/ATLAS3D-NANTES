#!/usr/bin/env node
// Prépare les données climatiques locales (data/climat/nantes-climat.json) à partir
// des archives horaires Open-Meteo (réanalyses ERA5 / ERA5-Land, Copernicus) :
//   - roses des vents par mois et sur l'année (16 secteurs × 5 classes de vitesse) ;
//   - normales par mois et par heure (température, humidité, nébulosité, rayonnement, vent) ;
//   - statistiques mensuelles (minimales, maximales, pluie, jours de pluie).
// Ces données servent au panneau Climat et aux valeurs indicatives hors connexion.
//
// Usage : node tools/preparer-climat.mjs [annéeDébut annéeFin]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJSON, log } from './commun.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const OUT = path.join(ROOT, 'data', 'climat');
const LAT = 47.2173, LON = -1.5534;

const finDefaut = new Date().getUTCFullYear() - 1;
const [DEBUT, FIN] = process.argv.length === 4 ? process.argv.slice(2).map(Number) : [finDefaut - 9, finDefaut];

const VARIABLES = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'shortwave_radiation'];

// Classes de vitesse (km/h). En dessous de CALME, le vent est considéré comme nul.
const CALME = 2;
const CLASSES = [10, 20, 30, 40, Infinity];

async function annee(a) {
  const fichier = path.join(CACHE, `openmeteo_${a}.json`);
  if (fs.existsSync(fichier)) return JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const params = new URLSearchParams({
    latitude: LAT, longitude: LON, start_date: `${a}-01-01`, end_date: `${a}-12-31`,
    hourly: VARIABLES.join(','), timezone: 'Europe/Paris', wind_speed_unit: 'kmh',
  });
  const d = await fetchJSON(`https://archive-api.open-meteo.com/v1/archive?${params}`, {},
    { label: `Open-Meteo ${a}`, timeoutMs: 120000, pauseMs: 20000 });
  fs.writeFileSync(fichier, JSON.stringify(d));
  return d;
}

const r1 = (v) => Math.round(v * 10) / 10;

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  // roses[m] : m = 0 pour l'année, 1..12 pour les mois.
  const roses = Array.from({ length: 13 }, () => ({
    n: 0, calme: 0, secteurs: Array.from({ length: 16 }, () => new Array(CLASSES.length).fill(0)), somme: 0,
  }));
  // Normales par mois et par heure : sommes et effectifs.
  const cumul = Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => ({
    n: 0, t: 0, t2: 0, hr: 0, nuage: 0, ray: 0, vent: 0,
  })));
  // Jours : { cle: { mois, tmin, tmax, pluie } }
  const jours = new Map();
  let rafaleMax = { v: 0, date: null };

  for (let a = DEBUT; a <= FIN; a++) {
    const d = await annee(a);
    const h = d.hourly;
    for (let i = 0; i < h.time.length; i++) {
      const t = h.temperature_2m[i];
      if (t == null) continue;
      const mois = +h.time[i].slice(5, 7);
      const heure = +h.time[i].slice(11, 13);
      const c = cumul[mois - 1][heure];
      c.n++; c.t += t; c.t2 += t * t;
      c.hr += h.relative_humidity_2m[i] ?? 0;
      c.nuage += h.cloud_cover[i] ?? 0;
      c.ray += h.shortwave_radiation[i] ?? 0;
      c.vent += h.wind_speed_10m[i] ?? 0;

      const v = h.wind_speed_10m[i], dir = h.wind_direction_10m[i];
      if (v != null && dir != null) {
        for (const r of [roses[0], roses[mois]]) {
          r.n++; r.somme += v;
          if (v < CALME) { r.calme++; continue; }
          const s = Math.round(dir / 22.5) % 16;
          r.secteurs[s][CLASSES.findIndex((b) => v < b)]++;
        }
      }
      if ((h.wind_gusts_10m[i] ?? 0) > rafaleMax.v) rafaleMax = { v: h.wind_gusts_10m[i], date: h.time[i] };

      const cle = h.time[i].slice(0, 10);
      let j = jours.get(cle);
      if (!j) jours.set(cle, j = { mois, tmin: Infinity, tmax: -Infinity, pluie: 0 });
      j.tmin = Math.min(j.tmin, t); j.tmax = Math.max(j.tmax, t); j.pluie += h.precipitation[i] ?? 0;
    }
    log(`Année ${a} traitée`);
  }

  const nbAnnees = FIN - DEBUT + 1;
  const mensuel = Array.from({ length: 12 }, () => ({ n: 0, tmin: 0, tmax: 0, pluie: 0, joursPluie: 0 }));
  for (const j of jours.values()) {
    const m = mensuel[j.mois - 1];
    m.n++; m.tmin += j.tmin; m.tmax += j.tmax; m.pluie += j.pluie; if (j.pluie >= 1) m.joursPluie++;
  }

  const sortieRose = (r) => {
    const pct = (x) => (r.n ? Math.round((x / r.n) * 1000) / 10 : 0);
    const totaux = r.secteurs.map((s) => s.reduce((a, b) => a + b, 0));
    const dominant = totaux.indexOf(Math.max(...totaux));
    return {
      calme: pct(r.calme),
      secteurs: r.secteurs.map((s) => s.map(pct)),
      vitesseMoyenne: r.n ? r1(r.somme / r.n) : null,
      dominante: dominant * 22.5,
    };
  };

  const resultat = {
    version: 1,
    genere: new Date().toISOString(),
    source: 'Open-Meteo — archives horaires (réanalyses ERA5 / ERA5-Land, Copernicus), CC BY 4.0',
    point: { lat: LAT, lon: LON, nom: 'Nantes centre' },
    periode: [DEBUT, FIN],
    vent: {
      unite: 'km/h',
      calme: CALME,
      classes: CLASSES.map((b, i) => [i ? CLASSES[i - 1] : CALME, b === Infinity ? null : b]),
      secteurs: ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'],
      roses: roses.map(sortieRose),
      rafaleMax: { vitesse: rafaleMax.v, date: rafaleMax.date },
    },
    normales: cumul.map((heures, m) => {
      const mm = mensuel[m];
      return {
        mois: m + 1,
        temperature: heures.map((c) => r1(c.t / c.n)),
        ecartType: heures.map((c) => r1(Math.sqrt(Math.max(0, c.t2 / c.n - (c.t / c.n) ** 2)))),
        humidite: heures.map((c) => Math.round(c.hr / c.n)),
        nebulosite: heures.map((c) => Math.round(c.nuage / c.n)),
        rayonnement: heures.map((c) => Math.round(c.ray / c.n)),
        vent: heures.map((c) => r1(c.vent / c.n)),
        tmin: r1(mm.tmin / mm.n),
        tmax: r1(mm.tmax / mm.n),
        pluie: r1(mm.pluie / nbAnnees),
        joursPluie: r1(mm.joursPluie / nbAnnees),
      };
    }),
  };
  fs.writeFileSync(path.join(OUT, 'nantes-climat.json'), JSON.stringify(resultat));
  const annuel = resultat.vent.roses[0];
  log(`Écrit data/climat/nantes-climat.json — vent dominant ${annuel.dominante}°, moyenne ${annuel.vitesseMoyenne} km/h, calme ${annuel.calme} %`);
}

main().catch((e) => { console.error(e); process.exit(1); });
