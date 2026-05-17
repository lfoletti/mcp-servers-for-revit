import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgBridge, kgResult, kgError } from "../kg/bridge.js";
import { kgManyEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Select-and-mutate in ONE call: filter live nodes of a type by attribute
 * predicates and apply `updates` to every match, atomically. Replaces the
 * "kg_query → filter in the prompt → loop kg_modify_element ×N" pattern with
 * a single round-trip and a compact return (count + small id sample, no
 * per-node echo). Highest token-economy lever for conditional bulk edits
 * (e.g. "raise the sill of every window below 0.9 m to 0.9"). Only
 * registered in `kg-many` mode.
 */
export function registerKgModifyWhereTool(server: McpServer) {
  logKgModeOnce();
  if (!kgManyEnabled()) return;
  server.tool(
    "kg_modify_where",
    "Atomically modify ALL Knowledge Graph nodes of a type that match attribute predicates, in one call. Prefer this over query→filter→loop for conditional bulk edits ('set X for every Y where Z'): one transaction, one round-trip, compact return (no per-node dump). All-or-nothing.",
    {
      node_type: z.string().describe("Node type to scan, e.g. Window."),
      where: z
        .array(
          z.object({
            attr: z.string().describe("Attribute name to test."),
            op: z
              .enum(["eq", "ne", "lt", "le", "gt", "ge", "in"])
              .describe("Comparison operator."),
            value: z.any().describe("Value (array for op='in')."),
          })
        )
        .optional()
        .describe("AND-combined predicates. Omit/empty ⇒ all live nodes of the type."),
      updates: z
        .record(z.any())
        .describe("Attributes to set on every matched node (schema-validated)."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgBridge.call("modify_where", {
          project_id: args.project_id,
          node_type: args.node_type,
          where: args.where ?? [],
          updates: args.updates,
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
