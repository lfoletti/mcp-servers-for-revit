/**
 * kg-seed-check.mjs — VERDICT EN UNE COMMANDE : le seed « Demo » a-t-il
 * réellement posé les 32 nœuds / 56 arêtes, ou a-t-il sous-persisté (et
 * OÙ a-t-il calé) ? À lancer juste après un run benchmark. Lecture seule,
 * zéro dépendance, SANS Claude / harness / serveur MCP — non facturable.
 *
 * Deux sources :
 *   - défaut : socket Revit live, `kg_blob_read` (read-only, sans Tx) ;
 *   - `--file <path>` : analyse hors-ligne un dump (ex. le
 *     `v1_state.kg.json` produit par `v1_state_dump.mjs`), sans Revit.
 *
 *   node server/scripts/kg-seed-check.mjs                       # :8080, project_id=Demo
 *   node server/scripts/kg-seed-check.mjs 8080 --pid=Demo
 *   node server/scripts/kg-seed-check.mjs --file kg_bridge/benchmark/live/out/v1_state.kg.json
 *
 * Spec seed complet (cf. mémoire project-demo-kg) : 2 Level + 1 WallType
 * + 1 FamilyType + 20 Wall + 8 Window = 32 nœuds ; arêtes = Wall×2
 * (at_level+is_type)=40 + Window×2 (is_type+hosts)=16 = 56. Murs/fenêtres
 * ne sont créés QUE par le seed (s4 ajoute des Level → Level peut être
 * >2, c'est normal et non bloquant ; on juge sur Wall/Window/arêtes).
 *
 * Exit 0 = SEED OK ; 1 = sous-persisté ; 2 = erreur infra.
 */
import net from "node:net";
import fs from "node:fs";

const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a)) || 8080);
const HOST = "127.0.0.1";
// Accepte `--k=v` ET `--k v` (la forme espace est celle de l'usage doc).
const optv = (k, d) => {
  const eq = ARGS.find((x) => x.startsWith(`--${k}=`));
  if (eq) return eq.slice(k.length + 3);
  const i = ARGS.indexOf(`--${k}`);
  if (i !== -1 && i + 1 < ARGS.length && !ARGS[i + 1].startsWith("--")) {
    return ARGS[i + 1];
  }
  return d;
};
const FILE = optv("file", null);
const PID = optv("pid", "Demo");

const EXPECT = { Wall: 20, Window: 8, edges: 56 };
const FOUNDATION = { Level: 2, WallType: 1, FamilyType: 1 };

function rawRead() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let buf = "";
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout kg_blob_read"));
    }, 30000);
    sock.on("connect", () =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", method: "kg_blob_read", params: {}, id: "s1" }))
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
function unwrap(res) {
  if (res == null || typeof res !== "object") throw new Error("réponse vide");
  const ok = res.Success ?? res.success;
  if (ok === false) throw new Error(res.Message ?? res.message ?? "kg_blob_read échec");
  return res.Response ?? res.response;
}

// Normalise vers {project_id, turn, nodes, edges} quelle que soit la
// source (blob enveloppé {schema_version,data,…} ou dump cœur direct).
function normalize(obj) {
  const d = obj && obj.data && obj.data.nodes ? obj.data : obj;
  return {
    project_id: d?.project_id ?? "?",
    turn: d?.turn ?? "?",
    nodes: Array.isArray(d?.nodes) ? d.nodes : [],
    edges: Array.isArray(d?.edges) ? d.edges : [],
  };
}

async function load() {
  if (FILE) {
    const raw = fs.readFileSync(FILE, "utf8");
    return { src: `fichier ${FILE}`, kg: normalize(JSON.parse(raw)) };
  }
  const p = unwrap(await rawRead());
  if (!p || !p.exists) return { src: `socket :${PORT}`, kg: null };
  return { src: `socket :${PORT}`, kg: normalize(JSON.parse(p.graph || "{}")) };
}

function main() {
  return load().then(({ src, kg }) => {
    console.log(`[kg-seed-check] source=${src}  attendu project_id=${PID}\n`);
    if (kg === null) {
      console.log("🔴 SOUS-PERSISTÉ : aucun blob KG (DataStorage absente / projet vierge).");
      process.exit(1);
    }
    if (kg.project_id !== PID) {
      console.log(
        `⚠️  project_id du blob = ${JSON.stringify(kg.project_id)} ≠ ${JSON.stringify(PID)} ` +
          `(autre projet / reset manquant). Analyse quand même :`
      );
    }

    const live = kg.nodes.filter((n) => n && n.deleted_at_turn == null);
    const by = {};
    for (const n of live) by[n._type] = (by[n._type] ?? 0) + 1;
    const edges = kg.edges.length;
    const eby = {};
    for (const e of kg.edges) {
      const t = e?._type ?? e?.key ?? e?.type ?? "?";
      eby[t] = (eby[t] ?? 0) + 1;
    }
    const W = by.Wall ?? 0;
    const Wi = by.Window ?? 0;

    console.log(`project_id=${kg.project_id}  turn=${kg.turn}`);
    console.log(`nœuds vivants=${live.length}  arêtes=${edges}`);
    console.log(`  par type : ${JSON.stringify(by)}`);
    console.log(`  arêtes par type : ${JSON.stringify(eby)}`);
    console.log(
      `  attendu seed complet : Wall=${EXPECT.Wall}, Window=${EXPECT.Window}, ` +
        `arêtes=${EXPECT.edges} (+ fondation ${JSON.stringify(FOUNDATION)})\n`
    );

    // Escalier de diagnostic : OÙ le seed a-t-il calé ?
    let code = 1;
    let verdict;
    const foundOK =
      (by.Level ?? 0) >= FOUNDATION.Level &&
      (by.WallType ?? 0) >= FOUNDATION.WallType &&
      (by.FamilyType ?? 0) >= FOUNDATION.FamilyType;

    if (live.length === 0) {
      verdict = "🔴 VIDE : seed jamais exécuté (ou reset .rvt sans reseed).";
    } else if (W === 0 && Wi === 0) {
      verdict =
        `🔴 FONDATION SEULEMENT (${live.length} nœuds, 0 Wall, 0 Window) : ` +
        `le seed a calé AVANT les murs.` +
        (foundOK ? "" : " ⚠️ fondation elle-même incomplète !");
    } else if (W < EXPECT.Wall || Wi < EXPECT.Window) {
      verdict =
        `🔴 PARTIEL : Wall=${W}/${EXPECT.Wall}, Window=${Wi}/${EXPECT.Window} ` +
        `— le seed a calé EN PLEIN lot d'éléments.`;
    } else if (edges === 0) {
      verdict =
        `🔴 NŒUDS SANS ARÊTES : ${W} Wall + ${Wi} Window mais 0 arête — ` +
        `les relations typées (at_level/is_type/hosts) n'ont jamais été créées.`;
    } else if (edges < EXPECT.edges) {
      verdict =
        `🟠 ARÊTES PARTIELLES : ${edges}/${EXPECT.edges} — nœuds OK, ` +
        `relations typées incomplètes.`;
    } else {
      verdict = `✅ SEED OK : Wall≥${EXPECT.Wall}, Window≥${EXPECT.Window}, arêtes≥${EXPECT.edges}.`;
      code = 0;
    }
    console.log(verdict);
    console.log(`\n[kg-seed-check] ${code === 0 ? "PASS" : "FAIL"} (exit ${code}).`);
    process.exit(code);
  });
}

main().catch((e) => {
  console.error(`\n[kg-seed-check] ERREUR: ${e.message}`);
  console.error("Vérifier : Revit + Switch (mode socket), ou --file <dump.json> valide.");
  process.exit(2);
});
