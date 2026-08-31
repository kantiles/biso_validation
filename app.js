// Grist Custom Widget for BISO validation — point d'entrée : câblage des
// événements et initialisation. La logique elle-même vit dans js/ (voir
// index.html) :
//   - js/dom.js         — références DOM et affichage du statut
//   - js/utils.js        — petites fonctions pures partagées
//   - js/grist-api.js    — backend SQL local (DuckDB-Wasm) pour les requêtes
//                          sur data_validation
//   - js/table-render.js — rendu générique d'un <table> avec cellules éditables
//   - js/main-table.js   — table "main_validation" (indicateurs, compteurs)
//   - js/stats-chart.js  — table "data_validation" (année, stats, graphique)
//
// Layout (see index.html):
//   1. Indicator dropdown (top) — the single source of truth for "which indicator
//      is selected". Filters BOTH sections below.
//   2. "main_validation" table — one row per indicator, with editable
//      validation/commentaires cells. Filtered to the selected indicator.
//   3. Year dropdown, distribution stats table (one row per "niv_geo" value,
//      including a NA count), and a bar chart of the "value" column at
//      département level ("niv_geo" = "dep", one bar per "code_geo") — all from
//      "data_validation", filtered to the selected indicator and year.
//
// Both table names are hardcoded (MAIN_TABLE_HINT / BOTTOM_TABLE_HINT, in
// main-table.js / stats-chart.js) rather than user-selectable — this widget is
// purpose-built for this document's schema.
"use strict";

import { normalize } from "./js/utils.js";
import { setStatus, validationFilter, anneeSelect, indicatorSelect, indicatorPrevBtn, indicatorNextBtn } from "./js/dom.js";
import {
  MAIN_TABLE_HINT,
  loadMainTable,
  populateIndicatorSelect,
  renderMainFromCache,
  selectIndicator,
  stepIndicator,
} from "./js/main-table.js";
import {
  BOTTOM_TABLE_HINT,
  loadBottomTable,
  populateAnneeSelect,
  renderStatsAndChart,
  setSelectedAnnee,
} from "./js/stats-chart.js";

// Numéro de version du widget — à incrémenter à chaque changement (app.js,
// n'importe quel fichier js/*.js, index.html ou style.css). Affiché en haut à
// droite de la page (voir index.html) pour vérifier facilement, notamment
// depuis Grist, que la dernière version déployée sur GitHub Pages est bien
// celle chargée.
const APP_VERSION = "4";
document.getElementById("app-version").textContent = APP_VERSION;

// Re-derives everything that depends on the selected indicator but isn't part of
// main_validation's cache: the year dropdown's options (distinct "annee" values
// for this indicator) and the stats table / chart below it. Used both when the
// indicator itself changes and when the Validation filter picks a new default
// indicator.
async function refreshForIndicator() {
  await populateAnneeSelect();
  await renderStatsAndChart();
}

async function init() {
  // A Custom Widget only receives the Grist API (`grist`) when embedded in an
  // iframe by Grist itself. Opening index.html directly (window === window.top)
  // means there is no document to talk to.
  if (window.self === window.top) {
    setStatus(
      "Ce widget doit être ajouté comme Custom Widget dans un document Grist (accès \"Full document\") " +
        "pour fonctionner : ouvert directement dans un onglet, il ne peut pas communiquer avec Grist.",
      "warn"
    );
    return;
  }

  if (typeof grist === "undefined") {
    setStatus(
      "Le script grist-plugin-api.js n'a pas pu être chargé. Vérifiez que l'URL du script " +
        "dans index.html correspond bien à l'instance Grist utilisée.",
      "error"
    );
    return;
  }

  // requiredAccess: "full" is needed because we write back to the document
  // (UpdateRecord in table-render.js's updateCell) and read arbitrary tables
  // (listTables/fetchTable).
  grist.ready({ requiredAccess: "full" });

  // Changing the indicator (via the dropdown or the prev/next buttons) only
  // re-filters already-cached rows — no refetch.
  indicatorSelect.addEventListener("change", () => {
    selectIndicator(indicatorSelect.value, refreshForIndicator);
  });
  indicatorPrevBtn.addEventListener("click", () => stepIndicator(-1, refreshForIndicator));
  indicatorNextBtn.addEventListener("click", () => stepIndicator(1, refreshForIndicator));

  // Changing the year only re-filters/re-aggregates data_validation for the
  // already-selected indicator — the indicator list itself is untouched.
  anneeSelect.addEventListener("change", () => {
    setSelectedAnnee(anneeSelect.value);
    renderStatsAndChart().catch((err) => {
      console.error(err);
      setStatus("Erreur lors du calcul des statistiques : " + err.message, "error");
    });
  });

  // Restricts which indicators show up in the dropdown/nav to those whose
  // main_validation row has this validation value — rebuilding the list picks a
  // new default (first eligible indicator) whenever the current one drops out.
  validationFilter.addEventListener("change", () => {
    populateIndicatorSelect();
    renderMainFromCache();
    refreshForIndicator().catch((err) => {
      console.error(err);
      setStatus("Erreur lors du calcul des statistiques : " + err.message, "error");
    });
  });

  try {
    const tableIds = await grist.docApi.listTables();

    const mainMatch = tableIds.find((id) => normalize(id) === normalize(MAIN_TABLE_HINT));
    if (!mainMatch) {
      setStatus("Table \"" + MAIN_TABLE_HINT + "\" introuvable dans ce document.", "error");
      return;
    }
    // Load main_validation first: it populates the indicator dropdown and its
    // default value, which loadBottomTable's initial render depends on.
    await loadMainTable(mainMatch);

    const bottomMatch = tableIds.find((id) => normalize(id) === normalize(BOTTOM_TABLE_HINT));
    if (!bottomMatch) {
      setStatus("Table \"" + BOTTOM_TABLE_HINT + "\" introuvable dans ce document.", "error");
      return;
    }
    await loadBottomTable(bottomMatch);
  } catch (err) {
    console.error(err);
    setStatus("Erreur lors du chargement du document : " + err.message, "error");
  }
}

init();
