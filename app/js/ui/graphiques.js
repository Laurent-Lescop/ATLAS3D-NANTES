// Petits graphiques SVG interactifs : courbes (réticule + infobulle),
// rose des vents (secteurs empilés), jauge. Les libellés sont insérés en texte brut.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

function texte(parent, x, y, contenu, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = contenu;
  return t;
}

// Infobulle propre au graphique (valeur en gras, libellé en second).
function creerInfobulle(conteneur) {
  const tip = document.createElement('div');
  tip.className = 'graphique-infobulle';
  tip.hidden = true;
  conteneur.appendChild(tip);
  return {
    montrer(x, y, lignes) {
      tip.replaceChildren();
      for (const l of lignes) {
        const row = document.createElement('div');
        row.className = 'ligne';
        if (l.couleur) {
          const k = document.createElement('i');
          k.style.background = l.couleur;
          if (l.trait) k.className = 'trait';
          row.appendChild(k);
        }
        const b = document.createElement('b');
        b.textContent = l.valeur;
        row.appendChild(b);
        if (l.libelle) {
          const s = document.createElement('span');
          s.textContent = l.libelle;
          row.appendChild(s);
        }
        tip.appendChild(row);
      }
      tip.hidden = false;
      const r = conteneur.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x + 12), r.width - w)}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
    },
    cacher() { tip.hidden = true; },
  };
}

function graduations(min, max, n = 4) {
  const brut = (max - min) / n;
  const pas = [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(brut))).find((p) => p >= brut) || brut;
  const t = [];
  for (let v = Math.ceil(min / pas) * pas; v <= max + 1e-9; v += pas) t.push(+v.toFixed(6));
  return t;
}

// Courbes sur un axe horizontal commun.
// series : [{ nom, points: [[x, y]], couleur, epaisseur, aire, discret }]
// options : { xMin, xMax, xTicks: [[x, libellé]], formatX(x), formatY(y), unite, marqueurX, hauteur }
export function courbe(conteneur, series, o) {
  conteneur.classList.add('graphique-conteneur');
  const L = 320, H = o.hauteur || 150, m = { g: 30, d: 8, h: 10, b: 20 };
  const svg = el('svg', { viewBox: `0 0 ${L} ${H}`, class: 'graphique', role: 'img', 'aria-label': o.titre || '' }, conteneur);
  const tousY = series.flatMap((s) => s.points.map((p) => p[1])).filter((v) => v != null);
  if (!tousY.length) return;
  let yMin = Math.min(...tousY), yMax = Math.max(...tousY);
  if (o.yMin != null) yMin = Math.min(yMin, o.yMin);
  if (yMax - yMin < 4) { const c = (yMax + yMin) / 2; yMin = c - 2; yMax = c + 2; }
  const ticks = graduations(yMin, yMax);
  yMin = Math.min(yMin, ticks[0]);
  yMax = Math.max(yMax, ticks[ticks.length - 1]);
  const sx = (x) => m.g + ((x - o.xMin) / (o.xMax - o.xMin)) * (L - m.g - m.d);
  const sy = (y) => H - m.b - ((y - yMin) / (yMax - yMin)) * (H - m.b - m.h);

  for (const t of ticks) {
    el('line', { x1: m.g, x2: L - m.d, y1: sy(t), y2: sy(t), class: 'grille' }, svg);
    texte(svg, m.g - 5, sy(t) + 3, (o.formatY || String)(t), { 'text-anchor': 'end' });
  }
  el('line', { x1: m.g, x2: L - m.d, y1: H - m.b, y2: H - m.b, class: 'axe' }, svg);
  for (const [x, lib] of o.xTicks || []) texte(svg, sx(x), H - 5, lib, { 'text-anchor': 'middle' });

  for (const s of series) {
    const pts = s.points.filter((p) => p[1] != null);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
    if (s.aire) {
      el('path', { d: `${d}L${sx(pts[pts.length - 1][0])},${H - m.b}L${sx(pts[0][0])},${H - m.b}Z`, fill: s.couleur, opacity: 0.1 }, svg);
    }
    el('path', { d, fill: 'none', stroke: s.couleur, 'stroke-width': s.epaisseur || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }
  if (o.marqueurX != null && o.marqueurX >= o.xMin && o.marqueurX <= o.xMax) {
    el('line', { x1: sx(o.marqueurX), x2: sx(o.marqueurX), y1: m.h, y2: H - m.b, class: 'marqueur' }, svg);
    const principale = series[0];
    const p = principale.points.reduce((best, q) => (Math.abs(q[0] - o.marqueurX) < Math.abs(best[0] - o.marqueurX) ? q : best));
    if (p[1] != null) el('circle', { cx: sx(p[0]), cy: sy(p[1]), r: 4, fill: principale.couleur, class: 'point' }, svg);
  }

  // Réticule : suit le pointeur et s'aligne sur l'abscisse la plus proche.
  const reticule = el('line', { y1: m.h, y2: H - m.b, class: 'reticule', visibility: 'hidden' }, svg);
  const zone = el('rect', { x: m.g, y: 0, width: L - m.g - m.d, height: H, fill: 'transparent' }, svg);
  const tip = creerInfobulle(conteneur);
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const survol = (ev) => {
    const r = svg.getBoundingClientRect();
    const xVue = ((ev.clientX - r.left) / r.width) * L;
    const xData = o.xMin + ((xVue - m.g) / (L - m.g - m.d)) * (o.xMax - o.xMin);
    const x = xs.reduce((best, v) => (Math.abs(v - xData) < Math.abs(best - xData) ? v : best), xs[0]);
    reticule.setAttribute('x1', sx(x));
    reticule.setAttribute('x2', sx(x));
    reticule.setAttribute('visibility', 'visible');
    const lignes = [{ valeur: (o.formatX || String)(x) }];
    for (const s of series) {
      const p = s.points.find((q) => q[0] === x);
      if (p && p[1] != null) lignes.push({ couleur: s.couleur, trait: true, valeur: `${(o.formatY || String)(p[1])}${o.unite || ''}`, libelle: s.nom });
    }
    tip.montrer((sx(x) / L) * r.width, ((ev.clientY - r.top)), lignes);
  };
  zone.addEventListener('pointermove', survol);
  zone.addEventListener('pointerleave', () => { reticule.setAttribute('visibility', 'hidden'); tip.cacher(); });
}

// Rose des vents : secteurs[16][classes] en %, couleurs[classes], libellés des classes.
export function roseDesVents(conteneur, { secteurs, noms, classes, couleurs, calme, courant, surface }) {
  conteneur.classList.add('graphique-conteneur');
  const T = 300, c = T / 2, R = 118, r0 = 14;
  const svg = el('svg', { viewBox: `0 0 ${T} ${T}`, class: 'graphique rose', role: 'img', 'aria-label': 'Rose des vents' }, conteneur);
  const totaux = secteurs.map((s) => s.reduce((a, b) => a + b, 0));
  const max = Math.max(...totaux, 1);
  const pasGrille = graduations(0, max, 3).filter((v) => v > 0);
  const echelle = (v) => r0 + (v / pasGrille[pasGrille.length - 1]) * (R - r0);
  for (const g of pasGrille) {
    el('circle', { cx: c, cy: c, r: echelle(g), class: 'grille', fill: 'none' }, svg);
    texte(svg, c + 3, c - echelle(g) - 2, `${g} %`);
  }
  for (let i = 0; i < 16; i += 4) {
    const a = (i * 22.5 * Math.PI) / 180;
    el('line', { x1: c, y1: c, x2: c + Math.sin(a) * (R + 4), y2: c - Math.cos(a) * (R + 4), class: 'grille' }, svg);
    texte(svg, c + Math.sin(a) * (R + 16), c - Math.cos(a) * (R + 16) + 4, noms[i], { 'text-anchor': 'middle', class: 'cardinal' });
  }
  const tip = creerInfobulle(conteneur);
  const demi = (22.5 / 2 - 1.6) * (Math.PI / 180); // espace entre pétales
  const arc = (a0, a1, ri, re) => {
    const p = (a, r) => `${(c + Math.sin(a) * r).toFixed(2)},${(c - Math.cos(a) * r).toFixed(2)}`;
    return `M${p(a0, ri)}L${p(a0, re)}A${re},${re} 0 0 1 ${p(a1, re)}L${p(a1, ri)}A${ri},${ri} 0 0 0 ${p(a0, ri)}Z`;
  };
  secteurs.forEach((valeurs, i) => {
    const a = (i * 22.5 * Math.PI) / 180;
    let cumul = 0;
    valeurs.forEach((v, k) => {
      if (v <= 0) return;
      const ri = echelle(cumul) + (cumul > 0 ? 1 : 0); // interstice de surface entre classes
      cumul += v;
      const re = echelle(cumul);
      if (re - ri < 0.4) return;
      const seg = el('path', { d: arc(a - demi, a + demi, ri, re), fill: couleurs[k], class: 'segment' }, svg);
      seg.addEventListener('pointermove', (ev) => {
        const r = conteneur.getBoundingClientRect();
        tip.montrer(ev.clientX - r.left, ev.clientY - r.top, [
          { valeur: `${v.toLocaleString('fr-FR')} % du temps` },
          { couleur: couleurs[k], valeur: classes[k], libelle: `vent de ${noms[i]}` },
          { valeur: `${totaux[i].toLocaleString('fr-FR')} %`, libelle: 'tous vents de ce secteur' },
        ]);
      });
      seg.addEventListener('pointerleave', () => tip.cacher());
    });
  });
  el('circle', { cx: c, cy: c, r: r0 - 2, fill: surface || 'var(--papier-plein)', class: 'calme' }, svg);
  texte(svg, c, c + 3, `${Math.round(calme)} %`, { 'text-anchor': 'middle', class: 'calme-texte' });

  // Vent actuel : flèche dans le sens où souffle le vent (depuis la direction indiquée).
  if (courant) {
    const a = ((courant.direction + 180) * Math.PI) / 180;
    const g = el('g', { class: 'vent-courant' }, svg);
    const x0 = c - Math.sin(a) * (R - 8), y0 = c + Math.cos(a) * (R - 8);
    const x1 = c + Math.sin(a) * (R - 8), y1 = c - Math.cos(a) * (R - 8);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1 }, g);
    const pointe = 9;
    el('path', {
      d: `M${x1},${y1}L${x1 - Math.sin(a - 0.45) * pointe},${y1 + Math.cos(a - 0.45) * pointe}` +
        `L${x1 - Math.sin(a + 0.45) * pointe},${y1 + Math.cos(a + 0.45) * pointe}Z`,
    }, g);
  }
}

// Petite courbe sans axes (tendance), avec valeur finale.
export function tendance(conteneur, points, { couleur, format, unite = '' }) {
  courbe(conteneur, [{ nom: '', points, couleur, aire: true }], {
    xMin: points[0][0], xMax: points[points.length - 1][0], hauteur: 110,
    formatY: format, formatX: (x) => new Date(x).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
    unite,
    xTicks: [],
  });
}
