/**
 * kg-svc-probe.mjs — PROFIL DU VRAI CHEMIN TS de production, SANS Claude,
 * SANS le harness, SANS le serveur MCP. Complément de `kg-es-probe.mjs` :
 * celui-ci sondait le socket Revit BRUT (couche C# isolée, ~tens of ms) ;
 * ICI on instancie le **vrai `KgService`** (aucun arg ⇒ `SocketKgBlobTransport`
 * + `SocketKgDocStateProvider` via `withRevitConnection`/`RevitClientConnection`,
 * mutex global, cache §5, queue sérialisée, `BlobKgPersistence` read-modify-
 * write) et on rejoue la **séquence S1** (modify 1 attr → diff_since →
 * query) en boucle, en chronométrant chaque `service.call(...)`.
 *
 * But unique : clore la question laissée ouverte par le profil offline —
 * la mémoire documente un `kg_modify_element` → « Command timed out after
 * 2 minutes » qui *commit quand même* en session live. Le 1ᵉʳ probe (socket
 * brut, Revit quiescent) ne pouvait PAS l'attraper (il bypassait tout le
 * TS). Si ICI tout reste en dizaines de ms ⇒ le chemin TS est sain, les
 * stalls 120 s étaient un artefact Revit-non-quiescent de la session live
 * (→ run 2 facturable sûr avec les fixes prompts). Si une call spike / 120 s
 * ⇒ défaut TS reproduit hors-ligne, à corriger AVANT tout run facturable.
 *
 * Prérequis : Revit ouvert sur le .rvt de bench (Demo déjà flushée par
 * kg-es-probe), add-in chargé, **Switch** cliqué, serveur TS **buildé**
 * (`npm run build`). Lancer via le node de l'env conda `revitmcp`.
 *
 *   node server/scripts/kg-svc-probe.mjs                 # :8080, N=8
 *   node server/scripts/kg-svc-probe.mjs --n=12
 *   node server/scripts/kg-svc-probe.mjs --force         # flush un KG tiers
 *
 * AVERTISSEMENT : écrit des blobs « es-probe » dans la DataStorage ES
 * unique/globale du .rvt actif (même cible que kg-es-probe). Garde-fou :
 * lit d'abord ; refuse un project_id tiers sauf `--force` (qui flush vers
 * un seed « es-probe » minimal avant de profiler).
 */
import net from "node:net";

const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a)) || 8080);
const HOST = "127.0.0.1";
const optN = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? Number(a.split("=")[1]) : d;
};
const N = Math.max(1, optN("n", 8));
const SLOW_MS = Math.max(1000, optN("slow-ms", 5000));
const FORCE = ARGS.includes("--force");
const PID = "es-probe";
const STALL_FINGERPRINT = "timed out after 2 minutes"; // SocketClient.ts:139

// ---- garde-fou : lecture socket brute (comme kg-es-probe) ----------------
function rawRpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let buf = "";
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout on ${method}`));
    }, 30000);
    sock.on("connect", () =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: "g1" }))
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
  const success = res.Success ?? res.success;
  if (success === false) throw new Error(res.Message ?? res.message ?? `${op} échec`);
  return res.Response ?? res.response;
}
const pidOf = (g) => {
  try {
    return JSON.parse(g || "")?.data?.project_id ?? null;
  } catch {
    return null;
  }
};

// ---- stats ---------------------------------------------------------------
function stat(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return {
    n: s.length,
    min: s[0],
    p50: q(0.5),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p90: q(0.9),
    max: s[s.length - 1],
  };
}
const f = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
function row(label, st) {
  if (!st) return console.log(`  ${label.padEnd(22)} (aucune mesure)`);
  console.log(
    `  ${label.padEnd(22)} n=${st.n}  min ${f(st.min).padStart(8)}  ` +
      `p50 ${f(st.p50).padStart(8)}  mean ${f(st.mean).padStart(8)}  ` +
      `p90 ${f(st.p90).padStart(8)}  max ${f(st.max).padStart(8)}`
  );
}

async function main() {
  console.log(`[kg-svc-probe] -> ${HOST}:${PORT}  N=${N}  force=${FORCE}\n`);

  // 1. Garde-fou non-destructif.
  const r0 = unwrap(await rawRpc("kg_blob_read", {}), "kg_blob_read");
  if (r0 && r0.exists) {
    const pid = pidOf(r0.graph);
    console.log(`[garde] blob existant: project_id=${JSON.stringify(pid)}`);
    if (pid && pid !== PID && !FORCE) {
      console.error(
        `\n[ABANDON] KG tiers (project_id=${JSON.stringify(pid)}) dans le ` +
          `.rvt actif. --force pour flush vers un seed « es-probe », ou ` +
          `relancer sur le .rvt de bench.`
      );
      process.exit(3);
    }
    if (pid && pid !== PID && FORCE) {
      const seed = JSON.stringify({
        schema_version: 1,
        data: { project_id: PID, turn: 0, counters: {}, nodes: [], edges: [] },
        revit_binding: {},
      });
      unwrap(
        await rawRpc("kg_blob_write", { graph: seed, log_chunks: [], log_schema_version: 1 }),
        "kg_blob_write"
      );
      console.log(`[garde] --force : flush vers seed « es-probe » vide.`);
    }
  } else {
    console.log(`[garde] aucun blob (projet vierge) — KgService seedera.`);
  }

  // 2. Le VRAI service de prod (aucun arg ⇒ chemin socket réel complet).
  const { KgService } = await import(new URL("../build/kg/service.js", import.meta.url));
  const svc = new KgService();

  // call() instrumenté : on chronomètre exactement ce que l'outil MCP
  // appellerait (getKg = poll kg_doc_state §5 + reload ES si besoin ;
  // mutation = + saveProjectKG/kg_blob_write ; le tout via withRevitConnection
  // + RevitClientConnection.processBuffer + mutex global).
  const timed = async (method, params, bag) => {
    const t0 = process.hrtime.bigint();
    try {
      const res = await svc.call(method, params);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      bag.push(ms);
      if (ms > SLOW_MS) console.log(`  ⚠️  ${method} LENTE: ${f(ms)}`);
      return { res, ms };
    } catch (e) {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const stall = String(e.message || e).includes(STALL_FINGERPRINT);
      console.log(
        `  ${stall ? "🔴 STALL 120 s" : "✖ ERREUR"} ${method} après ${f(ms)} : ${e.message}`
      );
      throw Object.assign(e, { _ms: ms, _stall: stall });
    }
  };

  // 3. Échauffement : health + cible à modifier (2 Level neufs, ids uniques
  //    au run → indépendant d'un éventuel résidu kg-es-probe).
  const warm = [];
  await timed("health", {}, warm);
  const tag = `svcprobe_${Date.now()}`;
  const add = await timed(
    "add_element",
    {
      project_id: PID,
      elements: [
        { node_type: "Level", llm_id: `${tag}_a`, attrs: { name: `${tag}_a`, elevation: 0 } },
        { node_type: "Level", llm_id: `${tag}_b`, attrs: { name: `${tag}_b`, elevation: 3 } },
      ],
    },
    warm
  );
  const target = `${tag}_a`;
  console.log(`[setup] cible=${target}  turn(post-add)=${add.res.turn}`);
  row("warm-up (health+add)", stat(warm));

  // 4. Boucle S1 : modify 1 attr → diff_since → query, ×N. iter 1 = cache
  //    FROID (1ᵉʳ getKg ⇒ loadProjectKG/kg_blob_read) ; iter ≥2 = cache
  //    CHAUD attendu (nos écritures ES filtrées par nom de Tx §5 ⇒ epoch
  //    inchangé ⇒ pas de reload). On sépare froid/chaud dans le verdict.
  console.log(`\n── Boucle S1 ×${N} (modify → diff_since → query) ──────────────`);
  const mod = [],
    dif = [],
    qry = [];
  let lastTurn = add.res.turn;
  let hardStall = false;
  for (let i = 0; i < N; i++) {
    try {
      const m = await timed(
        "modify_element",
        { project_id: PID, edits: [{ llm_id: target, updates: { elevation: 100 + i } }] },
        mod
      );
      lastTurn = m.res.turn;
    } catch (e) {
      if (e._stall) hardStall = true; // commit possible : on poursuit (mémoire)
    }
    try {
      await timed(
        "diff_since",
        { project_id: PID, since_turn: Math.max(1, lastTurn - 1) },
        dif
      );
    } catch (e) {
      if (e._stall) hardStall = true;
    }
    try {
      await timed("query", { project_id: PID, compact: true }, qry);
    } catch (e) {
      if (e._stall) hardStall = true;
    }
  }

  // 5. Profil + verdict.
  console.log(`\n══════════ PROFIL CHEMIN TS RÉEL ══════════`);
  const mS = stat(mod),
    dS = stat(dif),
    qS = stat(qry);
  row("modify_element", mS);
  row("diff_since", dS);
  row("query", qS);
  const coldMod = mod[0];
  const warmMod = stat(mod.slice(1));
  if (mod.length >= 2) {
    console.log(
      `\n• modify iter1 (cache FROID, inclut loadProjectKG/kg_blob_read) : ${f(coldMod)}`
    );
    console.log(
      `• modify iter≥2 (cache CHAUD attendu §5) : p50 ${f(warmMod.p50)} / max ${f(warmMod.max)} ` +
        `→ cache §5 ${warmMod.max < coldMod ? "TIENT (chaud < froid)" : "NE tient pas (reload chaque op ?)"}`
    );
  }
  const worst = Math.max(0, ...mod, ...dif, ...qry);
  console.log(`\nRègle de décision :`);
  if (hardStall) {
    console.log(
      `🔴 STALL 120 s REPRODUIT hors-ligne dans le chemin TS (sans Claude).\n` +
        `   → défaut TS/transport RÉEL (pas seulement un artefact live).\n` +
        `   CORRIGER avant tout run facturable. NE PAS lancer run 2.`
    );
  } else if (worst > SLOW_MS) {
    console.log(
      `🟠 Pas de 120 s, mais une call > ${f(SLOW_MS)} (max ${f(worst)}).\n` +
        `   Variance TS à investiguer avant un run 2 facturable.`
    );
  } else {
    console.log(
      `✅ Tout en dizaines/centaines de ms (max ${f(worst)}), zéro 120 s.\n` +
        `   Le chemin TS de prod est SAIN sans Claude. Les stalls 120 s\n` +
        `   documentés en live = artefact Revit-non-quiescent / session\n` +
        `   live, PAS un défaut TS reproductible. → run 2 facturable SÛR\n` +
        `   avec les fixes prompts/steering (s2 restate coupé, SUFFIX\n` +
        `   seed/edit, garde timeout-but-commits).`
    );
  }
  console.log(`\n[kg-svc-probe] terminé.`);
}

main().catch((e) => {
  console.error(`\n[kg-svc-probe] ERREUR FATALE: ${e.message}`);
  console.error("Vérifier : Revit + Switch + .rvt de bench + serveur buildé (npm run build).");
  process.exit(2);
});
