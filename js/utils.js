// Petites fonctions pures partagées par les autres modules.
"use strict";

// Column names are matched case/punctuation-insensitively so small naming drift in
// the Grist document (e.g. "Id_Indicateur" vs "id_indicateur") doesn't break the
// widget. Accents are folded first ("Thématique" ≡ "Thematique"), since Grist
// may strip them from column ids.
export function normalize(name) {
  return String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findColumn(columns, targetName) {
  const target = normalize(targetName);
  return columns.find((c) => normalize(c) === target) || null;
}

// Double-quotes a SQL identifier (table or column name) for SQLite, doubling any
// embedded quote. Needed because table/column ids come from Grist's schema at
// runtime and can't be hardcoded into the query strings.
export function quoteIdent(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

// Virgule décimale, espace comme séparateur de milliers (format "fr-FR" —
// toLocaleString y insère une espace insécable, pas une espace normale, mais
// ça reste un espace visuellement).
// `decimals` : nombre de décimales pour les non-entiers (2 par défaut ; 3 pour
// les colonnes de valeurs brutes des tableaux géographiques).
export function formatNumber(n, decimals = 2) {
  return n.toLocaleString("fr-FR", Number.isInteger(n) ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatNumberOrDash(n, decimals = 2) {
  return n === null || n === undefined ? "—" : formatNumber(n, decimals);
}

export function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
