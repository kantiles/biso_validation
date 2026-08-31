// Références aux éléments du DOM (voir index.html) et affichage du statut.
"use strict";

export const validationFilter = document.getElementById("validation-filter");
export const anneeSelect = document.getElementById("annee-select");
export const indicatorSelect = document.getElementById("indicator-select");
export const indicatorPrevBtn = document.getElementById("indicator-prev");
export const indicatorNextBtn = document.getElementById("indicator-next");
export const indicatorPositionEl = document.getElementById("indicator-position");
export const statusEl = document.getElementById("status");
export const chartContainer = document.getElementById("chart-container");
export const valueStatsContainer = document.getElementById("value-stats");
export const mainTableContainer = document.getElementById("main-table-container");
export const statTotalEl = document.getElementById("stat-total");
export const statValidatedEl = document.getElementById("stat-validated");
export const statToReviewEl = document.getElementById("stat-to-review");
export const statTodoEl = document.getElementById("stat-todo");

export function setStatus(message, level) {
  statusEl.textContent = message || "";
  statusEl.className = message ? "status " + (level || "info") : "status";
}
