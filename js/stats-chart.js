// Gestion de la table "data_validation" : sélecteur d'année, table de
// statistiques de distribution et tableau value_new/value_old/écart par
// département — tout calculé côté serveur via SQL (voir grist-api.js), jamais
// en rapatriant les lignes dans le navigateur.
"use strict";

import { quoteIdent, findColumn, formatNumber, formatNumberOrDash } from "./utils.js";
import { runSql, getTableColumns } from "./grist-api.js";
import {
  anneeSelect,
  anneePrevBtn,
  anneeNextBtn,
  anneePositionEl,
  chartContainer,
  valueStatsContainer,
  nivGeoBadgesContainer,
  setStatus,
} from "./dom.js";
import { getSelectedIndicator } from "./main-table.js";

export const BOTTOM_TABLE_HINT = "data_validation";

// The "niv_geo" value that selects département-level rows for the
// value_new/value_old/écart table (see renderDepartmentValueTable).
const DEP_NIV_GEO_VALUE = "dep";

// "niv_geo" values that each only ever have a single row (national-level
// aggregates, not a distribution across several geo units) — excluded from the
// per-niv_geo stats table, where a full distribution would be meaningless.
// Compared case-insensitively.
const NATIONAL_NIV_GEO_VALUES = new Set(["fr_ent", "fr_metro", "fr-ent_h_mayotte", "fr_ent_h_mayotte"]);

// "code_geo" values (niv_geo = "dep") flagged by renderNivGeoBadges, grouped by
// which territorial-reform regime they belong to — a group's badge only turns
// on when every one of its codes has at least one non-NA row, since some
// datasets only ever report one regime (e.g. "69" without "69D"/"69M").
// Compared case-insensitively (see renderNivGeoBadges).
const NIV_GEO_BADGE_GROUPS = [
  { label: "Division Rhône", codes: ["69D", "69M"] },
  { label: "Rhône regroupé", codes: ["69"] },
  { label: "Mayotte", codes: ["976"] },
  { label: "Division Corse", codes: ["2A", "2B"] },
  { label: "CT Corse", codes: ["20R"] },
  { label: "Division Alsace", codes: ["67", "68"] },
  { label: "CE Alsace", codes: ["6AE"] },
];

// "data_validation" state: only the table id and the resolved column names are
// kept — no row cache, since rows are never fetched (see the module doc above).
let bottomTableId = null;
let bottomSpecialCols = { idIndicateur: null, valueNew: null, valueOld: null, nivGeo: null, annee: null, codeGeo: null };

// The year currently chosen in the "Année" dropdown (see populateAnneeSelect) —
// built from the distinct "annee" values of data_validation for the selected
// indicator, most recent first, defaulting to the most recent. Always a string,
// for the same reason as main-table.js's selectedIndicator.
let selectedAnnee = "";

// Sets the selected year (from the dropdown or the prev/next buttons), syncs
// the <select>'s own value and the position/nav buttons, and re-renders the
// stats table(s) and chart for it — mirrors selectIndicator() in main-table.js.
export function selectAnnee(value) {
  selectedAnnee = value;
  anneeSelect.value = value;
  updateAnneeNav();
  return renderStatsAndChart();
}

// Moves the selection by `delta` positions (-1 = précédent, +1 = suivant)
// within the dropdown's (most-recent-first) option list, clamped to the
// first/last entry — mirrors stepIndicator() in main-table.js.
export function stepAnnee(delta) {
  const options = Array.from(anneeSelect.options);
  if (options.length === 0) return Promise.resolve();

  const currentIndex = options.findIndex((opt) => opt.value === selectedAnnee);
  const nextIndex = Math.min(options.length - 1, Math.max(0, currentIndex + delta));
  return selectAnnee(options[nextIndex].value);
}

// Keeps the "X / XX" position label and the prev/next buttons' disabled state
// in sync with the current selection — mirrors updateIndicatorNav() in
// main-table.js.
function updateAnneeNav() {
  const options = Array.from(anneeSelect.options);
  const total = options.length;

  if (total === 0) {
    anneePositionEl.textContent = "";
    anneePrevBtn.disabled = true;
    anneeNextBtn.disabled = true;
    return;
  }

  const currentIndex = options.findIndex((opt) => opt.value === selectedAnnee);
  const position = currentIndex === -1 ? 0 : currentIndex + 1;
  anneePositionEl.textContent = position + " / " + total;
  anneePrevBtn.disabled = currentIndex <= 0;
  anneeNextBtn.disabled = currentIndex === -1 || currentIndex >= total - 1;
}

// Resolves data_validation's column ids via schema introspection (getTableColumns)
// — no data row is fetched, so this is cheap no matter how many rows the table
// holds. idIndicateur/annee (filtering), valueNew (the stats/chart data),
// valueOld (compared against valueNew for the écart distribution table), nivGeo
// (the stats table's grouping column, and the chart's "dep" level filter) and
// codeGeo (the chart's per-bar label) are needed, since no table is ever
// rendered for data_validation.
export async function loadBottomTable(tableId) {
  bottomTableId = tableId;
  chartContainer.innerHTML = "";
  valueStatsContainer.innerHTML = "";

  try {
    const columns = await getTableColumns(tableId);

    bottomSpecialCols = {
      idIndicateur: findColumn(columns, "id_indicateur"),
      valueNew: findColumn(columns, "value_new"),
      valueOld: findColumn(columns, "value_old"),
      nivGeo: findColumn(columns, "niv_geo"),
      annee: findColumn(columns, "annee"),
      codeGeo: findColumn(columns, "code_geo"),
    };

    if (!bottomSpecialCols.valueNew) {
      setStatus("Attention : colonne \"value_new\" introuvable dans " + BOTTOM_TABLE_HINT + " : graphique indisponible.", "warn");
      return;
    }
    if (!bottomSpecialCols.nivGeo) {
      setStatus("Attention : colonne \"niv_geo\" introuvable dans " + BOTTOM_TABLE_HINT + " : statistiques non ventilées, graphique indisponible.", "warn");
    } else if (!bottomSpecialCols.codeGeo) {
      setStatus("Attention : colonne \"code_geo\" introuvable dans " + BOTTOM_TABLE_HINT + " : graphique indisponible.", "warn");
    }
    if (!bottomSpecialCols.valueOld) {
      setStatus("Attention : colonne \"value_old\" introuvable dans " + BOTTOM_TABLE_HINT + " : distribution des écarts indisponible.", "warn");
    }

    await populateAnneeSelect();
    await renderStatsAndChart();
  } catch (err) {
    console.error(err);
    setStatus("Erreur lors du chargement de la feuille : " + err.message, "error");
  }
}

// Builds the "Année" dropdown from the distinct "annee" values found in
// data_validation for the currently selected indicator, sorted from the most
// recent to the oldest, and defaults the selection to the most recent one.
export async function populateAnneeSelect() {
  anneeSelect.innerHTML = "";

  const anneeCol = bottomSpecialCols.annee;
  if (!anneeCol || !bottomTableId) {
    anneeSelect.disabled = true;
    selectedAnnee = "";
    updateAnneeNav();
    return;
  }

  anneeSelect.disabled = false;

  const selectedIndicator = getSelectedIndicator();
  const anneeId = quoteIdent(anneeCol);
  const whereParts = [anneeId + " IS NOT NULL"];
  const args = [];
  if (bottomSpecialCols.idIndicateur && selectedIndicator) {
    whereParts.push(quoteIdent(bottomSpecialCols.idIndicateur) + " = ?");
    args.push(selectedIndicator);
  }

  const rows = await runSql(
    "SELECT DISTINCT " + anneeId + " AS annee FROM " + quoteIdent(bottomTableId) +
      " WHERE " + whereParts.join(" AND ") + " ORDER BY " + anneeId + " DESC",
    args
  );

  const values = rows.map((row) => row.annee).filter((v) => v !== null && v !== undefined);

  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    anneeSelect.appendChild(option);
  });

  selectedAnnee = values.length > 0 ? String(values[0]) : "";
  anneeSelect.value = selectedAnnee;
  updateAnneeNav();
}

// Drives the per-niv_geo stats table(s) — one for "value_new", and (when
// "value_old" exists) one for the écart between them — and the département-level
// value_new/value_old/écart table, computed entirely on the server with SQL
// queries against data_validation — never all of its rows. All are scoped to
// the selected indicator and (when data_validation has an "annee" column) the
// selected year.
export async function renderStatsAndChart() {
  chartContainer.innerHTML = "";
  valueStatsContainer.innerHTML = "";
  nivGeoBadgesContainer.innerHTML = "";

  const valueCol = bottomSpecialCols.valueNew;
  if (!valueCol) return;

  const table = quoteIdent(bottomTableId);
  const valueId = quoteIdent(valueCol);
  const selectedIndicator = getSelectedIndicator();

  // Base WHERE (indicator + year only, NA rows included) — shared starting point
  // for the stats table(s) (which need NA counts) and the chart (which
  // additionally filters to "dep"-level rows and excludes NA rows below).
  // Filtering by the selected indicator (when data_validation has that column)
  // is what keeps each query fast — it should hit an index on id_indicateur
  // rather than scan the full hundreds-of-millions-row table.
  const baseWhereParts = [];
  const baseArgs = [];
  if (bottomSpecialCols.idIndicateur && selectedIndicator) {
    baseWhereParts.push(quoteIdent(bottomSpecialCols.idIndicateur) + " = ?");
    baseArgs.push(selectedIndicator);
  }
  if (bottomSpecialCols.annee && selectedAnnee) {
    baseWhereParts.push(quoteIdent(bottomSpecialCols.annee) + " = ?");
    baseArgs.push(selectedAnnee);
  }

  await renderNivGeoBadges(table, valueId, baseWhereParts, baseArgs);

  await renderValueStatsTable(table, valueId, baseWhereParts, baseArgs, "Distribution de value_new");

  if (bottomSpecialCols.valueOld) {
    // A NULL value_new or value_old naturally makes the écart NULL too, so it
    // falls into the group's NA count the same way a missing value_new does above.
    const ecartExpr = "(CAST(" + valueId + " AS REAL) - CAST(" + quoteIdent(bottomSpecialCols.valueOld) + " AS REAL))";
    await renderValueStatsTable(table, ecartExpr, baseWhereParts, baseArgs, "Distribution de l'écart (value_new − value_old)");
  }

  await renderDepartmentValueTable(table, valueId, baseWhereParts, baseArgs);
}

// Renders a pastille per NIV_GEO_BADGE_GROUPS entry — green when every code in
// the group has at least one non-NA row for the selected indicator/year,
// gray otherwise. Flags which territorial-reform regime(s) (Rhône/Corse/Alsace
// mergers, plus Mayotte) the current data uses. Deliberately NOT filtered to
// niv_geo = "dep": some of these codes (e.g. "20R"/"6AE", the Corse/Alsace
// collectivités) sit at a different niv_geo level than ordinary départements,
// so restricting to "dep" would always find them absent.
async function renderNivGeoBadges(table, valueId, baseWhereParts, baseArgs) {
  const codeGeoCol = bottomSpecialCols.codeGeo;
  if (!codeGeoCol) return;

  const codeGeoId = quoteIdent(codeGeoCol);
  const whereParts = baseWhereParts.concat([valueId + " IS NOT NULL"]);
  const args = baseArgs;
  const where = "WHERE " + whereParts.join(" AND ");

  const rows = await runSql(
    "SELECT DISTINCT " + codeGeoId + " AS g FROM " + table + " " + where,
    args
  );
  const presentCodes = new Set(
    rows.map((row) => row.g).filter((g) => g !== null && g !== undefined).map((g) => String(g).trim().toUpperCase())
  );

  NIV_GEO_BADGE_GROUPS.forEach((group) => {
    const isOn = group.codes.every((code) => presentCodes.has(code.toUpperCase()));

    const badge = document.createElement("span");
    badge.className = "niv-geo-badge " + (isOn ? "niv-geo-badge--on" : "niv-geo-badge--off");

    const dot = document.createElement("span");
    dot.className = "niv-geo-badge-dot";
    badge.appendChild(dot);

    badge.appendChild(document.createTextNode(group.label));
    nivGeoBadgesContainer.appendChild(badge);
  });
}

// Table of value_new / value_old / écart at département level ("niv_geo" =
// DEP_NIV_GEO_VALUE), one row per "code_geo", for the selected indicator/year.
async function renderDepartmentValueTable(table, valueId, baseWhereParts, baseArgs) {
  const nivGeoCol = bottomSpecialCols.nivGeo;
  const codeGeoCol = bottomSpecialCols.codeGeo;
  if (!nivGeoCol || !codeGeoCol) return;

  const codeGeoId = quoteIdent(codeGeoCol);
  const valueOldCol = bottomSpecialCols.valueOld;
  const valueOldId = valueOldCol ? quoteIdent(valueOldCol) : null;

  const whereParts = baseWhereParts.concat([quoteIdent(nivGeoCol) + " = ?"]);
  const args = baseArgs.concat([DEP_NIV_GEO_VALUE]);
  const where = "WHERE " + whereParts.join(" AND ");

  const selectParts = [codeGeoId + " AS g", "CAST(" + valueId + " AS REAL) AS valueNew"];
  if (valueOldId) {
    selectParts.push("CAST(" + valueOldId + " AS REAL) AS valueOld");
  }

  const rows = await runSql(
    "SELECT " + selectParts.join(", ") + " FROM " + table + " " + where + " ORDER BY " + codeGeoId,
    args
  );

  if (rows.length === 0) return;

  const selectedIndicator = getSelectedIndicator();
  const heading = document.createElement("h3");
  heading.textContent = "value_new" + (valueOldId ? " / value_old / écart" : "") + " par département (dep)" +
    (selectedIndicator ? " — " + selectedIndicator : "") +
    (selectedAnnee ? " — " + selectedAnnee : "");
  chartContainer.appendChild(heading);

  const toNumberOrNull = (v) => (v === null || v === undefined ? null : Number(v));

  const columns = [
    ["code_geo", (r) => (r.g === null || r.g === undefined ? "—" : String(r.g))],
    ["value_new", (r) => formatNumberOrDash(toNumberOrNull(r.valueNew))],
  ];
  if (valueOldId) {
    columns.push(["value_old", (r) => formatNumberOrDash(toNumberOrNull(r.valueOld))]);
    columns.push([
      "Écart",
      (r) => {
        const vNew = toNumberOrNull(r.valueNew);
        const vOld = toNumberOrNull(r.valueOld);
        return vNew === null || vOld === null ? "—" : formatNumber(vNew - vOld);
      },
    ]);
  }

  const tableEl = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach(([header]) => {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach(([, getValue]) => {
      const td = document.createElement("td");
      td.textContent = getValue(row);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);

  chartContainer.appendChild(tableEl);
}

// Distribution summary table: one row per distinct value of "niv_geo" (or a
// single "Tous" row when that column doesn't exist), each with its row count,
// NA count (rows whose `valueId` expression is blank), and — when the group has
// at least one non-NA value — min/max/déciles/moyenne/médiane/quartiles/écart-type/IQR.
// `valueId` is a SQL value expression (a quoted column, or an arithmetic
// expression such as the value_new/value_old écart) — not necessarily a plain
// column identifier. `baseWhereParts`/`baseArgs` scope every query to the
// selected indicator/year and deliberately do NOT exclude NA rows, since the NA
// count itself is a per-group aggregate here. Appends its table (under `title`)
// to valueStatsContainer without clearing it first, so callers can render
// several distributions (value_new, écart…) into the same container.
async function renderValueStatsTable(table, valueId, baseWhereParts, baseArgs, title) {
  const nivGeoCol = bottomSpecialCols.nivGeo;
  const nivGeoId = nivGeoCol ? quoteIdent(nivGeoCol) : null;
  const castValue = "CAST(" + valueId + " AS REAL)";
  const where = baseWhereParts.length > 0 ? "WHERE " + baseWhereParts.join(" AND ") : "";

  const groupRows = await runSql(
    "SELECT " + (nivGeoId ? nivGeoId + " AS g, " : "") +
      "COUNT(*) AS total, " +
      "SUM(CASE WHEN " + valueId + " IS NULL THEN 1 ELSE 0 END) AS naCount, " +
      "MIN(" + castValue + ") AS mn, MAX(" + castValue + ") AS mx, " +
      "AVG(" + castValue + ") AS mean, AVG(" + castValue + " * " + castValue + ") AS meanSq " +
      "FROM " + table + " " + where +
      (nivGeoId ? " GROUP BY " + nivGeoId + " ORDER BY " + nivGeoId : ""),
    baseArgs
  );

  if (groupRows.length === 0) return;

  const groups = [];
  for (const row of groupRows) {
    const rawGeo = nivGeoId ? row.g : undefined;
    const total = Number(row.total || 0);
    const naCount = Number(row.naCount || 0);
    const validCount = total - naCount;

    let min = null, max = null, mean = null, stdDev = null;
    let quantiles = { d1: null, q1: null, median: null, q3: null, d9: null };

    if (validCount > 0 && row.mn !== null && row.mx !== null) {
      min = Number(row.mn);
      max = Number(row.mx);
      mean = Number(row.mean);
      const variance = Math.max(0, Number(row.meanSq) - mean * mean);
      stdDev = Math.sqrt(variance);

      if (max - min === 0) {
        // Every value in this group is identical — no need to sort to know the
        // quantiles.
        quantiles = { d1: min, q1: min, median: min, q3: min, d9: min };
      } else {
        const groupWhereParts = baseWhereParts.concat([valueId + " IS NOT NULL"]);
        const groupArgs = baseArgs.slice();
        if (nivGeoId) {
          if (rawGeo === null || rawGeo === undefined) {
            groupWhereParts.push(nivGeoId + " IS NULL");
          } else {
            groupWhereParts.push(nivGeoId + " = ?");
            groupArgs.push(rawGeo);
          }
        }
        const groupWhere = "WHERE " + groupWhereParts.join(" AND ");
        quantiles = await fetchQuantiles(table, castValue, groupWhere, groupArgs, validCount);
      }
    }

    groups.push({
      nivGeoLabel: nivGeoCol
        ? rawGeo === null || rawGeo === undefined || rawGeo === "" ? "(vide)" : String(rawGeo)
        : "Tous",
      isNational: nivGeoCol && rawGeo !== null && rawGeo !== undefined &&
        NATIONAL_NIV_GEO_VALUES.has(String(rawGeo).trim().toLowerCase()),
      total,
      naCount,
      min,
      max,
      mean,
      stdDev,
      ...quantiles,
    });
  }

  const tableGroups = groups.filter((g) => !g.isNational);

  if (tableGroups.length > 0) {
    renderValueStatsRows(tableGroups, title);
  }
}

// Renders the groups computed by renderValueStatsTable() as a <table> — one row
// per niv_geo — under a heading naming which distribution it is. Appended to
// valueStatsContainer rather than replacing its content, so multiple
// distributions can stack.
function renderValueStatsRows(groups, title) {
  if (title) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    valueStatsContainer.appendChild(heading);
  }

  const columns = [
    ["niv_geo", (g) => g.nivGeoLabel],
    ["Effectif", (g) => String(g.total)],
    ["NA", (g) => String(g.naCount)],
    ["Min", (g) => formatNumberOrDash(g.min)],
    ["Max", (g) => formatNumberOrDash(g.max)],
    ["Décile 1", (g) => formatNumberOrDash(g.d1)],
    ["Quartile 1", (g) => formatNumberOrDash(g.q1)],
    ["Médiane", (g) => formatNumberOrDash(g.median)],
    ["Quartile 3", (g) => formatNumberOrDash(g.q3)],
    ["Décile 9", (g) => formatNumberOrDash(g.d9)],
    ["Moyenne", (g) => formatNumberOrDash(g.mean)],
    ["Écart-type", (g) => formatNumberOrDash(g.stdDev)],
    ["Écart interquartile", (g) => (g.q1 === null || g.q3 === null ? "—" : formatNumber(g.q3 - g.q1))],
  ];

  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach(([header]) => {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  groups.forEach((group) => {
    const tr = document.createElement("tr");
    columns.forEach(([, getValue]) => {
      const td = document.createElement("td");
      td.textContent = getValue(group);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  valueStatsContainer.appendChild(table);
}

// Nearest-rank D1/Q1/median/Q3/D9 in a single sorted pass over the filtered rows,
// using window functions (ROW_NUMBER/COUNT OVER) rather than five separate
// "ORDER BY value LIMIT 1 OFFSET n" queries. This does require SQLite to sort the
// filtered subset — unavoidable for exact quantiles without a value-ordered
// index or a pre-built approximation structure — but it's the one query that
// does, and it's scoped to the current indicator's rows, not the whole table.
async function fetchQuantiles(table, castValue, where, filterArgs, count) {
  // Rank (1-indexed) of the p-th nearest-rank quantile among `count` sorted
  // values — matches valueAt()'s Math.round(p * (count - 1)) + 1 below.
  const rankExpr = "MAX(CAST(ROUND(? * " + (count - 1) + ") AS INT) + 1, 1)";
  const ranks = [0.1, 0.25, 0.5, 0.75, 0.9];

  // filterArgs' placeholder(s) appear first in the SQL text (inside the
  // "filtered" CTE's WHERE clause), followed by one "?" per rank (inside the
  // final WHERE rn IN (...)) — args must be supplied in that same order.
  const rows = await runSql(
    "WITH filtered AS (SELECT " + castValue + " AS v FROM " + table + " " + where + "), " +
      "ordered AS (SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn FROM filtered) " +
      "SELECT v, rn FROM ordered WHERE rn IN (" + ranks.map(() => rankExpr).join(", ") + ")",
    [...filterArgs, ...ranks]
  );

  const byRank = new Map(rows.map((row) => [Number(row.rn), Number(row.v)]));
  const valueAt = (p) => {
    const rank = Math.max(1, Math.round(p * (count - 1)) + 1);
    return byRank.has(rank) ? byRank.get(rank) : null;
  };

  return {
    d1: valueAt(0.1),
    q1: valueAt(0.25),
    median: valueAt(0.5),
    q3: valueAt(0.75),
    d9: valueAt(0.9),
  };
}

