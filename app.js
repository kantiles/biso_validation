(function () {
  "use strict";

  const MAIN_TABLE_HINT = "main_validation";
  const BOTTOM_TABLE_HINT = "data_validation";
  const HISTOGRAM_BIN_COUNT = 10;

  const indicatorSelect = document.getElementById("indicator-select");
  const statusEl = document.getElementById("status");
  const chartContainer = document.getElementById("chart-container");
  const mainTableContainer = document.getElementById("main-table-container");

  let mainTableId = null;
  let mainColumns = [];
  let mainSpecialCols = { idIndicateur: null, validation: null, commentaires: null };
  let mainRows = [];

  let bottomTableId = null;
  let bottomSpecialCols = { idIndicateur: null, validation: null, commentaires: null, value: null };
  let bottomRows = [];

  let selectedIndicator = "";

  function setStatus(message, level) {
    statusEl.textContent = message || "";
    statusEl.className = message ? "status " + (level || "info") : "status";
  }

  function normalize(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findColumn(columns, targetName) {
    const target = normalize(targetName);
    return columns.find((c) => normalize(c) === target) || null;
  }

  async function init() {
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

    grist.ready({ requiredAccess: "full" });

    indicatorSelect.addEventListener("change", () => {
      selectedIndicator = indicatorSelect.value;
      renderMainFromCache();
      renderBottomFromCache();
    });

    try {
      const tableIds = await grist.docApi.listTables();

      const mainMatch = tableIds.find((id) => normalize(id) === normalize(MAIN_TABLE_HINT));
      if (!mainMatch) {
        setStatus("Table \"" + MAIN_TABLE_HINT + "\" introuvable dans ce document.", "error");
        return;
      }
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
    const columns = Object.keys(data).filter((k) => k !== "id" && k !== "manualSort");
    mainColumns = columns;

    mainSpecialCols = {
      idIndicateur: findColumn(columns, "id_indicateur"),
      validation: findColumn(columns, "validation"),
      commentaires: findColumn(columns, "commentaires"),
    };

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

    populateIndicatorSelect();
    renderMainFromCache();
  }

  function renderMainFromCache() {
    let rows = mainRows;

    if (mainSpecialCols.idIndicateur && selectedIndicator) {
      const col = mainSpecialCols.idIndicateur;
      rows = rows.filter((row) => String(row[col]) === selectedIndicator);
    }

    renderTable(mainTableContainer, mainColumns, rows, mainSpecialCols, mainTableId);
  }

  function populateIndicatorSelect() {
    indicatorSelect.innerHTML = "";

    const col = mainSpecialCols.idIndicateur;
    if (!col) {
      indicatorSelect.disabled = true;
      selectedIndicator = "";
      return;
    }

    indicatorSelect.disabled = false;

    const seen = new Set();
    const values = [];
    mainRows.forEach((row) => {
      const v = row[col];
      if (v === null || v === undefined || v === "") return;
      const s = String(v);
      if (!seen.has(s)) {
        seen.add(s);
        values.push(s);
      }
    });

    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      indicatorSelect.appendChild(option);
    });

    selectedIndicator = values.length > 0 ? values[0] : "";
    indicatorSelect.value = selectedIndicator;
  }

  async function loadBottomTable(tableId) {
    bottomTableId = tableId;
    bottomRows = [];
    chartContainer.innerHTML = "";

    try {
      const data = await grist.docApi.fetchTable(tableId);
      const columns = Object.keys(data).filter((k) => k !== "id" && k !== "manualSort");

      bottomSpecialCols = {
        idIndicateur: findColumn(columns, "id_indicateur"),
        validation: findColumn(columns, "validation"),
        commentaires: findColumn(columns, "commentaires"),
        value: findColumn(columns, "value"),
      };

      const rowCount = data.id ? data.id.length : 0;
      const rows = [];
      for (let i = 0; i < rowCount; i++) {
        const row = { id: data.id[i] };
        columns.forEach((col) => {
          row[col] = data[col][i];
        });
        rows.push(row);
      }
      bottomRows = rows;

      renderBottomFromCache();
    } catch (err) {
      console.error(err);
      setStatus("Erreur lors du chargement de la feuille : " + err.message, "error");
    }
  }

  function renderBottomFromCache() {
    let rows = bottomRows;

    if (bottomSpecialCols.idIndicateur && selectedIndicator) {
      const col = bottomSpecialCols.idIndicateur;
      rows = rows.filter((row) => String(row[col]) === selectedIndicator);
    }

    renderHistogram(rows);
  }

  function renderHistogram(rows) {
    chartContainer.innerHTML = "";

    const valueCol = bottomSpecialCols.value;
    if (!valueCol) return;

    const values = rows
      .map((row) => {
        const raw = row[valueCol];
        return typeof raw === "number" ? raw : parseFloat(raw);
      })
      .filter((v) => Number.isFinite(v));

    if (values.length === 0) return;

    const min = Math.min(...values);
    const max = Math.max(...values);

    const binCount = HISTOGRAM_BIN_COUNT;
    const bins = new Array(binCount).fill(0);
    const range = max - min;

    values.forEach((v) => {
      let idx;
      if (range === 0) {
        idx = 0;
      } else {
        idx = Math.floor(((v - min) / range) * binCount);
        if (idx >= binCount) idx = binCount - 1;
      }
      bins[idx]++;
    });

    const maxCount = Math.max(...bins, 1);
    const binWidth = range === 0 ? 0 : range / binCount;

    const title = document.createElement("h3");
    title.textContent = "Distribution de value" + (selectedIndicator ? " — " + selectedIndicator : "");
    chartContainer.appendChild(title);

    const chart = document.createElement("div");
    chart.className = "chart";

    bins.forEach((count, i) => {
      const rangeStart = range === 0 ? min : min + i * binWidth;
      const rangeEnd = range === 0 ? max : min + (i + 1) * binWidth;
      const label = range === 0 ? formatNumber(min) : formatNumber(rangeStart) + " – " + formatNumber(rangeEnd);

      const row = document.createElement("div");
      row.className = "chart-row";

      const labelEl = document.createElement("span");
      labelEl.className = "chart-label";
      labelEl.textContent = label;

      const track = document.createElement("div");
      track.className = "chart-bar-track";
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.width = (count / maxCount) * 100 + "%";
      track.appendChild(bar);

      const countEl = document.createElement("span");
      countEl.className = "chart-count";
      countEl.textContent = String(count);

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

  function renderTable(container, columns, rows, specialCols, tableId) {
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
    columns.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      columns.forEach((col) => {
        const td = document.createElement("td");

        if (col === specialCols.validation) {
          td.appendChild(buildValidationSelect(row, specialCols, tableId));
        } else if (col === specialCols.commentaires) {
          td.appendChild(buildCommentInput(row, specialCols, tableId));
        } else {
          td.textContent = formatValue(row[col]);
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

  function buildCommentInput(row, specialCols, tableId) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = row[specialCols.commentaires] || "";
    input.addEventListener("blur", () => {
      updateCell(tableId, row.id, specialCols.commentaires, input.value, input.closest("td"));
    });
    return input;
  }

  async function updateCell(tableId, rowId, colName, value, cellEl) {
    if (!tableId || !colName) return;

    cellEl.classList.add("saving");
    cellEl.classList.remove("saved");
    try {
      await grist.docApi.applyUserActions([
        ["UpdateRecord", tableId, rowId, { [colName]: value }],
      ]);

      const cache = tableId === mainTableId ? mainRows : bottomRows;
      const cachedRow = cache.find((r) => r.id === rowId);
      if (cachedRow) cachedRow[colName] = value;

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
