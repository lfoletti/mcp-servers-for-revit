# Étape 6 — A/B live : v1 (Revit + ExtensibleStorage) vs PoC gelé

> §10.6 « prouver v1 ≥ PoC ». Choix : **A/B live complet** (Claude Code
> réel → **appels Anthropic facturables**). Deux *stacks* (branches),
> mêmes prompts, mode `kg`, métriques réelles tokens/turns/wall/cost.

## Cadrage (à lire)

La surface d'outils et la sémantique `kg_*` sont portées **1:1** (60/60
TS + 13 tests service qui miment le sidecar + fumée ES 8/8). Donc :

- **tokens / turns / cost** : attendus `v1 ≈ PoC` (même surface agent) —
  c'est le test de non-régression.
- **wall_s** : `v1 > PoC` **attendu et accepté** — une `Transaction` ES
  dans Revit coûte plus qu'une écriture `.json` locale. C'est le prix de
  l'internalisation (§1 : atomicité Stage 2 quasi-gratuite, plus de
  `.json` orphelin, détection de drift). Informatif, **pas** une
  régression côté agent.
- **correction** : parité par construction (ci-dessus) + dump d'état
  final v1 vs `.kg.json` PoC (`v1_state_dump.mjs`). Le `verify.py`
  par-scénario (sidecar/KG_HOME-centré) est **hors périmètre v1**.

## Stacks

| | PoC (baseline gelée) | v1 |
|---|---|---|
| Branche | `feat/kg-memory-poc @ 9b9f680` (git worktree) | branche courante |
| KG → | sidecar Python → `KG_HOME/*.kg.json` | add-in C# → ES du `.rvt` |
| Revit | non | **oui** (add-in + **Switch** ON) |
| Profil | `kg_bridge/benchmark/live/profiles/poc-kg/.mcp.json` | `…/profiles/v1-kg/.mcp.json` |
| Reset | auto (`run_live` vide `KG_HOME`) | **`.rvt` vierge** avant le run |

> Si tu places le worktree ailleurs que `C:\Users\lauro\Documents\IT\poc-baseline`,
> ajuste les 2 chemins absolus de `profiles/poc-kg/.mcp.json`.

## 0. Prérequis (one-time)

```powershell
# (conda 'revitmcp' = node + python ; pas de .venv)
# --- worktree PoC gelé + build + networkx pour le sidecar ---
git worktree add --detach C:\Users\lauro\Documents\IT\poc-baseline 9b9f680
cd C:\Users\lauro\Documents\IT\poc-baseline\server ; npm install ; npm run build
C:\Users\lauro\AppData\Local\anaconda3\envs\revitmcp\python.exe -m pip install -r ..\kg_bridge\requirements.txt
# --- v1 : build courant à jour ---
cd C:\Users\lauro\Documents\IT\mcp-servers-for-revit-kg-poc\server ; npm run build
```

Approuver le serveur MCP **une fois par dossier profil** (sinon les runs
headless échouent) — pour `v1-kg`, Revit doit être ouvert + **Switch** ON :

```powershell
cd C:\Users\lauro\Documents\IT\mcp-servers-for-revit-kg-poc\kg_bridge\benchmark\live\profiles\poc-kg
claude            # approuver .mcp.json ; /mcp doit lister les kg_* ; exit
cd ..\v1-kg
claude            # idem ; /mcp doit lister les kg_* ; exit
```

## 1. Run PoC (pas de Revit)

```powershell
cd C:\Users\lauro\Documents\IT\mcp-servers-for-revit-kg-poc
python kg_bridge\benchmark\live\run_live.py `
  --kg-dir kg_bridge\benchmark\live\profiles\poc-kg `
  --out   kg_bridge\benchmark\live\out\poc --yes
```

## 2. Run v1 (Revit requis)

1. Revit 2025 : **Nouveau projet vierge** (= reset du KG ES), add-in
   chargé, bouton **Switch** ON.
2. ```powershell
   python kg_bridge\benchmark\live\run_live.py `
     --kg-dir kg_bridge\benchmark\live\profiles\v1-kg `
     --out   kg_bridge\benchmark\live\out\v1 --yes
   ```
3. **Sans fermer Revit** (état dans le `.rvt`), dump d'état final :
   ```powershell
   node kg_bridge\benchmark\live\v1_state_dump.mjs 8080
   ```

## 3. Comparaison

```powershell
python kg_bridge\benchmark\live\compare_stacks.py `
  --poc kg_bridge\benchmark\live\out\poc `
  --v1  kg_bridge\benchmark\live\out\v1
# -> out\v1\compare_stacks.{json,md}
```

Correction (parité d'état final) : diff `out\v1\v1_state.kg.json` contre
le `.kg.json` final du PoC
(`C:\Users\lauro\Documents\IT\poc-baseline\.kg-bench-poc\<project_id>.kg.json`)
— JSON trié des deux côtés (le dump v1 trie déjà ; `python -m json.tool`
pour trier le PoC).

## 4. Verdict

`compare_stacks.md` : viser **tokens/turns/cost `v1/poc ≈ 1` ou `<1`**
(non-régression agent) ; `wall s > 1` = coût d'internalisation documenté.
Si c'est le cas + parité d'état final ⇒ **v1 ≥ PoC** (§10.6 satisfait).

## Nettoyage

```powershell
git worktree remove C:\Users\lauro\Documents\IT\poc-baseline
```
