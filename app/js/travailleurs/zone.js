// Travailleur : traitement des bâtiments téléchargés en ligne (hors du fil principal).

import { processBuildings } from '../lib/batiments-core.js';

self.addEventListener('message', (e) => {
  const { id, osm, bdtopo } = e.data;
  try {
    const resultat = processBuildings(osm, bdtopo, { completer: true });
    self.postMessage({ id, resultat });
  } catch (err) {
    self.postMessage({ id, erreur: err.message });
  }
});
