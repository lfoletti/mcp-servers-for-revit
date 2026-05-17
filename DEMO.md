# Demo — Knowledge Graph project memory (no Revit required)

This PoC adds **graph-backed project memory** to the MCP server, as an
alternative to the flat `store_*_data` SQLite tools. Stage 1 runs entirely
offline: no Revit, no Autodesk licence, no network.

It does **not** modify any existing file. It adds:

```
kg_bridge/
  kg_sidecar.py        # JSON-lines stdio bridge (the only glue)
  smoke_test.py        # deterministic offline proof
  requirements.txt     # networkx
  vendor/
    project_kg.py      # VERBATIM copy of claude-in-revit's production KG
    PROVENANCE.md
server/src/kg/bridge.ts            # TS client (singleton sidecar spawner)
server/src/tools/kg_add_element.ts
server/src/tools/kg_query.ts
server/src/tools/kg_modify_element.ts
server/src/tools/kg_soft_delete.ts
server/src/tools/kg_diff_since.ts
server/src/tools/kg_transaction_demo.ts
```

The 6 `kg_*` tools are picked up automatically by the existing
`server/src/tools/register.ts` auto-discovery (each exports a `register…Tool`
function) — zero changes to the server core.

## 1. Fastest proof — the offline smoke test (no Node, no Revit)

```bash
python -m pip install -r kg_bridge/requirements.txt
python kg_bridge/smoke_test.py
```

It spawns the sidecar, drives every method, asserts the differentiating
invariants, and prints a transcript ending in `ALL PASS`. What it proves:

| Section | Invariant |
|---|---|
| health + schema | the graph is **typed** (validated `Wall` contract), not free-form KV |
| add elements + relations | typed nodes **and** typed edges (`at_level`, `is_type`) |
| query topology | reads back nodes **with their relations** |
| modify → history | `kg_diff_since` reports the exact before/after — impossible on a flat store |
| soft delete | node hidden but **retained** with `deleted_at_turn` (reversible) |
| atomic rollback | a failed batch leaves **no** node / turn / log residue |
| cross-session | a fresh sidecar process **reloads the graph from disk** |

## 2. Through the MCP server (Node)

```bash
cd server
npm install
npm run build        # tsc — the kg_*.ts compile under the repo's strict tsconfig
```

Point an MCP client at the built server (same as upstream), e.g. Claude
Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "revit": {
      "command": "node",
      "args": ["ABSOLUTE/PATH/server/build/index.js"],
      "env": {
        "KG_PYTHON": "python",
        "KG_HOME": "ABSOLUTE/PATH/.mcp-revit-kg"
      }
    }
  }
}
```

`KG_PYTHON` is the Python interpreter that has `networkx` installed (see
`kg_bridge/requirements.txt`). `KG_SIDECAR` can override the sidecar path; by
default it is resolved relative to the repo root.

### Try it (prompts)

- "Add a Level N0 at elevation 0, a WallType GEN_200 (thickness 0.2), then a
  Wall on N0 of that type, linked with `at_level` and `is_type`."
  → `kg_add_element` ×3
- "Show me the walls and their relations." → `kg_query`
- "Set that wall's height to 3.0." → `kg_modify_element`
- "What changed since turn 3?" → `kg_diff_since` (returns the create + modify)
- "Delete level N0." → `kg_soft_delete` (hidden, not destroyed)
- "Run the atomicity demo." → `kg_transaction_demo` (failed batch, `before == after`)

## 3. Side-by-side with the flat store

Ask the model to `store_project_data` then `kg_add_element` for the same
project, then:

- `query_stored_data` → a row. No relations, no history, no lifecycle.
- `kg_query` / `kg_diff_since` → a typed subgraph and an auditable change log.

That contrast is the point. The rationale and the Revit-coupled Stage 2 are in
[`DESIGN-kg.md`](./DESIGN-kg.md).

## Notes / honest caveats

- **No Node on the authoring machine**, so `npm run build` was not executed
  here. The TypeScript is written strictly to the repo's existing conventions
  (`say_hello.ts`, `store_project_data.ts`, `register.ts`, the `Node16`/strict
  `tsconfig.json`). The **executable** proof in this PoC is the Python smoke
  test; please run `npm run build` to confirm compilation in your environment.
- **Polyglot runtime**: Stage 1 needs Python + `networkx` alongside Node. This
  is the deliberate trade to reuse the *real* 821-test KG unchanged rather than
  reimplement it. `DESIGN-kg.md` describes the single-runtime endgame.
- **PoC turn model**: one MCP operation == one "turn" so `kg_diff_since` reads
  legibly. In the source project a turn is one conversational turn. This
  concession lives in the sidecar, not in the vendored KG.
