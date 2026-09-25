// Couleurs : lecture, mélange, rampes de valeurs.

export function lireCouleur(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  m = s.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [...hslVersRgb(p[0], p[1] / 100, p[2] / 100), p[3] ?? 1];
  }
  return null;
}

function hslVersRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function versCss([r, g, b, a = 1]) {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
}

export function melanger(c1, c2, t) {
  return c1.map((v, i) => v + ((c2[i] ?? v) - v) * t);
}

// Mélange deux valeurs de style (couleurs ou expressions contenant des couleurs).
export function melangerValeurStyle(a, b, t) {
  if (typeof a === 'string' && typeof b === 'string') {
    const ca = lireCouleur(a), cb = lireCouleur(b);
    if (ca && cb) return versCss(melanger(ca, cb, t));
    return t < 0.5 ? a : b;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.map((x, i) => melangerValeurStyle(x, b[i], t));
  }
  return t < 0.5 ? a : b;
}

// Rampe continue : liste de [valeur, [r, g, b]].
export function rampe(arrets, v) {
  if (v <= arrets[0][0]) return arrets[0][1];
  for (let i = 1; i < arrets.length; i++) {
    if (v <= arrets[i][0]) {
      const [v0, c0] = arrets[i - 1], [v1, c1] = arrets[i];
      return melanger(c0, c1, (v - v0) / (v1 - v0));
    }
  }
  return arrets[arrets.length - 1][1];
}

export function rampeCss(arrets) {
  const min = arrets[0][0], max = arrets[arrets.length - 1][0];
  return `linear-gradient(90deg, ${arrets.map(([v, c]) => `${versCss(c)} ${((v - min) / (max - min)) * 100}%`).join(', ')})`;
}
