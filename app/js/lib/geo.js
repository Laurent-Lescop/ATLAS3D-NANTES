// Géométrie locale : conversions degrés ↔ mètres autour d'un point (plan tangent
// de l'ellipsoïde GRS80), et cadre de sélection orienté.

const A = 6378137.0;
const E2 = 0.00669438002290;
const RAD = Math.PI / 180;

// Facteurs mètres/degré en longitude (kx) et en latitude (ky) à une latitude donnée.
export function echelles(lat) {
  const s = Math.sin(lat * RAD);
  const w = Math.sqrt(1 - E2 * s * s);
  const N = A / w;
  const M = A * (1 - E2) / (w * w * w);
  return { kx: N * Math.cos(lat * RAD) * RAD, ky: M * RAD };
}

export function versLocal([lon, lat], [lon0, lat0], k = echelles(lat0)) {
  return [(lon - lon0) * k.kx, (lat - lat0) * k.ky];
}

export function versLonLat([x, y], [lon0, lat0], k = echelles(lat0)) {
  return [lon0 + x / k.kx, lat0 + y / k.ky];
}

export function distance(a, b) {
  const [x, y] = versLocal(b, a);
  return Math.hypot(x, y);
}

// Cadre : { centre: [lon, lat], largeur: m, hauteur: m, angle: degrés (sens trigonométrique) }.
// Coordonnées « cadre » : x le long de la largeur, y le long de la hauteur.
export function coinsCadre(c) {
  const t = c.angle * RAD, cos = Math.cos(t), sin = Math.sin(t);
  const k = echelles(c.centre[1]);
  const hw = c.largeur / 2, hh = c.hauteur / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) =>
    versLonLat([x * cos - y * sin, x * sin + y * cos], c.centre, k));
}

export function polygoneCadre(c) {
  const coins = coinsCadre(c);
  return { type: 'Polygon', coordinates: [[...coins, coins[0]]] };
}

// Point (lon, lat) exprimé dans le repère du cadre (mètres).
export function dansRepereCadre(c, lonlat) {
  const [x, y] = versLocal(lonlat, c.centre);
  const t = -c.angle * RAD;
  return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
}

export function depuisRepereCadre(c, [x, y]) {
  const t = c.angle * RAD;
  return versLonLat([x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)], c.centre);
}

export function contientPoint(c, lonlat, marge = 0) {
  const [x, y] = dansRepereCadre(c, lonlat);
  return Math.abs(x) <= c.largeur / 2 + marge && Math.abs(y) <= c.hauteur / 2 + marge;
}

// Emprise [ouest, sud, est, nord] du cadre, agrandi d'une marge (m).
export function emprise(c, marge = 0) {
  const coins = coinsCadre({ ...c, largeur: c.largeur + 2 * marge, hauteur: c.hauteur + 2 * marge });
  const xs = coins.map((p) => p[0]), ys = coins.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Cap (degrés, sens horaire depuis le nord) qui aligne la largeur du cadre sur l'écran.
export function capAligne(c) {
  return -c.angle;
}

// Masque : le monde avec le cadre en creux.
export function masqueExterieur(c) {
  const coins = coinsCadre(c);
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
        [...coins, coins[0]].reverse(),
      ],
    },
  };
}
