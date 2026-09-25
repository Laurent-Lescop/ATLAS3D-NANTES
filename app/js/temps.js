// Heure légale de Nantes (Europe/Paris), heure d'été comprise.

const TZ = 'Europe/Paris';

const fmtParties = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

// Décompose un instant en date/heure de Paris.
export function partiesParis(date) {
  const p = Object.fromEntries(fmtParties.formatToParts(date).map((x) => [x.type, x.value]));
  const jours = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return {
    annee: +p.year, mois: +p.month, jour: +p.day, heure: +p.hour, minute: +p.minute, seconde: +p.second,
    jourSemaine: jours[p.weekday],
  };
}

// Décalage (minutes) de Paris par rapport à UTC à un instant donné.
export function decalageParis(date) {
  const p = partiesParis(date);
  const commeUTC = Date.UTC(p.annee, p.mois - 1, p.jour, p.heure, p.minute, p.seconde);
  return Math.round((commeUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// Instant correspondant à une date et une heure (minutes depuis minuit) de Paris.
export function dateParis(annee, mois, jour, minutes) {
  const naif = Date.UTC(annee, mois - 1, jour, 0, minutes);
  let t = naif - decalageParis(new Date(naif)) * 60000;
  const corr = decalageParis(new Date(t));
  t = naif - corr * 60000;
  return new Date(t);
}

export function minutesParis(date) {
  const p = partiesParis(date);
  return p.heure * 60 + p.minute;
}

export function isoJourParis(date) {
  const p = partiesParis(date);
  return `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`;
}

export function hhmm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function heureParis(date) {
  return date ? new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(date) : '—';
}

export function dateLongue(date) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

export function dateHeure(date) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

// Ancienneté lisible : « il y a 3 min ».
export function depuis(date) {
  const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

// Jours fériés français (métropole) d'une année.
export function joursFeries(annee) {
  const a = annee % 19, b = Math.floor(annee / 100), c = annee % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const moisP = Math.floor((h + l - 7 * m + 114) / 31), jourP = ((h + l - 7 * m + 114) % 31) + 1;
  const paques = Date.UTC(annee, moisP - 1, jourP);
  const j = (delta) => new Date(paques + delta * 86400000).toISOString().slice(0, 10);
  return new Set([
    `${annee}-01-01`, j(1), `${annee}-05-01`, `${annee}-05-08`, j(39), j(50),
    `${annee}-07-14`, `${annee}-08-15`, `${annee}-11-01`, `${annee}-11-11`, `${annee}-12-25`,
  ]);
}
