/**
 * KG transport — forward a kg_* operation to the Revit add-in over the socket.
 *
 * The Knowledge Graph lives Revit-side (RevitMCPKgCommandSet, projected from
 * the live model via the DocumentChanged hook). Each kg_* MCP tool is a thin
 * forwarder to its matching socket command (kg_query, kg_annotate, …), exactly
 * like send_code_to_revit. This replaces the abandoned Python sidecar bridge.
 */
import { withRevitConnection } from "../utils/ConnectionManager.js";

/** Send a kg_* command to Revit and return its raw response. */
export async function kgSend(command: string, params: Record<string, any>) {
  return withRevitConnection(async (revitClient) => {
    return await revitClient.sendCommand(command, params);
  });
}

/** Uniform MCP tool result wrapper (matches the repo's existing tool shape). */
export function kgResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

export function kgError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}
