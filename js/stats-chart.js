// Gestion de la table "data_validation" : sélecteur d'année, table de
// statistiques de distribution et tableaux value_new/value_old/écart par
// département et par région — tout calculé côté serveur via SQL (voir
// grist-api.js), jamais en rapatriant les lignes dans le navigateur.
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

// The "niv_geo" values that select département/région-level rows for the
// value_new/value_old/écart tables (see renderGeoValueTable).
const DEP_NIV_GEO_VALUE = "dep";
const REG_NIV_GEO_VALUE = "reg";

// "niv_geo" values that each only ever have a single row (national-level
// aggregates, not a distribution across several geo units) — excluded from the
// per-niv_geo stats table, where a full distribution would be meaningless.
// Compared case-insensitively.
const NATIONAL_NIV_GEO_VALUES = new Set(["fr_ent", "fr_metro", "fr-ent_h_mayotte", "fr_ent_h_mayotte"]);

// Libellés des départements par code INSEE (niv_geo = "dep"), pour l'affichage
// dans renderDepartmentValueTable — codés en dur car cette info ne vient
// d'aucune table Grist. Comparé insensible à la casse (voir departmentLabel).
// Inclut les codes des régimes de découpage territorial (Rhône/Corse/Alsace,
// voir NIV_GEO_BADGE_GROUPS ci-dessous) en plus des 101 départements standard.
const DEPARTMENT_LABELS = {
  "01": "Ain", "02": "Aisne", "03": "Allier", "04": "Alpes-de-Haute-Provence",
  "05": "Hautes-Alpes", "06": "Alpes-Maritimes", "07": "Ardèche", "08": "Ardennes",
  "09": "Ariège", "10": "Aube", "11": "Aude", "12": "Aveyron",
  "13": "Bouches-du-Rhône", "14": "Calvados", "15": "Cantal", "16": "Charente",
  "17": "Charente-Maritime", "18": "Cher", "19": "Corrèze",
  "2A": "Corse-du-Sud", "2B": "Haute-Corse",
  "21": "Côte-d'Or", "22": "Côtes-d'Armor", "23": "Creuse", "24": "Dordogne",
  "25": "Doubs", "26": "Drôme", "27": "Eure", "28": "Eure-et-Loir",
  "29": "Finistère", "30": "Gard", "31": "Haute-Garonne", "32": "Gers",
  "33": "Gironde", "34": "Hérault", "35": "Ille-et-Vilaine", "36": "Indre",
  "37": "Indre-et-Loire", "38": "Isère", "39": "Jura", "40": "Landes",
  "41": "Loir-et-Cher", "42": "Loire", "43": "Haute-Loire",
  "44": "Loire-Atlantique", "45": "Loiret", "46": "Lot", "47": "Lot-et-Garonne",
  "48": "Lozère", "49": "Maine-et-Loire", "50": "Manche", "51": "Marne",
  "52": "Haute-Marne", "53": "Mayenne", "54": "Meurthe-et-Moselle", "55": "Meuse",
  "56": "Morbihan", "57": "Moselle", "58": "Nièvre", "59": "Nord",
  "60": "Oise", "61": "Orne", "62": "Pas-de-Calais", "63": "Puy-de-Dôme",
  "64": "Pyrénées-Atlantiques", "65": "Hautes-Pyrénées", "66": "Pyrénées-Orientales",
  "67": "Bas-Rhin", "68": "Haut-Rhin",
  "69": "Rhône", "69D": "Rhône (partie départementale)", "69M": "Métropole de Lyon",
  "70": "Haute-Saône", "71": "Saône-et-Loire", "72": "Sarthe", "73": "Savoie",
  "74": "Haute-Savoie", "75": "Paris", "76": "Seine-Maritime",
  "77": "Seine-et-Marne", "78": "Yvelines", "79": "Deux-Sèvres", "80": "Somme",
  "81": "Tarn", "82": "Tarn-et-Garonne", "83": "Var", "84": "Vaucluse",
  "85": "Vendée", "86": "Vienne", "87": "Haute-Vienne", "88": "Vosges",
  "89": "Yonne", "90": "Territoire de Belfort", "91": "Essonne",
  "92": "Hauts-de-Seine", "93": "Seine-Saint-Denis", "94": "Val-de-Marne",
  "95": "Val-d'Oise",
  "971": "Guadeloupe", "972": "Martinique", "973": "Guyane",
  "974": "La Réunion", "975": "Saint-Pierre-et-Miquelon", "976": "Mayotte",
  "20R": "Collectivité de Corse", "6AE": "Collectivité européenne d'Alsace",
};

// Libellés des régions par code INSEE (niv_geo = "reg") — codés en dur pour la
// même raison que DEPARTMENT_LABELS ci-dessus. Les 13 régions métropolitaines
// et les 5 régions d'outre-mer (DROM, dont les codes 01-06 ne chevauchent pas
// la numérotation métropolitaine, qui commence à 11).
const REGION_LABELS = {
  "01": "Guadeloupe", "02": "Martinique", "03": "Guyane", "04": "La Réunion",
  "06": "Mayotte",
  "11": "Île-de-France", "24": "Centre-Val de Loire",
  "27": "Bourgogne-Franche-Comté", "28": "Normandie", "32": "Hauts-de-France",
  "44": "Grand Est", "52": "Pays de la Loire", "53": "Bretagne",
  "75": "Nouvelle-Aquitaine", "76": "Occitanie", "84": "Auvergne-Rhône-Alpes",
  "93": "Provence-Alpes-Côte d'Azur", "94": "Corse",
};

const GEO_LABELS = { [DEP_NIV_GEO_VALUE]: DEPARTMENT_LABELS, [REG_NIV_GEO_VALUE]: REGION_LABELS };

function geoLabel(nivGeoValue, codeGeo) {
  if (codeGeo === null || codeGeo === undefined) return "—";
  const key = String(codeGeo).trim().toUpperCase();
  return (GEO_LABELS[nivGeoValue] || {})[key] || "—";
}

// Plain alphabetical order puts "2A"/"2B" after "29" (not next to "19"/"21",
// their old "20" slot) and "6AE" after "69" (not next to "66"/"67"). These
// overrides give those codes a sort key that slots them where the
// département list actually expects them: "2A"/"2B" just before "21", "6AE"
// just before "67" — everything else sorts on its own code, unchanged.
// Région codes need no such override — plain numeric-string order is correct.
const GEO_SORT_KEY_OVERRIDES = { [DEP_NIV_GEO_VALUE]: { "2A": "20S", "2B": "20T", "6AE": "66Z" } };

function geoSortKey(nivGeoValue, codeGeo) {
  if (codeGeo === null || codeGeo === undefined) return "";
  const key = String(codeGeo).trim().toUpperCase();
  return (GEO_SORT_KEY_OVERRIDES[nivGeoValue] || {})[key] || key;
}

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
  // Buttons are wired in app.js so the left arrow decreases the year (moves
  // toward the END of this most-recent-first list) and the right arrow
  // increases it (moves toward the START) — disabled states follow that, not
  // the list order.
  anneePrevBtn.disabled = currentIndex === -1 || currentIndex >= total - 1;
  anneeNextBtn.disabled = currentIndex <= 0;
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

  // Indicator-only WHERE (no year) — used by the geo value tables below to
  // pull value_new for the current year and the two previous ones in a single
  // pass, regardless of which year is selected.
  const indicatorWhereParts = [];
  const indicatorArgs = [];
  if (bottomSpecialCols.idIndicateur && selectedIndicator) {
    indicatorWhereParts.push(quoteIdent(bottomSpecialCols.idIndicateur) + " = ?");
    indicatorArgs.push(selectedIndicator);
  }

  // Base WHERE (indicator + year only, NA rows included) — shared starting point
  // for the stats table(s) (which need NA counts) and the chart (which
  // additionally filters to a geo level and excludes NA rows below).
  // Filtering by the selected indicator (when data_validation has that column)
  // is what keeps each query fast — it should hit an index on id_indicateur
  // rather than scan the full hundreds-of-millions-row table.
  const baseWhereParts = indicatorWhereParts.slice();
  const baseArgs = indicatorArgs.slice();
  if (bottomSpecialCols.annee && selectedAnnee) {
    baseWhereParts.push(quoteIdent(bottomSpecialCols.annee) + " = ?");
    baseArgs.push(selectedAnnee);
  }

  await renderNivGeoBadges(table, valueId, baseWhereParts, baseArgs);

  await renderValueStatsTable(table, valueId, baseWhereParts, baseArgs, "Distribution de Valeur - nouvelle");

  if (bottomSpecialCols.valueOld) {
    // A NULL value_new or value_old naturally makes the écart NULL too, so it
    // falls into the group's NA count the same way a missing value_new does above.
    const ecartExpr = "(CAST(" + valueId + " AS REAL) - CAST(" + quoteIdent(bottomSpecialCols.valueOld) + " AS REAL))";
    await renderValueStatsTable(table, ecartExpr, baseWhereParts, baseArgs, "Distribution de l'écart (Valeur - nouvelle − Valeur - ancienne)");
  }

  await renderGeoValueTable(table, valueId, baseWhereParts, baseArgs, indicatorWhereParts, indicatorArgs, DEP_NIV_GEO_VALUE);
  await renderGeoValueTable(table, valueId, baseWhereParts, baseArgs, indicatorWhereParts, indicatorArgs, REG_NIV_GEO_VALUE);
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

// Table of value_new / value_old / écart at département or région level
// ("niv_geo" = `nivGeoValue`), one row per "code_geo", for the selected
// indicator/year — plus value_new for the two previous years, so reviewers
// can spot a trend without switching the Année dropdown back and forth.
// `indicatorWhereParts`/`indicatorArgs` (no year filter) are what the prior-year
// lookup runs against; `baseWhereParts`/`baseArgs` (indicator + selected year)
// are what the current year's value_new/value_old columns run against, same as
// before.
async function renderGeoValueTable(table, valueId, baseWhereParts, baseArgs, indicatorWhereParts, indicatorArgs, nivGeoValue) {
  const nivGeoCol = bottomSpecialCols.nivGeo;
  const codeGeoCol = bottomSpecialCols.codeGeo;
  const anneeCol = bottomSpecialCols.annee;
  if (!nivGeoCol || !codeGeoCol) return;

  const codeGeoId = quoteIdent(codeGeoCol);
  const valueOldCol = bottomSpecialCols.valueOld;
  const valueOldId = valueOldCol ? quoteIdent(valueOldCol) : null;

  const whereParts = baseWhereParts.concat([quoteIdent(nivGeoCol) + " = ?"]);
  const args = baseArgs.concat([nivGeoValue]);
  const where = "WHERE " + whereParts.join(" AND ");

  const selectParts = [codeGeoId + " AS g", "CAST(" + valueId + " AS REAL) AS valueNew"];
  if (valueOldId) {
    selectParts.push("CAST(" + valueOldId + " AS REAL) AS valueOld");
  }

  const rows = await runSql(
    "SELECT " + selectParts.join(", ") + " FROM " + table + " " + where,
    args
  );

  const normalizeCode = (g) => (g === null || g === undefined ? "" : String(g).trim().toUpperCase());

  // value_new for the previous two years, keyed by code_geo then by year
  // string — a single extra query (indicator + geo level, no year filter,
  // annee IN (N-1, N-2)) rather than one per year/code.
  const priorYears = anneeCol && selectedAnnee && !Number.isNaN(Number(selectedAnnee))
    ? [Number(selectedAnnee) - 1, Number(selectedAnnee) - 2]
    : [];
  const priorByCode = new Map();
  if (priorYears.length > 0) {
    const anneeId = quoteIdent(anneeCol);
    const priorWhereParts = indicatorWhereParts.concat([
      quoteIdent(nivGeoCol) + " = ?",
      anneeId + " IN (" + priorYears.map(() => "?").join(", ") + ")",
    ]);
    const priorArgs = indicatorArgs.concat([nivGeoValue], priorYears);
    const priorRows = await runSql(
      "SELECT " + codeGeoId + " AS g, " + anneeId + " AS annee, CAST(" + valueId + " AS REAL) AS v FROM " + table +
        " " + "WHERE " + priorWhereParts.join(" AND "),
      priorArgs
    );
    priorRows.forEach((row) => {
      const code = normalizeCode(row.g);
      if (!priorByCode.has(code)) priorByCode.set(code, {});
      priorByCode.get(code)[String(row.annee)] = row.v === null || row.v === undefined ? null : Number(row.v);
    });
  }

  // The table always lists every known code for this geo level (from
  // GEO_LABELS — plus any code found in the data that isn't in that
  // reference list, so nothing silently disappears) rather than only the
  // ones with data for the selected indicator/year — missing ones render as
  // "—" in every value column, same as any other null.
  const rowsByCode = new Map(rows.map((r) => [normalizeCode(r.g), r]));
  const allCodes = Array.from(new Set([...Object.keys(GEO_LABELS[nivGeoValue] || {}), ...rowsByCode.keys()]));
  if (allCodes.length === 0) return;

  allCodes.sort((a, b) => {
    const ka = geoSortKey(nivGeoValue, a);
    const kb = geoSortKey(nivGeoValue, b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const fullRows = allCodes.map((code) => {
    const r = rowsByCode.get(code);
    return { g: code, valueNew: r ? r.valueNew : null, valueOld: r ? r.valueOld : null };
  });

  const selectedIndicator = getSelectedIndicator();
  const heading = document.createElement("h3");
  heading.textContent = (selectedIndicator || "—") + " — " + (selectedAnnee || "—") + " — " + nivGeoValue;
  chartContainer.appendChild(heading);

  const toNumberOrNull = (v) => (v === null || v === undefined ? null : Number(v));
  const formatPercentOrDash = (v) => (v === null || v === undefined ? "—" : formatNumber(v) + " %");
  // Relative change, expressed as a percentage of `oldV` — null (rendered "—")
  // when either side is missing or `oldV` is 0 (division by zero).
  const pctChange = (newV, oldV) => (newV === null || oldV === null || oldV === 0 ? null : ((newV - oldV) / oldV) * 100);
  // Conditional-formatting tier for a % écart cell, regardless of direction —
  // the three thresholds the widget needs to flag (5/10/20 %), darkest at 20+.
  // See .pct-diff--* in style.css.
  const pctSeverityClass = (v) => {
    if (v === null || v === undefined) return "";
    const abs = Math.abs(v);
    if (abs >= 20) return "pct-diff--high";
    if (abs >= 10) return "pct-diff--medium";
    if (abs >= 5) return "pct-diff--low";
    return "";
  };
  const priorValueNew = (r, year) => {
    const byYear = priorByCode.get(normalizeCode(r.g));
    return byYear ? byYear[String(year)] ?? null : null;
  };

  // Column groups: a null `title` renders as a single header cell spanning
  // both header rows (N°/Libellé); any other group renders its `title` on the
  // first row (spanning its sub-columns) and each sub-column's own header on
  // the second row — this is the "en-tête double" the table needs (Valeur
  // modifiée over its 3 années, Valeur ancienne over its année, each écart
  // group over its absolu/% pair).
  const groups = [
    { title: null, subColumns: [
      ["N°", (r) => (r.g === null || r.g === undefined ? "—" : String(r.g))],
      ["Libellé", (r) => geoLabel(nivGeoValue, r.g)],
    ] },
    { title: "Valeur modifiée", subColumns: [
      [selectedAnnee || "—", (r) => formatNumberOrDash(toNumberOrNull(r.valueNew))],
      ...priorYears.map((year) => [String(year), (r) => formatNumberOrDash(priorValueNew(r, year))]),
    ] },
  ];

  if (valueOldId) {
    groups.push({ title: "Valeur ancienne", subColumns: [
      [selectedAnnee || "—", (r) => formatNumberOrDash(toNumberOrNull(r.valueOld))],
    ] });
    groups.push({ title: "Écart Valeur modifiée - ancienne", subColumns: [
      ["Écart", (r) => {
        const vNew = toNumberOrNull(r.valueNew);
        const vOld = toNumberOrNull(r.valueOld);
        if (vNew === null || vOld === null) return "—";
        // Rounded to 3 decimals before comparing, so float noise (e.g. a
        // value_new/value_old pair that only differs past the 3rd decimal
        // due to storage rounding) still reads as equal.
        const diff = vNew - vOld;
        return Math.round(diff * 1000) === 0 ? "Ok" : formatNumber(diff);
      }],
      ["Écart en %", (r) => formatPercentOrDash(pctChange(toNumberOrNull(r.valueNew), toNumberOrNull(r.valueOld))),
        (r) => pctSeverityClass(pctChange(toNumberOrNull(r.valueNew), toNumberOrNull(r.valueOld)))],
    ] });
  }

  if (priorYears.length > 0) {
    const prevYear = priorYears[0];
    groups.push({ title: "Écart N/N-1", subColumns: [
      ["Absolu", (r) => {
        const vNew = toNumberOrNull(r.valueNew);
        const vPrev = priorValueNew(r, prevYear);
        return vNew === null || vPrev === null ? "—" : formatNumber(vNew - vPrev);
      }],
      ["%", (r) => formatPercentOrDash(pctChange(toNumberOrNull(r.valueNew), priorValueNew(r, prevYear))),
        (r) => pctSeverityClass(pctChange(toNumberOrNull(r.valueNew), priorValueNew(r, prevYear)))],
    ] });
  }

  const tableEl = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow1 = document.createElement("tr");
  const headRow2 = document.createElement("tr");
  groups.forEach((group) => {
    if (group.title === null) {
      group.subColumns.forEach(([header]) => {
        const th = document.createElement("th");
        th.textContent = header;
        th.rowSpan = 2;
        headRow1.appendChild(th);
      });
      return;
    }
    const th = document.createElement("th");
    th.textContent = group.title;
    th.colSpan = group.subColumns.length;
    headRow1.appendChild(th);
    group.subColumns.forEach(([header]) => {
      const subTh = document.createElement("th");
      subTh.textContent = header;
      headRow2.appendChild(subTh);
    });
  });
  thead.appendChild(headRow1);
  thead.appendChild(headRow2);
  tableEl.appendChild(thead);

  const columns = groups.flatMap((group) => group.subColumns);

  const tbody = document.createElement("tbody");
  fullRows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach(([, getValue, getClass]) => {
      const td = document.createElement("td");
      td.textContent = getValue(row);
      const cls = getClass ? getClass(row) : "";
      if (cls) td.classList.add(cls);
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

  // grist.numerique.gouv.fr's WAF 403s this query even after casting only
  // once in a subquery (see git history) — the remaining suspect is the
  // CASE WHEN, a classic WAF-flagged SQLi pattern (used in blind/conditional
  // injection probes). COUNT(v) already ignores NULLs on its own, so the NA
  // count is just total - validCount, computed client-side instead — no CASE
  // needed.
  const innerSelect = "SELECT " + (nivGeoId ? nivGeoId + " AS g, " : "") + castValue + " AS v FROM " + table + " " + where;
  const groupRows = await runSql(
    "SELECT " + (nivGeoId ? "g, " : "") +
      "COUNT(*) AS total, COUNT(v) AS validCount, " +
      "MIN(v) AS mn, MAX(v) AS mx, " +
      "AVG(v) AS mean, AVG(v * v) AS meanSq " +
      "FROM (" + innerSelect + ")" +
      (nivGeoId ? " GROUP BY g ORDER BY g" : ""),
    baseArgs
  );

  if (groupRows.length === 0) return;

  const groups = [];
  for (const row of groupRows) {
    const rawGeo = nivGeoId ? row.g : undefined;
    const total = Number(row.total || 0);
    const validCount = Number(row.validCount || 0);
    const naCount = total - validCount;

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
    ["Décile 1", (g) => formatNumberOrDash(g.d1)],
    ["Quartile 1", (g) => formatNumberOrDash(g.q1)],
    ["Médiane", (g) => formatNumberOrDash(g.median)],
    ["Moyenne", (g) => formatNumberOrDash(g.mean)],
    ["Quartile 3", (g) => formatNumberOrDash(g.q3)],
    ["Décile 9", (g) => formatNumberOrDash(g.d9)],
    ["Max", (g) => formatNumberOrDash(g.max)],
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

