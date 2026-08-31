// Couche d'accès à l'API Grist : jeton d'accès, requêtes SQL en lecture seule,
// introspection du schéma (colonnes d'une table).
//
// "data_validation" holds hundreds of millions of rows, so unlike main_validation
// it is NEVER fetched into the browser with grist.docApi.fetchTable — that would
// pull the whole table over the wire just to compute a summary. Instead
// everything computed from it is run server-side with Grist's own SQL query API
// (POST /api/docs/:docId/sql, SELECT-only, running against the doc's underlying
// SQLite storage), reached from the widget via an access token — see runSql().
// Column names for that table are resolved the same lightweight way, by querying
// Grist's own schema tables (_grist_Tables / _grist_Tables_column) instead of
// fetching a data row.
"use strict";

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
export async function runSql(sql, args) {
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
export async function getTableColumns(tableId) {
  const rows = await runSql(
    "SELECT c.colId AS colId FROM _grist_Tables_column c " +
      "JOIN _grist_Tables t ON t.id = c.parentId " +
      "WHERE t.tableId = ?",
    [tableId]
  );
  return rows.map((row) => row.colId).filter((colId) => colId !== "manualSort");
}
