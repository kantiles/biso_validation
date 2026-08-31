(function () {
  "use strict";

  const MAX_ROWS = 10;
  const DEFAULT_TABLE_HINT = "base biso doc";
  const SPECIAL_COLUMNS = new Set(["id_indicateur", "validation", "commentaires"]);

  const sheetSelect = document.getElementById("sheet-select");
  const indicatorFilter = document.getElementById("indicator-filter");
  const statusEl = document.getElementById("status");
  const tableContainer = document.getElementById("table-container");

  let currentTableId = null;
  let currentColumns = [];
  let currentSpecialCols = { idIndicateur: null, validation: null, commentaires: null };

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

    sheetSelect.addEventListener("change", () => loadTable(sheetSelect.value));
    indicatorFilter.addEventListener("input", () => renderFromCache());

    try {
      const tableIds = await grist.docApi.listTables();
      populateSheetSelect(tableIds);
      if (tableIds.length > 0) {
        await loadTable(sheetSelect.value);
      } else {
        setStatus("Aucune table trouvée dans ce document.", "warn");
      }
    } catch (err) {
      console.error(err);
      setStatus("Erreur lors du chargement de la liste des feuilles : " + err.message, "error");
    }
  }

  function populateSheetSelect(tableIds) {
    sheetSelect.innerHTML = "";
    tableIds.forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      sheetSelect.appendChild(option);
    });

    const defaultMatch = tableIds.find((id) => normalize(id) === normalize(DEFAULT_TABLE_HINT));
    if (defaultMatch) {
      sheetSelect.value = defaultMatch;
    }
  }

  let cachedRows = [];

  async function loadTable(tableId) {
    currentTableId = tableId;
    cachedRows = [];
    tableContainer.innerHTML = "";
    setStatus("Chargement de la feuille \"" + tableId + "\"...", "info");

    try {
      const data = await grist.docApi.fetchTable(tableId);
      const columns = Object.keys(data).filter((k) => k !== "id" && k !== "manualSort");
      currentColumns = columns;

      currentSpecialCols = {
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
      cachedRows = rows;

      const warnings = [];
      if (!currentSpecialCols.idIndicateur) {
        warnings.push("colonne \"id_indicateur\" introuvable : aucun filtrage possible");
      }
      if (!currentSpecialCols.validation) {
        warnings.push("colonne \"validation\" introuvable : saisie désactivée");
      }
      if (!currentSpecialCols.commentaires) {
        warnings.push("colonne \"commentaires\" introuvable : saisie désactivée");
      }

      if (warnings.length > 0) {
        setStatus("Attention : " + warnings.join(" ; ") + ".", "warn");
      } else {
        setStatus("", "info");
      }

      renderFromCache();
    } catch (err) {
      console.error(err);
      setStatus("Erreur lors du chargement de la feuille : " + err.message, "error");
    }
  }

  function renderFromCache() {
    const filterValue = indicatorFilter.value.trim().toLowerCase();
    let rows = cachedRows;

    if (currentSpecialCols.idIndicateur && filterValue) {
      const col = currentSpecialCols.idIndicateur;
      rows = rows.filter((row) => {
        const value = row[col];
        return value !== null && value !== undefined && String(value).toLowerCase().includes(filterValue);
      });
    }

    rows = rows.slice(0, MAX_ROWS);
    renderTable(rows);
  }

  function renderTable(rows) {
    tableContainer.innerHTML = "";

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "Aucune ligne à afficher.";
      tableContainer.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    currentColumns.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      currentColumns.forEach((col) => {
        const td = document.createElement("td");

        if (col === currentSpecialCols.validation) {
          td.appendChild(buildValidationSelect(row));
        } else if (col === currentSpecialCols.commentaires) {
          td.appendChild(buildCommentInput(row));
        } else {
          td.textContent = formatValue(row[col]);
        }

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    tableContainer.appendChild(table);
  }

  function formatValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  function buildValidationSelect(row) {
    const select = document.createElement("select");
    ["", "Oui", "Non"].forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt === "" ? "—" : opt;
      select.appendChild(option);
    });
    select.value = row[currentSpecialCols.validation] || "";
    select.addEventListener("change", () => {
      updateCell(row.id, currentSpecialCols.validation, select.value, select.closest("td"));
    });
    return select;
  }

  function buildCommentInput(row) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = row[currentSpecialCols.commentaires] || "";
    input.addEventListener("blur", () => {
      updateCell(row.id, currentSpecialCols.commentaires, input.value, input.closest("td"));
    });
    return input;
  }

  async function updateCell(rowId, colName, value, cellEl) {
    if (!currentTableId || !colName) return;

    cellEl.classList.add("saving");
    cellEl.classList.remove("saved");
    try {
      await grist.docApi.applyUserActions([
        ["UpdateRecord", currentTableId, rowId, { [colName]: value }],
      ]);

      const cachedRow = cachedRows.find((r) => r.id === rowId);
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
