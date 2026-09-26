// Atlas 3D · Nantes — point d'entrée.

import { etat, emit, on, lirePreference, ecrirePreference } from './etat.js';
import { creerCarte, premierCalqueEtiquettes } from './carte/fond.js';
import { initRendu3D } from './carte/rendu3d.js';
import { initSoleil } from './carte/soleil.js';
import {
  initSelection, activerSelection, desactiverSelection, cadreCourant, definirCadre, recentrer,
} from './carte/selection.js';
import { chargerIndexBatiments, chargerBatiments } from './carte/zone.js';
import { initBatiments3D, afficherZone, viderBatiments } from './carte/batiments3d.js';
import { initPanneaux, fermerFiche } from './ui/panneaux.js';
import { chargement, finChargement, notifier, progression } from './ui/notifications.js';
import { masquerInfobulle } from './ui/infobulle.js';
import { surveillerConnexion, lireJSON } from './api.js';
import { initAffichage } from './modules/affichage.js';
import { initZoneStats, calculerStatistiques } from './modules/zone-stats.js';
import { initReglages } from './modules/reglages.js';
import { initSources } from './modules/sources.js';
import { initClimat } from './modules/climat.js';
import { initMobilites } from './modules/mobilites.js';
import { initLieux } from './modules/lieux.js';
import { initQuartiers, quartierDe, listeQuartiers } from './modules/quartiers.js';
import { initParcours } from './modules/parcours.js';
import { capAligne, masqueExterieur, polygoneCadre } from './lib/geo.js';

const CADRE_DEFAUT = { centre: [-1.5425, 47.2065], largeur: 5200, hauteur: 1500, angle: 12 };
let carte = null;
let secteurs = [];

// --- Adresse de la page (#zone=lon,lat,largeur,hauteur,angle&etude) -----------------

function lireCadreUrl() {
  const m = location.hash.match(/zone=([-\d.]+),([-\d.]+),([\d.]+),([\d.]+),([-\d.]+)/);
  if (!m) return null;
  const [lon, lat, largeur, hauteur, angle] = m.slice(1).map(Number);
  return { centre: [lon, lat], largeur, hauteur, angle };
}

function ecrireUrl(rect, etude) {
  const z = [rect.centre[0].toFixed(5), rect.centre[1].toFixed(5), Math.round(rect.largeur), Math.round(rect.hauteur),
    rect.angle.toFixed(1)].join(',');
  history.replaceState(null, '', `#zone=${z}${etude ? '&etude' : ''}`);
}

// --- Contour de la zone étudiée ------------------------------------------------------

function ajouterCouchesZone() {
  const avant = premierCalqueEtiquettes();
  const vide = { type: 'FeatureCollection', features: [] };
  carte.addSource('zone-masque', { type: 'geojson', data: vide });
  carte.addSource('zone-contour', { type: 'geojson', data: vide });
  carte.addLayer({ id: 'zone-masque', type: 'fill', source: 'zone-masque',
    paint: { 'fill-color': '#141822', 'fill-opacity': 0.16 } }, avant);
  carte.addLayer({ id: 'zone-contour', type: 'line', source: 'zone-contour',
    paint: { 'line-color': '#d2601a', 'line-width': 1.6, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } });
}

function dessinerZone(rect) {
  const vide = { type: 'FeatureCollection', features: [] };
  carte.getSource('zone-masque').setData(rect ? masqueExterieur(rect) : vide);
  carte.getSource('zone-contour').setData(rect ? { type: 'Feature', properties: {}, geometry: polygoneCadre(rect) } : vide);
}

// Caméra 3D cadrée sur la zone, alignée sur son grand côté.
function cadrerZone(rect, { duree = 2200 } = {}) {
  const canvas = carte.getCanvas();
  const largeurUtile = canvas.clientWidth - 180;
  const hauteurUtile = canvas.clientHeight - 260;
  const mpp = Math.max(rect.largeur / largeurUtile, rect.hauteur / (hauteurUtile * 1.5));
  const cos = Math.cos((rect.centre[1] * Math.PI) / 180);
  const zoom = Math.log2((40075016.686 * cos) / (512 * mpp));
  carte.flyTo({ center: rect.centre, zoom: Math.min(17.5, zoom), bearing: capAligne(rect), pitch: 58, duration: duree, essential: true });
}

// --- Zone d'étude --------------------------------------------------------------------

function nomParQuartier(rect) {
  const q = quartierDe(rect.centre);
  if (!q) return 'Zone libre';
  return q.commune === 'Nantes' ? `Secteur ${q.nom}` : `${q.commune} — ${q.nom}`;
}

function nomSecteurChoisi() {
  const opt = document.getElementById('selection-secteur').selectedOptions[0];
  return opt?.value ? opt.textContent : null;
}

async function etudier(zone) {
  calculerStatistiques(zone);
  etat.zone = zone;
  etat.mode = 'etude';
  document.body.dataset.mode = 'etude';
  desactiverSelection();
  dessinerZone(zone.rect);
  document.getElementById('zone-nom').textContent = zone.nom;
  document.getElementById('btn-modifier-zone').hidden = false;
  cadrerZone(zone.rect);
  afficherZone(zone);
  ecrirePreference('cadre', zone.rect);
  ecrirePreference('nomZone', zone.nom);
  ecrireUrl(zone.rect, true);
  emit('mode', etat.mode);
  emit('zone', zone);
}

async function validerZone(nom) {
  const rect = cadreCourant();
  const p = progression('Chargement des bâtiments…');
  const bouton = document.getElementById('btn-zone-valider');
  bouton.disabled = true;
  try {
    const res = await chargerBatiments(rect, { progres: (t) => p.maj(t) });
    if (!res.batiments.length) {
      notifier(etat.enLigne ? 'Aucun bâtiment trouvé dans ce cadre.'
        : 'Aucun bâtiment disponible hors ligne dans ce cadre (il sort du pack local).', { type: 'erreur', duree: 6000 });
      return;
    }
    await etudier({
      nom: nom || nomSecteurChoisi() || nomParQuartier(rect),
      rect,
      batiments: res.batiments,
      parties: res.parties,
      sources: res.sources,
    });
    if (res.horsPack === -1) {
      notifier('Une partie de la zone sort du pack local : elle reste vide tant que vous êtes hors ligne.', { duree: 7000 });
    } else if (res.horsPack > 0) {
      notifier(`${res.horsPack} bâtiments téléchargés en ligne (OpenStreetMap + IGN) pour compléter la zone.`);
    }
  } catch (e) {
    console.error(e);
    notifier(`Chargement impossible : ${e.message}`, { type: 'erreur', duree: 7000 });
  } finally {
    p.fin();
    bouton.disabled = false;
  }
}

function modifierZone() {
  etat.mode = 'selection';
  document.body.dataset.mode = 'selection';
  masquerInfobulle();
  fermerFiche();
  viderBatiments();
  dessinerZone(null);
  document.getElementById('btn-modifier-zone').hidden = true;
  document.getElementById('zone-nom').textContent = 'À choisir';
  activerSelection(etat.zone?.rect);
  if (etat.zone) ecrireUrl(etat.zone.rect, false);
  emit('mode', etat.mode);
}

// --- Secteurs prédéfinis -------------------------------------------------------------

function remplirSecteurs() {
  const select = document.getElementById('selection-secteur');
  const groupe = document.createElement('optgroup');
  groupe.label = 'Secteurs de l\'atlas';
  for (const s of secteurs) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.nom;
    if (s.description) o.title = s.description;
    groupe.appendChild(o);
  }
  select.appendChild(groupe);
  select.addEventListener('change', () => {
    const s = secteurs.find((x) => x.id === select.value);
    const desc = document.getElementById('selection-secteur-desc');
    desc.textContent = s?.description || '';
    desc.hidden = !s?.description;
    if (s) definirCadre(s.cadre);
  });
}

// Quartiers de Nantes et de Rezé (couverts par le pack local) comme cadres prédéfinis.
function remplirQuartiers() {
  const select = document.getElementById('selection-secteur');
  for (const commune of ['Nantes', 'Rezé']) {
    const liste = listeQuartiers().filter((q) => q.properties.commune === commune);
    if (!liste.length) continue;
    const groupe = document.createElement('optgroup');
    groupe.label = `Quartiers de ${commune}`;
    for (const q of liste) {
      const [o, s, e, n] = q.bbox;
      const centre = [(o + e) / 2, (s + n) / 2];
      const k = Math.cos((centre[1] * Math.PI) / 180);
      const cadre = {
        centre,
        largeur: Math.min(6000, Math.round((e - o) * 111320 * k + 150)),
        hauteur: Math.min(6000, Math.round((n - s) * 110540 + 150)),
        angle: 0,
      };
      const id = `quartier-${q.properties.id}`;
      secteurs.push({ id, nom: `${q.properties.nom}`, cadre });
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = q.properties.nom;
      groupe.appendChild(opt);
    }
    select.appendChild(groupe);
  }
}

// --- Connexion ----------------------------------------------------------------------------

function majBadge(enLigne) {
  const b = document.getElementById('badge-connexion');
  b.dataset.etat = enLigne ? 'en-ligne' : 'hors-ligne';
  b.textContent = enLigne ? 'En ligne' : 'Hors ligne · données indicatives';
  b.title = enLigne
    ? 'Données temps réel actives (météo, trafic, transports).'
    : 'Pas de connexion : l\'atlas utilise les données locales, les dernières valeurs connues et des valeurs indicatives.';
}

// --- Démarrage -------------------------------------------------------------------------

async function demarrer() {
  chargement('Chargement du fond de carte…', 0.15);
  Object.assign(etat.reglages, lirePreference('reglages', {}));
  carte = await creerCarte('carte', { centre: [-1.553, 47.212], zoom: 12.4 });
  window.atlas = { carte, etat }; // accès pratique depuis la console

  chargement('Préparation de la 3D…', 0.45);
  initRendu3D(carte);
  initBatiments3D();
  initPanneaux();
  initAffichage();
  initZoneStats();
  initReglages();
  initSources();

  chargement('Index des bâtiments…', 0.65);
  const index = await chargerIndexBatiments();
  if (!index) notifier('Pack local des bâtiments absent : seules les zones chargées en ligne seront disponibles.', { duree: 8000 });
  secteurs = await lireJSON('/data/editorial/secteurs.json').catch(() => []);
  remplirSecteurs();

  const cadreUrl = lireCadreUrl();
  const cadrePrefere = lirePreference('cadre', null);
  const cadre = cadreUrl || cadrePrefere || secteurs[0]?.cadre || CADRE_DEFAUT;
  if (!cadreUrl && !cadrePrefere && secteurs[0]) document.getElementById('selection-secteur').value = secteurs[0].id;
  initSelection(carte, { cadreInitial: cadre, densiteBatiments: index?.densite });
  ajouterCouchesZone();
  initSoleil();
  surveillerConnexion();
  initClimat();
  initMobilites();
  await initQuartiers();
  remplirQuartiers();
  await initLieux().catch((e) => console.error('lieux', e));
  await initParcours();
  on('etudier-cadre', async ({ cadre, nom }) => {
    document.getElementById('selection-secteur').value = '';
    definirCadre(cadre);
    await validerZone(nom);
  });
  on('connexion', majBadge);

  document.getElementById('btn-zone-valider').addEventListener('click', () => validerZone());
  document.getElementById('btn-zone-recentrer').addEventListener('click', recentrer);
  document.getElementById('btn-modifier-zone').addEventListener('click', modifierZone);
  on('cadre', (c) => ecrireUrl(c, false));
  on('ouvrir-zone-enregistree', (fc) => {
    if (!fc.atlas?.cadre) return;
    etudier({ nom: fc.atlas.nom, rect: fc.atlas.cadre, batiments: fc.features, parties: fc.parties || [], sources: ['zone-enregistree'] });
  });

  chargement('Prêt', 1);
  finChargement();

  if (cadreUrl && /&etude/.test(location.hash)) {
    definirCadre(cadreUrl);
    await validerZone(lirePreference('nomZone', null));
  } else {
    activerSelection();
  }
}

demarrer().catch((e) => {
  console.error(e);
  chargement(`Erreur au démarrage : ${e.message}`);
});
