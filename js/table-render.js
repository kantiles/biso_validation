// Rendu générique d'un <table> à partir de lignes/colonnes, avec cellules
// "validation" et "commentaires" éditables qui écrivent dans Grist.
"use strict";

window.BISO = window.BISO || {};

window.BISO.tableRender = (function () {
  const { formatValue } = window.BISO.utils;
  const { setStatus } = window.BISO.dom;

  // Generic table renderer shared by any table in the widget (currently only
  // main_validation). `displayColumns` is a [{key, header}] list — `key` looks up
  // the value in the row object, `header` is what's shown in <th>. `specialCols`
  // and `tableId` are passed through so validation/commentaires cells can render as
  // editable inputs that write back to the right Grist table. `onCellSaved(rowId,
  // colName, value)` is called after a successful write, so the caller can mirror
  // the edit into its own row cache and react to it (e.g. recompute counters).
  function renderTable(container, displayColumns, rows, specialCols, tableId, onCellSaved) {
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
          td.appendChild(buildValidationSelect(row, specialCols, tableId, onCellSaved));
        } else if (key === specialCols.commentaires) {
          td.appendChild(buildCommentInput(row, specialCols, tableId, onCellSaved));
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

  // Fixed "Oui" / "Non" / "—" (empty) choices — validation is a tri-state flag, not
  // free text, so a <select> is used instead of a text input.
  function buildValidationSelect(row, specialCols, tableId, onCellSaved) {
    const select = document.createElement("select");
    ["", "Oui", "Non"].forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt === "" ? "—" : opt;
      select.appendChild(option);
    });
    select.value = row[specialCols.validation] || "";
    select.addEventListener("change", () => {
      updateCell(tableId, row.id, specialCols.validation, select.value, select.closest("td"), onCellSaved);
    });
    return select;
  }

  // A <textarea> rather than a single-line <input> — commentaires can run longer
  // than a table cell's width, so a 2-row box (see .comment-input in style.css)
  // gives room to read/write without truncating. Saved on blur rather than on
  // every keystroke, to avoid one Grist API call per character typed.
  function buildCommentInput(row, specialCols, tableId, onCellSaved) {
    const textarea = document.createElement("textarea");
    textarea.className = "comment-input";
    textarea.rows = 2;
    textarea.value = row[specialCols.commentaires] || "";
    textarea.addEventListener("blur", () => {
      updateCell(tableId, row.id, specialCols.commentaires, textarea.value, textarea.closest("td"), onCellSaved);
    });
    return textarea;
  }

  // Writes a single cell back to Grist. The "saving"/"saved" classes give the cell
  // a brief visual confirmation (see style.css). `onCellSaved` lets the caller keep
  // its own row cache in sync without this file knowing about it.
  async function updateCell(tableId, rowId, colName, value, cellEl, onCellSaved) {
    if (!tableId || !colName) return;

    cellEl.classList.add("saving");
    cellEl.classList.remove("saved");
    try {
      await grist.docApi.applyUserActions([
        ["UpdateRecord", tableId, rowId, { [colName]: value }],
      ]);

      if (onCellSaved) onCellSaved(rowId, colName, value);

      cellEl.classList.remove("saving");
      cellEl.classList.add("saved");
      setTimeout(() => cellEl.classList.remove("saved"), 800);
    } catch (err) {
      console.error(err);
      cellEl.classList.remove("saving");
      setStatus("Erreur lors de l'enregistrement : " + err.message, "error");
    }
  }

  return { renderTable };
})();
