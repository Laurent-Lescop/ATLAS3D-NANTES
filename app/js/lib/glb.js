// Écriture et lecture d'un fichier glTF binaire (GLB) simple : un maillage, avec
// positions, normales, couleurs de sommets et indices. Le fichier est lisible par
// les logiciels courants (Blender…). Convention glTF : Y vers le haut ; l'atlas
// travaille en repère local Est-Nord-Haut (x, y, z), converti à l'écriture et à la lecture.

const FLOAT = 5126, UINT32 = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

function bornes(v, taille) {
  const min = new Array(taille).fill(Infinity), max = new Array(taille).fill(-Infinity);
  for (let i = 0; i < v.length; i += taille) {
    for (let k = 0; k < taille; k++) {
      if (v[i + k] < min[k]) min[k] = v[i + k];
      if (v[i + k] > max[k]) max[k] = v[i + k];
    }
  }
  return { min, max };
}

// Est-Nord-Haut → glTF (x, z, −y).
function versGltf(v) {
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) { o[i] = v[i]; o[i + 1] = v[i + 2]; o[i + 2] = -v[i + 1]; }
  return o;
}

function depuisGltf(v) {
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) { o[i] = v[i]; o[i + 1] = -v[i + 2]; o[i + 2] = v[i + 1]; }
  return o;
}

const aligner4 = (n) => (n + 3) & ~3;

export function ecrireGlb({ positions, normales, couleurs, indices }, extras = {}) {
  const parties = [versGltf(positions), versGltf(normales), couleurs, indices];
  let decalage = 0;
  const vues = parties.map((p, i) => {
    const vue = { buffer: 0, byteOffset: decalage, byteLength: p.byteLength, target: i === 3 ? ELEMENT_ARRAY_BUFFER : ARRAY_BUFFER };
    decalage = aligner4(decalage + p.byteLength);
    return vue;
  });
  const n = positions.length / 3;
  const b = bornes(parties[0], 3);
  const json = {
    asset: { version: '2.0', generator: 'Atlas 3D Nantes', extras: { repere: 'glTF Y haut ; atlas : Est-Nord-Haut', ...extras } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: extras.nom || 'projet' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
    buffers: [{ byteLength: decalage }],
    bufferViews: vues,
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: n, type: 'VEC3', min: b.min, max: b.max },
      { bufferView: 1, componentType: FLOAT, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: FLOAT, count: n, type: 'VEC3' },
      { bufferView: 3, componentType: UINT32, count: indices.length, type: 'SCALAR' },
    ],
  };
  let texteJson = new TextEncoder().encode(JSON.stringify(json));
  const longueurJson = aligner4(texteJson.length);
  const total = 12 + 8 + longueurJson + 8 + decalage;
  const sortie = new ArrayBuffer(total);
  const dv = new DataView(sortie);
  const u8 = new Uint8Array(sortie);
  dv.setUint32(0, 0x46546c67, true); // « glTF »
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, longueurJson, true);
  dv.setUint32(16, 0x4e4f534a, true); // « JSON »
  u8.set(texteJson, 20);
  for (let i = 20 + texteJson.length; i < 20 + longueurJson; i++) u8[i] = 0x20;
  const debutBin = 20 + longueurJson;
  dv.setUint32(debutBin, decalage, true);
  dv.setUint32(debutBin + 4, 0x004e4942, true); // « BIN »
  parties.forEach((p, i) => u8.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), debutBin + 8 + vues[i].byteOffset));
  texteJson = null;
  return sortie;
}

// Lit un GLB écrit par ecrireGlb (ou tout GLB à un maillage sans compression).
export function lireGlb(tampon) {
  const dv = new DataView(tampon);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('fichier GLB invalide');
  const longueurJson = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(tampon, 20, longueurJson)));
  const debutBin = 20 + longueurJson + 8;
  const lire = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const Type = a.componentType === UINT32 ? Uint32Array : a.componentType === 5123 ? Uint16Array : Float32Array;
    const taille = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    return new Type(tampon.slice(debutBin + v.byteOffset + (a.byteOffset || 0),
      debutBin + v.byteOffset + (a.byteOffset || 0) + a.count * taille * Type.BYTES_PER_ELEMENT));
  };
  const prim = json.meshes[0].primitives[0];
  let couleurs = prim.attributes.COLOR_0 != null ? lire(prim.attributes.COLOR_0) : null;
  const positions = depuisGltf(lire(prim.attributes.POSITION));
  if (couleurs && couleurs.length === (positions.length / 3) * 4) {
    const c3 = new Float32Array(positions.length);
    for (let i = 0, j = 0; i < couleurs.length; i += 4, j += 3) { c3[j] = couleurs[i]; c3[j + 1] = couleurs[i + 1]; c3[j + 2] = couleurs[i + 2]; }
    couleurs = c3;
  }
  return {
    positions,
    normales: prim.attributes.NORMAL != null ? depuisGltf(lire(prim.attributes.NORMAL)) : null,
    couleurs,
    indices: prim.indices != null ? Uint32Array.from(lire(prim.indices)) : null,
    extras: json.asset?.extras || {},
  };
}
