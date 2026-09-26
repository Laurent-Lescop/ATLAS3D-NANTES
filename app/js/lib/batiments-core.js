// Traitement des bâtiments, partagé entre le script de préparation (Node)
// et le navigateur (zones chargées en ligne).
//
// Entrées : réponse JSON d'Overpass (OSM) et, si disponible, GeoJSON BD TOPO (IGN).
// Sortie  : entités GeoJSON compactes avec hauteur, emprise, année, usage…
//
// Priorité des hauteurs :
//   1. balise OSM height (mesure explicite)
//   2. BD TOPO : hauteur à mi-toiture (gouttière + moitié du toit)
//   3. OSM building:levels × 3 m (+ niveaux de toit)
//   4. BD TOPO nombre d'étages × 3 m
//   5. valeur par défaut selon le type de bâtiment

export const HAUTEUR_NIVEAU = 3.0;

export const SOURCES_HAUTEUR = {
  o: 'OpenStreetMap (hauteur renseignée)',
  b: 'IGN BD TOPO (mesure, mi-toiture)',
  n: 'OpenStreetMap (niveaux × 3 m)',
  e: 'IGN BD TOPO (étages × 3 m)',
  d: 'Estimation par défaut',
};

const HAUTEURS_DEFAUT = {
  house: 6.5, detached: 6.5, semidetached_house: 6.5, terrace: 8, bungalow: 4,
  apartments: 15, residential: 9, dormitory: 12,
  garage: 3, garages: 3, carport: 2.5, shed: 2.5, hut: 2.5, roof: 4, kiosk: 3,
  greenhouse: 3, service: 3, toilets: 3, transformer_tower: 6,
  commercial: 9, retail: 7, office: 15, supermarket: 7, industrial: 9, warehouse: 9,
  school: 10, university: 14, college: 12, hospital: 18, public: 10, civic: 10,
  church: 18, cathedral: 35, chapel: 9, train_station: 12, stadium: 20, sports_hall: 10,
};

// ---------------------------------------------------------------------------
// Géométrie

const GRS80_A = 6378137.0;
const GRS80_E2 = 0.00669438002290;

// Rayons de courbure (méridien M, grande normale N) à une latitude donnée.
function radii(latDeg) {
  const phi = latDeg * Math.PI / 180;
  const s = Math.sin(phi);
  const w = Math.sqrt(1 - GRS80_E2 * s * s);
  return { M: GRS80_A * (1 - GRS80_E2) / (w * w * w), N: GRS80_A / w, cos: Math.cos(phi) };
}

// Aire (m²) d'un anneau [lon, lat] projeté sur le plan tangent local de l'ellipsoïde.
export function ringAreaM2(ring, lat0 = ring[0][1]) {
  const { M, N, cos } = radii(lat0);
  const kx = N * cos * Math.PI / 180;
  const ky = M * Math.PI / 180;
  const lon0 = ring[0][0];
  let s = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const x1 = (ring[i][0] - lon0) * kx, y1 = (ring[i][1] - lat0) * ky;
    const x2 = (ring[i + 1][0] - lon0) * kx, y2 = (ring[i + 1][1] - lat0) * ky;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

// Aire d'un polygone ou multipolygone GeoJSON (trous déduits).
export function areaM2(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let total = 0;
  for (const poly of polys) {
    const lat0 = poly[0][0][1];
    poly.forEach((ring, i) => { total += (i === 0 ? 1 : -1) * ringAreaM2(ring, lat0); });
  }
  return total;
}

// Périmètre (m) de l'anneau extérieur principal.
export function perimeterM(geometry) {
  const ring = geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : geometry.coordinates[0];
  const { M, N, cos } = radii(ring[0][1]);
  const kx = N * cos * Math.PI / 180, ky = M * Math.PI / 180;
  let p = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    p += Math.hypot((ring[i + 1][0] - ring[i][0]) * kx, (ring[i + 1][1] - ring[i][1]) * ky);
  }
  return p;
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, y, geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) {
    if (!pointInRing(x, y, poly[0])) continue;
    let inHole = false;
    for (let k = 1; k < poly.length; k++) if (pointInRing(x, y, poly[k])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

export function bboxOf(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

// Point garanti à l'intérieur du polygone : centroïde s'il convient, sinon
// milieu du plus large segment horizontal passant par le centroïde.
export function interiorPoint(geometry) {
  const ring = geometry.type === 'MultiPolygon' ? largestRing(geometry) : geometry.coordinates[0];
  let a = 0, cx = 0, cy = 0;
  const x0 = ring[0][0], y0 = ring[0][1];
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] - x0, y1 = ring[i][1] - y0, x2 = ring[i + 1][0] - x0, y2 = ring[i + 1][1] - y0;
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) > 1e-18) {
    cx = cx / (3 * a) + x0; cy = cy / (3 * a) + y0;
    if (pointInPolygon(cx, cy, geometry)) return [cx, cy];
  } else {
    cx = x0; cy = y0;
  }
  const xs = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [xa, ya] = ring[i], [xb, yb] = ring[i + 1];
    if ((ya > cy) !== (yb > cy)) xs.push(xa + ((cy - ya) * (xb - xa)) / (yb - ya));
  }
  xs.sort((p, q) => p - q);
  let best = null, bestW = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > bestW) { bestW = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, cy]; }
  }
  return best || [ring[0][0], ring[0][1]];
}

function largestRing(geometry) {
  let best = null, bestA = -1;
  for (const poly of geometry.coordinates) {
    const a = ringAreaM2(poly[0]);
    if (a > bestA) { bestA = a; best = poly[0]; }
  }
  return best;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function roundGeometry(geometry) {
  const r = (ring) => ring.map(([x, y]) => [round6(x), round6(y)]);
  if (geometry.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map(r)) };
  }
  return { type: 'Polygon', coordinates: geometry.coordinates.map(r) };
}

// ---------------------------------------------------------------------------
// Assemblage OSM (Overpass « out geom »)

const closed = (ring) => ring.length >= 4 &&
  ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];

// Relie des chemins en anneaux fermés (membres de multipolygones).
function assembleRings(ways) {
  const pending = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let guard = 0;
    while (!closed(ring) && guard++ < 1000) {
      const end = ring[ring.length - 1];
      const idx = pending.findIndex((w) =>
        (w[0][0] === end[0] && w[0][1] === end[1]) ||
        (w[w.length - 1][0] === end[0] && w[w.length - 1][1] === end[1]));
      if (idx < 0) break;
      let next = pending.splice(idx, 1)[0];
      if (!(next[0][0] === end[0] && next[0][1] === end[1])) next = next.slice().reverse();
      ring = ring.concat(next.slice(1));
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

function wayToRing(el) {
  if (!el.geometry || el.geometry.length < 4) return null;
  const ring = el.geometry.map((p) => [p.lon, p.lat]);
  return closed(ring) ? ring : null;
}

function relationToGeometry(el) {
  const outers = [], inners = [];
  for (const m of el.members || []) {
    if (m.type !== 'way' || !m.geometry) continue;
    const coords = m.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
    (m.role === 'inner' ? inners : outers).push(coords);
  }
  const outerRings = assembleRings(outers);
  const innerRings = assembleRings(inners);
  if (!outerRings.length) return null;
  const polys = outerRings.map((r) => [r]);
  for (const hole of innerRings) {
    const [x, y] = hole[0];
    const host = polys.find((p) => pointInRing(x, y, p[0]));
    if (host) host.push(hole);
  }
  return polys.length === 1
    ? { type: 'Polygon', coordinates: polys[0] }
    : { type: 'MultiPolygon', coordinates: polys };
}

export function parseLength(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|mètres?|metres?)?$/i);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(ft|')\s*(?:(\d+(?:\.\d+)?)\s*("|in))?$/i);
  if (m) return parseFloat(m[1]) * 0.3048 + (m[3] ? parseFloat(m[3]) * 0.0254 : 0);
  return null;
}

function parseNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseYear(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1000 && y <= 2100 ? y : null;
}

// Convertit la réponse Overpass en bâtiments et parties de bâtiments.
export function osmElementsToFeatures(overpass) {
  const buildings = [], parts = [];
  for (const el of overpass.elements || []) {
    const tags = el.tags || {};
    const isPart = tags['building:part'] && tags['building:part'] !== 'no';
    const isBuilding = tags.building && tags.building !== 'no';
    if (!isPart && !isBuilding) continue;
    let geometry = null;
    if (el.type === 'way') {
      const ring = wayToRing(el);
      if (ring) geometry = { type: 'Polygon', coordinates: [ring] };
    } else if (el.type === 'relation') {
      geometry = relationToGeometry(el);
    }
    if (!geometry) continue;
    const f = { type: 'Feature', id: (el.type === 'way' ? 'w' : 'r') + el.id, geometry, tags };
    (isBuilding ? buildings : parts).push(f);
  }
  return { buildings, parts };
}

// ---------------------------------------------------------------------------
// Index spatial simple (grille) pour les jointures

class GridIndex {
  constructor(cell = 0.002) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 100003 + j; }
  insert(bbox, item) {
    const c = this.cell;
    for (let i = Math.floor(bbox[0] / c); i <= Math.floor(bbox[2] / c); i++) {
      for (let j = Math.floor(bbox[1] / c); j <= Math.floor(bbox[3] / c); j++) {
        const k = this.key(i, j);
        let list = this.map.get(k);
        if (!list) this.map.set(k, list = []);
        list.push(item);
      }
    }
  }
  query(x, y) {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))) || [];
  }
}

function bdtopoRecord(f) {
  const p = f.properties || {};
  const geometry = f.geometry && {
    type: f.geometry.type,
    coordinates: f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates.map((poly) => poly.map((r) => r.map((c) => [c[0], c[1]])))
      : f.geometry.coordinates.map((r) => r.map((c) => [c[0], c[1]])),
  };
  let h = parseNumber(p.hauteur);
  const tMin = parseNumber(p.altitude_minimale_toit), tMax = parseNumber(p.altitude_maximale_toit);
  if (h != null && tMin != null && tMax != null && tMax > tMin && tMax - tMin < 15) h += (tMax - tMin) / 2;
  return {
    geometry,
    h: h != null && h > 0 ? h : null,
    hg: parseNumber(p.hauteur),
    etages: parseNumber(p.nombre_d_etages),
    annee: parseYear(p.date_d_apparition),
    usage: p.usage_1 && p.usage_1 !== 'Indifférencié' ? p.usage_1 : null,
    usage2: p.usage_2 || null,
    logements: parseNumber(p.nombre_de_logements),
    rnb: p.identifiants_rnb ? String(p.identifiants_rnb).split('/')[0] : null,
    id: p.cleabs,
  };
}

// Associe à chaque bâtiment OSM l'enregistrement BD TOPO qui contient son point
// intérieur (ou dont le point intérieur est contenu dans le bâtiment OSM).
export function joinBdTopo(buildings, bdtopoFC) {
  const recs = (bdtopoFC?.features || []).map(bdtopoRecord).filter((r) => r.geometry);
  const index = new GridIndex();
  for (const r of recs) {
    r.bbox = bboxOf(r.geometry);
    r.pt = interiorPoint(r.geometry);
    index.insert(r.bbox, r);
  }
  let matched = 0;
  for (const b of buildings) {
    const [x, y] = b.pt || (b.pt = interiorPoint(b.geometry));
    let rec = index.query(x, y).find((r) => pointInPolygon(x, y, r.geometry));
    if (!rec) {
      const bb = bboxOf(b.geometry);
      const candidates = new Set([...index.query(bb[0], bb[1]), ...index.query(bb[2], bb[3]),
        ...index.query(x, y)]);
      rec = [...candidates].find((r) => pointInPolygon(r.pt[0], r.pt[1], b.geometry));
    }
    if (rec) { b.bdt = rec; matched++; }
  }
  return { matched, total: buildings.length, bdtopo: recs.length, records: recs };
}

// ---------------------------------------------------------------------------
// Hauteurs et propriétés finales

export function resolveHeight(tags, bdt) {
  const levels = parseNumber(tags['building:levels']);
  const roofLevels = parseNumber(tags['roof:levels']) || 0;
  const minLevel = parseNumber(tags['building:min_level']);
  let minH = parseLength(tags.min_height);
  if (minH == null && minLevel != null) minH = minLevel * HAUTEUR_NIVEAU;

  const hTag = parseLength(tags.height);
  if (hTag != null && hTag > 0) return { h: hTag, mh: minH || 0, hs: 'o', lv: levels };
  if (bdt?.h) return { h: bdt.h, mh: minH || 0, hs: 'b', lv: levels ?? bdt.etages };
  if (levels != null && levels > 0) {
    return { h: (levels + roofLevels * 0.5) * HAUTEUR_NIVEAU + 1, mh: minH || 0, hs: 'n', lv: levels };
  }
  if (bdt?.etages) return { h: bdt.etages * HAUTEUR_NIVEAU + 1, mh: minH || 0, hs: 'e', lv: bdt.etages };
  const type = tags.building || tags['building:part'];
  return { h: HAUTEURS_DEFAUT[type] ?? 7, mh: minH || 0, hs: 'd', lv: null };
}

const r1 = (v) => (v == null ? undefined : Math.round(v * 10) / 10);

// Construit l'entité finale compacte d'un bâtiment.
export function finalizeBuilding(b) {
  const t = b.tags;
  const hh = resolveHeight(t, b.bdt);
  const props = {
    id: b.id,
    h: r1(hh.h),
    mh: hh.mh ? r1(hh.mh) : undefined,
    hs: hh.hs,
    lv: hh.lv ?? undefined,
    a: r1(areaM2(b.geometry)),
    t: t.building !== 'yes' ? t.building : undefined,
    n: t.name || t['name:fr'] || undefined,
    y: parseYear(t.start_date) ?? b.bdt?.annee ?? undefined,
    u: b.bdt?.usage ?? undefined,
    lg: b.bdt?.logements || undefined,
    rnb: b.bdt?.rnb || undefined,
    hg: b.bdt?.hg != null ? r1(b.bdt.hg) : undefined,
    hp: b.hasParts ? 1 : undefined,
    fs: b.fromBdTopo ? 'b' : undefined,
  };
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  const pt = b.pt || interiorPoint(b.geometry);
  props.c = [round6(pt[0]), round6(pt[1])];
  return { type: 'Feature', geometry: roundGeometry(b.geometry), properties: props };
}

export function finalizePart(p) {
  const hh = resolveHeight(p.tags, null);
  const props = { id: p.id, b: p.parent, h: r1(hh.h), mh: hh.mh ? r1(hh.mh) : undefined, hs: hh.hs };
  if (props.mh === undefined) delete props.mh;
  return { type: 'Feature', geometry: roundGeometry(p.geometry), properties: props };
}

// Rattache les parties de bâtiments (building:part) à leur bâtiment.
export function attachParts(buildings, parts) {
  const index = new GridIndex();
  for (const b of buildings) index.insert(bboxOf(b.geometry), b);
  const kept = [];
  for (const p of parts) {
    const [x, y] = interiorPoint(p.geometry);
    const host = index.query(x, y).find((b) => pointInPolygon(x, y, b.geometry));
    if (host) { host.hasParts = true; p.parent = host.id; kept.push(p); }
  }
  return kept;
}

// Bâtiments BD TOPO sans équivalent OSM (secteurs non cartographiés dans OSM,
// ou données OSM indisponibles) : ajoutés avec leur emprise IGN.
function unmatchedBdTopo(buildings, recs) {
  const used = new Set(buildings.filter((b) => b.bdt).map((b) => b.bdt));
  const index = new GridIndex();
  for (const b of buildings) index.insert(bboxOf(b.geometry), b);
  const added = [];
  for (const r of recs) {
    if (used.has(r) || !r.geometry) continue;
    const [x, y] = r.pt;
    if (index.query(x, y).some((b) => pointInPolygon(x, y, b.geometry))) continue;
    added.push({
      id: 'i' + String(r.id || '').replace(/^BATIMENT0*/, ''),
      geometry: r.geometry,
      tags: {},
      bdt: r,
      pt: r.pt,
      fromBdTopo: true,
    });
  }
  return added;
}

// Chaîne complète : Overpass (+ BD TOPO facultative) → bâtiments et parties finalisés.
// Avec completer = true, les bâtiments BD TOPO absents d'OSM sont ajoutés.
export function processBuildings(overpassJson, bdtopoFC, { completer = true } = {}) {
  const { buildings, parts } = osmElementsToFeatures(overpassJson || { elements: [] });
  const seen = new Set();
  const unique = buildings.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
  const seenP = new Set();
  const uniqueParts = parts.filter((p) => (seenP.has(p.id) ? false : (seenP.add(p.id), true)));
  for (const b of unique) b.pt = interiorPoint(b.geometry);
  let stats = { matched: 0, total: unique.length, bdtopo: 0, ajoutes_bdtopo: 0 };
  let all = unique;
  if (bdtopoFC) {
    const res = joinBdTopo(unique, bdtopoFC);
    stats = { ...stats, ...res };
    if (completer) {
      const added = unmatchedBdTopo(unique, res.records);
      all = unique.concat(added);
      stats.ajoutes_bdtopo = added.length;
    }
    delete stats.records;
  }
  const keptParts = attachParts(unique, uniqueParts);
  return {
    buildings: all.map(finalizeBuilding),
    parts: keptParts.map(finalizePart),
    stats: { ...stats, parts: keptParts.length },
  };
}
