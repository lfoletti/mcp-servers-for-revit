# Vendored: `project_kg.py`

`project_kg.py` in this directory is a **byte-for-byte, unmodified copy** of the
production Knowledge Graph module from the [claude-in-revit] project
(`claude-in-revit.extension/lib/project_kg.py`).

It is vendored — not reimplemented — on purpose. The point of this PoC is to
show that an existing, battle-tested KG (821 passing tests upstream) drops in
behind the MCP server's tool convention with only thin glue. Reimplementing it
in TypeScript would mean diverging from the reference implementation and
maintaining two graphs; vendoring keeps a single source of truth.

- **Source**: `claude-in-revit` — `lib/project_kg.py`
- **Modifications**: none. Verified identical at vendor time (`diff -q`).
- **Dependencies**: standard library + `networkx` only (see `../requirements.txt`).
- **Upstream-merge note**: if maintainers want a single-runtime build with no
  Python dependency, the endgame is a faithful TypeScript port of *this exact
  file* (see `DESIGN-kg.md` §"Upstream integration paths"). The sidecar path is
  the fast way to prove the value first.

The KG's Revit binding (`kg_sync.py`, the `@kg_synced` decorator) is **not**
vendored: Stage 1 of this PoC exercises the graph with no Revit in the loop.
The Revit-coupled atomicity story is specified in `DESIGN-kg.md` §"Stage 2".

[claude-in-revit]: a PyRevit + Anthropic API agent that maintains this KG as a
first-class mirror of the Revit model.
