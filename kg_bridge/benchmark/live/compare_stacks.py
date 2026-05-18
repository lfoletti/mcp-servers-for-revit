#!/usr/bin/env python3
"""compare_stacks.py — étape 6 : diff cross-stack v1 (Revit+ES) vs PoC gelé
(sidecar+.json), à partir de deux runs `run_live.py` distincts.

    python compare_stacks.py --poc out/poc --v1 out/v1

Chaque `--<x>` est un dossier `--out` de `run_live.py` contenant
`live_results.json` (forme {scenario: {label: metrics}} ; label == "kg"
pour les deux, chacun lancé via `--kg-dir`).

Métrique-vérité demandée (§10.6, choix utilisateur « A/B live ») :
tokens / turns / wall / cost RÉELS de Claude Code. Rappel cadrage : la
surface d'outils et la sémantique kg_* sont portées 1:1 (60/60 TS + 13
tests service + fumée ES 8/8) → tokens/turns attendus ~équivalents ; le
delta v1 attendu et ACCEPTÉ est `wall_s` (une Tx ES Revit > une écriture
.json locale) — c'est le prix de l'internalisation (§1), pas une
régression agent. Le script l'affiche sans le « faire échouer ».
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

METRICS = [
    ("input_tokens", "in tok", "lower"),
    ("output_tokens", "out tok", "lower"),
    ("num_turns", "turns", "lower"),
    ("wall_s", "wall s", "info"),       # v1 > PoC attendu (Tx ES) — informatif
    ("total_cost_usd", "cost $", "lower"),
]


def load(out_dir: str) -> dict:
    p = Path(out_dir) / "live_results.json"
    if not p.exists():
        raise SystemExit(f"introuvable: {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def kg(entry: dict) -> dict:
    # run_live met les métriques sous le label de slot ; ici "kg".
    return entry.get("kg") or next(iter(entry.values()), {}) if entry else {}


def num(x):
    return x if isinstance(x, (int, float)) else None


def ratio(v1, poc):
    a, b = num(v1), num(poc)
    if a is None or b is None or not b:
        return None
    return round(a / b, 3)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--poc", required=True, help="run_live --out dir (PoC)")
    ap.add_argument("--v1", required=True, help="run_live --out dir (v1)")
    ap.add_argument("--out", default=None,
                    help="dossier de sortie (défaut: --v1)")
    a = ap.parse_args()

    poc, v1 = load(a.poc), load(a.v1)
    scens = sorted(set(poc) | set(v1))
    out_dir = Path(a.out or a.v1)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    agg = {m: {"poc": 0.0, "v1": 0.0, "n": 0} for m, _, _ in METRICS}
    for sc in scens:
        mp, mv = kg(poc.get(sc, {})), kg(v1.get(sc, {}))
        rec = {"scenario": sc,
               "poc_err": bool(mp.get("is_error")),
               "v1_err": bool(mv.get("is_error")),
               "metrics": {}}
        for key, _, _ in METRICS:
            p, v = num(mp.get(key)), num(mv.get(key))
            rec["metrics"][key] = {"poc": p, "v1": v,
                                   "v1_over_poc": ratio(v, p)}
            if p is not None and v is not None:
                agg[key]["poc"] += p
                agg[key]["v1"] += v
                agg[key]["n"] += 1
        rows.append(rec)

    report = {"poc_dir": a.poc, "v1_dir": a.v1,
              "scenarios": rows,
              "totals": {k: {"poc": round(agg[k]["poc"], 4),
                             "v1": round(agg[k]["v1"], 4),
                             "v1_over_poc": ratio(agg[k]["v1"],
                                                  agg[k]["poc"]),
                             "n": agg[k]["n"]}
                         for k in agg}}
    (out_dir / "compare_stacks.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8")

    L = ["# Étape 6 — A/B live : v1 (Revit+ES) vs PoC gelé (sidecar)\n",
         "`v1/poc` : <1 = v1 mieux (moins de tokens/turns/$). `wall s` : "
         "v1>poc **attendu & accepté** (Tx ES Revit vs écriture .json) — "
         "informatif, pas une régression agent (§1, §10.6).\n",
         "| Scénario | Métrique | PoC | v1 | v1/poc |",
         "|---|---|--:|--:|--:|"]
    for r in rows:
        for key, lbl, _ in METRICS:
            c = r["metrics"][key]
            L.append("| {} | {} | {} | {} | {} |".format(
                r["scenario"], lbl, c["poc"], c["v1"],
                "-" if c["v1_over_poc"] is None else f"x{c['v1_over_poc']}"))
        if r["poc_err"] or r["v1_err"]:
            L.append("| {} | _err_ | poc_err={} | v1_err={} | |".format(
                r["scenario"], r["poc_err"], r["v1_err"]))
    L += ["", "## Totaux", "| Métrique | PoC | v1 | v1/poc | n |",
          "|---|--:|--:|--:|--:|"]
    for key, lbl, _ in METRICS:
        t = report["totals"][key]
        L.append("| {} | {} | {} | {} | {} |".format(
            lbl, t["poc"], t["v1"],
            "-" if t["v1_over_poc"] is None else f"x{t['v1_over_poc']}",
            t["n"]))
    L += ["",
          "**Lecture (§10.6 « v1 ≥ PoC »)** : viser tokens/turns/$ "
          "`v1/poc ≈ 1` ou `< 1` (surface d'outils portée 1:1). `wall s` "
          "`> 1` est le coût documenté de l'internalisation ES, pas une "
          "régression côté agent. Vérif correction = parité par "
          "construction (60/60 TS + 13 service + fumée ES 8/8) + dump "
          "d'état final (`v1_state_dump.mjs`) vs `.kg.json` PoC."]
    md = "\n".join(L) + "\n"
    (out_dir / "compare_stacks.md").write_text(md, encoding="utf-8")
    print(md)
    print(f"Wrote {out_dir}/compare_stacks.{{json,md}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
