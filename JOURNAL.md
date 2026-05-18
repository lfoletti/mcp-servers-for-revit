# JOURNAL

Journal de bord du travail KG. Convention reprise du projet source
(*claude-in-revit* — cf. les références « JOURNAL session … » dans
`kg_bridge/vendor/project_kg.py`). Entrée la plus récente en haut.

---

## 2026-05-18 — ÉTAPE 4 terminée : `kg_*.ts` rebranchés sur `core/`, sidecar supprimé

**Chemin spec §10.4 bouclé.** Le sidecar Python ne tourne plus nulle part :
le KG vit dans le `.rvt`. Suite TS **57/57** (25 core + 19 persist + **13
service**), build prod `tsc` vert.

**Nouveaux fichiers.**

- `server/src/kg/service.ts` — KG **en-process** : port **1:1** des 13
  méthodes du sidecar (`kg_sidecar.py`) sur `core/` (ProjectKG) +
  `persist.ts` (`saveProjectKG`/`loadProjectKG`). Mêmes noms/params/formes
  de résultat (projections compactes, `_node_view` *avec son quirk* `id`-
  dans-`attrs`, modèle « 1 op MCP == 1 turn ») ⇒ re-bench étape 6
  comparable + diff outils mécanique. Cache `Map<project_id,ProjectKG>`
  (= cache du blob ES, comme `_INSTANCES`) ; `call()` **sérialisés** (file
  interne — `transaction()` non réentrant, parité stdin-série du sidecar).
  `kgResult`/`kgError` déplacés ici (étaient dans `bridge.ts`).
- `server/src/kg/transport.ts` — `SocketKgBlobTransport` : unique
  réalisation concrète du port (étape 2) via `withRevitConnection` +
  `sendCommand("kg_blob_read"/"kg_blob_write")` (étape 3). Déballe
  l'`AIResult` C# en **tolérant les deux casings** du wrapper
  (`Success`/`success` — dépend du sérialiseur RevitMCPSDK) ; champs
  internes figés snake_case par `[JsonProperty]`. Store par défaut **lazy**
  (aucun socket à l'import — la registration importe tout au boot).

**Rebranchés.** Les 9 outils `kg_*.ts` : `../kg/bridge.js` →
`../kg/service.js`, `kgBridge` → `kgService` (diff mécanique, surface
`.call(method,params)` inchangée).

**Supprimés** (glue sidecar morte) : `server/src/kg/bridge.ts`,
`kg_bridge/kg_sidecar.py`, `kg_bridge/smoke_test.py`.

**Décision tranchée (fork spec §9/§10.4 vs §10.6).** §10.4 dit « retirer
`kg_bridge/` » mais §10.6 (re-bench v1≥PoC) **a besoin** du harness
`kg_bridge/benchmark/`, et §9 nomme `kg_bridge/vendor/project_kg.py` la
**référence figée** du port. → on retire seulement la glue sidecar
**morte** ; `kg_bridge/{vendor,benchmark}/` **conservés jusqu'à l'étape 6**
(suppression triviale plus tard, dé-suppression coûteuse ; le PoC gelé
`9b9f680` garde de toute façon `kg_bridge/` complet comme pièce à
conviction). Risque connu hérité du PoC (parité voulue) : mutation
appliquée en mémoire **puis** persistée ; échec socket ⇒ mémoire en avance
sur l'ES, résolu au reload (invalidation `DocumentChanged` = étape 5).

**Prochaine session — ÉTAPE 5 (spec §10.5).** Handlers C#
`DocumentChanged` / `DocumentOpened` / `DocumentSynchronizingWithCentral`
dans `commandset/Services/KnowledgeGraph/` : invalidation/reload du cache
serveur (cohérence §5) + bascule `deleted_at_turn` sur
`GetDeletedElementIds()` — base de `kg_detect_drift` (Stage 2). Puis
étape 6 : re-bench v1 vs PoC sur le harness `kg_bridge/benchmark/`.

## 2026-05-18 — ÉTAPE 3 terminée : commandes C# `kg_blob_read` / `kg_blob_write` (ES)

**Chemin spec §10.3 bouclé.** Premières — et seules — lignes
d'ExtensibleStorage du repo (aucune n'existait : `grep ExtensibleStorage`
ne trouvait que doc/spec). Écrites sur le **moule exact** de
`CreateLevelCommand` (commande → `ExternalEventCommandBase` →
`IExternalEventHandler`+`IWaitableExternalEventHandler` → `AIResult<T>`).

**Fichiers (auto-inclus, csproj SDK-style — rien à éditer côté .csproj).**

- `commandset/Services/KnowledgeGraph/KgExtensibleStorage.cs` — **source
  unique** des spécificités ES (faits §3 vérifiés, encodés inline) :
  schéma **GUID constant à vie** (le changer orpheline les blobs des
  `.rvt` existants), `AccessLevel.Public` r/w + VendorId, 3 Field
  (`graph` string, `log_chunks` Array<string>, `log_schema_version` int —
  **aucun flottant/XYZ → aucune unité**), find-or-create de l'**unique**
  `DataStorage` globale via `ExtensibleStorageFilter`, `Read` **sans Tx**
  / `Write` **en `Transaction`** (atomicité Stage 2 « gratuite », §1) +
  recreate-if-missing (§4).
- `…/KgBlobReadEventHandler.cs` / `…/KgBlobWriteEventHandler.cs` (moule
  `CreateLevelEventHandler` ; le read tourne quand même sur le thread API
  Revit via l'ExternalEvent — obligatoire même en lecture).
- `commandset/Commands/KnowledgeGraph/KgBlobReadCommand.cs` /
  `KgBlobWriteCommand.cs` (`CommandName` = `kg_blob_read` /
  `kg_blob_write`).
- `commandset/Models/KnowledgeGraph/KgBlobModels.cs` — DTOs aux clés JSON
  **figées snake_case** via `[JsonProperty]` (matchent **1:1** le
  `KgBlobRecord` TS de `persist.ts`, indépendamment du casing du
  sérialiseur).
- `command.json` : `kg_blob_read` + `kg_blob_write` enregistrés (dispatch
  = clé `commandName` → assembly).

**Décisions tranchées.** C# = **coffre à blob « bête »**, toute la
politique (chunking 16 Mo, schéma, compaction, versioning) reste côté TS
(`persist.ts`, étape 2) → ES non typé sur les attrs KG (NODE_TYPES évolue,
schéma ES figé une fois diffusé, §3). `projectId` **pas** un champ ES : il
vit déjà dans `graph` (`data.project_id`) et le garde-fou est côté TS
(`assembleProjectKG` `expectProjectId`). Wire = JSON-RPC sur socket
(`SocketClient.ts`) : `kg_blob_read` params `{}` → `result` =
`AIResult<{exists,graph,log_chunks,log_schema_version}>` (`exists:false`
⇒ le transport TS mappe sur `null`, pas d'erreur) ; `kg_blob_write` params
`{graph,log_chunks,log_schema_version}`. **Réalise** le port
`KgBlobTransport` posé étape 2 — rien à redéfinir côté TS.

**Vérif.** C# **non compilable dans cet env** (pas de SDK Revit / refs
`Nice3point.Revit.Api.*` ; conda `revitmcp` = node seul) — comme **toutes**
les commandes du repo, build dans l'env Revit (R20–R26, net48/net8). Suite
TS (étapes 1+2) **toujours 44/44** (aucun fichier TS touché ; vérifié non
nécessaire de relancer — rien de partagé modifié). Statut documenté dans
les deux `README.md` `KnowledgeGraph/`.

**Prochaine session — ÉTAPE 4 (spec §10.4).** Rebrancher les `kg_*.ts`
sur `core/` via `saveProjectKG`/`loadProjectKG` (étape 2) + un
`KgBlobTransport` réel = client `SocketClient`/`ConnectionManager`
appelant `kg_blob_read`/`kg_blob_write` ; retirer `bridge.ts` (sidecar)
puis `kg_bridge/`. Étape 5 ensuite : handlers `DocumentChanged`/`Opened`/
`Sync` (cohérence cache + base `kg_detect_drift`).

## 2026-05-18 — ÉTAPE 2 terminée : contrat `persist.ts` (agnostique du transport)

**Chemin spec §10.2 bouclé.** `server/src/kg/persist.ts` n'est plus un
stub : le contrat lecture/écriture du blob (graphe vivant + `action_log`
chunké) est **implémenté au-dessus de `core/`**, strictement agnostique
du transport. Étape 1 figée à `beacfb6` — **`core/` non modifié**.

**Architecture posée (forks tranchés, doc inline).**

- **Port de transport** `KgBlobTransport` + `KgBlobRecord` : le *seul*
  seam que les étapes 3/4 fourniront (client WebSocket→C#), taillé **1:1**
  sur `kg_blob_read`/`kg_blob_write`. `persist.ts` ne dépend QUE de ce
  port → agnostique du transport, par construction.
- **`KgBlobRecord`** = `{ graph (string ES), log_chunks (Array<string>
  ES), log_schema_version (int ES) }` : mappe **1:1** sur l'Entity de la
  `DataStorage` globale unique (§3, §4) — deux conteneurs distincts,
  mitigation du plafond 16 Mo/string.
- **`BlobKgPersistence`** réalise `KgPersistence` + `KgSnapshotStore`
  (read/write atomique de l'enregistrement entier = une Tx Revit, §1) en
  **read-modify-write** complet par op (design « toujours cohérent, 1 a/r »
  explicitement accepté §5 ; le cache d'écritures = étape 5, **hors** de
  ce module — séparation des responsabilités).
- **Pont core↔blob** : `splitProjectKG` (= `to_dict()` découpé en les 2
  conteneurs) / `assembleProjectKG` ; façade `saveProjectKG`/
  `loadProjectKG` (ce qu'appellera l'étape 4, ≡ `persist()`/`load()` du
  PoC mais vers ES).
- **`InMemoryBlobTransport`** zéro-dépendance : exerce TOUT le contrat
  *avant* que le C# (étape 3) n'existe = preuve concrète d'agnosticité.
  Clone profond en lecture ET écriture (isole comme une vraie frontière
  process — pas d'alias mémoire masquant un bug).

**Pièges traités (documentés inline).** Chunking append-**stable** (vieux
chunks immuables octet-pour-octet → cache/diff futurs) borné très en-deçà
des 16 Mo + garde-fou dur 15 Mio/chunk ; compaction **par chunk entier**
(jamais scindé ; chunk à cheval gardé entier — `diff_since()` ne lit
qu'une fenêtre récente) avec `turnOf` injectable (découple `persist.ts`
du schéma exact d'`ActionLogEntry`) ; `revit_binding` = **projection
dérivée** persistée pour la forward-compat §2 (non ré-appliquée tant que
`core/` porte encore `_revit_id` sur les nodes — documenté) ; schéma
forward-incompat **refusé** (pas parsé de travers) ; blob/chunk corrompu
→ `KgPersistenceError` dédiée.

**Suite.** **44/44 verts** : 25 core (étape 1, **intacts** — aucune
régression) + **19 tests de contrat** (`src/kg/__tests__/persist.test.ts`,
même runner zéro-dep). `tsconfig.test.json` élargi à `src/kg/**` (toujours
self-contained, que des builtins), glob `npm test` → `build-test/kg/**`.
Build prod (`tsc` strict) vert.

**Prochaine session — ÉTAPE 3 (spec §10.3).** Commandes C#
`kg_blob_read` / `kg_blob_write` sur le moule `CreateLevelCommand.cs` +
`DataStorage` recreate-if-missing ; elles réaliseront le port
`KgBlobTransport` (rien à redéfinir côté TS). Puis étape 4 : rebrancher
les `kg_*.ts` sur `core/` via `saveProjectKG`/`loadProjectKG`, retirer
`bridge.ts` + `kg_bridge/`.

## 2026-05-18 — ÉTAPE 1 terminée : port TS de `ProjectKG` + suite verte

**Chemin critique (spec §10.1) bouclé.** `kg_bridge/vendor/project_kg.py`
porté en TypeScript dans `server/src/kg/core/`, suite portée **1:1** dans
`server/src/kg/core/__tests__/` : **25/25 verts, iso-comportement** vs le
Python de référence.

**Sources & vérifs.**

- Référence figée confirmée **byte-for-byte** : SHA256 de
  `kg_bridge/vendor/project_kg.py` == upstream
  `claude-in-revit/.../lib/project_kg.py` (identique).
- Le « 821 » de la spec = total de la suite upstream *entière*. **Le**
  fichier qui couvre `project_kg.py` est `claude-in-revit/tests/`
  `test_project_kg.py` (25 tests) → porté 1:1. `kg_sync.py` /
  `test_kg_sync.py` = binding Revit, **hors scope** (exclu par le docstring
  du module Python lui-même). Périmètre étape 1 = ce fichier, vert à 100 %.

**Décisions d'implémentation (forks de la spec/README tranchés).**

- **Graphe** : adjacence maison (`graph.ts`), **pas** `graphology` —
  zéro dépendance, contrôle exact de l'ordre d'insertion + clonage plat.
- **Runner** : `node:test` intégré, **zéro dépendance** ;
  `tsconfig.test.json` (build isolé `build-test/`) + `npm test`. Le
  `tsconfig.json` de prod exclut désormais `__tests__` (pas dans le paquet
  npm). `clean` purge aussi `build-test`.
- **API** : surface en **noms Python** (snake_case, `to_dict`/`from_dict`/
  `transaction`, props `turn`/`action_log`) pour un portage de tests
  mécanique et minimiser la dérive silencieuse (spec §7).

**Pièges §7 traités (documentés inline).** Ordre `find_by_type` =
ordre d'insertion (`graph.ts`) ; rollback `transaction()` via
`structuredClone(to_dict())` ≡ `copy.deepcopy` + `from_dict`
(`project-kg.ts`) ; sérialisation `pyJsonDump` ≡
`json.dump(sort_keys=True, indent=2, ensure_ascii=True)` (`pyjson.ts`),
avec la **delta connue et acceptée `1.0`→`1`** (JS ne distingue pas
int/float ; `JSON.parse` relit de toute façon `1.0` comme `1` ; aucun test
n'asserte les octets bruts — round-trip sémantique seul).

**Env.** Node introuvable au PATH système ; build/tests lancés via le
node de l'env conda `revitmcp`
(`C:\Users\lauro\AppData\Local\anaconda3\envs\revitmcp`, Node v25.8.2).

**Prochaine session — ÉTAPE 2 (spec §10.2).** Implémenter le contrat
`server/src/kg/persist.ts` (interface déjà posée : `LiveGraphBlob` /
`LogChunks` / `KgPersistence`) au-dessus de `core/`, agnostique du
transport. Rien d'autre n'était bloquant : étape 1 verte débloque tout
le reste du plan.

## 2026-05-18 — Session conception v1 (internalisation ES, suppression du sidecar)

**Contexte.** Branche PoC `feat/kg-memory-poc` gelée à `9b9f680`
(= pièce à conviction + baseline de comparaison ; ne pas y toucher).
Nouvelle branche de travail : **`feat/kg-v1-internalized`**, créée *depuis*
le PoC pour hériter de la surface d'outils `kg_*.ts` réutilisable + du
harness de benchmark.

**Décisions actées** (détail : `DESIGN-internalize-es.md` §0) :

1. Sidecar Python **entièrement supprimé** → port **TypeScript** de
   `ProjectKG` obligatoire. Le portage des **821 tests** devient le
   **chemin critique**.
2. `llm_id` = **clé primaire** (compteur `_next_llm_id` conservé).
   `ElementId` = **liaison seule**, via une **`Map<ElementId, llm_id>`
   globale** ; remplace `_revit_id` + `full_rescan`, pas le `llm_id`.
   (4 raisons, dont le recyclage d'`ElementId` documenté comme crash dans
   `snapshot_revit_id_map_typed`.)
3. **Pas d'ancre par élément** → piège copier-coller éliminé, une seule
   `DataStorage` globale.
4. `action_log` **séparé** du graphe vivant (plafond ES 16 Mo/string ;
   doc Autodesk vérifiée) ; log = `Array<string>` chunké/compactable.
5. Le graphe TS en mémoire = **cache du `.rvt`** → protocole
   d'invalidation requis (`DocumentChanged/Opened/Sync`), indissociable
   du bénéfice détection-de-drift (Stage 2).
6. Worksharing : blob global suffit en mono-session ; hybride par-élément
   = endgame **différé**, hors périmètre v1.
7. Branche dédiée, **pas** fork (fork seulement si divergence durable
   vs objectif upstream).

**Fait cette session.**

- Spec réécrite et trackée : `DESIGN-internalize-es.md` (était une étude
  privée gitignored ; désormais spec v1 versionnée).
- Squelette posé : `server/src/kg/core/` (+ `__tests__/`),
  `server/src/kg/persist.ts` (contrat typé : `LiveGraphBlob` /
  `LogChunks` / `KgPersistence`, stub `NotImplemented`),
  `commandset/Commands/KnowledgeGraph/`,
  `commandset/Services/KnowledgeGraph/`, `reference/`.
- `.gitignore` : aucune modif en suspens (revenu à l'état du commit).

**Prochaine session — ÉTAPE 1 (chemin critique, spec §10).**
Démarrer à froid sur :

> Port TS de `ProjectKG` dans `server/src/kg/core/` **+ portage des 821
> tests** dans `server/src/kg/core/__tests__/`. Référence figée (lecture
> seule) : `kg_bridge/vendor/project_kg.py`. Critère de fin : suite verte
> **et iso-comportement** vs le fichier Python (pièges connus : ordre
> d'itération `find_by_type`, rollback `transaction()`, sérialisation
> `json.dump(sort_keys, indent=2)` vs `JSON.stringify`). Rien d'autre du
> plan ne démarre tant que ce n'est pas vert.

Le plan complet ordonné est dans `DESIGN-internalize-es.md` §10.
