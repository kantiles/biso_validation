// Références aux éléments du DOM (voir index.html) et affichage du statut.
"use strict";

window.BISO = window.BISO || {};

window.BISO.dom = (function () {
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

  function setStatus(message, level) {
    statusEl.textContent = message || "";
    statusEl.className = message ? "status " + (level || "info") : "status";
  }

  return {
    validationFilter,
    anneeSelect,
    indicatorSelect,
    indicatorPrevBtn,
    indicatorNextBtn,
    indicatorPositionEl,
    statusEl,
    chartContainer,
    valueStatsContainer,
    mainTableContainer,
    statTotalEl,
    statValidatedEl,
    statToReviewEl,
    statTodoEl,
    setStatus,
  };
})();
