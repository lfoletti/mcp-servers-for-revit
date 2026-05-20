/**
 * kg-es-probe.mjs — PROFIL DE LATENCE PAR-OP du C# ExtensibleStorage v1,
 * EN DIRECT sur le socket Revit, SANS Claude, SANS le harness, SANS le
 * serveur TS. But : élucider le « DÉFAUT PERF v1 » du JOURNAL (s1 = 1 edit
 * trivial → 597 s / 20 turns) en isolant **latence-infra** vs
 * **amplification boucle-agent**.
 *
 * Pourquoi ces 3 ops : en v1 chaque op KG paie jusqu'à 3 a/r socket
 * sérialisés (cf. `service.ts::getKg` + `transport.ts`) —
 *   1. `kg_doc_state`  : poll §5, sur CHAQUE getKg (lecture ET mutation),
 *   2. `kg_blob_read`  : si cache froid / epoch changé,
 *   3. `kg_blob_write` : chaque mutation = 1 Transaction Revit, blob ENTIER
 *                        re-sérialisé (`saveSnapshot`, suspect O(graphe)).
 * Chaque a/r = une socket neuve via `withRevitConnection` (mutex global),
 * un `ExternalEvent` traité à l'idle Revit. Ce probe chronomètre ces a/r
 * isolément, exactement comme la prod (1 requête JSON-RPC par connexion,
 * séquentiel — cf. `SocketClient.ts`/`withRevitConnection`).
 *
 * Décision (règle du JOURNAL) :
 *   infra ≈ 0,5 s/op  → racine = boucle-agent / poll §5 (pas l'infra).
 *   infra ≈ 10-30 s/op → racine = ExternalEvent / socket / saveSnapshot.
 *
 * Prérequis : Revit ouvert sur un projet **scratch/bench** (PAS le .rvt
 * « Demo » de prod — voir AVERTISSEMENT plus bas), add-in chargé, bouton
 * **Switch** cliqué (socket up). Zéro dépendance — `node:net` seul.
 * `node` n'est PAS sur le PATH système : lancer via le node de l'env conda
 * `revitmcp` (cf. mémoire kg-v1-effort).
 *
 *   node server/scripts/kg-es-probe.mjs                  # :8080, défauts
 *   node server/scripts/kg-es-probe.mjs 8080 --n=8
 *   node server/scripts/kg-es-probe.mjs --sizes=1,32,200,1000
 *   node server/scripts/kg-es-probe.mjs --no-restore     # ne pas restaurer
 *   node server/scripts/kg-es-probe.mjs --force          # écraser un KG tiers
 *
 * AVERTISSEMENT — ÉCRITURE : la DataStorage ES est UNIQUE & GLOBALE par
 * document. Ce probe écrit des blobs « es-probe » dans le .rvt actif. Il
 * lit d'abord le blob existant ; s'il en trouve un d'un AUTRE project_id
 * il REFUSE (sauf --force) ; sinon il le SNAPSHOT et le RESTAURE en fin de
 * run (sauf --no-restore). Best-effort : à lancer sur le .rvt de bench.
 */
import net from "node:net";

// ---- args ----------------------------------------------------------------
const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a)) || 8080);
const HOST = "127.0.0.1";
const opt = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
};
const has = (k) => ARGS.includes(`--${k}`);
const N = Math.max(1, Number(opt("n", 6))); // itérations / op isolée
const SWEEP_M = Math.max(1, Number(opt("m", 3))); // itérations / taille
const SIZES = String(opt("sizes", "1,32,200,1000"))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const TRIPLETS = Math.max(1, Number(opt("triplets", 5)));
const RPC_TIMEOUT = Math.max(1000, Number(opt("rpc-timeout", 120000))); // ms
const RESTORE = !has("no-restore");
const FORCE = has("force");
const PROBE_PID = "es-probe";

let _id = 1;

/**
 * Un a/r JSON-RPC = une connexion (comme `withRevitConnection`). Le
 * chrono démarre AVANT le connect (la socket neuve fait partie du coût
 * infra payé par chaque op v1) et s'arrête à la réponse parsée.
 */
function rpcTimed(method, params = {}) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect(PORT, HOST);
    let buf = "";
    const req = { jsonrpc: "2.0", method, params, id: String(_id++) };
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout (${RPC_TIMEOUT} ms) on ${method}`));
    }, RPC_TIMEOUT);
    sock.on("connect", () => sock.write(JSON.stringify(req)));
    sock.on("data", (d) => {
      buf += d.toString();
      try {
        const msg = JSON.parse(buf); // parse-quand-complet (cf. SocketClient)
        clearTimeout(to);
        sock.end();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (msg.error) reject(new Error(msg.error.message || "Revit error"));
        else resolve({ result: msg.result, ms });
      } catch {
        /* trame incomplète : attendre */
      }
    });
    sock.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}

// AIResult<T> : casing wrapper non garantie (JToken.FromObject). Champs
// internes figés snake_case par [JsonProperty]. Cf. transport.ts.
function unwrap(res, op) {
  if (res == null || typeof res !== "object")
    throw new Error(`${op}: réponse vide`);
  const success = res.Success ?? res.success;
  const message = res.Message ?? res.message;
  const response = res.Response ?? res.response;
  if (success === false) throw new Error(message || `${op} échec (Revit)`);
  return response;
}

// ---- stats ---------------------------------------------------------------
function stats(samples) {
  const xs = [...samples].sort((a, b) => a - b);
  const n = xs.length;
  const q = (p) => xs[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  return { n, min: xs[0], p50: q(0.5), mean, p90: q(0.9), max: xs[n - 1] };
}
const f = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
function row(label, st, extra = "") {
  console.log(
    `  ${label.padEnd(26)} n=${st.n}  min ${f(st.min).padStart(8)}  ` +
      `p50 ${f(st.p50).padStart(8)}  mean ${f(st.mean).padStart(8)}  ` +
      `p90 ${f(st.p90).padStart(8)}  max ${f(st.max).padStart(8)}${extra}`
  );
}

// ---- payload synthétique -------------------------------------------------
// Graphe « es-probe » de ~k noeuds Level (le `graph` est la part qui
// grossit avec le projet ; le log reste petit & constant pour isoler
// l'effet taille-graphe sur l'écriture — suspect saveSnapshot O(graphe)).
function makeGraph(k) {
  const nodes = [];
  for (let i = 0; i < k; i++) {
    nodes.push({
      id: `lvl_${String(i).padStart(4, "0")}`,
      _type: "Level",
      created_at_turn: 1,
      modified_at_turn: [],
      deleted_at_turn: null,
      name: `N${i}`,
      elevation: i * 3,
    });
  }
  return JSON.stringify({
    schema_version: 1,
    data: { project_id: PROBE_PID, turn: 1, counters: { Level: k }, nodes, edges: [] },
    revit_binding: {},
  });
}
const SMALL_LOG = [
  JSON.stringify([JSON.stringify({ turn: 1, action: "create", target: "lvl_0000", details: {} })]),
];
const bytesOf = (graph) =>
  Buffer.byteLength(graph, "utf8") + Buffer.byteLength(JSON.stringify(SMALL_LOG), "utf8");

async function writeBlob(graph) {
  const { result, ms } = await rpcTimed("kg_blob_write", {
    graph,
    log_chunks: SMALL_LOG,
    log_schema_version: 1,
  });
  unwrap(result, "kg_blob_write");
  return ms;
}
async function readBlob() {
  const { result, ms } = await rpcTimed("kg_blob_read", {});
  return { p: unwrap(result, "kg_blob_read"), ms };
}
async function docState() {
  const { result, ms } = await rpcTimed("kg_doc_state", { since_epoch: 0 });
  return { p: unwrap(result, "kg_doc_state"), ms };
}

function projectIdOf(graphStr) {
  try {
    return JSON.parse(graphStr)?.data?.project_id ?? null;
  } catch {
    return null;
  }
}

// ---- main ----------------------------------------------------------------
async function main() {
  console.log(`[kg-es-probe] -> ${HOST}:${PORT}`);
  console.log(
    `[kg-es-probe] N=${N} sweep_m=${SWEEP_M} sizes=[${SIZES}] triplets=${TRIPLETS} ` +
      `restore=${RESTORE} force=${FORCE}\n`
  );

  // 0. Garde-fou non-destructif : snapshot du blob existant.
  let original = null;
  {
    const { p } = await readBlob();
    if (p && p.exists) {
      const pid = projectIdOf(p.graph || "");
      original = { graph: p.graph, log_chunks: p.log_chunks, log_schema_version: p.log_schema_version, pid };
      console.log(`[garde] blob existant: project_id=${JSON.stringify(pid)}, graph=${Buffer.byteLength(p.graph || "", "utf8")} o`);
      if (pid && pid !== PROBE_PID && !FORCE) {
        console.error(
          `\n[ABANDON] le .rvt actif porte un KG tiers (project_id=${JSON.stringify(pid)}).\n` +
            `Ce probe ÉCRIT dans la DataStorage ES unique/globale et l'écraserait.\n` +
            `Relancer sur le .rvt de bench, ou --force (restore best-effort) si jetable.`
        );
        process.exit(3);
      }
    } else {
      console.log(`[garde] aucun blob existant (projet vierge).`);
    }
  }

  // 1. doc_state isolé — coût du poll §5 payé par CHAQUE op (lecture ET
  //    mutation), même si rien n'a changé. Suspect #1.
  console.log(`\n── 1. kg_doc_state (poll §5, sur chaque getKg) ───────────────`);
  const ds = [];
  for (let i = 0; i < N; i++) ds.push((await docState()).ms);
  const dsSt = stats(ds);
  row("kg_doc_state", dsSt);

  // 2. blob_read isolé — coût du reload sur cache froid / epoch changé.
  //    On garantit un blob (write d'amorce) puis on lit N fois.
  console.log(`\n── 2. kg_blob_read (reload cache froid) ──────────────────────`);
  await writeBlob(makeGraph(1));
  const rd = [];
  for (let i = 0; i < N; i++) rd.push((await readBlob()).ms);
  row("kg_blob_read (1 noeud)", stats(rd));

  // 3. blob_write isolé — chaque mutation = 1 Transaction Revit, blob
  //    ENTIER re-sérialisé. Suspect ExternalEvent/Tx.
  console.log(`\n── 3. kg_blob_write (1 Tx Revit / mutation) ──────────────────`);
  const wr = [];
  for (let i = 0; i < N; i++) wr.push(await writeBlob(makeGraph(1)));
  const wrSt = stats(wr);
  row("kg_blob_write (1 noeud)", wrSt);

  // 4. Balayage de taille — teste suspect #2 : `saveSnapshot` réécrit le
  //    blob ENTIER à chaque mutation → write O(graphe) ? read O(graphe) ?
  //    NB : le serveur socket C# ne réassemble PAS une requête entrante
  //    multi-segment (un seul `socket.write` non-framé, cf. SocketClient.ts)
  //    → au-delà de ~quelques KiB, kg_blob_write peut échouer côté Revit
  //    avec « Invalid JSON ». On l'attrape : plafond de payload = finding
  //    secondaire (échelle projet / Stage 2), PAS la latence. On garde le
  //    profil partiel et on imprime quand même le verdict.
  console.log(`\n── 4. Balayage taille-graphe (write & read vs #noeuds) ───────`);
  const sweep = [];
  let ceilingHitAt = null;
  for (const k of SIZES) {
    const g = makeGraph(k);
    try {
      const wS = [];
      for (let i = 0; i < SWEEP_M; i++) wS.push(await writeBlob(g));
      const rS = [];
      for (let i = 0; i < SWEEP_M; i++) rS.push((await readBlob()).ms);
      const w = stats(wS);
      const r = stats(rS);
      sweep.push({ k, bytes: bytesOf(g), w, r });
      row(`write k=${k}`, w, `   (${(bytesOf(g) / 1024).toFixed(1)} KiB)`);
      row(`read  k=${k}`, r);
    } catch (e) {
      ceilingHitAt = { k, bytes: bytesOf(g), msg: e.message };
      console.log(
        `  write k=${k}  ÉCHEC @ ${(bytesOf(g) / 1024).toFixed(1)} KiB : ${e.message}\n` +
          `  → PLAFOND requête entrante socket C# (finding secondaire, pas la latence).`
      );
      break;
    }
  }

  // 5. Triplet réaliste — le chemin EXACT d'une mutation v1 à froid :
  //    doc_state → blob_read → blob_write enchaînés. Somme = ce qu'un
  //    tour d'edit paie réellement en infra. k=32 = sous le plafond.
  console.log(`\n── 5. Triplet mutation v1 (doc_state → read → write) ─────────`);
  let tSt = null;
  try {
    const trip = [];
    for (let i = 0; i < TRIPLETS; i++) {
      const a = (await docState()).ms;
      const b = (await readBlob()).ms;
      const c = await writeBlob(makeGraph(32)); // ~ taille bench « Demo »
      trip.push(a + b + c);
    }
    tSt = stats(trip);
    row("triplet (a/r×3, k=32)", tSt);
  } catch (e) {
    console.log(`  triplet ÉCHEC : ${e.message} (verdict calculé sans le triplet).`);
  }

  // 6. Restauration non-destructive.
  if (RESTORE && original) {
    try {
      const { result } = await rpcTimed("kg_blob_write", {
        graph: original.graph,
        log_chunks: original.log_chunks,
        log_schema_version: original.log_schema_version ?? 1,
      });
      unwrap(result, "kg_blob_write");
      console.log(`\n[restore] blob d'origine (project_id=${JSON.stringify(original.pid)}) réécrit.`);
    } catch (e) {
      console.error(`\n[restore] ÉCHEC — blob laissé en état « es-probe » : ${e.message}`);
    }
  } else if (!original) {
    console.log(`\n[restore] rien à restaurer (projet vierge au départ) — blob « es-probe » laissé.`);
  } else {
    console.log(`\n[restore] désactivé (--no-restore) — blob « es-probe » laissé.`);
  }

  // ---- verdict (règle du JOURNAL) ----------------------------------------
  console.log(`\n══════════ LECTURE DU PROFIL ══════════`);
  const perOp = (dsSt.p50 + wrSt.p50) / 2; // ordre de grandeur d'un a/r
  // Pas de triplet mesuré ⇒ borne basse = somme des a/r isolés (p50).
  const tripP50 = tSt ? tSt.p50 : dsSt.p50 + stats(rd).p50 + wrSt.p50;
  console.log(`• a/r isolé (p50) : doc_state ${f(dsSt.p50)} | read ${f(rd.length ? stats(rd).p50 : 0)} | write ${f(wrSt.p50)}`);
  console.log(
    `• triplet mutation v1 (p50) : ${f(tripP50)}  ← coût infra d'UN tour d'edit` +
      (tSt ? "" : "  (estimé = Σ a/r isolés ; triplet non mesuré)")
  );
  if (ceilingHitAt) {
    console.log(
      `• PLAFOND payload write : échec @ k=${ceilingHitAt.k} / ` +
        `${(ceilingHitAt.bytes / 1024).toFixed(1)} KiB (« ${ceilingHitAt.msg} ») — ` +
        `réassemblage requête entrante socket C# absent. Finding secondaire ` +
        `(échelle projet/Stage 2), hors latence ; sans effet sur le bench 32 noeuds.`
    );
  }
  const sw0 = sweep[0];
  const swN = sweep[sweep.length - 1];
  if (sweep.length >= 2) {
    const grow = swN.w.p50 / Math.max(1, sw0.w.p50);
    console.log(
      `• write k=${sw0.k} → k=${swN.k} : ${f(sw0.w.p50)} → ${f(swN.w.p50)} ` +
        `(×${grow.toFixed(1)}) → saveSnapshot ${grow > 2 ? "CROÎT avec le graphe (O(n))" : "≈ plat (pas O(n) dominant)"}`
    );
  }
  console.log(`\nRègle de décision :`);
  if (perOp < 1500) {
    console.log(
      `→ infra ≈ ${f(perOp)}/op (< ~1,5 s). L'infra N'EST PAS la racine.\n` +
        `  La racine est l'AMPLIFICATION boucle-agent (re-query complet par\n` +
        `  tour, poll §5 ×3/op) ×20 tours. Cible : prompts/steering & poll §5.`
    );
  } else if (perOp >= 1500 && perOp < 8000) {
    console.log(
      `→ infra ≈ ${f(perOp)}/op (zone grise). Mixte : un triplet à ${f(tripP50)}\n` +
        `  × ~20 tours d'agent ≈ ${f(tripP50 * 20)} → explique l'essentiel des\n` +
        `  597 s. Réduire les a/r/op (cache, batcher) ET la longueur de boucle.`
    );
  } else {
    console.log(
      `→ infra ≈ ${f(perOp)}/op (≥ ~8 s). L'INFRA EST la racine :\n` +
        `  ExternalEvent/socket/saveSnapshot. ${f(tripP50)}/tour × ~20 tours\n` +
        `  ≈ ${f(tripP50 * 20)} ≈ les 597 s observés. Cible : nb d'a/r & Tx.`
    );
  }
  console.log(
    `\nRappel observé (JOURNAL) : 10_s1 = 1 edit → 597 s / 20 turns.\n` +
      `Borne basse infra de ce profil : ${f(tripP50)} × 20 ≈ ${f(tripP50 * 20)}.`
  );
  console.log(`\n[kg-es-probe] terminé.`);
}

main().catch((e) => {
  console.error(`\n[kg-es-probe] ERREUR: ${e.message}`);
  console.error("Vérifier : Revit ouvert + projet actif + bouton Switch cliqué + port.");
  process.exit(2);
});
