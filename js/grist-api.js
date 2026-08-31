// Backend de requêtage SQL en local, via DuckDB-Wasm — remplace les appels à
// l'API REST /sql de Grist (POST /api/docs/:docId/sql). Cette API faisait une
// requête HTTP cross-origin directement depuis le widget vers
// grist.numerique.gouv.fr, qui se heurte à la protection anti-bot
// (Incapsula/Imperva) de cette instance : redirections 307 en boucle, jamais de
// réponse utilisable, "TypeError: Failed to fetch" côté navigateur.
//
// À la place : les données de "data_validation" sont rapatriées une seule fois
// via grist.docApi.fetchTable() (RPC postMessage entre le widget et la page
// Grist parente — aucune requête réseau directe, donc insensible au WAF), puis
// chargées dans une base DuckDB en mémoire DANS le navigateur (voir
// loadTableIntoDuckDb ci-dessous, appelée depuis stats-chart.js). Toutes les
// requêtes SQL (stats de distribution, quantiles, graphique) tournent ensuite
// localement contre cette base — plus aucun appel réseau vers Grist une fois la
// table chargée.
"use strict";

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";
import { tableFromArrays } from "https://cdn.jsdelivr.net/npm/apache-arrow@17/+esm";

let connPromise = null;

// Instantiates a single AsyncDuckDB (+ worker) and opens one connection,
// lazily and only once — reused for every load/query, since spinning up the
// wasm module has real overhead. Follows DuckDB-Wasm's documented bootstrap
// pattern: the worker script is loaded via a same-origin Blob that
// `importScripts()`s the actual (cross-origin, CDN-hosted) worker bundle,
// which sidesteps cross-origin Worker-construction restrictions.
async function getConn() {
  if (!connPromise) {
    connPromise = (async () => {
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      return db.connect();
    })();
  }
  return connPromise;
}

function quoteIdent(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

// Loads `columnsData` (the {colId: valueArray} shape returned by
// grist.docApi.fetchTable(), minus "id"/"manualSort") into a local DuckDB table
// named `tableName`, replacing any previous contents under that name — the
// widget only ever loads data_validation once per session, but this stays safe
// to call again.
export async function loadTableIntoDuckDb(tableName, columnsData) {
  const conn = await getConn();
  await conn.query("DROP TABLE IF EXISTS " + quoteIdent(tableName));
  const arrowTable = tableFromArrays(columnsData);
  await conn.insertArrowTable(arrowTable, { name: tableName, create: true });
}

// Runs a SQL query against the local DuckDB database and returns the result
// rows as plain objects — same shape the previous Grist-REST-backed runSql()
// returned, so callers didn't need to change. `args`, when given, are bound
// positionally to "?" placeholders via a prepared statement.
export async function runSql(sql, args) {
  const conn = await getConn();
  let result;
  if (args && args.length > 0) {
    const stmt = await conn.prepare(sql);
    try {
      result = await stmt.query(...args);
    } finally {
      await stmt.close();
    }
  } else {
    result = await conn.query(sql);
  }
  return result.toArray().map((row) => row.toJSON());
}
