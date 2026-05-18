import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgManyEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Bulk modify: apply updates to N nodes in ONE atomic transaction and ONE
 * agent<->tool round-trip. The "set the sill of all windows to 0.8" case:
 * 1 call here vs N single kg_modify_element calls (each ~80-150 tokens of
 * overhead + a sequential API round-trip). Only registered in `kg-many`
 * mode so the benchmark can isolate the single-vs-bulk effect.
 */
export function registerKgModifyElementsManyTool(server: McpServer) {
  logKgModeOnce();
  if (!kgManyEnabled()) return;
  server.tool(
    "kg_modify_elements_many",
    "Atomically modify many Knowledge Graph nodes in a single call (one transaction, all-or-nothing). Use this instead of looping kg_modify_element when changing several elements (e.g. 'set the sill of all windows to 0.8') — far fewer tokens and one round-trip instead of N.",
    {
      items: z
        .array(
          z.object({
            llm_id: z.string().describe("The node to modify."),
            updates: z
              .record(z.any())
              .describe("Attributes to set, per the node type's schema."),
          })
        )
        .describe("Per-element {llm_id, updates}. Applied atomically."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("modify_many", {
          project_id: args.project_id,
          items: args.items,
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
