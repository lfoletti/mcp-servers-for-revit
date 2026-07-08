import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Compute room-to-room adjacency from the live Revit model and project it as
 * Derived `adjacent_to` edges. Forwards to the `kg_compute_adjacency` socket
 * command (RevitMCPKgCommandSet). Deterministic, idempotent (full replace),
 * Revit-side read-only. Run it after geometry changes to refresh adjacency.
 */
export function registerKgComputeAdjacencyTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_compute_adjacency",
    "Compute room-to-room adjacency from the live model and project it as Derived adjacent_to edges (Room ↔ Room), projecting room-separation lines (RoomSeparationLine nodes + bounded_by) on the way. Deterministic (no LLM), idempotent (full replace each run), Revit-side read-only. Each edge carries boundary_type (wall|separation|mixed), via (mediator node llm_ids) and computed_at_turn. Returns { rooms, pairs, separation_lines, computed_at_turn }. Derived, not live: re-run after geometry edits.",
    {},
    async () => {
      try {
        return kgResult(await kgSend("kg_compute_adjacency", {}));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
