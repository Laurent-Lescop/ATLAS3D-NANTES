// Géoréférencement des maquettes IFC : conversion des systèmes projetés français
// vers WGS84 (proj4js), prise en compte de la convergence des méridiens.

/* global proj4 */
import { versLonLat, versLocal } from './geo.js';

const DEFINITIONS = {
  'EPSG:2154': '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:27572': '+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +towgs84=-168,-60,320,0,0,0,0 +pm=paris +units=m +no_defs',
  'EPSG:32630': '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs',
  'EPSG:32631': '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs',
};
// Coniques conformes 9 zones (CC42 à CC50 : EPSG 3942 à 3950).
for (let z = 42; z <= 50; z++) {
  DEFINITIONS[`EPSG:${3900 + z}`] = `+proj=lcc +lat_0=${z} +lon_0=3 +lat_1=${z - 0.75} +lat_2=${z + 0.75} ` +
    `+x_0=1700000 +y_0=${(z - 41) * 1000000 + 200000} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
}

// Reconnaît le système à partir du nom trouvé dans l'IFC (« EPSG:2154 », « RGF93 / Lambert-93 »…).
export function identifierCrs(nom) {
  if (!nom) return null;
  const s = String(nom).toUpperCase();
  const m = s.match(/(?:EPSG)?\D*(\d{4,5})/);
  if (m && DEFINITIONS[`EPSG:${m[1]}`]) return `EPSG:${m[1]}`;
  if (/LAMBERT.?93|RGF93\s*\/?\s*LAMBERT/.test(s)) return 'EPSG:2154';
  const cc = s.match(/CC\s?(4[2-9]|50)/);
  if (cc) return `EPSG:${3900 + +cc[1]}`;
  if (/LAMBERT.?II|NTF/.test(s)) return 'EPSG:27572';
  return null;
}

function versWgs84(crs, e, n) {
  return proj4(DEFINITIONS[crs], 'EPSG:4326', [e, n]);
}

const DANS_FRANCE = ([lon, lat]) => lon > -6 && lon < 10 && lat > 41 && lat < 52;

// Altitude du rez-de-chaussée dans le repère du projet : niveau nommé comme tel,
// sinon le plus bas des niveaux hors sous-sol, sinon le bas de la maquette.
export function niveauSol(niveaux, bas) {
  const n = (niveaux || []).filter((x) => Number.isFinite(x.altitude));
  const rdc = n.find((x) => /(^|[^a-z])(rdc|rez|ground|gf|r\+?0|n0?0|niveau 0|level 0|etage 0)([^a-z0-9]|$)/i.test(x.nom || ''));
  if (rdc) return rdc.altitude;
  const hors = n.filter((x) => x.altitude >= -0.5);
  if (hors.length) return Math.min(...hors.map((x) => x.altitude));
  return bas;
}

// Calcule le placement (ancre WGS84, rotation, échelle) d'une maquette convertie.
// L'altitude est relative au sol de la carte : le rez-de-chaussée est posé à 0.
// centre : point (repère projet IFC) ramené à l'origine du maillage.
export function placementIfc(infos, centre, repli) {
  const c = infos.conversion;
  const alt = centre[2] - niveauSol(infos.niveaux, centre[2]);
  if (c && c.est != null) {
    const crs = identifierCrs(c.crs) || (c.est > 100000 && c.est < 1300000 && c.nord > 6000000 ? 'EPSG:2154' : null);
    if (crs) {
      const theta = Math.atan2(c.ay, c.ax);
      const e = c.est + c.echelle * (centre[0] * Math.cos(theta) - centre[1] * Math.sin(theta));
      const n = c.nord + c.echelle * (centre[0] * Math.sin(theta) + centre[1] * Math.cos(theta));
      const ancre = versWgs84(crs, e, n);
      if (DANS_FRANCE(ancre)) {
        // Convergence : angle entre le nord du quadrillage et le nord géographique.
        const nordGrille = versWgs84(crs, e, n + 100);
        const [dx, dy] = versLocal(nordGrille, ancre);
        const convergence = Math.atan2(dx, dy); // positif : nord de grille à l'est du nord vrai
        return {
          mode: 'ifc',
          lon: ancre[0], lat: ancre[1], alt,
          rotation: ((theta - convergence) * 180) / Math.PI,
          echelle: c.echelle || 1,
          note: `Géoréférencement IFC (IfcMapConversion, ${crs}).`,
        };
      }
    }
  }
  const s = infos.site;
  if (s?.lat != null && s?.lon != null && DANS_FRANCE([s.lon, s.lat]) && Math.abs(s.lat) > 1) {
    const rotation = infos.nordVrai ? (Math.atan2(infos.nordVrai[0], infos.nordVrai[1]) * 180) / Math.PI : 0;
    const r = (rotation * Math.PI) / 180;
    const ancre = versLonLat([centre[0] * Math.cos(r) - centre[1] * Math.sin(r), centre[0] * Math.sin(r) + centre[1] * Math.cos(r)], [s.lon, s.lat]);
    return {
      mode: 'site', lon: ancre[0], lat: ancre[1], alt, rotation, echelle: 1,
      note: 'Position approchée : coordonnées du site IFC (IfcSite). Vérifiez le calage.',
    };
  }
  return {
    mode: 'aucun', lon: repli[0], lat: repli[1], alt, rotation: 0, echelle: 1,
    note: 'La maquette n\'est pas géoréférencée : placez-la sur la carte.',
  };
}

// Passe d'un point du maillage (x est, y nord, mètres) aux coordonnées WGS84.
export function versCarte(placement, [x, y]) {
  const r = (placement.rotation * Math.PI) / 180, s = placement.echelle || 1;
  return versLonLat([s * (x * Math.cos(r) - y * Math.sin(r)), s * (x * Math.sin(r) + y * Math.cos(r))], [placement.lon, placement.lat]);
}

// Enveloppe convexe de l'emprise au sol du maillage, en WGS84.
export function empreinte(positions, placement) {
  const pts = [];
  const pas = Math.max(3, Math.floor(positions.length / 3 / 4000) * 3);
  for (let i = 0; i < positions.length; i += pas) pts.push([positions[i], positions[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const croix = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const bas = [], haut = [];
  for (const p of pts) {
    while (bas.length >= 2 && croix(bas[bas.length - 2], bas[bas.length - 1], p) <= 0) bas.pop();
    bas.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (haut.length >= 2 && croix(haut[haut.length - 2], haut[haut.length - 1], p) <= 0) haut.pop();
    haut.push(p);
  }
  const coque = bas.slice(0, -1).concat(haut.slice(0, -1));
  const anneau = coque.map((p) => versCarte(placement, p));
  anneau.push(anneau[0]);
  return anneau;
}

