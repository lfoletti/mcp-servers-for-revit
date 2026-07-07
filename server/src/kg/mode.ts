/**
 * KG benchmark mode gate.
 *
 * Lets you A/B benchmark "baseline" vs "baseline + KG" by running TWO MCP
 * server profiles from the same build (e.g. `revit-flat` and `revit-kg`
 * entries in the client config), with no changes to the upstream core: the
 * gate lives entirely in the additive kg_* tool modules, which early-return
 * before `server.tool(...)` when disabled. When the kg_* tools are not
 * registered, no kg_* command is ever forwarded to Revit.
 *
 *   KG_BENCH_MODE = kg | both | (unset)   -> kg_* tools REGISTERED
 *   KG_BENCH_MODE = flat | off            -> kg_* tools ABSENT (pure baseline)
 *
 * Aliases accepted for convenience: KG_TOOLS, and on/off/with/without/0/1.
 *
 * Methodology note: in `kg` mode the upstream store_*_data tools are also
 * still present (they are not ours to unregister, and a marginal A/B does
 * not require removing them). For a clean "KG path" run, instruct the model
 * to use the kg_* tools for project state (see BENCHMARK.md).
 */
function rawMode(): string {
  return (process.env.KG_BENCH_MODE ?? process.env.KG_TOOLS ?? "kg")
    .trim()
    .toLowerCase();
}

export function kgToolsEnabled(): boolean {
  const m = rawMode();
  const disabled =
    m === "flat" ||
    m === "off" ||
    m === "without" ||
    m === "0" ||
    m === "false" ||
    m === "no";
  return !disabled;
}

/**
 * Bulk-variant gate. The `_many` tools (atomic batch over N elements) only
 * register in `kg-many` mode, so the benchmark can isolate single-call vs
 * bulk: `kg` = singles only, `kg-many` = singles + _many. Mirrors the
 * claude-in-revit "bulk tool variant policy" (~70-90% fewer tokens +
 * round-trips on multi-element operations).
 */
export function kgManyEnabled(): boolean {
  const m = rawMode();
  return kgToolsEnabled() && (m === "kg-many" || m === "many" || m === "all");
}

let logged = false;

/** Emit the active mode once, on the server's stderr log channel. */
export function logKgModeOnce(): void {
  if (logged) return;
  logged = true;
  const src =
    process.env.KG_BENCH_MODE !== undefined
      ? `KG_BENCH_MODE=${process.env.KG_BENCH_MODE}`
      : process.env.KG_TOOLS !== undefined
      ? `KG_TOOLS=${process.env.KG_TOOLS}`
      : "default(kg)";
  process.stderr.write(
    `[kg] tools ${kgToolsEnabled() ? "ENABLED" : "DISABLED"}` +
      `, _many ${kgManyEnabled() ? "ENABLED" : "DISABLED"} (${src})\n`
  );
}
