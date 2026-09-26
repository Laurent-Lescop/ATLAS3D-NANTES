// Fiches au format Markdown avec en-tête YAML simplifié :
//
//   ---
//   titre: Les Machines de l'île
//   statut: existant
//   liens:
//     - titre: Site officiel
//       url: https://…
//   ---
//   Texte en **Markdown**…
//
// Sous-ensemble YAML reconnu : valeurs simples, listes de valeurs, listes d'objets.

function valeurScalaire(s) {
  const t = s.trim();
  if (t === '') return '';
  if (/^".*"$/.test(t)) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^\[.*\]$/.test(t)) return t.slice(1, -1).split(',').map((x) => valeurScalaire(x)).filter((x) => x !== '');
  return t;
}

export function lireFiche(texte) {
  const m = texte.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, corps: texte };
  const meta = {};
  let cle = null, liste = null, objet = null;
  for (const ligne of m[1].split(/\r?\n/)) {
    if (!ligne.trim() || ligne.trim().startsWith('#')) continue;
    const racine = ligne.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (racine) {
      cle = racine[1];
      objet = null;
      if (racine[2].trim() === '') { liste = []; meta[cle] = liste; } else { meta[cle] = valeurScalaire(racine[2]); liste = null; }
      continue;
    }
    const item = ligne.match(/^\s+-\s*(.*)$/);
    if (item && liste) {
      const kv = item[1].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) { objet = { [kv[1]]: valeurScalaire(kv[2]) }; liste.push(objet); } else { objet = null; liste.push(valeurScalaire(item[1])); }
      continue;
    }
    const suite = ligne.match(/^\s{2,}([A-Za-z_][\w-]*):\s*(.*)$/);
    if (suite && objet) objet[suite[1]] = valeurScalaire(suite[2]);
  }
  return { meta, corps: m[2] };
}

function ecrireScalaire(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  return /^[\w\s.,’'()àâäéèêëïîôöùûüçÀÂÉÈÊËÎÏÔÖÙÛÜÇœŒ«»°/-]*$/.test(s) && !/^[\d\s-]|^$/.test(s) && !s.includes(': ')
    ? s : JSON.stringify(s);
}

export function ecrireFiche(meta, corps = '') {
  const lignes = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) {
      lignes.push(`${k}:`);
      for (const item of v) {
        if (item && typeof item === 'object') {
          const entrees = Object.entries(item).filter(([, x]) => x != null && x !== '');
          entrees.forEach(([k2, v2], i) => lignes.push(`${i ? '    ' : '  - '}${k2}: ${ecrireScalaire(v2)}`));
        } else {
          lignes.push(`  - ${ecrireScalaire(item)}`);
        }
      }
    } else {
      lignes.push(`${k}: ${ecrireScalaire(v)}`);
    }
  }
  lignes.push('---', '');
  return `${lignes.join('\n')}${corps.trim()}\n`;
}
