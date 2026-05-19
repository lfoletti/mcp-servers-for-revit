/**
 * run_stage2.mjs — Stage-2 pilote runner. Pour UN (scenario, stack) :
 *   1) reset modèle (kg-rvt-reset.mjs) [+ kg-reset.mjs Demo si B]
 *   2) claude -p (prompt + steering A/B, cwd=profile, --output-format
 *      json, --allowedTools mcp__revit)  — sauf en mode --stub
 *      (raw socket build d'un mini-modèle, pour valider l'orchestration
 *      sans Claude/facturable).
 *   3) send_code_to_revit document.Save() (transactionMode:none).
 *   4) fs-copy stage2-bench.rvt → out/stage2/<scen>__<stack>.rvt.
 *   5) verify_rvt.readTruth() → out/stage2/<scen>__<stack>.truth.json.
 *   6) écrit aussi <scen>__<stack>.run.json (résultat claude + walltime).
 *
 *   node kg_bridge/benchmark/stage2/run_stage2.mjs --stack A --scenario P1
 *   node kg_bridge/benchmark/stage2/run_stage2.mjs --stack A --scenario P1 --stub
 *
 * Prérequis : Revit + Switch ON, stage2-bench.rvt comme doc actif
 * (créé par le SaveAs scripté), profils s2-direct/s2-kg approuvés.
 */
import net from "node:net";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readTruth } from "./verify_rvt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..", "..", "..");
const OUT = resolvePath(ROOT, "kg_bridge/benchmark/live/out/stage2");
const BENCH_RVT = resolvePath(OUT, "stage2-bench.rvt");
const NODE = "C:/Users/lauro/AppData/Local/anaconda3/envs/revitmcp/node.exe";
const PROFILES = resolvePath(ROOT, "kg_bridge/benchmark/live/profiles");

const STEER = {
  A: " You have NO project-memory tools. Create every element FOR REAL in Revit using the create_* commands. Answer questions ONLY by querying the live Revit model (ai_element_filter, get_current_view_elements). Do NOT use store_*_data.",
  B: " Create every element FOR REAL in Revit using create_* commands. For EACH created element, IMMEDIATELY call kg_bind_revit_id(llm_id, the ElementId returned by the create command) and record the structure in the KG. Answer questions from the KG (kg_query, kg_diff_since).",
};
const PROFILE_DIR = { A: resolvePath(PROFILES, "s2-direct"), B: resolvePath(PROFILES, "s2-kg") };

// --- args ---
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const stack = arg("--stack");
const scen = arg("--scenario");
const stub = argv.includes("--stub");
if (!["A", "B"].includes(stack) || !["P1", "P3"].includes(scen)) {
  console.error("usage: --stack A|B --scenario P1|P3 [--stub]"); process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// --- helpers ---
function rpc(method, params) {
  return new Promise((res, rej) => {
    const s = net.connect(8080, "127.0.0.1");
    let b = ""; const to = setTimeout(() => { s.destroy(); rej(new Error("timeout " + method)); }, 180000);
    s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: "r" })));
    s.on("data", (d) => { b += d; try { const m = JSON.parse(b); clearTimeout(to); s.end(); res(m); } catch {} });
    s.on("error", (e) => { clearTimeout(to); rej(e); });
  });
}
const R = (m) => (m.result ?? m.error);
async function code(snippet, args = []) {
  const m = await rpc("send_code_to_revit", { code: snippet, parameters: args, transactionMode: "none" });
  const r = R(m); return { ok: r?.Success ?? r?.success, result: r?.Result, err: r?.ErrorMessage ?? m.error };
}
function runScript(scriptRel, args = []) {
  const script = resolvePath(ROOT, scriptRel);
  const r = spawnSync(NODE, [script, ...args], { encoding: "utf-8", timeout: 120000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// --- main ---
console.log(`[run_stage2] stack=${stack} scenario=${scen} stub=${stub}`);

// (1) reset model + (B) KG
console.log("\n--- (1) reset ---");
const r1 = runScript("server/scripts/kg-rvt-reset.mjs");
console.log("kg-rvt-reset exit", r1.code, "tail:", (r1.stdout || "").split("\n").slice(-3).join(" | "));
if (stack === "B") {
  const r2 = runScript("server/scripts/kg-reset.mjs", ["Demo"]);
  console.log("kg-reset Demo exit", r2.code, "tail:", (r2.stdout || "").split("\n").slice(-2).join(" | "));
}

// (2) Claude (or --stub raw-socket build)
const t0 = Date.now();
let runMeta = { stub, claude: null };
if (stub) {
  console.log("\n--- (2) STUB: raw-socket build (no Claude) ---");
  // tiny known model: 1 level + 2 walls (proves the per-scenario plumbing)
  const fam = await rpc("get_available_family_types", { categoryList: ["OST_Walls"], familyNameFilter: "", limit: 50 });
  const farr = R(fam)?.Response ?? R(fam)?.response ?? R(fam) ?? [];
  const wt = (Array.isArray(farr) ? farr : []).find((t) => !/rideau|curtain/i.test(JSON.stringify(t))) || farr[0];
  const wtId = Number(wt?.FamilyTypeId ?? wt?.Id ?? wt?.id);
  await rpc("create_level", { data: [{ name: "STUBN0", elevation: 0 }] });
  await rpc("create_line_based_element", { data: [
    { category: "OST_Walls", typeId: wtId, locationLine: { p0: { x: 0, y: 0, z: 0 }, p1: { x: 4000, y: 0, z: 0 } }, thickness: 200, height: 2700, baseLevel: 0, baseOffset: 0 },
    { category: "OST_Walls", typeId: wtId, locationLine: { p0: { x: 4000, y: 0, z: 0 }, p1: { x: 8000, y: 0, z: 0 } }, thickness: 200, height: 2700, baseLevel: 0, baseOffset: 0 },
  ]});
  runMeta.stub_build = "1 level + 2 walls created via raw socket";
} else {
  console.log("\n--- (2) claude -p ---");
  const promptPath = resolvePath(HERE, "prompts", scen === "P1" ? "10_P1.txt" : "20_P3.txt");
  const prompt = readFileSync(promptPath, "utf-8") + STEER[stack];
  const r = spawnSync("claude", ["-p", prompt, "--output-format", "json", "--max-turns", "40", "--allowedTools", "mcp__revit"],
    { cwd: PROFILE_DIR[stack], encoding: "utf-8", shell: true, timeout: 1500000 });
  let claudeJson = null; try { claudeJson = JSON.parse(r.stdout); } catch {}
  runMeta.claude = { exit: r.status, json: claudeJson, raw_head: (r.stdout || "").slice(0, 400), stderr_head: (r.stderr || "").slice(0, 300) };
  console.log("claude exit", r.status, "is_error=", claudeJson?.is_error, "turns=", claudeJson?.num_turns, "wall_s=", ((Date.now() - t0) / 1000).toFixed(1));
}
runMeta.wall_s = (Date.now() - t0) / 1000;

// (3) document.Save()
console.log("\n--- (3) document.Save() ---");
const sv = await code("document.Save(); return document.PathName;");
console.log("Save ok=", sv.ok, "err=", sv.err);

// (4) archive .rvt
const archive = resolvePath(OUT, `${scen}__${stack}.rvt`);
let archiveOk = false;
try { copyFileSync(BENCH_RVT, archive); archiveOk = true;
  console.log(`(4) archive: OK ${statSync(archive).size}b -> ${archive}`);
} catch (e) { console.log("(4) archive FAILED:", e.message); }

// (5) verify_rvt
console.log("\n--- (5) verify_rvt.readTruth ---");
const truth = await readTruth();
console.log("truth:", JSON.stringify(truth.counts), "levels=", truth.levels.length, "walls=", truth.walls.length, "windows=", truth.windows.length);
const truthPath = resolvePath(OUT, `${scen}__${stack}.truth.json`);
writeFileSync(truthPath, JSON.stringify(truth, null, 2));

// (6) write run.json
writeFileSync(resolvePath(OUT, `${scen}__${stack}.run.json`),
  JSON.stringify({ scenario: scen, stack, stub, save_ok: sv.ok, archive_ok: archiveOk, archive_path: archiveOk ? archive : null, ...runMeta }, null, 2));

console.log(`\n[run_stage2] DONE ${scen}__${stack}: save=${sv.ok} archive=${archiveOk} truth_levels=${truth.levels.length}/walls=${truth.walls.length}/windows=${truth.windows.length}`);
