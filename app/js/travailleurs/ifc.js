// Travailleur : lecture d'un fichier IFC avec web-ifc (WebAssembly).
// Produit un maillage fusionné (coordonnées du projet IFC, Z vers le haut, mètres,
// relatives au centre bas de l'emprise), les couleurs, et les informations utiles :
// géoréférencement, niveaux, surfaces des espaces, nombre d'éléments par classe.

import * as WebIFC from '../../vendor/web-ifc/web-ifc-api.js';

let api = null;

async function initialiser() {
  if (api) return api;
  api = new WebIFC.IfcAPI();
  api.SetWasmPath('/vendor/web-ifc/', true);
  await api.Init(undefined, true); // version monotâche (pas besoin d'isolation cross-origin)
  return api;
}

// Classes conservées pour l'échelle urbaine (enveloppe et structure).
const ENVELOPPE = [
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCROOF', 'IFCCURTAINWALL', 'IFCPLATE', 'IFCMEMBER',
  'IFCCOLUMN', 'IFCBEAM', 'IFCWINDOW', 'IFCDOOR', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT',
  'IFCRAILING', 'IFCCOVERING', 'IFCBUILDINGELEMENTPROXY', 'IFCCHIMNEY', 'IFCSHADINGDEVICE', 'IFCFOOTING',
];
// Classes toujours exclues (volumes abstraits).
const EXCLUES = ['IFCSPACE', 'IFCOPENINGELEMENT', 'IFCSITE', 'IFCANNOTATION', 'IFCGRID', 'IFCVIRTUALELEMENT'];

// (x, y, z) → (x, −z, y), colonnes majeures.
const Y_VERS_Z = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

const valeur = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

function multiplier(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[j * 4 + k];
      r[j * 4 + i] = s;
    }
  }
  return r;
}

function inverser(m) {
  // Inverse d'une matrice 4×4 (colonnes majeures).
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  return inv.map((v) => v / det);
}

// Tableau typé extensible.
class Tampon {
  constructor(Type, taille = 1 << 16) { this.Type = Type; this.a = new Type(taille); this.n = 0; }
  reserver(k) {
    if (this.n + k <= this.a.length) return;
    let t = this.a.length * 2;
    while (t < this.n + k) t *= 2;
    const b = new this.Type(t);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  fin() { return this.a.slice(0, this.n); }
}

function angleCompose(v) {
  // IfcCompoundPlaneAngleMeasure : [degrés, minutes, secondes, millionièmes]
  const t = (v || []).map(valeur);
  if (!t.length) return null;
  const signe = t.some((x) => x < 0) ? -1 : 1;
  const [d = 0, m = 0, s = 0, u = 0] = t.map(Math.abs);
  return signe * (d + m / 60 + (s + u / 1e6) / 3600);
}

function lireInfos(modele) {
  const lignes = (type) => {
    const v = api.GetLineIDsWithType(modele, type);
    const out = [];
    for (let i = 0; i < v.size(); i++) out.push(api.GetLine(modele, v.get(i), false));
    return out;
  };
  const infos = { schema: api.GetModelSchema(modele) };
  const projet = lignes(WebIFC.IFCPROJECT)[0];
  infos.projet = valeur(projet?.Name) || valeur(projet?.LongName) || null;
  const site = lignes(WebIFC.IFCSITE)[0];
  if (site) {
    infos.site = {
      nom: valeur(site.Name),
      lat: angleCompose(site.RefLatitude),
      lon: angleCompose(site.RefLongitude),
      altitude: valeur(site.RefElevation),
    };
  }
  // Unité de longueur du projet (les altitudes des niveaux sont exprimées dans cette unité).
  infos.unite = 1;
  for (const u of lignes(WebIFC.IFCSIUNIT)) {
    if (valeur(u.UnitType) !== 'LENGTHUNIT') continue;
    const prefixe = valeur(u.Prefix);
    infos.unite = { MILLI: 0.001, CENTI: 0.01, DECI: 0.1, KILO: 1000 }[prefixe] || 1;
  }
  infos.batiments = lignes(WebIFC.IFCBUILDING).map((b) => valeur(b.Name)).filter(Boolean);
  infos.niveaux = lignes(WebIFC.IFCBUILDINGSTOREY)
    .map((n) => ({ nom: valeur(n.Name), altitude: valeur(n.Elevation) == null ? null : valeur(n.Elevation) * infos.unite }))
    .sort((a, b) => (a.altitude ?? 0) - (b.altitude ?? 0));

  // Géoréférencement IFC4 : IfcMapConversion vers un système projeté.
  const conv = WebIFC.IFCMAPCONVERSION ? lignes(WebIFC.IFCMAPCONVERSION)[0] : null;
  if (conv) {
    let crs = null;
    const cible = conv.TargetCRS?.value ? api.GetLine(modele, conv.TargetCRS.value, false) : null;
    if (cible) crs = valeur(cible.Name);
    infos.conversion = {
      crs,
      est: valeur(conv.Eastings), nord: valeur(conv.Northings), altitude: valeur(conv.OrthogonalHeight) ?? 0,
      ax: valeur(conv.XAxisAbscissa) ?? 1, ay: valeur(conv.XAxisOrdinate) ?? 0, echelle: valeur(conv.Scale) ?? 1,
    };
  }
  // Nord géographique du contexte de représentation.
  for (const ctx of lignes(WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT)) {
    if (ctx.TrueNorth?.value) {
      const d = api.GetLine(modele, ctx.TrueNorth.value, false);
      const r = (d.DirectionRatios || []).map(valeur);
      if (r.length >= 2) infos.nordVrai = [r[0], r[1]];
    }
  }

  // Surfaces des espaces (quantités IFC).
  let surfaceNette = 0, surfaceBrute = 0;
  const espaces = new Set(lignes(WebIFC.IFCSPACE).map((e) => e.expressID));
  infos.espaces = espaces.size;
  for (const rel of lignes(WebIFC.IFCRELDEFINESBYPROPERTIES)) {
    const objets = (rel.RelatedObjects || []).map((o) => o.value);
    if (!objets.some((o) => espaces.has(o))) continue;
    const def = rel.RelatingPropertyDefinition?.value ? api.GetLine(modele, rel.RelatingPropertyDefinition.value, false) : null;
    if (!def?.Quantities) continue;
    for (const q of def.Quantities) {
      const quantite = api.GetLine(modele, q.value, false);
      const nom = valeur(quantite.Name);
      if (nom === 'NetFloorArea') surfaceNette += valeur(quantite.AreaValue) || 0;
      if (nom === 'GrossFloorArea') surfaceBrute += valeur(quantite.AreaValue) || 0;
    }
  }
  infos.surfaceNette = Math.round(surfaceNette) || null;
  infos.surfaceBrute = Math.round(surfaceBrute) || null;
  return infos;
}

async function convertir(octets, { niveauDetail = 'enveloppe' }, progres) {
  await initialiser();
  const modele = api.OpenModel(new Uint8Array(octets), { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 12 });
  // web-ifc livre la géométrie en repère « Y en haut » (x, z, −y) ; on revient au repère IFC (Z en haut).
  const retour = multiplier(Y_VERS_Z, inverser(api.GetCoordinationMatrix(modele)));
  const gardees = new Set(ENVELOPPE.map((n) => WebIFC[n]).filter(Boolean));
  const exclues = new Set(EXCLUES.map((n) => WebIFC[n]).filter(Boolean));

  const pos = new Tampon(Float64Array), nor = new Tampon(Float32Array), col = new Tampon(Float32Array), idx = new Tampon(Uint32Array);
  const classes = {};
  let sommets = 0;
  api.StreamAllMeshes(modele, (mesh, i, total) => {
    const type = api.GetLineType(modele, mesh.expressID);
    if (exclues.has(type) || (niveauDetail === 'enveloppe' && !gardees.has(type))) return;
    const nomClasse = api.GetNameFromTypeCode(type);
    classes[nomClasse] = (classes[nomClasse] || 0) + 1;
    const geoms = mesh.geometries;
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = api.GetGeometry(modele, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const ind = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = multiplier(retour, pg.flatTransformation);
      const n = v.length / 6;
      pos.reserver(n * 3); nor.reserver(n * 3); col.reserver(n * 3); idx.reserver(ind.length);
      for (let k = 0; k < n; k++) {
        const x = v[k * 6], y = v[k * 6 + 1], z = v[k * 6 + 2];
        pos.a[pos.n++] = m[0] * x + m[4] * y + m[8] * z + m[12];
        pos.a[pos.n++] = m[1] * x + m[5] * y + m[9] * z + m[13];
        pos.a[pos.n++] = m[2] * x + m[6] * y + m[10] * z + m[14];
        const nx = v[k * 6 + 3], ny = v[k * 6 + 4], nz = v[k * 6 + 5];
        let a = m[0] * nx + m[4] * ny + m[8] * nz, b = m[1] * nx + m[5] * ny + m[9] * nz, c = m[2] * nx + m[6] * ny + m[10] * nz;
        const l = Math.hypot(a, b, c) || 1;
        nor.a[nor.n++] = a / l; nor.a[nor.n++] = b / l; nor.a[nor.n++] = c / l;
        // Vitrages (transparents) : teinte claire bleutée, le rendu étant opaque.
        const transparent = pg.color.w < 0.9;
        col.a[col.n++] = transparent ? 0.72 : pg.color.x;
        col.a[col.n++] = transparent ? 0.82 : pg.color.y;
        col.a[col.n++] = transparent ? 0.9 : pg.color.z;
      }
      for (let k = 0; k < ind.length; k++) idx.a[idx.n++] = ind[k] + sommets;
      sommets += n;
      geom.delete?.();
    }
    if (i % 25 === 0) progres(i / total);
  }, true);

  const infos = lireInfos(modele);
  api.CloseModel(modele);
  if (!sommets) throw new Error('aucune géométrie exploitable dans ce fichier IFC');

  // Centre bas de l'emprise, pour garder la précision des coordonnées en 32 bits.
  const p = pos.fin();
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < p.length; k += 3) {
    x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]);
    y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]);
    z0 = Math.min(z0, p[k + 2]); z1 = Math.max(z1, p[k + 2]);
  }
  const centre = [(x0 + x1) / 2, (y0 + y1) / 2, z0];
  const positions = new Float32Array(p.length);
  for (let k = 0; k < p.length; k += 3) {
    positions[k] = p[k] - centre[0];
    positions[k + 1] = p[k + 1] - centre[1];
    positions[k + 2] = p[k + 2] - centre[2];
  }
  return {
    positions, normales: nor.fin(), couleurs: col.fin(), indices: idx.fin(),
    centre,
    dimensions: [x1 - x0, y1 - y0, z1 - z0],
    classes,
    infos: { ...infos, sommets, triangles: idx.n / 3 },
  };
}

self.addEventListener('message', async (e) => {
  const { id, octets, options } = e.data;
  try {
    const r = await convertir(octets, options || {}, (f) => self.postMessage({ id, progres: f }));
    self.postMessage({ id, resultat: r }, [r.positions.buffer, r.normales.buffer, r.couleurs.buffer, r.indices.buffer]);
  } catch (err) {
    self.postMessage({ id, erreur: err.message || String(err) });
  }
});
