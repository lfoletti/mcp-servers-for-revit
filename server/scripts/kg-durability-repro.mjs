/**
 * kg-durability-repro.mjs — LE TEST FONDATEUR : le KG interne v1 persiste-t-il
 * DURABLEMENT, ou la mémoire devance-t-elle l'ES (faux positif de vérif) ?
 * SANS Claude, SANS harness — on isole le mécanisme KG, pas l'agent.
 *
 * Pilote le VRAI `KgService` (aucun arg ⇒ SocketKgBlobTransport +
 * SocketKgDocStateProvider, cap socket 120 s, cache §5, BlobKgPersistence)
 * pour seeder le Demo complet PAR PALIERS. Après CHAQUE palier, 3 lectures :
 *   1. cache du process écrivain   (svcW.query)      ← peut MENTIR
 *   2. instance KgService NEUVE    (svcF.query)      ← recharge depuis l'ES
 *   3. kg_blob_read BRUT (socket)  (hors KgService)  ← VÉRITÉ ES absolue
 * Si (1) ≠ (3) à un palier ⇒ bug « mémoire devant ES » prouvé à froid,
 * localisé au palier/volume exact. Mirroir final : le seed 28-éléments en
 * UN SEUL write atomique (l'appel exact qui timeoutait pour l'agent).
 *
 * Prérequis : Revit ouvert sur un projet **vierge/bench**, Switch ON,
 * serveur TS buildé (npm run build). Node de l'env conda `revitmcp`.
 *
 *   node server/scripts/kg-durability-repro.mjs            # :8080
 *   node server/scripts/kg-durability-repro.mjs --force     # écraser un KG tiers
 *   node server/scripts/kg-durability-repro.mjs --no-restore
 *
 * AVERTISSEMENT : écrit dans la DataStorage ES unique du .rvt actif
 * (project_id="Demo-repro"). Garde-fou : lit d'abord, refuse un autre
 * project_id sauf --force ; snapshot + restore best-effort en fin (sauf
 * --no-restore). À lancer sur le .rvt de bench.
 */
import net from "node:net";

const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a)) || 8080);
const HOST = "127.0.0.1";
const FORCE = ARGS.includes("--force");
const RESTORE = !ARGS.includes("--no-restore");
const PID = "Demo-repro";

// ---- lecture ES brute (hors KgService — vérité absolue) ------------------
function rawRpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let buf = "";
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout ${method}`));
    }, 130000);
    sock.on("connect", () =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: "r" }))
    );
    sock.on("data", (d) => {
      buf += d.toString();
      try {
        const m = JSON.parse(buf);
        clearTimeout(to);
        sock.end();
        m.error ? reject(new Error(m.error.message || "Revit error")) : resolve(m.result);
      } catch {
        /* trame incomplète */
      }
    });
    sock.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}
function unwrap(res, op) {
  if (res == null || typeof res !== "object") throw new Error(`${op}: vide`);
  const ok = res.Success ?? res.success;
  if (ok === false) throw new Error(res.Message ?? res.message ?? `${op} échec`);
  return res.Response ?? res.response;
}
// Compte (nœuds vivants, arêtes) directement dans le blob ES.
async function esTruth() {
  const p = unwrap(await rawRpc("kg_blob_read", {}), "kg_blob_read");
  if (!p || !p.exists) return { exists: false, n: 0, e: 0, pid: null };
  let g;
  try {
    g = JSON.parse(p.graph || "{}");
  } catch {
    return { exists: true, n: -1, e: -1, pid: "?(graph illisible)" };
  }
  const d = g.data && g.data.nodes ? g.data : g;
  const n = (d.nodes || []).filter((x) => x && x.deleted_at_turn == null).length;
  return { exists: true, n, e: (d.edges || []).length, pid: d.project_id ?? null };
}

// ---- specs du seed Demo (schéma vérifié ; arêtes À LA CRÉATION) ----------
const pad = (i) => String(i).padStart(2, "0");
const foundation = [
  { node_type: "Level", llm_id: "N0", attrs: { name: "N0", elevation: 0 } },
  { node_type: "Level", llm_id: "N1", attrs: { name: "N1", elevation: 3 } },
  { node_type: "WallType", llm_id: "GEN_200", attrs: { name: "GEN_200", total_thickness: 0.2 } },
  {
    node_type: "FamilyType",
    llm_id: "WIN_0610",
    attrs: { family_name: "Window", type_name: "WIN_0610", category: "Windows" },
  },
];
const wall = (i) => ({
  node_type: "Wall",
  llm_id: `wall_${pad(i)}`,
  attrs: {
    height: 2.7,
    length: 1,
    level_ref: "N0",
    type_ref: "GEN_200",
    p1: [i - 1, 0, 0],
    p2: [i, 0, 0],
  },
  edges: [
    { type: "at_level", to: "N0" },
    { type: "is_type", to: "GEN_200" },
  ],
});
const win = (i) => ({
  node_type: "Window",
  llm_id: `window_${pad(i)}`,
  attrs: {
    head_height: 2.1,
    sill_height: 0.9,
    host_wall_ref: `wall_${pad(i)}`,
    type_ref: "WIN_0610",
    position: [i - 0.5, 0, 0],
  },
  edges: [
    { type: "is_type", to: "WIN_0610" },
    { type: "hosts", from: `wall_${pad(i)}` },
  ],
});
const walls = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => wall(a + k));
const wins = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => win(a + k));

// Paliers cumulatifs : [label, elements de CE palier, n attendu, e attendu]
const STAGES = [
  ["fondation (4)", foundation, 4, 0],
  ["+1 mur", [wall(1)], 5, 2],
  ["+5 murs (2-6)", walls(2, 6), 10, 12],
  ["+14 murs (7-20)", walls(7, 20), 24, 40],
  ["+8 fenêtres", wins(1, 8), 32, 56],
];

const f = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`);

async function main() {
  console.log(`[kg-durability-repro] -> ${HOST}:${PORT}  project_id=${PID}\n`);

  // garde-fou + snapshot
  const orig = await esTruth();
  if (orig.exists) {
    console.log(`[garde] blob existant: project_id=${JSON.stringify(orig.pid)} (${orig.n} nœuds)`);
    if (orig.pid && orig.pid !== PID && !FORCE) {
      console.error(
        `\n[ABANDON] KG tiers (${JSON.stringify(orig.pid)}). --force pour écraser, ` +
          `ou relancer sur un .rvt vierge/bench.`
      );
      process.exit(3);
    }
  } else console.log(`[garde] aucun blob (projet vierge) — idéal.`);
  let snapshot = null;
  if (orig.exists && RESTORE) {
    const p = unwrap(await rawRpc("kg_blob_read", {}), "kg_blob_read");
    snapshot = { graph: p.graph, log_chunks: p.log_chunks, log_schema_version: p.log_schema_version };
  }

  const { KgService } = await import(new URL("../build/kg/service.js", import.meta.url));
  const svcW = new KgService(); // process écrivain (cache potentiellement menteur)

  console.log(
    "\n palier".padEnd(22) +
      "write".padEnd(10) +
      "err".padEnd(7) +
      "cacheW".padEnd(10) +
      "instF".padEnd(10) +
      "ES brut".padEnd(12) +
      "verdict"
  );
  console.log("─".repeat(82));

  let firstDivergenceAt = null;
  let cacheEverLied = false; // Fix A : cache écrivain != ES (≠ « write perdu »)
  let anyTimeout = false;
  let lastTruth = orig;

  for (const [label, els, expN, expE] of STAGES) {
    let wms = 0,
      err = "";
    const t0 = process.hrtime.bigint();
    try {
      await svcW.call("add_element", { project_id: PID, elements: els });
      wms = Number(process.hrtime.bigint() - t0) / 1e6;
    } catch (e) {
      wms = Number(process.hrtime.bigint() - t0) / 1e6;
      err = String(e.message || e);
      if (err.includes("timed out after 2 minutes")) {
        anyTimeout = true;
        err = "TIMEOUT120";
      } else err = "ERR";
    }

    // 1. cache du process écrivain (peut mentir)
    let cW = "?";
    try {
      const q = await svcW.call("query", { project_id: PID, compact: true });
      cW = `${q.count}/${q.edges_count}`;
    } catch {
      cW = "qfail";
    }
    // 2. instance NEUVE ⇒ recharge depuis l'ES
    let iF = "?";
    try {
      const svcF = new KgService();
      const q = await svcF.call("query", { project_id: PID, compact: true });
      iF = `${q.count}/${q.edges_count}`;
    } catch {
      iF = "qfail";
    }
    // 3. ES BRUT (vérité absolue, hors KgService)
    const t = await esTruth();
    lastTruth = t;
    const esStr = `${t.n}/${t.e}`;

    const esOK = t.n === expN && t.e === expE;
    const cacheLies = cW !== esStr; // le cache écrivain diffère de l'ES réel
    let v;
    if (esOK && !cacheLies) v = "✅ durable";
    else if (cacheLies) {
      v = `🔴 CACHE MENT (attendu ES ${expN}/${expE})`;
      cacheEverLied = true;
      if (firstDivergenceAt === null) firstDivergenceAt = label;
    } else {
      v = `🟠 ES=${esStr}≠attendu ${expN}/${expE}`;
      if (firstDivergenceAt === null) firstDivergenceAt = label;
    }
    console.log(
      ` ${label}`.padEnd(22) +
        f(wms).padEnd(10) +
        (err || "-").padEnd(7) +
        cW.padEnd(10) +
        iF.padEnd(10) +
        esStr.padEnd(12) +
        v
    );
  }

  // Miroir : le SEED 28-éléments en UN write atomique (l'appel exact de
  // l'agent qui timeoutait), dans un project_id propre.
  console.log("\n── Miroir : seed 28-éléments en UN write atomique ──");
  const PID2 = "Demo-repro-oneshot";
  const oneShot = [...foundation, ...walls(1, 20), ...wins(1, 8)];
  const svcO = new KgService();
  let oErr = "",
    oms = 0;
  const o0 = process.hrtime.bigint();
  try {
    await svcO.call("add_element", { project_id: PID2, elements: oneShot });
    oms = Number(process.hrtime.bigint() - o0) / 1e6;
  } catch (e) {
    oms = Number(process.hrtime.bigint() - o0) / 1e6;
    oErr = String(e.message || e).includes("timed out after 2 minutes") ? "TIMEOUT120" : "ERR";
    if (oErr === "TIMEOUT120") anyTimeout = true;
  }
  let oCache = "?";
  try {
    const q = await svcO.call("query", { project_id: PID2, compact: true });
    oCache = `${q.count}/${q.edges_count}`;
  } catch {
    oCache = "qfail";
  }
  // ES brut pour PID2
  const pp = unwrap(await rawRpc("kg_blob_read", {}), "kg_blob_read");
  let oEs = "0/0";
  try {
    const g = JSON.parse(pp.graph || "{}");
    const d = g.data && g.data.nodes ? g.data : g;
    if ((d.project_id ?? null) === PID2)
      oEs = `${(d.nodes || []).filter((x) => x && x.deleted_at_turn == null).length}/${(d.edges || []).length}`;
    else oEs = `(blob pid=${d.project_id})`;
  } catch {
    oEs = "?";
  }
  console.log(
    ` write=${f(oms)}  err=${oErr || "-"}  cacheW=${oCache}  ES brut=${oEs}  (attendu 32/56)`
  );

  // restore best-effort
  if (snapshot && RESTORE) {
    try {
      unwrap(
        await rawRpc("kg_blob_write", {
          graph: snapshot.graph,
          log_chunks: snapshot.log_chunks,
          log_schema_version: snapshot.log_schema_version ?? 1,
        }),
        "kg_blob_write"
      );
      console.log(`\n[restore] blob d'origine (pid=${JSON.stringify(orig.pid)}) réécrit.`);
    } catch (e) {
      console.error(`\n[restore] ÉCHEC — blob laissé en état repro : ${e.message}`);
    }
  }

  // ---- VERDICT ----------------------------------------------------------
  console.log(`\n══════════ VERDICT — le mécanisme KG interne ══════════`);
  const finalDurable = lastTruth.n === 32 && lastTruth.e === 56;
  if (finalDurable && firstDivergenceAt === null) {
    console.log(
      `✅ MÉCANISME SAIN (régime quiescent). Chaque palier : ES == cache,\n` +
        `   seed final DURABLE en ES (32/56)${anyTimeout ? " MALGRÉ un timeout" : ", sans timeout"}.\n` +
        `   → le KG interne persiste vraiment. Cause racine corrigée =\n` +
        `   réassemblage socket entrant C# (Fix B, SocketService.cs :\n` +
        `   accumule jusqu'à JSON complet) ; le cache reste honnête sur\n` +
        `   échec persist (Fix A, service.ts persistOrEvict). Le défaut\n` +
        `   n'était NI la contention NI l'agent : un write multi-segments\n` +
        `   que le C# ne réassemblait pas. Bench A/B redevient viable.`
    );
  } else if (cacheEverLied) {
    console.log(
      `🔴 CACHE MENT — DÉFAUT « mémoire devant ES » REPRODUIT À FROID.\n` +
        `   Première divergence : « ${firstDivergenceAt} ».\n` +
        `   Le cache du process écrivain affiche des nœuds que l'ES brut\n` +
        `   N'A PAS : la vérif in-process ment. Fix A absent/inopérant —\n` +
        `   à corriger AVANT tout benchmark. ${anyTimeout ? "Un write a timeouté à 120 s." : ""}`
    );
  } else if (firstDivergenceAt) {
    console.log(
      `🟠 WRITE PERDU mais CACHE HONNÊTE (Fix A OK).\n` +
        `   Première divergence : « ${firstDivergenceAt} ».\n` +
        `   cache écrivain == instance neuve == ES brut à chaque palier :\n` +
        `   le cache NE MENT PLUS (Fix A persistOrEvict opérant). Mais\n` +
        `   le write y est PERDU (ES non avancé)${anyTimeout ? " — timeout 120 s" : ""} : la\n` +
        `   CAUSE RACINE (réassemblage socket entrant C#, Fix B) reste à\n` +
        `   corriger ; le bench ne peut pas passer tant que Fix B manque.`
    );
  } else {
    console.log(
      `🟠 INDÉTERMINÉ : ES final = ${lastTruth.n}/${lastTruth.e} (attendu 32/56),\n` +
        `   sans divergence cache↔ES détectée. Voir le tableau ci-dessus.`
    );
  }
  console.log(`\n[kg-durability-repro] terminé.`);
}

main().catch((e) => {
  console.error(`\n[kg-durability-repro] ERREUR FATALE: ${e.message}`);
  console.error("Vérifier : Revit + Switch + .rvt bench + serveur buildé (npm run build).");
  process.exit(2);
});
