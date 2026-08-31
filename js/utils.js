// Petites fonctions pures partagées par les autres fichiers (voir index.html
// pour l'ordre de chargement — window.BISO.utils, chargé en premier).
"use strict";

window.BISO = window.BISO || {};

window.BISO.utils = (function () {
  // Column names are matched case/punctuation-insensitively so small naming drift
  // in the Grist document (e.g. "Id_Indicateur" vs "id_indicateur") doesn't break
  // the widget.
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

  function formatNumber(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  function formatNumberOrDash(n) {
    return n === null || n === undefined ? "—" : formatNumber(n);
  }

  function formatValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  return { normalize, findColumn, quoteIdent, formatNumber, formatNumberOrDash, formatValue };
})();
