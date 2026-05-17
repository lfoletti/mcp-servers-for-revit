/**
 * KG sidecar bridge — TypeScript client for the Python `kg_sidecar.py` process.
 *
 * Mirrors the role of `database/service.ts` for the flat SQLite store: a thin
 * local service the `kg_*` tools call. No Revit, no WebSocket — the sidecar
 * wraps the unmodified, 821-test claude-in-revit ProjectKG.
 *
 * One sidecar process per server lifetime (lazy-spawned, singleton). Protocol
 * is newline-delimited JSON, one request -> one response, matched by id.
 *
 * Env overrides:
 *   KG_PYTHON   python executable (default: "python")
 *   KG_SIDECAR  absolute path to kg_sidecar.py (default: resolved from repo root)
 *   KG_HOME     where the sidecar persists <project_id>.kg.json
 */
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveSidecar(): string {
  if (process.env.KG_SIDECAR) return process.env.KG_SIDECAR;
  // Built layout: <repo>/server/build/kg/bridge.js  -> repo root is ../../..
  // Source layout: <repo>/server/src/kg/bridge.ts    -> repo root is ../../..
  const candidate = path.resolve(
    __dirname, "..", "..", "..", "kg_bridge", "kg_sidecar.py"
  );
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `kg_sidecar.py not found at ${candidate}. Set KG_SIDECAR to its path.`
  );
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

class KgBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;

    const py = process.env.KG_PYTHON || "python";
    const sidecar = resolveSidecar();
    const proc = spawn(py, [sidecar], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    proc.on("error", (err) => this.failAll(
      new Error(`failed to spawn KG sidecar via "${py}": ${err.message}`)
    ));
    proc.on("exit", (code) => {
      this.failAll(new Error(`KG sidecar exited (code ${code})`));
      this.proc = null;
      this.rl = null;
    });
    // Sidecar logs/diagnostics: surface on the server's stderr log channel.
    proc.stderr.on("data", (d) =>
      process.stderr.write(`[kg-sidecar] ${d}`)
    );

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // non-JSON noise on stdout — ignore
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "KG sidecar error"));
    });

    this.proc = proc;
    return proc;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  call(method: string, params: Record<string, any> = {}): Promise<any> {
    const proc = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`KG sidecar timeout on "${method}"`));
        }
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
}

// Singleton — shared by every kg_* tool, like `db` is shared by the SQLite tools.
export const kgBridge = new KgBridge();

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
