// Gestion de la table "data_validation" : sélecteur d'année, table de
// statistiques de distribution et graphique en barres par département.
//
// Les lignes sont rapatriées une fois via grist.docApi.fetchTable() (RPC
// postMessage, jamais de requête réseau directe — voir grist-api.js) puis
// chargées dans une base DuckDB en mémoire dans le navigateur ; tous les calculs
// ci-dessous (statistiques de distribution, quantiles, graphique) sont ensuite
// des requêtes SQL contre cette base locale, jamais un rapatriement des lignes
// une par une dans du JS. Le graphique lui-même est rendu avec Observable Plot
// plutôt qu'en HTML/CSS fait main (voir renderDepartmentBars).
"use strict";

import { quoteIdent, findColumn, formatNumber, formatNumberOrDash } from "./utils.js";
import { runSql, loadTableIntoDuckDb } from "./grist-api.js";
import { anneeSelect, chartContainer, valueStatsContainer, setStatus } from "./dom.js";
import { getSelectedIndicator } from "./main-table.js";
import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm";

export const BOTTOM_TABLE_HINT = "data_validation";

// Name of the local DuckDB table data_validation's rows are loaded into — an
// identifier we control ourselves, independent of Grist's own internal table
// id (bottomTableId, used only to call fetchTable).
const DUCKDB_TABLE = "data_validation";

// The "niv_geo" value that selects département-level rows for the bar chart
// (see renderDepartmentChartFromSql).
const DEP_NIV_GEO_VALUE = "dep";

// "data_validation" state: the resolved column names — no row cache here (the
// rows themselves live in DuckDB, not in a JS array, once loaded).
let bottomSpecialCols = { idIndicateur: null, valueNew: null, valueOld: null, nivGeo: null, annee: null, codeGeo: null };

// The year currently chosen in the "Année" dropdown (see populateAnneeSelect) —
// built from the distinct "annee" values of data_validation for the selected
// indicator, most recent first, defaulting to the most recent. Always a string,
// for the same reason as main-table.js's selectedIndicator.
let selectedAnnee = "";

export function setSelectedAnnee(value) {
  selectedAnnee = value;
}

// Fetches data_validation in full via fetchTable() (postMessage RPC — the
// table isn't astronomically large, just too big to recompute stats over in
// hand-written JS on every filter change) and loads it into a local DuckDB
// table, then resolves the columns this widget treats specially the same way
// loadMainTable does for main_validation.
export async function loadBottomTable(tableId) {
  chartContainer.innerHTML = "";
  valueStatsContainer.innerHTML = "";

  try {
    const data = await grist.docApi.fetchTable(tableId);
    const columns = Object.keys(data).filter((k) => k !== "id" && k !== "manualSort");

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

    const columnsData = {};
    columns.forEach((col) => {
      columnsData[col] = data[col];
    });
    await loadTableIntoDuckDb(DUCKDB_TABLE, columnsData);

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
  if (!anneeCol) {
    anneeSelect.disabled = true;
    selectedAnnee = "";
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
    "SELECT DISTINCT " + anneeId + " AS annee FROM " + quoteIdent(DUCKDB_TABLE) +
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
}

// Drives the per-niv_geo stats table(s) — one for "value_new", and (when
// "value_old" exists) one for the écart between them — and the département-level
// bar chart of "value_new", computed entirely by DuckDB queries against the
// local copy of data_validation. All are scoped to the selected indicator and
// (when data_validation has an "annee" column) the selected year.
export async function renderStatsAndChart() {
  chartContainer.innerHTML = "";
  valueStatsContainer.innerHTML = "";

  const valueCol = bottomSpecialCols.valueNew;
  if (!valueCol) return;

  const table = quoteIdent(DUCKDB_TABLE);
  const valueId = quoteIdent(valueCol);
  const selectedIndicator = getSelectedIndicator();

  // Base WHERE (indicator + year only, NA rows included) — shared starting point
  // for the stats table(s) (which need NA counts) and the chart (which
  // additionally filters to "dep"-level rows and excludes NA rows below).
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

  await renderValueStatsTable(table, valueId, baseWhereParts, baseArgs, "Distribution de value_new");

  if (bottomSpecialCols.valueOld) {
    // A NULL value_new or value_old naturally makes the écart NULL too, so it
    // falls into the group's NA count the same way a missing value_new does above.
    const ecartExpr = "(TRY_CAST(" + valueId + " AS DOUBLE) - TRY_CAST(" + quoteIdent(bottomSpecialCols.valueOld) + " AS DOUBLE))";
    await renderValueStatsTable(table, ecartExpr, baseWhereParts, baseArgs, "Distribution de l'écart (value_new − value_old)");
  }

  await renderDepartmentChartFromSql(table, valueId, baseWhereParts, baseArgs);
}

// Bar chart of "value_new" at département level ("niv_geo" = DEP_NIV_GEO_VALUE),
// one bar per "code_geo", for the selected indicator/year.
async function renderDepartmentChartFromSql(table, valueId, baseWhereParts, baseArgs) {
  const nivGeoCol = bottomSpecialCols.nivGeo;
  const codeGeoCol = bottomSpecialCols.codeGeo;
  if (!nivGeoCol || !codeGeoCol) return;

  const codeGeoId = quoteIdent(codeGeoCol);
  const whereParts = baseWhereParts.concat([
    quoteIdent(nivGeoCol) + " = ?",
    valueId + " IS NOT NULL",
  ]);
  const args = baseArgs.concat([DEP_NIV_GEO_VALUE]);
  const where = "WHERE " + whereParts.join(" AND ");
  const castValue = "TRY_CAST(" + valueId + " AS DOUBLE)";

  const rows = await runSql(
    "SELECT " + codeGeoId + " AS g, " + castValue + " AS v FROM " + table + " " + where +
      " ORDER BY " + codeGeoId,
    args
  );

  if (rows.length === 0) return;

  const bars = rows
    .filter((row) => row.g !== null && row.g !== undefined)
    .map((row) => ({ label: String(row.g), value: Number(row.v) }));

  renderDepartmentBars(bars);
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
  const castValue = "TRY_CAST(" + valueId + " AS DOUBLE)";
  const where = baseWhereParts.length > 0 ? "WHERE " + baseWhereParts.join(" AND ") : "";

  // Aliases "naCount"/"meanSq" are double-quoted to preserve their exact case —
  // unlike SQLite, DuckDB folds unquoted identifiers to lowercase, which would
  // otherwise silently rename them to naCount -> nacount / meanSq -> meansq.
  const groupRows = await runSql(
    "SELECT " + (nivGeoId ? nivGeoId + " AS g, " : "") +
      "COUNT(*) AS total, " +
      "SUM(CASE WHEN " + valueId + " IS NULL THEN 1 ELSE 0 END) AS \"naCount\", " +
      "MIN(" + castValue + ") AS mn, MAX(" + castValue + ") AS mx, " +
      "AVG(" + castValue + ") AS mean, AVG(" + castValue + " * " + castValue + ") AS \"meanSq\" " +
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
      total,
      naCount,
      min,
      max,
      mean,
      stdDev,
      ...quantiles,
    });
  }

  renderValueStatsRows(groups, title);
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
// using window functions (ROW_NUMBER OVER) rather than five separate
// "ORDER BY value LIMIT 1 OFFSET n" queries. This does require DuckDB to sort the
// filtered subset — unavoidable for exact quantiles without a value-ordered
// index or a pre-built approximation structure — but it's the one query that
// does, and it's scoped to the current indicator's rows, not the whole table.
async function fetchQuantiles(table, castValue, where, filterArgs, count) {
  // Rank (1-indexed) of the p-th nearest-rank quantile among `count` sorted
  // values — matches valueAt()'s Math.round(p * (count - 1)) + 1 below.
  // GREATEST(a, b), not SQLite's two-argument scalar MAX(a, b) — DuckDB's MAX
  // is aggregate-only.
  const rankExpr = "GREATEST(CAST(ROUND(? * " + (count - 1) + ") AS INT) + 1, 1)";
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

// One horizontal bar per département ("code_geo"), rendered with Observable
// Plot — negative values just extend the bar left of the zero rule instead of
// needing the abs()-based width hack a hand-rolled div/CSS bar chart needs.
function renderDepartmentBars(bars) {
  const selectedIndicator = getSelectedIndicator();

  const title = document.createElement("h3");
  title.textContent = "value_new par département (dep)" +
    (selectedIndicator ? " — " + selectedIndicator : "") +
    (selectedAnnee ? " — " + selectedAnnee : "");
  chartContainer.appendChild(title);

  const chart = Plot.plot({
    width: Math.max(480, chartContainer.clientWidth || 0),
    height: Math.max(200, bars.length * 20 + 40),
    marginLeft: 60,
    grid: true,
    x: { label: "value_new" },
    y: { label: null, domain: bars.map((b) => b.label) },
    marks: [
      Plot.ruleX([0]),
      Plot.barX(bars, {
        y: "label",
        x: "value",
        fill: (d) => (d.value < 0 ? "var(--stat-danger)" : "var(--accent)"),
      }),
      Plot.text(bars, {
        y: "label",
        x: "value",
        text: (d) => formatNumber(d.value),
        dx: (d) => (d.value < 0 ? -4 : 4),
        textAnchor: (d) => (d.value < 0 ? "end" : "start"),
        fill: "var(--text-muted)",
        fontSize: 11,
      }),
    ],
  });

  chartContainer.appendChild(chart);
}
