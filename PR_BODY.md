# A Knowledge Graph memory layer for mcp-servers-for-revit (fork / proposal)

> **Repo description:** 🤖 mcp-servers-for-revit + a graph-backed
> project-memory layer (typed/historized/atomic Knowledge Graph) —
> additive, zero core changes, benchmarked.
>
> Suggested topics: `mcp` `revit` `knowledge-graph` `bim` `ai`
> `model-context-protocol`

*Filed as an Issue because Discussions aren't enabled here — happy to move
it if you turn them on, or to open a PR if there's interest. Everything is
on the branch `feat/kg-memory-poc`; none of your core files are touched.*

## In a few words

A first try at combining the agent with a larger, persistent **memory of
the model** — a typed, queryable Knowledge Graph (KG) kept alongside the
Revit project. Think of it as a continuation of the `store_*_data` you
already have for room info, but expanded to the whole BIM scale (walls,
windows, levels, types and the relations between them), with the history of
changes and atomic edits.

I went in expecting a token-economy win, but it turns out the bigger impact
is on **trust** and confidence. Over 15 deterministic BIM tasks — scored
against the *actual persisted state*, not the model's prose — the flat
`store_*_data` path answered a confident *"done"* on **8 of 15** while
nothing had really been stored: it can't represent a building, so it
essentially made the answer up. The KG layer was **15/15 correct**. The
token side is real but secondary (input is cache-cheap; the KG mostly
saves output and round-trips).

So, the question for you: is a persistent model-memory layer like this
something you'd want in mcp-servers-for-revit — and what would it be worth
to the project to have an agent that *cannot* silently fabricate building
state? The rest of this write-up is the detail, the numbers, and how it's
wired (additive — nothing in your core is touched).

## What I found (benchmark)

I built a small benchmark: 15 deterministic BIM tasks, run through real
Claude Code sessions, each scored **against the persisted state** — a
checker reads the actual KG / SQLite and compares it to the known correct
answer, instead of believing the model's prose.

- The flat `store_*_data` baseline replied a confident *"done, persisted"*
  on **8 of 15** tasks where **nothing had actually been stored**. It can't
  represent walls/windows/relations, so it essentially made the answer up.
  Not slower-but-fine — **wrong, and sounding right**.
- The KG layer was **15/15 correct** (verified against state).
- Cost was a secondary, partial bonus: ~**$0.54 vs $1.71 per _correct_
  task** (the flat figure is inflated because most of its spend bought
  wrong answers). On tasks the flat store genuinely *can* do (plain rooms),
  both are correct and the KG is still ~25–40 % cheaper — so it isn't a
  rigged comparison.

**At a glance** (15 deterministic BIM tasks, scored against persisted state):

| | flat `store_*_data` | KG (this fork) |
|---|--:|--:|
| Correct (verified vs state) | 6 / 15 | **15 / 15** |
| Fabricated (confident but false) | **8 / 15** | 0 / 15 |
| Honest "can't do it" | 1 / 15 | 0 / 15 |
| Total tokens (input incl. cache + output) | ~7.0 M | ~5.8 M |
| — of which output (the uncached cost driver) | ~140 k | ~105 k |
| **$ per _correct_ task** | $1.71 | **$0.54** |

Two controlled micro-benchmarks (same correct end state — cost is the only
variable):

| | without | with | gain |
|---|--:|--:|--:|
| bulk economy scales (round-trip ratio kg/kg-many) | N=10: 3.6× | N=20: 4.3× | widens with N |
| `kg_modify_where` vs query+loop (N=30) | 45 turns / $1.25 | 15 turns / $0.87 | turns ×3, −31 % |

On the token side, honestly: with prompt caching the input is cheap, so the
real bill is output + round-trips. The KG helps there too (bulk +
select-and-mutate + compact returns — e.g. one conditional bulk edit went
from 45 turns to 15, −31 % cost), but the headline is **correctness, not
speed**.

## Why it happens

With Revit live the agent hits the model directly every turn and keeps no
memory between turns; `store_*_data` is a flat side-store that can't mirror
a building. So when asked to "update all the windows" and remember it, the
flat path has nowhere to put that — and the model tends to report success
anyway. The KG is simply a place for that state to actually live: typed
nodes/edges, change history, atomic edits, and it survives across sessions.

## How it's wired (additive, no core changes)

A handful of new files only: `kg_*` MCP tools (picked up by your existing
`register.ts` auto-discovery, exactly like `store_project_data`), backed by
a small Python sidecar that wraps a real, already-tested Knowledge Graph
implementation (vendored verbatim, ~250 lines of glue). Same shape as
`tool → database/service.ts`. No Revit and no WebSocket at this stage. Your
files are untouched.

## Caveats, up front

- It needs Python + networkx next to Node (the sidecar). If that's a
  dealbreaker for merging, the clean endgame is a TypeScript port of the
  vendored file — glad to do that if the idea lands.
- "Made up the answer" is specifically about BIM tasks that are out of
  `store_*_data`'s domain; on plain room data the flat store is fine. The
  claim is *"for BIM memory it fabricates"*, not "it's bad".
- One benchmark run, so treat the dollar figures as indicative; the
  correctness verdicts are robust.
- This is **memory only** so far — no Revit element is created or edited by
  these tools yet. There's a sketched Stage 2 (couple it to the Revit
  transaction so the model and the memory can't drift apart), but that needs
  your C#/WebSocket loop and is deferred until there's interest.

## Try it / what I'd like to know

No Revit and no API cost needed: `DEMO.md` (offline smoke) and
`BENCHMARK.md` (the numbers + how to reproduce, including exact token
counts).

Mostly I'd like your read: is a memory layer like this interesting to you?
Is the Python sidecar acceptable for a first cut, or would you want a TS
port up front? Any appetite for the Revit-coupled Stage 2?
