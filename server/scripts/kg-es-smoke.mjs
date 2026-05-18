/**
 * kg-es-smoke.mjs — fumée bout-en-bout du C# ExtensibleStorage (étapes 3 & 5),
 * EN DIRECT sur le socket Revit (pas de client MCP, pas du serveur TS) : on
 * isole la couche jamais encore exécutée. Remplace l'esprit de l'ancien
 * `kg_bridge/smoke_test.py` (sidecar, supprimé) côté v1.
 *
 * Prérequis : Revit ouvert sur un projet, add-in chargé, bouton **Switch**
 * cliqué (socket up). Zéro dépendance — `node:net` seul.
 *
 *   node server/scripts/kg-es-smoke.mjs            # localhost:8080
 *   node server/scripts/kg-es-smoke.mjs 8080
 *
 * Protocole = celui de `server/src/utils/SocketClient.ts` : un objet
 * JSON-RPC par connexion, réponse lue quand le buffer parse. Une requête
 * par connexion (comme `withRevitConnection`), séquentiel.
 */
import net from "node:net";

const PORT = Number(process.argv[2] || 8080);
const HOST = "127.0.0.1";

let _id = 1;

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let buf = "";
    const req = { jsonrpc: "2.0", method, params, id: String(_id++) };
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout on ${method}`));
    }, 30000);
    sock.on("connect", () => sock.write(JSON.stringify(req)));
    sock.on("data", (d) => {
      buf += d.toString();
      try {
        const msg = JSON.parse(buf); // parse-quand-complet (cf. SocketClient)
        clearTimeout(to);
        sock.end();
        if (msg.error) reject(new Error(msg.error.message || "Revit error"));
        else resolve(msg.result);
      } catch {
        /* trame incomplète : attendre plus de données */
      }
    });
    sock.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}

// AIResult<T> : casing du wrapper non garanti (JToken.FromObject côté
// RevitMCPSDK). On lit les deux. Les champs internes (exists/graph/
// log_chunks/log_schema_version) sont figés snake_case par [JsonProperty].
function unwrap(res, op) {
  if (res == null || typeof res !== "object")
    throw new Error(`${op}: réponse vide`);
  const success = res.Success ?? res.success;
  const message = res.Message ?? res.message;
  const response = res.Response ?? res.response;
  if (success === false) throw new Error(message || `${op} échec (Revit)`);
  return response;
}

const ok = (b, label) =>
  console.log(`${b ? "  PASS" : "  FAIL"}  ${label}`) || b;

let failed = false;
const check = (b, label) => {
  if (!ok(b, label)) failed = true;
};

const GRAPH = JSON.stringify({
  schema_version: 1,
  data: {
    project_id: "es-smoke",
    turn: 1,
    counters: { Level: 1 },
    nodes: [
      {
        id: "level_001",
        _type: "Level",
        created_at_turn: 1,
        modified_at_turn: [],
        deleted_at_turn: null,
        name: "N00",
        elevation: 0,
      },
    ],
    edges: [],
  },
  revit_binding: {},
});
const LOG_CHUNKS = [JSON.stringify([JSON.stringify({ turn: 1, action: "create", target: "level_001", details: {} })])];

async function main() {
  console.log(`[kg-es-smoke] -> ${HOST}:${PORT}\n`);

  // 1. kg_doc_state : sans Tx, déclenche EnsureSubscribed (§5).
  const s0 = unwrap(await rpc("kg_doc_state", { since_epoch: 0 }), "kg_doc_state");
  const epoch0 = s0.epoch;
  check(typeof epoch0 === "number", `kg_doc_state -> epoch=${epoch0}, doc_key=${JSON.stringify(s0.doc_key)}`);

  // 2. kg_blob_read sur un projet vierge : DataStorage absente.
  const r0 = unwrap(await rpc("kg_blob_read", {}), "kg_blob_read");
  check(r0 && typeof r0.exists === "boolean", `kg_blob_read -> exists=${r0?.exists} (false attendu sur projet neuf)`);

  // 3. kg_blob_write : crée la DataStorage dans une Transaction (étape 3).
  const w = unwrap(
    await rpc("kg_blob_write", { graph: GRAPH, log_chunks: LOG_CHUNKS, log_schema_version: 1 }),
    "kg_blob_write"
  );
  check(w && w.wrote === true, `kg_blob_write -> wrote=${w?.wrote}, created_data_storage=${w?.created_data_storage}`);

  // 4. kg_blob_read : round-trip exact du blob.
  const r1 = unwrap(await rpc("kg_blob_read", {}), "kg_blob_read");
  check(r1.exists === true, "kg_blob_read -> exists=true après write");
  check(r1.graph === GRAPH, "graph round-trip (octet-pour-octet)");
  check(JSON.stringify(r1.log_chunks) === JSON.stringify(LOG_CHUNKS), "log_chunks round-trip");
  check(r1.log_schema_version === 1, "log_schema_version round-trip");

  // 5. kg_doc_state : NOTRE écriture (Tx "KG blob write") NE bumpe PAS
  //    l'epoch (filtre §5) — sinon le cache serveur rechargerait à chaque op.
  const s1 = unwrap(await rpc("kg_doc_state", { since_epoch: 0 }), "kg_doc_state");
  check(s1.epoch === epoch0, `epoch inchangé après notre write (${epoch0} -> ${s1.epoch}) — filtre §5 OK`);

  console.log(`\n[kg-es-smoke] ${failed ? "ÉCHEC — voir FAIL ci-dessus" : "TOUT VERT ✅"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n[kg-es-smoke] ERREUR: ${e.message}`);
  console.error("Vérifier : Revit ouvert + projet actif + bouton Switch cliqué + port.");
  process.exit(2);
});
