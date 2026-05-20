# DESIGN — Knowledge Graph v2 : projection C# native, embedded-tx, single-source-of-truth

> Statut : **DRAFT** (2026-05-20). Décisions verrouillées + décisions
> ouvertes marquées explicitement (`DECISION NEEDED`). Inclut un plan
> Stage-3 chiffré pour trancher la perf réelle KG/no-KG.
>
> Branche cible : `feat/kg-v2` (pas encore créée). Précédent : `feat/kg-v1-internalized` (v1 = Stage-2 verdict §7(iv)).

---

## 0. Pourquoi une v2

**Verdict Stage-2** (`JOURNAL.md` 2026-05-20) : sur 11 scénarios × 2 stacks (A=Revit-direct, B=Revit+KG-v1), B coûte 1.91× A en moyenne, **jamais moins cher**, et **fabrique** sur 2/11 (Refactor/B renomme le KG sans toucher Revit ; P5/B prétend faux « KG=Revit match »). DESIGN §7(iv) confirmé : « *le KG interne ne vaut pas son coût en contexte modèle-vivant* ».

**Cause racine identifiée** : la v1 maintient **deux sources de vérité** (modèle Revit + blob KG) **et** expose les deux à l'agent. Trois symptômes en découlent :

1. **Divergence par construction** : `kg_modify_node` ne touche pas Revit ; `create_wall` ne touche pas le KG. Cohérence = discipline d'agent.
2. **Double surface de query** : l'agent doit choisir KG vs Revit à chaque question → tokens en plus, fabrication possible (cf. Refactor/B).
3. **Whole-blob read-modify-write** (`server/kg/persist.ts` lignes 23-25) : chaque mutation re-sérialise+re-shippe le graphe entier + log cumulé → O(état+historique) par write.

**Hypothèse v2** : déplacer le KG dans le **plugin Revit C#** comme **projection auto-maintenue du modèle**, exposer une **surface read-only** pour la famille structurelle, **ré-évaluer** dans un régime favorable (gros modèle, workflow long, queries multi-hop). Si la v2 perd encore le bench Stage-3 chiffré, la décision honnête sera de geler le KG interne ; si elle gagne, on a un produit.

---

## 1. Décisions verrouillées (input utilisateur 2026-05-20)

| # | Décision | Détail |
|---|---|---|
| L-1 | **C# natif, pas de sidecar** | Le KG core est porté en C# dans le plugin Revit. Pas de Python, pas de TS port — un runtime, un binaire. |
| L-2 | **CommandSet dédié** | Nouvelle assembly `RevitMCPKgCommandSet.dll` chargée par `plugin/Core/CommandManager.cs` via `CommandConfig` JSON. Isolation binaire, désactivable, accès natif au `Document` + `DocumentChanged`. |
| L-3 | **`diff_since` + cross-session = MUST** | Deux use cases non mesurés Stage-2 mais MUST-ship v2 : `kg_diff_since(turn)` (queries de différentiel) + persistance/restauration entre sessions. |
| L-4 | **Persistance delta** | Pas de whole-blob. Mutations append-only, projection reconstruite à la lecture (ou cache cohérent). Élimine la suite-4 debt. |
| L-5 | **Mirror structurel conservé** | Décision utilisateur : ne pas abandonner le mirror structurel sur la base de Stage-2 (échantillon trop petit, modèle trop petit, double surface). Validation déférée à Stage-3 sous régime favorable. |
| L-6 | **Transport delta = JSONL dans `kg_doc_state`** | Continuité v1 (même slot ES), effort port C# minimal, replay-only. Compaction occasionnelle (snapshot + truncate). SQLite-embed restera évolution possible si Stage-3 montre replay limitant. |
| L-7 | **Cold-start = eager full-scan** | Au session-open : replay journal + balayage doc pour reconcilier. Cohérence garantie avant la 1re query. Latence à mesurer Stage-3 ; bascule background si critère §8.4 (viii) échoue. |
| L-8 | **`project_id` = hash PathName** | Parité vendor (`kg_sync.project_id_for`). Ferme par construction le blocker v1 `kg-no-project-switch-affordance` (plus d'agent qui change manuellement le project_id). Save As ⇒ nouveau id (intentionnel). |
| L-9 | **Mono-document en v2.0** | Projection suit `ActiveDocument`. Swap au changement de doc Revit. Multi-doc en v2.1 si demande réelle. |
| L-10 | **Ontologie F2 v2.0 = 4 kinds** | `replaced_by` (MUST, validé Rebind) + `tagged` + `violates_rule` + `implements_intent`. **Caveat scope** : `violates_rule` et `implements_intent` sont **kinds réservés** — la KB règlementaire (`compliance_kb`, UC8 claude-in-revit) et le registre `intent_id` sont **hors v2.0**. Les 4 kinds acceptent `kg_annotate(payload=…)` libre ; aucune validation sémantique des arguments. Intégration KB / intent-registry en v2.1+. |
| L-11 | **Critère C/A favorable = ≤ 1.0 (parité)** | Sur sc. favorables KG (`Audit-XL`, `Fanout-XL`, `Resume`), v2 doit au moins égaler A pour être considérée gagnante sur son terrain naturel. |
| L-12 | **Taille modèle Stage-3 ≈ 500 éléments** | Au-dessus du seuil Stage-2 (~40 fen.) pour exposer le régime multi-hop où l'index KG doit battre `ai_element_filter`. Pré-construction `.rvt` ~1h. |
| L-13 | **Longueur workflow long ≈ 30 turns** | Sc. `M-Long` / `Drift-Long` / `Resume`. Suffit pour exposer le cohérence-overhead de A (re-query systématique) vs C (`diff_since`). |

---

## 2. Architecture

### 2.1 Topologie des processus

```
┌─────────────────────────────────────────────────────────────────┐
│ Revit process (process Autodesk)                                │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ revit_mcp_plugin (existing, R25)                         │   │
│  │                                                          │   │
│  │  ┌───────────────────────┐  ┌───────────────────────┐    │   │
│  │  │ Core/                 │  │ CommandSets/          │    │   │
│  │  │  Application.cs       │  │  RevitMCPCommandSet/  │    │   │
│  │  │  CommandManager.cs    │  │  (existing tools)     │    │   │
│  │  │  SocketService.cs     │  │                       │    │   │
│  │  └───────────────────────┘  ├───────────────────────┤    │   │
│  │                              │ RevitMCPKgCommandSet/ │    │   │
│  │  ┌───────────────────────┐  │  (NEW, v2)            │    │   │
│  │  │ Application.cs hooks:  │  │   ProjectKG.cs        │    │   │
│  │  │   DocumentChanged ────►│   Projection.cs        │    │   │
│  │  │   UndoOrRedo flag      │  │   DeltaStore.cs       │    │   │
│  │  └───────────────────────┘  │   KgCommands/*.cs     │    │   │
│  │                              │     (MCP-exposed)     │    │   │
│  │                              └───────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ JSON-RPC over TCP socket
                            │ (existing SocketService transport)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ MCP server (Node.js, server/)                                    │
│   Existing TS tools (server/tools/*) — unchanged                 │
│   NEW thin wrappers : kg_query, kg_diff_since, kg_traverse,      │
│                       kg_annotate, kg_resume_session             │
│   REMOVED v1 tools : kg_add_element, kg_modify_node,             │
│                      kg_blob_read/write, kg_soft_delete,         │
│                      kg_bind_revit_id (auto in v2)               │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Deux familles d'edges (sources de vérité distinctes)

Différenciation **architecturale**, pas seulement conceptuelle : la famille décide d'où vient l'edge et ce qui le tue.

| Famille | Source de vérité | Création | Modification | Suppression | Undo/Redo |
|---|---|---|---|---|---|
| **F1 — dérivée Revit** | Revit | Hook `DocumentChanged.GetAddedElementIds()` après commit | Hook `GetModifiedElementIds()` → diff edges → patch | Hook `GetDeletedElementIds()` → cascade depuis nœud | Symétrique (Revit émet le delta inversé, projection le rejoue) |
| **F2 — sémantique** | KG | `kg_annotate` (MCP, explicite) | `kg_annotate` (replace) | `kg_annotate(payload=null)` | **Survit** (cf. §6) |

**Edges F1** (portés depuis vendor) :
- `at_level` : Wall/Door/Window/Room/Floor/Column → Level
- `is_type` : instance → type (Wall→WallType, Window→FamilyType, etc.)
- `hosts` : Wall → Door/Window
- `bounded_by` : Room → Wall*
- `connects_at` : Wall → Wall (corner/T/cross)
- `derived_from` : élément → élément (lineage)

**Edges F2 v2.0** (verrouillage L-10) :
- `replaced_by(tombstone_id, new_id)` — audit trail post-soft-delete. Use case Rebind validé Stage-2.
- `tagged(node_id, tag_string)` — classement libre utilisateur/agent. Payload : `{ tag: string, scope?: string }`.
- `violates_rule(node_id, rule_id_string)` — **kind réservé**, KB règlementaire **hors v2.0**. Annotation manuelle uniquement (l'agent passe un `rule_id` libre, aucune validation). Intégration `compliance_kb` (UC8 claude-in-revit) en v2.1+.
- `implements_intent(node_id, intent_id_string)` — **kind réservé**, intent-registry **hors v2.0**. Annotation manuelle uniquement. Vocabulaire d'intents à formaliser en v2.1+.

Les 4 kinds partagent la même primitive d'écriture (`kg_annotate`, §2.5). Pas de schéma payload strict en v2.0 hors `replaced_by`/`tagged` ; `violates_rule`/`implements_intent` acceptent `{ rule_id|intent_id: string, note?: string }` libre.

### 2.3 Contrat embedded-tx (équivalent C# de `@kg_synced`)

L'invariant **clé** de claude-in-revit (`kg_sync.py:17-22`) : une mutation Revit et la mutation KG correspondante commitent ou rollback **ensemble**. Ordre :

```
1. Ouvrir KG transaction (snapshot interne)
2. Ouvrir Revit Transaction
3. Muter Revit
4. Si exception → rollback Revit (auto Revit Tx), puis restore KG snapshot, raise
5. Sinon → commit Revit Tx (fire DocumentChanged)
6. Dans le hook DocumentChanged → projeter le delta dans le KG (F1)
7. Persister le delta (append-only)
8. Si persist échoue après commit Revit → drift consigné, refresh à la prochaine query
```

**Différence clé v2** : le pas 6 n'est pas piloté par l'agent — c'est un hook plugin. **L'agent ne peut pas oublier de mettre à jour le KG.** La cause directe du failure Refactor/B disparaît.

**Drift window résiduel** (équivalent au `kg.persist()` failing du vendor) : le commit Revit a réussi mais l'append-delta échoue (disque plein, lock, plantage). Le KG en mémoire est cohérent, le persisté ne l'est pas. Mitigation : (a) checkpoint best-effort, (b) `kg_detect_drift` au session-resume re-projette les ElementIds présents dans le `.rvt` qui n'ont pas d'entrée KG correspondante.

### 2.4 Persistance delta (verrouillage L-4, L-6)

**Schéma append-only JSONL dans `kg_doc_state`** (L-6). Squelette logique :

```
Entry = { turn, op: create|modify|delete|annotate, node_id|edge_key, payload }
```

Persistance physique : **co-localisée avec le `.rvt`** via le slot `kg_doc_state` ES déjà existant (continuité maximale v1). Replay-only : pas d'index natif (différence avec SQLite-embed considérée comme évolution v2.1 si Stage-3 montre le replay limitant). Compaction occasionnelle (snapshot complet + truncate journal) déclenchée hors-bande (taille journal > seuil, ou explicit `kg_compact()` exposé MCP).

Reconstruction de la projection mémoire au session-resume = replay JSONL séquentiel + reconcile §4.1.

### 2.5 Surface MCP redéfinie

**Read-only, F1 + lifecycle** (auto-projeté, jamais écrit par l'agent) :
- `kg_query(node_type=?, attrs=?, edge_filter=?)` — recherche typée
- `kg_traverse(start_id, edge_path)` — multi-hop (ex. `Window --hosts⁻¹--> Wall --at_level--> Level`)
- `kg_diff_since(turn)` — différentiel d'actions (MUST L-3)
- `kg_get_node(id)` — par llm_id
- `kg_get_by_revit_id(revit_id)` — résolution croisée
- `kg_detect_drift()` — vérifie projection ≡ Revit ; renvoie les ElementIds manquants
- `kg_session_info()` — turn courant, project_id, dernier checkpoint

**Write, F2 uniquement** :
- `kg_annotate(from_id, to_id|null, kind, payload)` — créer/modifier/supprimer un edge F2 ou annoter un nœud

**RETIRÉS** (v1 → v2) :
- `kg_add_element`, `kg_modify_node`, `kg_soft_delete` (auto via embedded-tx)
- `kg_blob_read`, `kg_blob_write` (transport interne, plus exposé)
- `kg_bind_revit_id` (auto à la projection F1)
- `kg_add_elements_many` (bulks Revit, le hook batch reçoit `addedIds` ensemble)

**Effet sur Stage-2 failure modes** :
- Refactor/B (renomme le KG seul) : **impossible by API**. Pas de `kg_modify_node` exposé.
- P5/B (claim « KG=Revit match » faux) : **vrai par construction**. La seule façon de muter le KG est via une Tx Revit qui a committed.

---

## 3. Ontologie portée du vendor

Source : `C:/Users/lauro/Documents/IT/claude-in-revit/claude-in-revit.extension/lib/project_kg.py`. Portage **byte-for-byte** des contrats (pas du code Python, du **schéma**).

### 3.1 Types de nœuds (16, schéma strict required/optional)

`Level, Wall, Door, Window, Room, WallType, FloorType, Floor, Column, ColumnType, FamilyType, Stair, StairsType, ModelLine, DetailLine, DxfImportContext`

Détails (required attrs minimaux) : voir `project_kg.py:31-204`. Le port C# **doit** maintenir le contrat required/optional (validation côté projection).

### 3.2 Types d'edges (6, set fermé)

`at_level, is_type, hosts, bounded_by, connects_at, derived_from` (cf. `project_kg.py:217-224`).

Sémantique MultiDiGraph : **au plus une edge de chaque type entre un même (src, dst)**. Le port C# doit conserver cette invariante (impacte l'indexation interne).

### 3.3 Attributs framework

- **Lifecycle** : `created_at_turn` (int), `modified_at_turn` (list<int>), `deleted_at_turn` (int|null)
- **Revit binding** : `_revit_id` (long) — posé automatiquement par la projection F1 dès qu'un `ElementId` est connu
- **Provenance** : `_origin` (string, ex. "api"|"rescan"|"annotated")
- **Réservés** : `_type, _revit_id, _origin, created_at_turn, modified_at_turn, deleted_at_turn` (rejet à l'écriture utilisateur)

### 3.4 `SESSION_NODE_TYPES` (invariant à porter)

Sous-ensemble des nœuds **non reconstruits par rescan** (cf. `project_kg.py:206-213`) : `DxfImportContext, Stair`. Marqués par `rebuilt_by_rescan: false` côté schéma. Préservés au cold-start (cf. §4) et au `kg_detect_drift`.

**Implication v2** : ces types sont F2-comme (pas de source de vérité Revit) mais ont la forme de F1 (nœud typé). Compromis : les traiter comme F1 read-only pour l'agent mais **avec mutations explicites** via un canal restreint (ex. `kg_session_node_set(type, attrs)`). À cadrer en §7 si on porte `DxfImportContext` dès la v2 ou en v2.1.

### 3.5 Compteurs et identifiants

- `llm_id` : `{type_lower}_{counter:03d}` (ex. `wall_001`) — préservé entre rescans (cf. `kg_sync.full_rescan` policy 2026-05-11). Le port C# doit reconstruire le mapping `revit_id → llm_id` au cold-start pour stabilité UX.
- `turn` : compteur monotone par session ; `advance_turn` séparé de `add_node/modify/delete` pour permettre des "framework actions" (binding) sans bumper le turn.

---

## 4. Cold-start & cross-session (MUST L-3)

### 4.1 Cold-start

Quand un `.rvt` est ouvert :

1. **Restore** : si `kg_doc_state` contient un journal v2 → replay → projection en mémoire. Vérifie cohérence (turn final, dernier checkpoint).
2. **Reconcile** : `full_rescan` léger — balaye le doc, pour chaque ElementId présent vérifie un `_revit_id` correspondant dans la projection. Manquants → projeter (cas typique : `.rvt` édité hors-session sans plugin). Excédentaires (KG sans Revit) → soft-delete.
3. **SESSION_NODE_TYPES** : préservés pendant l'étape 2 (cf. `kg_sync.full_rescan` 2026-05-11).

### 4.2 Cross-session resume

`kg_resume_session()` exposé à l'agent en début de conversation : retourne `{project_id, turn, last_action_summary, n_nodes, n_edges}`. L'agent peut enchaîner sur `kg_diff_since(last_turn_of_previous_session)` pour reprendre.

**Cas dégénérés** :
- `.rvt` ouvert sur autre machine sans plugin → projection désynchronisée au retour → étape 2 ci-dessus corrige.
- `Save As` → nouveau `project_id` (cf. `kg_sync.project_id_for` : hash de `doc.PathName`) → KG nouveau, ancien garbage-collected.

---

## 5. Mécaniques de création (mémo §"comment seraient gérés les edges")

**Cas batch dans une seule Revit Tx** (l'agent crée Level + Wall + Window en un appel C# via `create_*` enchaîné) :

```
hook DocumentChanged reçoit:
  addedIds = [eid_level, eid_wall, eid_window]
  modifiedIds = []
  deletedIds = []

projection:
  pass 1 (nodes only):
    for eid in addedIds:
      type = inferType(doc.GetElement(eid))
      attrs = readAttrs(eid)
      llm_id = allocateOrLookup(type)
      kg.AddNode(llm_id, type, attrs, _revit_id=eid)
  pass 2 (edges):
    for eid in addedIds:
      llm_id = lookupByRevitId(eid)
      for (refKind, refValue) in readRefs(eid):  // LevelId, Host, GetTypeId
        if refValue != null:
          target_llm_id = lookupByRevitId(refValue)
          kg.AddEdge(llm_id, target_llm_id, refKind)
```

**Tri topologique non requis** grâce au deux-passes (les cibles d'edges existent toutes après pass 1). Surface API C# du KG core supporte `AddEdge` indépendamment de `AddNode` (le vendor le supporte aussi, cf. `project_kg.py:368` — la contrainte "edges only at node-creation" était une contrainte du **MCP wrapper v1**, pas du core, donc pas de fork de sémantique).

**Cas modify** (`GetModifiedElementIds()`) : pour chaque eid, ré-lire les références, diff contre les edges actuels, patch (remove old + add new). Atomique dans la projection.

**Cas delete** : cascade — supprimer edges incidents au nœud, soft-delete le nœud (`deleted_at_turn = current_turn`). Edges F2 incidents : **conservées** (cf. §6).

---

## 6. Undo/Redo (Ctrl+Z) — option A verrouillée

Revit émet `DocumentChanged` au Ctrl+Z avec `UndoOrRedo` flag dans `GetTransactionNames()` et le delta inversé dans `Added/Modified/Deleted`.

**Famille 1** : projeter le delta inversé symétriquement. Si Ctrl+Z annule un `create_wall`, le hook reçoit l'ElementId dans `deletedIds` → soft-delete le nœud → cascade.

**Famille 2** : **survit**. Rationale : une annotation F2 est l'historique de ce qui a été **tenté/exprimé**, pas de ce qui reste vrai. Un soft-delete suivi d'un Ctrl+Z effacerait sinon la trace `replaced_by`, ce qui défait le use case Rebind (validé Stage-2).

**Conséquence visible** : on peut voir un edge F2 `replaced_by(W1_tombstone, W2)` pointer vers un W1 actuellement non tombstoné. C'est de l'historique honnête, pas un bug. La doc agent doit le mentionner.

**Alternative refusée** (option B) : grouper "Revit op + F2 annotation" dans une Tx logique KG-side réversible par Ctrl+Z Revit. Trop complexe, brise l'audit trail.

---

## 7. Décisions ouvertes (résidu)

Les 6 décisions D-1 à D-6 ont été tranchées (cf. §1 L-6 à L-13 + §8.4). Résidu : seuils Stage-3 secondaires, à valider avant tout run facturable. Ces 4 valeurs sont posées comme **drafts pré-enregistrés** dans §8.4 ; je les liste ici pour ouverture explicite — change-les si elles te paraissent mal calibrées avant que Stage-3 démarre.

| # | Quoi | Draft posé | Effet d'un changement |
|---|---|---|---|
| R-1 | C/A seuil sur sc. **neutres** (`P1`, `S4`, `Q`, `M`) | ≤ 1.3 (overhead toléré 30%) | plus strict → plus de chances de fail "v2 saigne sur petits cas" |
| R-2 | C/A seuil "fail" sur petits cas | ≥ 1.5 = fail | plus permissif → laisse passer une v2 chère sur petit modèle |
| R-3 | Taux de drift détecté C/A (sc. `Drift-Long`) | C ≥ 90% / A ≤ 30% | les chiffres sont à la louche ; A=30% suppose que le prompt demande un re-query systématique, à valider |
| R-4 | Budget cold-start (sur modèle Stage-3 ~500 él.) | ≤ 5s acceptable | si > 5s observé → trigger pour bascule background L-7 (décision automatique, pas re-design) |

Si tu n'amendes pas, ces 4 drafts deviennent les critères de Stage-3.

---

## 8. Stage-3 — bench validant le mirror structurel

> **Objet** : trancher si la v2 mirror structurel-+-annotations gagne là où la v1 a perdu, ou confirmer §7(iv) Stage-2 dans un régime favorable et **enterrer** le mirror.
>
> **Cadrage neutre** : peut conclure « v2 ≥ A », « v2 ≈ A » ou « v2 < A ». Critères §8.4 **pré-enregistrés**, à la `DESIGN-bench-stage2.md §7`.

### 8.1 Ce que Stage-2 n'a pas mesuré

| Aspect | Stage-2 | Stage-3 ciblera |
|---|---|---|
| Taille modèle | petit-moyen (~40 fenêtres max créables, Audit petit) | **grand** (≥ 500 éléments cible, ≥ 100 fenêtres) |
| Longueur workflow | court (5-69 turns) | **long** (≥ 30 turns continus) |
| Multi-hop queries répétées | 1-3 questions par scénario | **≥ 10 questions multi-hop sur le même état** |
| `diff_since` | non utilisé | scénario dédié (resume avec `diff_since(turn_N)`) |
| Cross-session | non utilisé | scénario dédié (close+reopen, query après) |
| Drift detection long workflow | 1 drift unique, prompt court | drifts injectés à intervalle régulier, 30+ turns |

### 8.2 Stacks comparés (3 stacks, pas 2)

| Stack | Description | Rôle |
|---|---|---|
| **A** | Revit-direct, no-KG (`s2-direct` Stage-2, inchangé) | baseline, gagnant Stage-2 |
| **B** | Revit + KG-v1 (`s2-kg` Stage-2, inchangé) | perdant Stage-2, **pour confirmer la régression v1 sur grand modèle** |
| **C** | Revit + KG-v2 (nouveau, ce DESIGN) | le challenger |

Inclure B coûte $X mais permet de prouver que la v2 corrige des défaillances spécifiques de la v1 (Refactor fabrication, etc.).

### 8.3 Scénarios (extension Stage-2 + nouveaux)

**Extension de scénarios existants à grand modèle** :
- `Audit-XL` : audit conformité multi-zone sur **500 éléments** (vs 8 fenêtres Stage-2). Hypothèse : C/A < 1 (KG bat re-query Revit asymptotique).
- `Fanout-XL` : **10 questions** sur gros modèle (vs 3 Stage-2).
- `M-Long` : **30 mini-edits** consécutifs (vs 10), avec `kg_diff_since` à mi-parcours.

**Scénarios neufs (use cases MUST L-3)** :
- `Resume` : session 1 crée 20 éléments + 5 modifs → sauve `.rvt` → ouvre nouvelle session Claude Code → `kg_resume_session()` + `kg_diff_since(last_turn)` → questions. Mesure : turns/cost à reprendre.
- `Drift-Long` : 30 turns avec drift injecté tous les 5 turns (out-of-band element edit). Mesure : taux de détection de drift et coût-de-rattrapage.

**Scénarios de stress F2** :
- `Audit-Trail` : 10 cycles delete+recreate avec annotations `replaced_by`. Mesure : intégrité audit trail, coût d'annotation.

### 8.4 Critères chiffrés (PRÉ-ENREGISTRÉS, drafts en attente d'amendement R-1..R-4)

> Statut : **drafts** §1 L-11/L-12/L-13 verrouillés ; §7 R-1..R-4 amendables. Format inspiré de `DESIGN-bench-stage2.md §7`.

**Fiabilité** (vs vérité `.rvt`) :
- (i) C ≥ A en correction sur **chaque** scénario (jamais moins fiable). **0 fabrication tolérée.**
- (ii) C strictement meilleur que B sur Refactor (pas de "renomme KG seul" possible by API) et P5 (pas de claim "KG=Revit" faux). C **élimine** les 2 failure modes Stage-2.

**Coût** :
- (iii) **L-11** : C/A ≤ 1.0 sur scénarios "favorables KG" (`Audit-XL`, `Fanout-XL`, `Resume`, `Drift-Long`). C doit au minimum égaliser A sur son terrain.
- (iv) **R-1** : C/A ≤ 1.3 sur scénarios "neutres" (`P1`, `S4`, `Q`, `M`). C ne doit pas saigner sur petits cas.
- (v) **R-2** : C/A ≥ 1.5 sur petits cas = **fail** : overhead cold-start/hook/projection trop cher.

**Use cases MUST** :
- (vi) `Resume` finissable en C, infaisable en A (A n'a pas de mémoire entre sessions par construction). Succès qualitatif : "C finit en N turns, A ne finit pas".
- (vii) **R-3** : détection de drift `Drift-Long` ≥ 90% en C (`kg_detect_drift`), ≤ 30% en A (A doit le détecter par re-query systématique = prompt-dépendant).

**Conditions opérationnelles** :
- (viii) **R-4** : cold-start ≤ 5s sur le modèle Stage-3 (~500 él.). Si dépassé → bascule L-7 vers background (décision automatique, pas re-design).
- (ix) `kg_diff_since` retourne le delta correct sur 100% des cas testés (validation fonctionnelle, pas un threshold).

### 8.5 Verdict pré-enregistré

Avant tout run, **on s'engage** sur :

| Si... | Alors verdict |
|---|---|
| (i)+(ii)+(iii)+(iv) tous OK | **C ≥ A**, le mirror structurel v2 paie. v2 ship. |
| (i)+(ii) OK mais (iii) KO | C élimine les failures mais reste cher. **Cas Rebind-only** : ship v2 pour audit-trail+cross-session, ne pas promouvoir le mirror structurel comme query primaire. |
| (i) KO sur ≥ 1 scénario | C fabrique malgré l'embedded-tx. **Bug bloquant**, pas de ship. |
| (iii) KO + (vi)+(vii) OK | C perd le mirror mais gagne le temporel. Réduire le scope v2 aux primitives temporelles + annotations. **Pas de mirror.** |
| Tout KO | Stage-2 §7(iv) confirmé à plus grande échelle. **Geler le KG interne**, recentrer hors-Revit. |

### 8.6 Budget Stage-3 (estimation)

Stage-2 = $32.16 pour 11 scénarios × 2 stacks. Stage-3 = ~9 scénarios × 3 stacks, scénarios plus longs (`M-Long` 30 turns, `Drift-Long` 30 turns) → estimation à la louche **$60-90 facturable**. Pilote non-facturable (P1+P3 sur stack C neuf) avant la matrice complète, pour valider la télémétrie et le verifier.

---

## 9. Phases d'implémentation

> Estimation effort à la louche. Aucune n'est verrouillée — c'est un séquençage cohérent, pas un planning.

| Phase | Contenu | Effort estimé | Gate |
|---|---|---|---|
| **P0** | Scaffolding `RevitMCPKgCommandSet` (csproj, AssemblyInfo, intégration `CommandManager`) | 0.5 j | dll charge sans erreur |
| **P1** | Port C# `ProjectKG` core (nodes, edges, transaction, action_log, schema validation). **Pas de Revit binding encore**. Tests unitaires miroirs des 821 vendor. | 4-6 j | tests passent, parité fonctionnelle avec vendor sur les cas tests portables |
| **P2** | Hook `DocumentChanged` + projection F1 (`Projection.cs`). Création/modify/delete des edges F1 dans le hook. Pas encore d'undo. | 2-3 j | dry-run : créer 1 mur via `create_*` Revit, vérifier le nœud Wall + edges `at_level`/`is_type` apparaissent |
| **P3** | Undo/redo support (`UndoOrRedo` flag, delta inversé). | 1-2 j | dry-run : Ctrl+Z après create, le nœud disparaît |
| **P4** | Embedded-tx wrapper (`@kg_synced` équivalent C#) sur les `create_*`/`modify_*`/`delete_*` du CommandSet existant. | 1-2 j | dry-run : `create_wall` qui throw côté Revit → KG snapshot restauré |
| **P5** | Persistance delta (DECISION-1) + replay au cold-start. | 2-3 j | close+reopen `.rvt`, projection identique |
| **P6** | API MCP : `kg_query`, `kg_diff_since`, `kg_traverse`, `kg_get_by_revit_id`, `kg_detect_drift`, `kg_session_info`. Wrappers TS thin. | 1-2 j | tools déclarés, dry-run end-to-end via Claude Code |
| **P7** | API MCP F2 : `kg_annotate` + ontologie DECISION-3. | 0.5-1 j | annotate Rebind audit trail |
| **P8** | Pilote Stage-3 (P1+Audit-XL sur stack C non-facturable, verifier les chiffres). | 1 j | télémétrie correcte, verifier ok |
| **P9** | Matrice Stage-3 facturable. | 1 j run + 1 j analyse | verdict §8.5 |

**Chemin critique** : P0→P1→P2→P3→P4 = MVP fonctionnel embedded-tx (~9-14 j). P5-P7 ajoutent les MUST L-3 (~4-6 j). Stage-3 ferme (~3 j).

---

## 10. Risques & non-goals

### Risques

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| `DocumentChanged` ne fire pas pour certaines voies d'édition (link reload, family update) | moyenne | moyen (drift silencieux) | `kg_detect_drift` au session-resume + tests P2 sur cas connus REVIT_API_NOTES |
| Hook synchrone bloque l'UI Revit sur gros batch (P5 = 320 éléments) | moyenne | élevé (UX) | profilage P2/P3 ; bascule async si > 100ms par batch |
| Cold-start lent (> 10s) sur gros `.rvt` | moyenne | moyen | DECISION-2 background ; cache mtime-validated |
| Port C# diverge du vendor (semantic drift) | basse-moyenne | élevé (bug compliance) | tests portés byte-equivalent ; revue croisée vendor |
| `IUpdater` perf-kill | basse | élevé | **ne pas utiliser `IUpdater`** ; rester sur `DocumentChanged` post-commit |
| Drift window `persist` après commit Revit | basse | bas | best-effort + `kg_detect_drift` au resume (déjà §2.3) |

### Non-goals v2.0

- **Multi-utilisateur** / Worksharing : KG local par session, comme v1.
- **Multi-document** : mono-doc, DECISION-5.
- **DXF import context portage complet** : `DxfImportContext` peut rester côté Python sidecar de claude-in-revit ; v2 le supporte comme nœud F2-like mais ne le mute pas auto.
- **Shared parameter project_uuid** : DECISION-4 défaut hash PathName.
- **UI Revit** (panneau, browser KG) : hors scope, agent-only.
- **Rendu graphique** du KG : hors scope.

---

## 11. Sources & références

- `JOURNAL.md` 2026-05-20 — verdict Stage-2 §7(iv) (point de départ v2)
- `DESIGN-bench-stage2.md` — modèle pour critères pré-enregistrés (§7, §8)
- `DESIGN-kg.md` — DESIGN original v1 (use cases hérités §2)
- `DESIGN-internalize-es.md` — v1 internalisation, contraintes `kg_doc_state` ES blob (DECISION-1)
- `C:/Users/lauro/Documents/IT/claude-in-revit/claude-in-revit.extension/lib/project_kg.py` — ontologie source (§3)
- `C:/Users/lauro/Documents/IT/claude-in-revit/claude-in-revit.extension/lib/kg_sync.py` — contrat `@kg_synced` (§2.3)
- `C:/Users/lauro/Documents/IT/claude-in-revit/DESIGN.md` — use cases claude-in-revit (UC1-UC8, §UC8 = source famille 2 compliance)
- `plugin/Core/CommandManager.cs` — pattern CommandSet (§2.1)
- Mémoire `[[stage2-verdict]]`, `[[kg-no-project-switch-affordance]]`, `[[kg-soft-delete-no-cascade]]` — invariants v1 à corriger
