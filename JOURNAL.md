# JOURNAL

Journal de bord du travail KG. Convention reprise du projet source
(*claude-in-revit* — cf. les références « JOURNAL session … » dans
`kg_bridge/vendor/project_kg.py`). Entrée la plus récente en haut.

---

## 2026-05-18 — Fix : bulk (`kg-many`) par défaut = baseline claude-in-revit

Relevé par l'utilisateur avant de lancer le bench (à raison) : v1
n'était **pas** bulk par défaut. `mode.ts` `rawMode()` défaut = `"kg"`
→ `kgManyEnabled()` false → `kg_add_elements_many` /
`kg_modify_elements_many` / `kg_modify_where` **non enregistrés**. Or
claude-in-revit livre la *bulk-variant policy* (BENCHMARK.md : « kg-many
is the shipped baseline; the no-bulk profile is retired »). Le défaut
produit était donc en-dessous de la baseline qu'on compare.

- `server/src/kg/mode.ts` : défaut `"kg"` → **`"kg-many"`** (1 ligne +
  doc d'en-tête). `KG_BENCH_MODE=kg` reste dispo pour le profil
  singles-only. Build prod vert, **suite 60/60** (mode.ts non couvert
  par les tests mais aucune régression).
- `profiles/{v1-kg,poc-kg}/.mcp.json` : `KG_BENCH_MODE` `kg` → **`kg-many`**.
  Indispensable côté **PoC** : la branche gelée `9b9f680` garde l'ancien
  défaut `kg`, donc le profil DOIT forcer `kg-many` pour comparer la
  vraie baseline livrée.
- `BENCHMARK-v1.md` : régime `kg-many` sur les 2 stacks documenté +
  nuance honnête `run_live --kg-dir` ⇒ suffixe générique `SUFFIX["kg"]`
  (bulk *disponible*, pas *forcé* ; symétrique 2 stacks = équitable).

**Conséquence run** : tout run lancé avant ce fix était en `kg`
(singles), **hors baseline** → à refaire. L'ordre v1↔PoC reste sans
incidence (runs indépendants, dossiers `--out` distincts).

## 2026-05-18 — ÉTAPE 6 : scaffolding A/B live posé (exécution = poste user, facturable)

Choix utilisateur §10.6 : **A/B live complet** (Claude Code réel,
Anthropic facturable). Le harness hérité `run_live.py` pilote `claude -p`
par profil (`.mcp.json`) ; conçu flat-vs-kg sur 1 build → ici détourné en
**v1 vs PoC cross-branche** (2 stacks, 2 runs `--kg-dir`, comparaison).

Posé (tracké, non exécuté ici) :

- `kg_bridge/benchmark/live/profiles/{v1-kg,poc-kg}/.mcp.json` — profils
  (serveur nommé `revit` car `run_live` force `--allowedTools mcp__revit`).
  v1 = build courant, pas de `KG_*` env (KG dans le `.rvt`, Revit+Switch).
  poc = worktree gelé `9b9f680`, sidecar (`KG_PYTHON` conda + `KG_HOME`).
- `compare_stacks.py` — diff cross-stack des 2 `live_results.json`
  (tokens/turns/wall/cost, ratios v1/poc, verdict).
- `v1_state_dump.mjs` — dump état final v1 (`kg_blob_read` socket →
  forme `.kg.json`, log_chunks dépaquetés ≡ `assembleProjectKG`) pour la
  parité de correction vs `.kg.json` PoC.
- `BENCHMARK-v1.md` — protocole exact (worktree+build, approbation MCP
  one-time, 2 runs, compare, dump, verdict, cleanup).

Cadrage acté : tokens/turns/cost attendus `v1≈PoC` (surface portée 1:1) ;
`wall_s` `v1>PoC` **attendu & accepté** (Tx ES vs `.json` — coût
internalisation §1, pas régression agent) ; correction = parité par
construction (60/60 TS + 13 service + fumée 8/8) + dump d'état final.
Reset v1 = `.rvt` vierge (le harness ne sait pas vider l'ES). `verify.py`
par-scénario = hors périmètre v1 (sidecar/KG_HOME-centré).

Non commités (hors scope, apparus côté user) : `server/package-lock.json`
modifié (`npm install`), `server/dotnet` (chemin inattendu).

## 2026-05-18 — Fumée ES VERTE 8/8 : C# étapes 3 & 5 validé en réel (Revit 2025)

Première **exécution** réelle du C# ExtensibleStorage (compilé la veille,
jamais lancé). `server/scripts/kg-es-smoke.mjs` (zéro dép., parle direct
au socket Revit — isole la couche C#, sans client MCP) sur Revit 2025,
projet neuf « Projet1 » :

1. `kg_doc_state` OK (epoch=0, `EnsureSubscribed` §5 déclenché, sans Tx).
2. `kg_blob_read` projet vierge → `exists:false` (pas d'erreur — sémantique
   recreate-if-missing portée par le write).
3. `kg_blob_write` → `DataStorage` créée **dans une `Transaction`**
   (`wrote=true, created_data_storage=true`) — cœur étape 3.
4. `kg_blob_read` → **round-trip octet-pour-octet** du graphe + log chunké
   + `log_schema_version`.
5. `kg_doc_state` → **epoch inchangé 0→0** après notre write : le filtre
   §5 (Tx « KG blob write » ignorée) marche → le cache serveur ne
   rechargera pas sur nos propres écritures.

Conséquence : `KgExtensibleStorage` / `KgDocumentWatcher` / les commandes
`kg_blob_read|write` / `kg_doc_state` sont **prouvés en conditions
réelles**. Tout le pont TS↔C# (étape 4 + transport socket) tient. Reste :
re-bench v1 vs PoC (§10.6).

## 2026-05-18 — Build C# vérifié VERT (`Debug R25`) + `BUILD.md`

Première compilation réelle du C# des étapes 3 & 5 sur poste Windows+Revit
(impossible dans l'env de dev — node seul). **`RevitMCPCommandSet`
compile sans erreur** : prouvé par l'arbre de staging
`plugin\bin\AddIn 2025 Debug R25\` complet (plugin + commandset, code
`KnowledgeGraph\` inclus). Seuls warnings = `CS0618`/`CS0168` **amont
pré-existants** (hors périmètre, non touchés).

Pièges rencontrés, tous documentés dans **`BUILD.md`** (nouveau, tracké) :
- `MSB4126` : la solution n'a que des configs `… | Any CPU` → ne pas
  passer `-p:Platform=x64` (le x64 est forcé dans les `.csproj`).
- `MSB4062` : `RevitMCPCommandSet.Tests` (SDK `Nice3point.Revit.Sdk/6.1.0`,
  tâches MSBuild en `net10.0`) échoue faute de runtime .NET 10 → builder
  les 2 projets *runtime* directement, pas le `.sln` (le projet de tests
  C# est hors chemin étape 6).
- Faux négatif de vérif : `$root` non défini + `-EA SilentlyContinue` →
  toujours vérifier l'install par **chemin littéral** ; l'arbre
  `bin\AddIn …\` peuplé = preuve de référence que le build a réussi.

Reste : déployer dans `%AppData%\…\Addins\2025\` (auto en `Debug`, sinon
`robocopy` — cf. `BUILD.md` §3), puis **étape 6** (re-bench, requiert
Revit lancé + bouton *Switch* + serveur MCP).

## 2026-05-18 — ÉTAPE 5 terminée : protocole de cohérence cache↔`.rvt` (§5)

**Chemin spec §10.5 bouclé.** Le cache serveur ne peut plus mentir
silencieusement : un changement hors-bande du `.rvt` (édition humaine,
ouverture/bascule de document, Sync-to-Central) le force à recharger
depuis l'ES. Suite TS **60/60** (25 core + 19 persist + **16 service**,
dont 3 d'invalidation), build prod `tsc` vert.

**Décision tranchée (fork d'archi — pas de canal push).** Le socket est
requête→réponse : **aucun** push Revit→serveur. Plutôt que toucher au
plugin (`IExternalApplication`), on reste self-contained dans le
commandset (cohérent étapes 3–4) : un **epoch monotone** + identité
document, *sondés* à coût quasi nul par le serveur (commande
`kg_doc_state`, sans Tx) au début de chaque op KG. C'est la ligne « Cache
longue durée + signal d'invalidation » du tableau §5, le signal étant
sondé, pas poussé (1 a/r léger/op ; reload ES seulement si epoch/doc a
bougé → on garde « cache longue durée pour les écritures-outils »).

**Côté C# (build Revit requis — pas de SDK ici, comme étapes 3–4).**

- `commandset/Services/KnowledgeGraph/KgDocumentWatcher.cs` — static,
  souscription **lazy/idempotente** (depuis les handlers KG ; pas
  d'`IExternalApplication` à ajouter) à `DocumentChanged`/`DocumentOpened`/
  `DocumentSynchronizingWithCentral`. **Filtre clé** : un `DocumentChanged`
  dont *toutes* les Tx == `KgExtensibleStorage.WriteTransactionName`
  (constante désormais **publique partagée** — source unique, le filtre ne
  peut pas dériver) **n'incrémente pas** l'epoch ⇒ nos propres écritures
  ES n'invalident pas le cache. Capture deleted/added/modified ids
  (fenêtre bornée 10k/cat., par epoch) = **base `kg_detect_drift`**.
  Handlers d'événements sous try/catch (ne jamais lever dans Revit).
- `KgDocStateCommand.cs` / `KgDocStateEventHandler.cs` (moule, sans Tx) ;
  DTOs `KgDocStateParams`/`KgDocStateResult` (clés snake_case) ;
  `kg_doc_state` enregistré dans `command.json` ; `EnsureSubscribed`
  appelé aussi en tête des handlers blob read/write.

**Côté TS.** `transport.ts` : `KgDocStateProvider` (+ `SocketKgDocStateProvider`
réel, `NoopKgDocStateProvider` hors-ligne, factory lazy). `service.ts` :
cache devenu `{kg, docKey, epoch}` ; `getKg` sonde le provider →
`docKey`/`epoch` inchangés ⇒ cache gardé, sinon reload `loadProjectKG`.
Provider injectable ; défaut = Noop si un store est injecté (les 13 tests
existants **inchangés**, hors Revit), socket lazy en prod. 3 tests §5
(cache « périmé » stable, reload sur epoch++, reload sur docKey changé)
via un provider factice — zéro Revit.

**Différé explicite (§2 / Stage 2).** Basculer `deleted_at_turn` + tenir
la `Map<ElementId,llm_id>` sur les ids supprimés = refactor identité §2 ;
étape 5 ne fait que **câbler + exposer le signal**. Le drift n'est pas
encore consommé (`kg_detect_drift` = Stage 2).

**Prochaine session — ÉTAPE 6 (spec §10.6).** Re-bench v1 vs PoC sur le
harness hérité `kg_bridge/benchmark/` (prouver v1 ≥ PoC). Nécessite une
session Revit + le build C# du commandset (les commandes `kg_blob_*` /
`kg_doc_state` ne sont vérifiables qu'en env Revit). Après étape 6 :
suppression possible de `kg_bridge/{vendor,benchmark}/` (cf. décision
étape 4).

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
