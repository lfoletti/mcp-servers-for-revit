/**
 * KG on/off gate (benchmark baseline A/B).
 *
 * Lets you A/B "baseline" vs "baseline + KG" by running two MCP server
 * profiles from the same build, with no change to the upstream core: the
 * gate lives entirely in the additive kg_* tool modules, which early-return
 * before `server.tool(...)` when disabled.
 *
 *   KG_BENCH_MODE = (unset) | kg | kg-many | …  -> kg_* tools REGISTERED
 *   KG_BENCH_MODE = flat | off                  -> kg_* tools ABSENT (pure baseline)
 *
 * Aliases accepted for convenience: KG_TOOLS, and on/off/with/without/0/1.
 *
 * The historical `kg` vs `kg-many` distinction is GONE: the KG mutators
 * are now list-native (1..N) by design — bulk is intrinsic, not a mode
 * (cf. the single/`_many` merge in `service.ts`). `kg-many` is still
 * accepted as a no-op alias so existing client configs / the frozen-PoC
 * comparison keep working; it only ever means "KG on".
 *
 * Methodology note: the upstream store_*_data tools stay present (not ours
 * to unregister). For a clean "KG path" run, steer the model to the kg_*
 * tools for project state (see BENCHMARK.md / run_live.py --steer).
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

let logged = false;

/** Emit the active state once, on the server's stderr log channel. */
export function logKgModeOnce(): void {
  if (logged) return;
  logged = true;
  const src =
    process.env.KG_BENCH_MODE !== undefined
      ? `KG_BENCH_MODE=${process.env.KG_BENCH_MODE}`
      : process.env.KG_TOOLS !== undefined
      ? `KG_TOOLS=${process.env.KG_TOOLS}`
      : "default";
  process.stderr.write(
    `[kg] tools ${kgToolsEnabled() ? "ENABLED" : "DISABLED"} ` +
      `(list-native bulk; ${src})\n`
  );
}
