(function () {
  "use strict";

  // Grist Custom Widget for BISO validation.
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
  // Both table names are hardcoded (MAIN_TABLE_HINT / BOTTOM_TABLE_HINT) rather than
  // user-selectable — this widget is purpose-built for this document's schema.
  //
  // "data_validation" holds hundreds of millions of rows, so unlike main_validation
  // it is NEVER fetched into the browser with grist.docApi.fetchTable — that would
  // pull the whole table over the wire just to compute a summary. Instead
  // everything in section 3 is computed server-side with Grist's own SQL query API
  // (POST /api/docs/:docId/sql, SELECT-only, running against the doc's underlying
  // SQLite storage), reached from the widget via an access token — see runSql().
  // Column names for that table are resolved the same lightweight way, by querying
  // Grist's own schema tables (_grist_Tables / _grist_Tables_column) instead of
  // fetching a data row.

  const MAIN_TABLE_HINT = "main_validation";
  const BOTTOM_TABLE_HINT = "data_validation";

  // The "niv_geo" value that selects département-level rows for the bar chart
  // (see renderDepartmentChartFromSql).
  const DEP_NIV_GEO_VALUE = "dep";

  // Sentinel used by the validation filter's "Non renseigné" option — validation
  // itself uses "" for its own "unset" choice (see buildValidationSelect), so an
  // empty string can't also mean "no filter" here without ambiguity.
  const VALIDATION_FILTER_EMPTY = "__empty__";

  const validationFilter = document.getElementById("validation-filter");
  const anneeSelect = document.getElementById("annee-select");
  const indicatorSelect = document.getElementById("indicator-select");
  const indicatorPrevBtn = document.getElementById("indicator-prev");
  const indicatorNextBtn = document.getElementById("indicator-next");
  const indicatorPositionEl = document.getElementById("indicator-position");
  const statusEl = document.getElementById("status");
  const chartContainer = document.getElementById("chart-container");
  const valueStatsContainer = document.getElementById("value-stats");
  const mainTableContainer = document.getElementById("main-table-container");
  const statTotalEl = document.getElementById("stat-total");
  const statValidatedEl = document.getElementById("stat-validated");
  const statToReviewEl = document.getElementById("stat-to-review");
  const statTodoEl = document.getElementById("stat-todo");

  // "main_validation" state: the table id (needed for UpdateRecord calls), the
  // resolved column names for the fields we treat specially, and the cached rows
  // (avoids refetching from Grist on every filter change).
  let mainTableId = null;
  let mainSpecialCols = { idIndicateur: null, libelle: null, validation: null, commentaires: null };
  let mainRows = [];

  // "data_validation" state: only the table id and the resolved column names are
  // kept — no row cache, since rows are never fetched (see the SQL note above).
  let bottomTableId = null;
  let bottomSpecialCols = { idIndicateur: null, value: null, nivGeo: null, annee: null, codeGeo: null };

  // The indicator currently chosen in the dropdown — drives both renderMainFromCache()
  // and renderStatsAndChart(). Always a string (Grist cell values are coerced with
  // String() before comparison, since a Reference display value could be numeric-looking).
  let selectedIndicator = "";

  // The year currently chosen in the "Année" dropdown (see populateAnneeSelect) —
  // built from the distinct "annee" values of data_validation for the selected
  // indicator, most recent first, defaulting to the most recent. Always a string
  // for the same reason as selectedIndicator.
  let selectedAnnee = "";

  function setStatus(message, level) {
    statusEl.textContent = message || "";
    statusEl.className = message ? "status " + (level || "info") : "status";
  }

  // Column names are matched case/punctuation-insensitively so small naming drift in
  // the Grist document (e.g. "Id_Indicateur" vs "id_indicateur") doesn't break the
  // widget.
  function normalize(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findColumn(columns, targetName) {
    const target = normalize(targetName);
    return columns.find((c) => normalize(c) === target) || null;
  }

  // Double-quotes a SQL identifier (table or column name) for SQLite, doubling any
  // embedded quote. Needed because table/column ids come from Grist's schema at
  // runtime and can't be hardcoded into the query strings.
  function quoteIdent(id) {
    return '"' + String(id).replace(/"/g, '""') + '"';
  }

  // Access tokens from grist.docApi.getAccessToken are short-lived (ttlMsecs) but
  // meant to be reused across calls rather than fetched per-query; cached here and
  // refreshed a few seconds before expiry.
  let cachedAccessToken = null;

  async function getAccessToken() {
    if (!cachedAccessToken || Date.now() > cachedAccessToken.expiresAt) {
      const result = await grist.docApi.getAccessToken({ readOnly: true });
      cachedAccessToken = { ...result, expiresAt: Date.now() + result.ttlMsecs - 5000 };
    }
    return cachedAccessToken;
  }

  // Runs a read-only SQL SELECT against the document via Grist's REST SQL endpoint
  // and returns the result rows as plain objects (one per record). This is what
  // lets the stats/chart section aggregate hundreds of millions of rows on the
  // server instead of downloading them.
  async function runSql(sql, args) {
    const { token, baseUrl } = await getAccessToken();
    const url = baseUrl + "/sql?auth=" + encodeURIComponent(token);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, args: args || [], timeout: 20000 }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error("Requête SQL échouée (" + response.status + ") " + text);
    }

    const body = await response.json();
    return (body.records || []).map((record) => record.fields);
  }

  // Lists a table's column ids by querying Grist's own schema tables rather than
  // fetching a row of real data — cheap regardless of the table's row count.
  async function getTableColumns(tableId) {
    const rows = await runSql(
      "SELECT c.colId AS colId FROM _grist_Tables_column c " +
        "JOIN _grist_Tables t ON t.id = c.parentId " +
        "WHERE t.tableId = ?",
      [tableId]
    );
    return rows.map((row) => row.colId).filter((colId) => colId !== "manualSort");
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
    // (UpdateRecord in updateCell) and read arbitrary tables (listTables/fetchTable).
    grist.ready({ requiredAccess: "full" });

    // Changing the indicator (via the dropdown or the prev/next buttons) only
    // re-filters already-cached rows — no refetch.
    indicatorSelect.addEventListener("change", () => {
      selectIndicator(indicatorSelect.value);
    });
    indicatorPrevBtn.addEventListener("click", () => stepIndicator(-1));
    indicatorNextBtn.addEventListener("click", () => stepIndicator(1));

    // Changing the year only re-filters/re-aggregates data_validation for the
    // already-selected indicator — the indicator list itself is untouched.
    anneeSelect.addEventListener("change", () => {
      selectedAnnee = anneeSelect.value;
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

  async function loadMainTable(tableId) {
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
  // per indicator.
  function renderStats() {
    const col = mainSpecialCols.idIndicateur;
    const validationCol = mainSpecialCols.validation;

    const seen = new Set();
    let validated = 0;
    let toReview = 0;
    let todo = 0;

    mainRows.forEach((row) => {
      const id = col ? row[col] : null;
      if (id === null || id === undefined || id === "") return;
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);

      const validationValue = validationCol ? row[validationCol] || "" : "";
      if (validationValue === "Oui") {
        validated++;
      } else if (validationValue === "Non") {
        toReview++;
      } else {
        todo++;
      }
    });

    statTotalEl.textContent = String(seen.size);
    statValidatedEl.textContent = String(validated);
    statToReviewEl.textContent = String(toReview);
    statTodoEl.textContent = String(todo);
  }

  function renderMainFromCache() {
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

    renderTable(mainTableContainer, displayColumns, rows, mainSpecialCols, mainTableId);
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
  // matchesValidationFilter), sorted alphabetically, and defaults the selection to
  // the first one (i.e. the alphabetically-first indicator) — per spec, "prend par
  // défaut la première valeur".
  function populateIndicatorSelect() {
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
  function stepIndicator(delta) {
    const options = Array.from(indicatorSelect.options);
    if (options.length === 0) return;

    const currentIndex = options.findIndex((opt) => opt.value === selectedIndicator);
    const nextIndex = Math.min(options.length - 1, Math.max(0, currentIndex + delta));
    selectIndicator(options[nextIndex].value);
  }

  function selectIndicator(value) {
    selectedIndicator = value;
    indicatorSelect.value = value;
    updateIndicatorNav();
    renderMainFromCache();
    // Fire-and-forget: refreshForIndicator issues its own SQL requests and
    // repaints the year selector / stats / chart when they resolve. Errors are
    // surfaced via setStatus rather than left as an unhandled rejection.
    refreshForIndicator().catch((err) => {
      console.error(err);
      setStatus("Erreur lors du calcul des statistiques : " + err.message, "error");
    });
  }

  // Re-derives everything that depends on the selected indicator but isn't part of
  // main_validation's cache: the year dropdown's options (distinct "annee" values
  // for this indicator) and the stats table / chart below it. Used both when the
  // indicator itself changes and when the Validation filter picks a new default
  // indicator.
  async function refreshForIndicator() {
    await populateAnneeSelect();
    await renderStatsAndChart();
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

  // Resolves data_validation's column ids via schema introspection (getTableColumns)
  // — no data row is fetched, so this is cheap no matter how many rows the table
  // holds. idIndicateur/annee (filtering), value (the stats/chart data), nivGeo
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
        value: findColumn(columns, "value"),
        nivGeo: findColumn(columns, "niv_geo"),
        annee: findColumn(columns, "annee"),
        codeGeo: findColumn(columns, "code_geo"),
      };

      if (!bottomSpecialCols.value) {
        setStatus("Attention : colonne \"value\" introuvable dans " + BOTTOM_TABLE_HINT + " : graphique indisponible.", "warn");
        return;
      }
      if (!bottomSpecialCols.nivGeo) {
        setStatus("Attention : colonne \"niv_geo\" introuvable dans " + BOTTOM_TABLE_HINT + " : statistiques non ventilées, graphique indisponible.", "warn");
      } else if (!bottomSpecialCols.codeGeo) {
        setStatus("Attention : colonne \"code_geo\" introuvable dans " + BOTTOM_TABLE_HINT + " : graphique indisponible.", "warn");
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

  // Drives both the per-niv_geo stats table and the département-level bar chart
  // of the "value" column, computed entirely on the server with SQL queries
  // against data_validation — never all of its rows. Both are scoped to the
  // selected indicator and (when data_validation has an "annee" column) the
  // selected year.
  async function renderStatsAndChart() {
    chartContainer.innerHTML = "";
    valueStatsContainer.innerHTML = "";

    const valueCol = bottomSpecialCols.value;
    if (!valueCol) return;

    const table = quoteIdent(bottomTableId);
    const valueId = quoteIdent(valueCol);

    // Base WHERE (indicator + year only, NA rows included) — shared starting point
    // for the stats table (which needs NA counts) and the chart (which
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

    await renderValueStatsTable(table, valueId, baseWhereParts, baseArgs);
    await renderDepartmentChartFromSql(table, valueId, baseWhereParts, baseArgs);
  }

  // Bar chart of "value" at département level ("niv_geo" = DEP_NIV_GEO_VALUE),
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
  // NA count (rows whose "value" is blank), and — when the group has at least one
  // non-NA value — min/max/déciles/moyenne/médiane/quartiles/écart-type/IQR.
  // `baseWhereParts`/`baseArgs` scope every query to the selected indicator/year
  // and deliberately do NOT exclude NA rows, since the NA count itself is a
  // per-group aggregate here.
  async function renderValueStatsTable(table, valueId, baseWhereParts, baseArgs) {
    valueStatsContainer.innerHTML = "";

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

    renderValueStatsRows(groups);
  }

  // Renders the groups computed by renderValueStatsTable() as a <table> — one row
  // per niv_geo.
  function renderValueStatsRows(groups) {
    valueStatsContainer.innerHTML = "";

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

  function formatNumberOrDash(n) {
    return n === null || n === undefined ? "—" : formatNumber(n);
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

    const title = document.createElement("h3");
    title.textContent = "Value par département (dep)" +
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

  function formatNumber(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  // Generic table renderer shared by any table in the widget (currently only
  // main_validation). `displayColumns` is a [{key, header}] list — `key` looks up
  // the value in the row object, `header` is what's shown in <th>. `specialCols`
  // and `tableId` are passed through so validation/commentaires cells can render as
  // editable inputs that write back to the right Grist table.
  function renderTable(container, displayColumns, rows, specialCols, tableId) {
    container.innerHTML = "";

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "Aucune ligne à afficher.";
      container.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    displayColumns.forEach(({ header }) => {
      const th = document.createElement("th");
      th.textContent = header;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      displayColumns.forEach(({ key }) => {
        const td = document.createElement("td");

        if (key === specialCols.validation) {
          td.appendChild(buildValidationSelect(row, specialCols, tableId));
        } else if (key === specialCols.commentaires) {
          td.appendChild(buildCommentInput(row, specialCols, tableId));
        } else {
          td.textContent = formatValue(row[key]);
        }

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.appendChild(table);
  }

  function formatValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  // Fixed "Oui" / "Non" / "—" (empty) choices — validation is a tri-state flag, not
  // free text, so a <select> is used instead of a text input.
  function buildValidationSelect(row, specialCols, tableId) {
    const select = document.createElement("select");
    ["", "Oui", "Non"].forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt === "" ? "—" : opt;
      select.appendChild(option);
    });
    select.value = row[specialCols.validation] || "";
    select.addEventListener("change", () => {
      updateCell(tableId, row.id, specialCols.validation, select.value, select.closest("td"));
    });
    return select;
  }

  // A <textarea> rather than a single-line <input> — commentaires can run longer
  // than a table cell's width, so a 2-row box (see .comment-input in style.css)
  // gives room to read/write without truncating. Saved on blur rather than on
  // every keystroke, to avoid one Grist API call per character typed.
  function buildCommentInput(row, specialCols, tableId) {
    const textarea = document.createElement("textarea");
    textarea.className = "comment-input";
    textarea.rows = 2;
    textarea.value = row[specialCols.commentaires] || "";
    textarea.addEventListener("blur", () => {
      updateCell(tableId, row.id, specialCols.commentaires, textarea.value, textarea.closest("td"));
    });
    return textarea;
  }

  // Writes a single cell back to Grist and mirrors it into the in-memory row cache
  // (mainRows — the only cache that exists, since main_validation is the only table
  // rendered with editable cells) so a later re-render (e.g. switching indicator and
  // back) reflects the edit without refetching the table. The "saving"/"saved"
  // classes give the cell a brief visual confirmation (see style.css).
  async function updateCell(tableId, rowId, colName, value, cellEl) {
    if (!tableId || !colName) return;

    cellEl.classList.add("saving");
    cellEl.classList.remove("saved");
    try {
      await grist.docApi.applyUserActions([
        ["UpdateRecord", tableId, rowId, { [colName]: value }],
      ]);

      const cachedRow = mainRows.find((r) => r.id === rowId);
      if (cachedRow) cachedRow[colName] = value;

      // A validation edit changes which bucket the row counts toward — keep the
      // top-of-widget counters in sync immediately rather than waiting for a
      // reload.
      if (colName === mainSpecialCols.validation) renderStats();

      cellEl.classList.remove("saving");
      cellEl.classList.add("saved");
      setTimeout(() => cellEl.classList.remove("saved"), 800);
    } catch (err) {
      console.error(err);
      cellEl.classList.remove("saving");
      setStatus("Erreur lors de l'enregistrement : " + err.message, "error");
    }
  }

  init();
})();
