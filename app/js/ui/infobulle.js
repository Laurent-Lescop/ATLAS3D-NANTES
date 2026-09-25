// Infobulle qui suit le pointeur.

let el = null;

export function afficherInfobulle(x, y, contenuHtml) {
  el ??= document.getElementById('infobulle');
  if (!contenuHtml) { el.hidden = true; return; }
  el.innerHTML = contenuHtml;
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const marge = 16;
  let left = x + marge, top = y + marge;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - marge;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - marge;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

export function masquerInfobulle() {
  el ??= document.getElementById('infobulle');
  el.hidden = true;
}
