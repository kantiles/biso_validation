// Gestion de la table "data_validation" : sélecteur d'année, table de
// statistiques de distribution et graphique en barres par département — tout
// calculé côté serveur via SQL (voir grist-api.js), jamais en rapatriant les
// lignes dans le navigateur.
"use strict";

window.BISO = window.BISO || {};

window.BISO.statsChart = (function () {
  const { quoteIdent, findColumn, formatNumber, formatNumberOrDash } = window.BISO.utils;
  const { runSql, getTableColumns } = window.BISO.gristApi;
  const { anneeSelect, chartContainer, valueStatsContainer, setStatus } = window.BISO.dom;
  const { getSelectedIndicator } = window.BISO.mainTable;

  const BOTTOM_TABLE_HINT = "data_validation";

  // The "niv_geo" value that selects département-level rows for the bar chart
  // (see renderDepartmentChartFromSql).
  const DEP_NIV_GEO_VALUE = "dep";

  // "data_validation" state: only the table id and the resolved column names are
  // kept — no row cache, since rows are never fetched (see the file doc above).
  let bottomTableId = null;
  let bottomSpecialCols = { idIndicateur: null, valueNew: null, valueOld: null, nivGeo: null, annee: null, codeGeo: null };

  // The year currently chosen in the "Année" dropdown (see populateAnneeSelect) —
  // built from the distinct "annee" values of data_validation for the selected
  // indicator, most recent first, defaulting to the most recent. Always a string,
  // for the same reason as main-table.js's selectedIndicator.
  let selectedAnnee = "";

  function setSelectedAnnee(value) {
    selectedAnnee = value;
  }

  // Resolves data_validation's column ids via schema introspection (getTableColumns)
  // — no data row is fetched, so this is cheap no matter how many rows the table
  // holds. idIndicateur/annee (filtering), valueNew (the stats/chart data),
  // valueOld (compared against valueNew for the écart distribution table), nivGeo
  // (the stats table's grouping column, and the chart's "dep" level filter) and
  // codeGeo (the chart's per-bar label) are needed, since no table is ever
  // rendered for data_validation.
  async function loadBottomTable(tableId) {
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
  async function populateAnneeSelect() {
    anneeSelect.innerHTML = "";

    const anneeCol = bottomSpecialCols.annee;
    if (!anneeCol || !bottomTableId) {
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
  }

  // Drives the per-niv_geo stats table(s) — one for "value_new", and (when
  // "value_old" exists) one for the écart between them — and the département-level
  // bar chart of "value_new", computed entirely on the server with SQL queries
  // against data_validation — never all of its rows. All are scoped to the
  // selected indicator and (when data_validation has an "annee" column) the
  // selected year.
  async function renderStatsAndChart() {
    chartContainer.innerHTML = "";
    valueStatsContainer.innerHTML = "";

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

    await renderValueStatsTable(table, valueId, baseWhereParts, baseArgs, "Distribution de value_new");

    if (bottomSpecialCols.valueOld) {
      // A NULL value_new or value_old naturally makes the écart NULL too, so it
      // falls into the group's NA count the same way a missing value_new does above.
      const ecartExpr = "(CAST(" + valueId + " AS REAL) - CAST(" + quoteIdent(bottomSpecialCols.valueOld) + " AS REAL))";
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
    const castValue = "CAST(" + valueId + " AS REAL)";

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

  // One bar per département ("code_geo"), width proportional to |value| against
  // the largest |value| among the bars — handles the case where "value" can be
  // negative, since a bar's track can only grow one way.
  function renderDepartmentBars(bars) {
    const maxAbsValue = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
    const selectedIndicator = getSelectedIndicator();

    const title = document.createElement("h3");
    title.textContent = "value_new par département (dep)" +
      (selectedIndicator ? " — " + selectedIndicator : "") +
      (selectedAnnee ? " — " + selectedAnnee : "");
    chartContainer.appendChild(title);

    const chart = document.createElement("div");
    chart.className = "chart";

    bars.forEach(({ label, value }) => {
      const row = document.createElement("div");
      row.className = "chart-row";

      const labelEl = document.createElement("span");
      labelEl.className = "chart-label";
      labelEl.textContent = label;

      const track = document.createElement("div");
      track.className = "chart-bar-track";
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.width = (Math.abs(value) / maxAbsValue) * 100 + "%";
      track.appendChild(bar);

      const countEl = document.createElement("span");
      countEl.className = "chart-count";
      countEl.textContent = formatNumber(value);

      row.appendChild(labelEl);
      row.appendChild(track);
      row.appendChild(countEl);
      chart.appendChild(row);
    });

    chartContainer.appendChild(chart);
  }

  return {
    BOTTOM_TABLE_HINT,
    loadBottomTable,
    populateAnneeSelect,
    renderStatsAndChart,
    setSelectedAnnee,
  };
})();
