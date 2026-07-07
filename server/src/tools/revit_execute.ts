import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const transactionModeSchema = z
  .enum(["auto", "none"])
  .default("auto")
  .describe(
    "How the snippet interacts with Revit transactions. 'auto' wraps the snippet in a transaction (warnings swallowed); 'none' when your code manages its own transactions."
  );

/**
 * revit_execute — generic arbitrary-C# entry point into the live Revit API.
 *
 * Alias of the `send_code_to_revit` add-in command, exposed under a clearer name
 * and with the fuller surface the handler now provides. The snippet runs inside:
 *
 *   public static object Execute(
 *       UIApplication uiapp, UIDocument uidoc, Document document,
 *       Autodesk.Revit.ApplicationServices.Application app,
 *       object[] parameters, Action<object> Print) { <your code> }
 *
 * so it can use uiapp / uidoc / document / app / parameters / Print(...) directly.
 * Return a value to get it back serialized; call Print(...) to stream text output.
 */
export function registerRevitExecuteTool(server: McpServer) {
  server.tool(
    "revit_execute",
    "Execute arbitrary C# against the live Revit API. Your code runs inside a method with access to uiapp (UIApplication), uidoc (UIDocument), document (Document), app (Application), parameters (object[]), and Print(object) which accumulates text output. Return any value to receive it serialized. In 'auto' transaction mode the code is wrapped in a Transaction with warnings swallowed. Full API power — no whitelist.",
    {
      code: z
        .string()
        .describe(
          "C# code executed inside the Execute method. Has uiapp, uidoc, document, app, parameters and Print(...) in scope. May 'return' a value; use Print(...) for text output."
        ),
      parameters: z
        .array(z.string())
        .optional()
        .describe("Optional string parameters passed to your code as object[] parameters."),
      transactionMode: transactionModeSchema,
    },
    async (args, extra) => {
      const params = {
        code: args.code,
        parameters: args.parameters || [],
        transactionMode: args.transactionMode,
      };

      try {
        // 复用既有的 add-in 命令名，仅在 MCP 层换一个清晰的工具名。
        // Reuse the existing add-in command name; only the MCP-facing tool name changes.
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("send_code_to_revit", params);
        });

        return {
          content: [
            {
              type: "text",
              text: `Execution successful.\nResult: ${JSON.stringify(response, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
