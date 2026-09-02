// Gestion de la table "main_validation" : chargement/cache des lignes, sélecteur
// d'indicateur, compteurs globaux, et rendu de la table éditable.
"use strict";

import { normalize, findColumn, quoteIdent } from "./utils.js";
import { runSql, getTableColumns } from "./grist-api.js";
import {
  mainTableContainer,
  indicatorSelect,
  indicatorPrevBtn,
  indicatorNextBtn,
  indicatorPositionEl,
  statTotalEl,
  statValidatedEl,
  statToReviewEl,
  statTodoEl,
  statMissingEl,
  validationFilter,
  setStatus,
} from "./dom.js";
import { renderTable } from "./table-render.js";

export const MAIN_TABLE_HINT = "main_validation";

// Sentinel used by the validation filter's "Non renseigné" option — validation
// itself uses "" for its own "unset" choice (see buildValidationSelect in
// table-render.js), so an empty string can't also mean "no filter" here without
// ambiguity.
export const VALIDATION_FILTER_EMPTY = "__empty__";

// "main_validation" state: the table id (needed for UpdateRecord calls), the
// resolved column names for the fields we treat specially, and the cached rows
// (avoids refetching from Grist on every filter change).
let mainTableId = null;
let mainSpecialCols = { idIndicateur: null, libelle: null, validation: null, commentaires: null };
let mainRows = [];

// Distinct id_indicateur values found in data_validation — null until
// loadDataValidationIndicatorIds() resolves (no filtering/counting happens
// yet), a Set thereafter. Restricts the indicator dropdown (populateIndicatorSelect)
// and drives the "absent" counter (renderStats) below.
let dataValidationIndicatorIds = null;

// Resolves data_validation's distinct id_indicateur values via a single
// SELECT DISTINCT (not fetchTable — data_validation is too large to pull into
// the browser, see grist-api.js) so the indicator dropdown can be restricted to
// indicators that actually have data, and the "indicateurs absent des données"
// counter can be computed. Safe to call even if data_validation has no
// id_indicateur column (falls back to "no indicator has data" — an empty set —
// rather than leaving the previous document's ids stale).
export async function loadDataValidationIndicatorIds(tableId) {
  const columns = await getTableColumns(tableId);
  const idCol = findColumn(columns, "id_indicateur");
  if (!idCol) {
    dataValidationIndicatorIds = new Set();
    return;
  }

  const idId = quoteIdent(idCol);
  const rows = await runSql(
    "SELECT DISTINCT " + idId + " AS id FROM " + quoteIdent(tableId) + " WHERE " + idId + " IS NOT NULL",
    []
  );
  dataValidationIndicatorIds = new Set(rows.map((row) => String(row.id)));
}

// The indicator currently chosen in the dropdown — drives both renderMainFromCache()
// and the stats/chart module. Always a string (Grist cell values are coerced with
// String() before comparison, since a Reference display value could be numeric-looking).
let selectedIndicator = "";

export function getSelectedIndicator() {
  return selectedIndicator;
}

export async function loadMainTable(tableId) {
  mainTableId = tableId;
  mainRows = [];
  mainTableContainer.innerHTML = "";

  const data = await grist.docApi.fetchTable(tableId);
  // fetchTable returns one array per column, keyed by column id; "id" (row id) and
  // "manualSort" (Grist's internal row-order column) aren't real data columns.
  const columns = Object.keys(data).filter((k) => k !== "id" && k !== "manualSort");

  // id_indicateur is a Reference column pointing at documentation_biso: the raw
  // column here holds row ids (1, 2, 3…), not the human-readable code. When a
  // Reference's visible column is configured in Grist, fetchTable also returns an
  // auto-generated "gristHelper_DisplayN" column containing that display text —
  // this is what actually matches data_validation's plain-text id_indicateur values,
  // so it's what we filter and display on. The libellé comes from a separate lookup
  // column added in Grist whose name contains "Libelle_Indicateur".
  // If id_indicateur is ever reverted to a plain text/code column (no reference),
  // there's no gristHelper_Display* column and we fall back to it directly.
  const refDisplayCol = columns.find((c) => normalize(c).startsWith("gristhelperdisplay"));
  const libelleCol = columns.find((c) => normalize(c).includes("libelleindicateur"));
  const rawIdCol = findColumn(columns, "id_indicateur");

  mainSpecialCols = {
    idIndicateur: refDisplayCol || rawIdCol,
    libelle: libelleCol,
    validation: findColumn(columns, "validation"),
    commentaires: findColumn(columns, "commentaires"),
  };

  // fetchTable's column-of-arrays shape is turned into one object per row (row-of-
  // objects) since the rest of the widget (filtering, rendering, cache lookup by
  // row id) is much simpler to write against rows.
  const rowCount = data.id ? data.id.length : 0;
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = { id: data.id[i] };
    columns.forEach((col) => {
      row[col] = data[col][i];
    });
    rows.push(row);
  }
  mainRows = rows;

  const warnings = [];
  if (!mainSpecialCols.idIndicateur) {
    warnings.push("colonne \"id_indicateur\" introuvable dans " + MAIN_TABLE_HINT);
  }
  if (!mainSpecialCols.validation) {
    warnings.push("colonne \"validation\" introuvable dans " + MAIN_TABLE_HINT + " : saisie désactivée");
  }
  if (!mainSpecialCols.commentaires) {
    warnings.push("colonne \"commentaires\" introuvable dans " + MAIN_TABLE_HINT + " : saisie désactivée");
  }
  if (warnings.length > 0) {
    setStatus("Attention : " + warnings.join(" ; ") + ".", "warn");
  } else {
    setStatus("", "info");
  }

  // Order matters: populateIndicatorSelect sets selectedIndicator (default = first
  // indicator found), and renderMainFromCache reads selectedIndicator to filter.
  populateIndicatorSelect();
  renderMainFromCache();
  renderStats();
}

// Top-of-widget counters: total indicators and their breakdown by validation
// status, computed from ALL of main_validation's rows (ignoring the Validation
// filter and the selected indicator) so they always read as a global overview.
// Counts distinct id_indicateur values, in case a table ever has duplicate rows
// per indicator. "Indicateurs" (total) and "À traiter" exclude indicators
// absent from data_validation (see loadDataValidationIndicatorIds) — nothing to
// action on those, they're broken out into their own "absent des données"
// counter instead. "Validés"/"À revoir" still count every main_validation row
// regardless: a prior validation stays visible even if the data disappeared
// since.
export function renderStats() {
  const col = mainSpecialCols.idIndicateur;
  const validationCol = mainSpecialCols.validation;

  const seen = new Set();
  let total = 0;
  let validated = 0;
  let toReview = 0;
  let todo = 0;
  let missing = 0;

  mainRows.forEach((row) => {
    const id = col ? row[col] : null;
    if (id === null || id === undefined || id === "") return;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);

    const isMissing = dataValidationIndicatorIds && !dataValidationIndicatorIds.has(key);
    if (isMissing) {
      missing++;
    } else {
      total++;
    }

    const validationValue = validationCol ? row[validationCol] || "" : "";
    if (validationValue === "Oui") {
      validated++;
    } else if (validationValue === "Non") {
      toReview++;
    } else if (!isMissing) {
      todo++;
    }
  });

  statTotalEl.textContent = String(total);
  statMissingEl.textContent = String(missing);
  statValidatedEl.textContent = String(validated);
  statToReviewEl.textContent = String(toReview);
  statTodoEl.textContent = String(todo);
}

// Mirrors a successful cell edit into the row cache (mainRows — the only cache
// that exists, since main_validation is the only table rendered with editable
// cells) so a later re-render (e.g. switching indicator and back) reflects the
// edit without refetching the table.
function handleCellSaved(rowId, colName, value) {
  const cachedRow = mainRows.find((r) => r.id === rowId);
  if (cachedRow) cachedRow[colName] = value;

  // A validation edit changes which bucket the row counts toward — keep the
  // top-of-widget counters in sync immediately rather than waiting for a reload.
  if (colName === mainSpecialCols.validation) renderStats();
}

export function renderMainFromCache() {
  let rows = mainRows;

  if (mainSpecialCols.idIndicateur && selectedIndicator) {
    const col = mainSpecialCols.idIndicateur;
    rows = rows.filter((row) => String(row[col]) === selectedIndicator);
  }

  // The table is rendered from a fixed, explicit list of {key, header} pairs
  // (rather than every raw column from Grist) so extra technical columns —
  // gristHelper_Display*, the raw id_indicateur reference, "etat", etc. — stay
  // hidden and the header text stays human-readable regardless of the underlying
  // Grist column names.
  const displayColumns = [];
  if (mainSpecialCols.idIndicateur) {
    displayColumns.push({ key: mainSpecialCols.idIndicateur, header: "id_indicateur" });
  }
  if (mainSpecialCols.libelle) {
    displayColumns.push({ key: mainSpecialCols.libelle, header: "libelle_indicateur" });
  }
  if (mainSpecialCols.validation) {
    displayColumns.push({ key: mainSpecialCols.validation, header: "validation" });
  }
  if (mainSpecialCols.commentaires) {
    displayColumns.push({ key: mainSpecialCols.commentaires, header: "commentaires" });
  }

  renderTable(mainTableContainer, displayColumns, rows, mainSpecialCols, mainTableId, handleCellSaved);
}

// Whether a main_validation row's "validation" cell matches the global
// validation filter — "" (Tous) always matches, VALIDATION_FILTER_EMPTY matches
// an unset/blank cell, anything else matches by exact value ("Oui"/"Non").
function matchesValidationFilter(row) {
  const filterValue = validationFilter.value;
  if (!filterValue) return true;
  if (!mainSpecialCols.validation) return true;

  const cellValue = row[mainSpecialCols.validation] || "";
  if (filterValue === VALIDATION_FILTER_EMPTY) return cellValue === "";
  return cellValue === filterValue;
}

// Builds the indicator dropdown from the distinct id_indicateur values found in
// main_validation, restricted to rows matching the "Validation" filter (see
// matchesValidationFilter) AND to indicators that actually have data_validation
// rows (dataValidationIndicatorIds, once loadDataValidationIndicatorIds has
// resolved — selecting an indicator with nothing in data_validation would leave
// the year dropdown/stats/chart below permanently empty), sorted alphabetically,
// and defaults the selection to the first one (i.e. the alphabetically-first
// indicator) — per spec, "prend par défaut la première valeur".
export function populateIndicatorSelect() {
  indicatorSelect.innerHTML = "";

  const col = mainSpecialCols.idIndicateur;
  if (!col) {
    indicatorSelect.disabled = true;
    indicatorPrevBtn.disabled = true;
    indicatorNextBtn.disabled = true;
    selectedIndicator = "";
    updateIndicatorNav();
    return;
  }

  indicatorSelect.disabled = false;

  const seen = new Set();
  const values = [];
  mainRows.forEach((row) => {
    const v = row[col];
    if (v === null || v === undefined || v === "") return;
    if (!matchesValidationFilter(row)) return;
    const s = String(v);
    if (dataValidationIndicatorIds && !dataValidationIndicatorIds.has(s)) return;
    if (!seen.has(s)) {
      seen.add(s);
      values.push(s);
    }
  });

  values.sort((a, b) => a.localeCompare(b, "fr", { numeric: true, sensitivity: "base" }));

  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    indicatorSelect.appendChild(option);
  });

  selectedIndicator = values.length > 0 ? values[0] : "";
  indicatorSelect.value = selectedIndicator;
  updateIndicatorNav();
}

// Moves the selection by `delta` positions (-1 = précédent, +1 = suivant) within
// the dropdown's (already alphabetically sorted) option list, clamped to the
// first/last entry.
export function stepIndicator(delta, afterSelect) {
  const options = Array.from(indicatorSelect.options);
  if (options.length === 0) return;

  const currentIndex = options.findIndex((opt) => opt.value === selectedIndicator);
  const nextIndex = Math.min(options.length - 1, Math.max(0, currentIndex + delta));
  selectIndicator(options[nextIndex].value, afterSelect);
}

// `afterSelect`, when given, is an async callback (typically refreshForIndicator
// from stats-chart.js, wired up in app.js) invoked once the indicator's own
// re-render is done — errors from it are reported the same way as everywhere
// else in the widget.
export function selectIndicator(value, afterSelect) {
  selectedIndicator = value;
  indicatorSelect.value = value;
  updateIndicatorNav();
  renderMainFromCache();
  if (afterSelect) {
    afterSelect().catch((err) => {
      console.error(err);
      setStatus("Erreur lors du calcul des statistiques : " + err.message, "error");
    });
  }
}

// Keeps the "X / XX" position label and the prev/next buttons' disabled state in
// sync with the current selection.
function updateIndicatorNav() {
  const options = Array.from(indicatorSelect.options);
  const total = options.length;

  if (total === 0) {
    indicatorPositionEl.textContent = "";
    indicatorPrevBtn.disabled = true;
    indicatorNextBtn.disabled = true;
    return;
  }

  const currentIndex = options.findIndex((opt) => opt.value === selectedIndicator);
  const position = currentIndex === -1 ? 0 : currentIndex + 1;
  indicatorPositionEl.textContent = position + " / " + total;
  indicatorPrevBtn.disabled = currentIndex <= 0;
  indicatorNextBtn.disabled = currentIndex === -1 || currentIndex >= total - 1;
}
