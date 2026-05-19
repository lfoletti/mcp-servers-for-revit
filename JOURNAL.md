# JOURNAL

Journal de bord du travail KG. Convention reprise du projet source
(*claude-in-revit* — cf. les références « JOURNAL session … » dans
`kg_bridge/vendor/project_kg.py`). Entrée la plus récente en haut.

---

## 2026-05-19 (soir, suite 7) — 📐 DESIGN Stage-2 « create-for-real » (éval neutre fiabilité/coût A vs B)

Demande utilisateur : concevoir (en //, sans lancer) un bench Stage-2
où le bâtiment est **créé pour de vrai** dans le `.rvt` et l'agent
répond « par tous moyens » (interroger le modèle vivant inclus).
**But explicite : évaluer honnêtement avantages/inconvénients RÉELS
(fiabilité + coût) des 2 approches — PAS prouver que le KG gagne** ;
le design doit pouvoir conclure « KG interne non rentable en contexte
modèle-vivant ». Doc : `DESIGN-bench-stage2.md` (tracké).

Points clés actés : stacks **A = Revit-direct/no-kg** vs **B = Revit +
KG-interne** (les 2 ont Revit, seule différence = maintenir/utiliser un
index KG) ; flat-SQLite hors périmètre. C'est l'axe « Revit-augmented /
Stage-2 » déjà signalé différé par `BENCHMARK.md`/`DESIGN-kg.md`. Il
**mesure** ce que Stage-1 ne fait que **modéliser** (coût query
modèle-vivant). **Prérequis bloquant** : le binding KG↔ElementId
(`Map<ElementId,llm_id>`, §2/Stage-2 **différé & non prouvé**) — sans
lui S5 (drift) est inévaluable et la fiabilité de B est conditionnée à
une feature non construite. Vérité-terrain = le `.rvt` réel → **nouveau
vérificateur déterministe** à concevoir (ingénierie neuve, dry-run non
facturable d'abord). Critères pré-enregistrés (incl. issues où B perd /
KG non rentable). Plan de-risk : dry-run vérificateur → valider binding
→ **pilote S1+S3 seulement** → matrice complète si verts. Séquencement
recommandé : **après** clôture du 17×3 (run flat `b10bfnziw` en cours).

## 2026-05-19 (soir, suite 6) — ⚖️ NOTATION verify.py : 0 fabrication ; v1 cœur-7 = PoC (juge déterministe) ; limite ES mono-projet actée

Demande : ajouter le verdict claim↔état {correct/fabricated/
honest_incomplete/indeterminate} du 1er benchmark. Fait, **scopé
honnêtement**.

**Adaptation (non facturable, validée hors-ligne avant dépense) :**
`verify.py` **inchangé** (couvre les 17 ; `pick_project` tolère le
project_id ; forme `.kg.json` compatible). Seul `run_live.py` adapté :
`read_profile` expose le `command` du `.mcp.json` ; `snapshot_state`
dumpe l'ES v1 par scénario via `v1_state_dump.mjs` quand pas de
KG_HOME. Test direct (import + appel, tmp) → snapshot v1 à la forme
exacte verify.py. Re-run scoré des 2 stacks (`--snapshot`,
`--timeout 1200`, reset v1/​set), `out/scored-{poc,v1}-{core,bulkN,
cases,modwhere,wow}`.

**⚠️ 2ᵉ aveu méthodo (lié à la dette mono-projet).** Les snapshots v1
extra sont **non fidèles** : l'ES v1 = **un seul blob = un seul
projet** ; `v1_state_dump` lit ce blob unique ; les scénarios extra
utilisent des `project_id` distincts (`Resume`, `RoomBench20`,
`Tower`…) que l'agent n'écrit pas toujours sous "Demo" → snapshots
`cs9_a/b` = 0 nœud, `bulkN n20` bloqué à 11. Donner ça à verify.py
produirait des `fabricated` **FAUX**. Refusé. **v1 cœur-7** (tout sur
"Demo", cohérent) reste fidèle ; PoC (sidecar multi-projet, un
`.kg.json`/projet) entièrement fidèle. → C'est une **limite v1
substantielle** (l'ES mono-projet ne peut pas supporter le scoring
par-scénario multi-projet comme le sidecar) ; prolonge la dette
« whole-blob / mono-projet » (suite 4) — Fix B-3 / ES multi-projet la
lèverait.

**Résultats verify.py (le vrai juge) :**

| | correct | fabricated | honest_inc | indét | $/correct |
|---|--:|--:|--:|--:|--:|
| **PoC — 17 scén.** | **17** | **0** | 0 | 0 | 0.612 |
| **v1 — cœur-7** | **7** | **0** | 0 | 0 | 0.299 |
| Face-à-face cœur-7 PoC | 7/7 | 0 | | | 0.321 |

Par scénario : tous `correct` (état pour les BIM-représentables ;
`claim` pour S3 lecture-seule & S5 honnêteté-drift). **0 fabrication
des deux côtés.** Sur le set canonique §10.6 (cœur-7), juge
déterministe : **v1 7/7 correct = PoC 7/7 correct, 0 fabrication, v1
~7 % moins cher/correct (0.299 vs 0.321 $)**. PoC 17/17 = preuve forte
que le PoC gelé est correct sur toute la suite.

**VERDICT (niveau de preuve le plus haut atteignable) :**
- **§10.6 cœur-7 : v1 = PoC en correction (7/7, 0 fabriqué), v1 moins
  cher — RIGOUREUSEMENT PROUVÉ** (juge claim↔état, plus seulement
  `err=False`). v1 ≥ PoC confirmé.
- **v1 extra-10 : non state-scorable** (ES mono-projet, limite
  documentée — PAS « v1 fabrique »). Correction extra v1 = err=False +
  parité-par-construction + spot-check exact `wow`/Tower (déjà acté
  `dcd4533`). PoC extra : 10/10 correct au juge.
Artefacts gitignored : `out/scored-{poc,v1}-*`,
`scored-poc-core/verify_report.{json,md}` (PoC 17),
`scored-v1-core/verify_report.{json,md}` (v1 cœur-7).

## 2026-05-19 (soir, suite 5) — 🏁 BENCH COMPLÉTÉ (17 scénarios) : v1 ≥ PoC — + aveu méthodo

Extension demandée : passer les 10 scénarios « manquants » (`bulkN` 4,
`cases` 3, `modwhere` 2, `wow` 1) en A/B v1-vs-PoC, même protocole que
le cœur-7.

**⚠️ Aveu méthodo (ma faute).** Mon analyse d'isolation (« pas de reset
inter-set nécessaire ») était FAUSSE : l'ES v1 est mono-projet et n'est
pas vidé entre sets → 1er run v1 extra **confondu** (tout accumulé dans
un `Demo` à 222 nœuds ; `bulkN`/`modwhere` dégradés, `wow` DNF 600 s).
Détecté via le dump ES. Correctif : `server/scripts/kg-reset.mjs`
(générique ; vide le blob mono-projet) appelé **avant chaque set** +
`--timeout 1200`. PoC restait propre (`run_live` vide `KG_HOME` par
invocation). Sorties confondues archivées `out/v1-prompts_*-contaminated`
(non utilisées). Les chiffres ci-dessous = **run v1 extra CORRIGÉ**
(reset confirmé `removed=true → 0/0` ×4 ; 10/10 `err=False` ; `wow`
DNF→**322,88 s/11 turns** ⇒ l'échec `wow` était 100 % l'artefact de
contamination, PAS une régression Fix B).

**Totaux v1/poc par set (corrigé, < 1 = v1 mieux ; cœur-7 rappel) :**

| set | n | out tok | turns | wall s | cost $ |
|---|--:|--:|--:|--:|--:|
| cœur-7 | 7 | x0.931 | x1.049 | x0.911 | x0.943 |
| bulkN | 4 | x1.148 | x0.829 | x1.152 | x0.887 |
| cases | 3 | x0.707 | x0.789 | x0.739 | x0.739 |
| modwhere | 2 | x0.716 | x1.0 | x0.985 | x0.962 |
| wow | 1 | x0.789 | x0.407 | x0.743 | x0.709 |
| **TOTAL 17** | **17** | **x0.818** | **x0.853** | **x0.890** | **x0.858** |

(in tok TOTAL x0.953 ; `modwhere` in x2.0 = absolu minuscule 92 vs 46,
cache-cheap, négligeable au coût.)

**Agrégé sur les 17 : v1 ≥ PoC sur in/out/turns/wall/cost** (TOUS < 1,
y compris `wall` x0.890 — le surcoût d'internalisation ES ne domine pas
même sur le set étendu, plus écriture-lourd). Seule exception : `bulkN`
où v1 est légèrement pire en out (x1.148) & wall (x1.152) — le **coût
whole-blob-write sur seed bulk de Rooms**, exactement la dette « suite
4 » (cost reste x0.887 < 1, turns x0.829 < 1 : pas une régression
agent). `cases`/`wow` = victoires v1 nettes ; `wow` passe de DNF à
**x0.407 turns / x0.709 cost** + parité nœuds+conformité exacte (PoC
Tower vs v1 : 53 nœuds, même by_type, 18/18 sills @0.9 ; écart arêtes
81/96 = latitude modélisation agent, documentée, pas un défaut).

**Correction (périmètre choisi : sans verify.py/--snapshot).** Extra-10
= parité-par-construction (surface 1:1, 60/60 TS + 13 service) +
`err=False` 10/10 (agent auto-confirme les comptes exacts demandés par
chaque prompt) + spot-check déterministe `wow`/Tower exact. Pas de
notation déterministe par scénario (option verify.py déclinée par
l'utilisateur). Cœur-7 garde sa parité d'état finale exacte (`bf4264a`).

**VERDICT ÉTENDU : sur 17 scénarios, v1 ≥ PoC partout (tokens/turns/
wall/cost < 1), 0 erreur après correctif, parité où vérifiable.** §10.6
non seulement satisfait (cœur-7, `bf4264a`) mais **renforcé** par le set
étendu. Réserve unique & honnête : `bulkN` expose le coût whole-blob-
write (dette « suite 4 », fix = B-3 post-bench). Artefacts gitignored :
`out/{poc,v1}-prompts_*` ; confondus : `out/v1-prompts_*-contaminated`.
Coût extra ≈ PoC 8,93 $ + v1 (confondu, jeté) + v1 corrigé ≈ 13 $.

## 2026-05-19 (soir, suite 4) — 🧱 DETTE D'ÉCHELLE : whole-blob write O(état+historique)/op + PLAN Fix B-3

Question utilisateur (suite à la contamination du blob v1) : « tout le
blob est-il transporté à chaque requête ? » Réponse vérifiée dans le
code — **distinguer lectures et écritures.**

**Blob** = `KgBlobRecord = { graph (1 string ES), log_chunks
(Array<string> ES, action_log append-only chunké), log_schema_version }`
dans **une seule `DataStorage` globale** (mono-projet).

**Lectures (`kg_query`/`diff_since`/`stats`) — PAS de transport du blob
par requête.** Le cache §5 (`service.ts getKg`) ne fait qu'un sondage
`kg_doc_state` minuscule (epoch/docKey, ~13 ms, sans Tx) ; tant que
l'epoch n'a pas bougé → `ProjectKG` en mémoire, **aucun read**. Blob
relu seulement sur cache-miss (1er accès / restart / changement
hors-bande). Vérifié `kg-svc-probe` (§5 holds, no per-op reload).

**Écritures (`kg_add_element`/`modify_*`/`soft_delete`) — OUI, tout le
record part à chaque op.** `persist.ts` l.23-25 : *« read-modify-write
de l'enregistrement complet à chaque opération mutante — design
"toujours cohérent, 1 a/r par op" accepté §5 »*. Chaque mutation ne
**relit pas** (cache) mais **re-sérialise + ré-émet l'intégralité**
(`graph` entier + **tous** les `log_chunks`) en 1 `Transaction` Revit.
= **O(état total + historique total) par écriture**, pas O(delta).

**Conséquences.** Payload d'écriture **monotone croissant** (taille
projet + historique append-only). C'est précisément pourquoi le blob
`Demo` contaminé à 222 nœuds rendait chaque write suivant énorme
(`bulkN`/`modwhere` dégradés, `wow` DNF). **Ne passe pas à l'échelle**
(gros modèles / longue histoire). Dette architecturale réelle, pas un
détail. Atténué mais pas résolu : cache §5 (tue le coût *lecture*) ;
log chunké + compactable (`persist.ts` l.18-20/92-100 : ≤1 Mo/chunk,
plafond 16 Mo, vieux chunks élaguables, `diff_since` = fenêtre récente)
→ réduit *combien* de chunks, pas le caractère whole-blob ; **Fix B** a
rendu les gros writes **non bloquants**, **pas moins chers**.

**(b) PLAN POST-BENCH — Fix B-3 = prochaine étape architecturale.**
Sortir du whole-blob write. Deux formes (à arbitrer) :
1. **Persistance delta / append-only** : n'écrire que les *nouvelles*
   entrées de log + le delta de graphe, au lieu du record complet.
   Le log étant déjà append-only & chunké, append le(s) chunk(s)
   actif(s) seulement ; graphe en patch incrémental ou snapshot
   périodique + replay.
2. **Write-behind** : journal local append-only = vérité immédiate ;
   checkpoint ES asynchrone/coalescé. Découple la latence ES du chemin
   critique agent.
Implications : **change le contrat `persist.ts`** (« 1 a/r complet par
op » §5) → re-concevoir la cohérence cache↔ES + la crash-safety
(au moins aussi soigneusement que Fix A) ; **plus gros que Fix A/B** ;
**NON requis pour §10.6** (satisfait par le cœur-7, déjà commité
`bf4264a`). Séquencement : **après** la clôture du bench (extra-sets en
cours). Réf. `DESIGN-internalize-es.md` §1/§5/§10 (le « write-cache
étape 5 » est la lecture ; B-3 est le pendant écriture, non spécifié).

## 2026-05-19 (soir, suite 3) — 🏁 A/B LIVE FACTURABLE : v1 ≥ PoC — §10.6 SATISFAIT

Run A/B complet (Claude Code réel, `claude -p`, facturable) v1 (Revit +
ES, build patché Fix A+B) vs PoC gelé `9b9f680` (sidecar), `--steer
kg-many`, seed + S1–S6 (7 prompts). Préconditions vérifiées non
facturables (builds, sidecar networkx, profils ; **approbation MCP
re-faite par l'utilisateur** ; 3 sondes headless ~0,32 $ ont prouvé que
les kg_* se chargent en headless des 2 côtés — de-risk avant dépense).
Sorties VOID pré-fix archivées `out/{poc,v1}-void-prefixAB`.

**Résultat — 0 erreur / 0 timeout, 7/7 scénarios des 2 côtés.** Le
`00_seed` v1 (qui s'évaporait à 120 s avant) : **197 s, err=False**.
Totaux `v1/poc` (`compare_stacks`) :

| métrique | PoC | v1 | v1/poc | §10.6 |
|---|--:|--:|--:|---|
| in tok | 78 | 78 | x1.00 | ✅ |
| out tok | 32 505 | 30 254 | **x0.931** | ✅ <1 (−7 %) |
| turns | 41 | 43 | x1.049 | ✅ ≈1 |
| wall s | 540.9 | 492.6 | **x0.911** | ✅ <1 (−9 % ; surcoût ES attendu NON matérialisé) |
| cost $ | 2.539 | 2.395 | **x0.943** | ✅ <1 (−5,7 %) |

**Parité d'état final EXACTE** (`v1_state_dump` ES live vs PoC
`.kg-bench-poc/Demo.kg.json`, structurel — la géométrie est agent-choisie
non figée) : les deux = `project_id=Demo`, **32 nœuds / 56 arêtes**,
même distribution (`FamilyType 1, Level 2, Wall 20, WallType 1, Window
8` ; `at_level 20, hosts 8, is_type 28`). Ce n'est **pas** l'artefact
VOID (« moins cher car fait moins ») : v1 a fait **tout le travail** ET
est ≈/meilleur sur chaque métrique agent. + surface 1:1 (60/60 TS + 13
service + fumée ES 8/8).

**VERDICT : v1 ≥ PoC sur in/out/turns/wall/cost, parité d'état exacte
→ §10.6 « prouver v1 ≥ PoC » SATISFAIT.** L'arc complet (diag du seed
qui s'évaporait → Fix A honnêteté → Fix B cause racine transport C# →
validation à froid → A/B facturable) est clos avec succès. Artefacts
(gitignored, données de travail) : `kg_bridge/benchmark/live/out/{poc,
v1}/live_results.{json,md}`, `out/v1/compare_stacks.{json,md}`,
`out/v1/v1_state.kg.json`. Coût A/B ≈ 4,93 $ (PoC 2,54 + v1 2,39) +
sondes 0,32.

## 2026-05-19 (soir, suite 2) — ✅✅ Fix B BUILDÉ, DÉPLOYÉ & VALIDÉ À FROID — bench viable

Patch B-1 (`plugin/Core/SocketService.cs`) buildé sur cette box
(`dotnet 9.0.302`, `Debug R25`, build minimal §2 BUILD.md) :
`RevitMCPPlugin` **0 err / 0 warn**, `RevitMCPCommandSet` 0 err (19 warn
amont pré-existants, hors KG). DLL patchée déployée & horodatée dans
`%AppData%\…\Addins\2025\revit_mcp_plugin\`. Revit relancé + Switch ON,
re-sonde à froid (`kg-reset-repro` → `kg-durability-repro`), sans Claude :

| palier | AVANT | APRÈS Fix B |
|---|---|---|
| fondation/+1/+5 murs | ✅ durable | ✅ durable |
| **+14 murs (7-20)** | **120,0 s TIMEOUT, PERDU** (ES 10/12) | **17 ms ✅ durable** (ES 24/40) |
| +8 fenêtres | 120,0 s TIMEOUT | **21 ms ✅ durable** |
| seed complet | jamais (ES 10/12) | **ES 32/56 DURABLE** |
| verdict | 🔴 | ✅ **MÉCANISME SAIN** |

`cacheW == instF == ES` à chaque palier (Fix A tient, 0 régression) ET
le write qui pendait 120 s & se perdait complète en **17 ms** durable
(120 000 → 17 ms ≈ ×7000 : ce n'était jamais du travail lent, mais le
socket C# ne réassemblant pas la requête multi-segments → client en
attente jusqu'au cap). **Diagnostic confirmé de bout en bout** :
contention/agent-loop falsifiés ; cause racine = transport entrant C#
(`SocketService.HandleClientCommunication`, 1 `stream.Read` ≤ 8 KiB
traité comme requête complète) ; corrigée par accumulation-jusqu'à-
parsable côté C# seul (B-1), aucun changement de protocole ni des ~30
autres commandes. Bandeau ✅ du script corrigé (portait l'ancien récit
« contention/architectural »). **Statut : Fix A + Fix B livrés &
validés à froid → un run A/B facturable redevient viable** (décision
utilisateur). Reste : commits (Fix A / Fix B / outillage), puis run A/B.

## 2026-05-19 (soir, suite) — ✅ Fix A LIVRÉ & VÉRIFIÉ À FROID (le mensonge est éliminé)

`service.ts` : nouveau `persistOrEvict(projectId, kg)` (les 4 mutateurs
y passent ; `mReset` inchangé). Sur throw de `saveProjectKG` →
`this.instances.delete(pid)` (prochain `getKg` recharge l'ES) + re-lève
un message sans ambiguïté (« NOT persisted, view invalidated, do NOT
assume background commit, re-issue smaller »). Commentaire d'en-tête
faux (lignes ~30) corrigé. `tsc` clean (build via node conda, env sur
PATH pour le `prebuild` npm imbriqué).

**Re-sonde quiescente (même protocole, sans Claude), preuve directe :**

| palier | cacheW | instF | ES brut | AVANT Fix A | APRÈS Fix A |
|---|---|---|---|---|---|
| fondation/+1/+5 murs | =ES | =ES | ok | ✅ durable | ✅ durable (pas de régression) |
| **+14 murs (timeout 120 s)** | **10/12** | 10/12 | 10/12 | 🔴 `cacheW=24/40` MENT | 🟠 `cacheW=10/12` **== ES** |

La ligne timeout passe de `🔴 CACHE MENT` à `🟠 ES≠attendu` : le cache
écrivain **ne ment plus** (il recharge l'ES = vérité). Inchangé (=
Fix B, attendu) : le write +14 timeoute & est PERDU — cause racine
(transport C#) intacte. Différence : le système ne **ment plus**, il
remonte une erreur honnête et toute lecture voit la vérité durable.
Logique de verdict de `kg-durability-repro.mjs` corrigée pour distinguer
« cache ment » (🔴) de « write perdu mais cache honnête » (🟠) — l'outil
reste fiable pour valider Fix B. Ajout `kg-reset-repro.mjs` (remet les
blobs de repro à zéro avant re-test ; blob laissé propre/0 après run).
**Reste : Fix B (réassemblage socket entrant C#).**

**Fix B SCOPÉ — racine localisée à la ligne près.**
`plugin/Core/SocketService.cs:167-219` (`HandleClientCommunication`) :
`byte[8192]` + **un seul** `stream.Read` traité comme une requête
JSON-RPC complète — aucune boucle d'accumulation, aucun length-prefix,
aucun délimiteur, plafond 8192 o. TCP est un flux d'octets : une requête
qui s'étale sur ≥2 segments → 1er `stream.Read` = JSON tronqué →
`JsonException` → `CreateErrorResponse(null, ParseError,"Invalid JSON")`
avec **`id:null`**. Le client TS corrèle par `response.id`
(`SocketClient.ts:81`) → une erreur id-null ne matche aucun callback →
le Promise pend jusqu'au cap 120 s → write perdu. Asymétrie clé : le
client TS *entrant* (`SocketClient.ts:42-52 processBuffer`) accumule
DÉJÀ jusqu'à ce que `JSON.parse` réussisse — d'où grosses *réponses* OK
mais grosses *requêtes* KO. Une seule cause racine, deux visages.

Options Fix B : **B-1 accumuler-jusqu'à-parsable côté C# uniquement**
(miroir de ce que fait déjà le TS entrant ; aucun changement TS ni de
protocole ; bas risque pour les ~30 autres commandes ; garde-fous = cap
taille max + timeout lecture) — **recommandé pour débloquer** ; **B-2
framing length-prefixé** (robuste mais TS+C# + TOUS les appelants
`mcp__revit` → gros blast radius) ; **B-3 writes delta** (sortir du
whole-blob qui croît avec l'action_log — optionnel, scale, NON requis :
un blob 32-nœuds bien framé ≈ qq dizaines de Ko, ~20 ms). C# non
buildable dans l'env conda → patch écrit ici, build/deploy/validate sur
la box Revit de l'utilisateur (re-sonde `kg-durability-repro.mjs`,
désormais Fix-A-correcte).

**Fix B B-1 PATCH ÉCRIT (à builder sur la box Revit).**
`plugin/Core/SocketService.cs` : `HandleClientCommunication` réécrit —
accumule les octets entrants dans un `MemoryStream`, décode le tampon
ENTIER (UTF-8 multi-octets peut chevaucher un segment), ne traite que
quand `IsCompleteJsonRpc` (try-parse `JsonRPCRequest`, miroir de
`SocketClient.ts processBuffer`) réussit ; reset après réponse (connexion
persistante). Garde-fous : `ReadTimeout` Infinite si tampon vide (idle,
ne coupe pas une connexion réutilisée) sinon 30 s (anti half-message
bloquant) ; cap 32 MiB → erreur propre. Aucun changement du protocole ni
des ~30 autres commandes. Imports déjà présents. **Non buildable ici
(conda = node-only).** À faire sur la box : rebuild plugin (BUILD.md) +
redeploy add-in + redémarrer Revit + Switch, puis `kg-reset-repro.mjs`
→ `kg-durability-repro.mjs`. Succès attendu = ✅ MÉCANISME SAIN (tous
paliers durables incl. +14/+8, ES final 32/56, aucun timeout 120 s) →
run A/B facturable redevient viable.

## 2026-05-19 (soir) — ✅ TEST DÉCISIF TRANCHÉ : PAS la contention — défaut transport C# REPRODUIT À FROID

`server/scripts/kg-durability-repro.mjs` lancé **quiescent** (aucune
session Claude, aucune dispute de l'idle Revit), sur .rvt **vierge**
(`[garde] aucun blob — idéal` → zéro risque fixture). Pilote le VRAI
`KgService`. Seed cumulatif par paliers, 3 lectures/palier :

| palier | write | cacheW | instF (instance neuve ⇒ ES) | ES brut | verdict |
|---|---|---|---|---|---|
| fondation (4) | 215 ms | 4/0 | 4/0 | 4/0 | ✅ durable |
| +1 mur | 19 ms | 5/2 | 5/2 | 5/2 | ✅ durable |
| +5 murs (2-6) | 16 ms | 10/12 | 10/12 | 10/12 | ✅ durable |
| **+14 murs (7-20)** | **120,0 s TIMEOUT** | 24/40 | **10/12** | **10/12** | 🔴 CACHE MENT |
| +8 fenêtres | 120,0 s TIMEOUT | 32/56 | 10/12 | 10/12 | 🔴 |
| miroir one-shot 28-él. | 17 ms **ERR** (pas TIMEOUT) | qfail | — | — | fast-fail |

**Le pari « contention-driven → mécanisme sain → fix architectural » est
FALSIFIÉ.** Le timeout 120 s se reproduit **déterministiquement, 100 % à
froid**, sans Claude ni contention idle. Le seuil n'est PAS la
contention : c'est la **taille du payload whole-blob** (graphe +
action_log cumulé). Writes < ~4–8 KiB sérialisé : instantanés &
durables. Le write 10→24 nœuds (24 n / 40 a + log accumulé) franchit le
seuil → hang jusqu'au cap socket 120 s → **write PERDU**. Le miroir
one-shot 28-él. *fast-fail* en 17 ms (`ERR`, pas TIMEOUT) = l'autre face
du même défaut (single-shot > 8 KiB « Invalid JSON »).

**Cause racine = le défaut classé « secondaire / low-prio / Stage-2 »
dans `kg-v1-effort.md` ÉTAIT la cause bloquante du bench :** le serveur
socket **C#** ne réassemble pas une requête entrante multi-segments /
> ~4–8 KiB. NI la contention, NI le coût d'écriture ES, NI
l'ordonnancement idle Revit. → branche 🔴 « coût-C#-write / §1 ».

**Impact sur les mesures discutées :**
- (2) timeout 120→180 s : **RÉFUTÉ empiriquement** — le C# ne réassemble
  jamais ; pendrait à 180 s et perdrait quand même le write.
- (1) « ≤ 16 mutations » : plafond réel = **octets sérialisés (~4–8
  KiB)**, qui *rétrécit* à mesure que le whole-blob (+ action_log)
  grossit → un cap en nb de mutations est fragile par nature.
- (3) « fail au timeout » : déjà le comportement (`kg_add_element.ts:78`
  → `kgError`/`isError`). Le manque réel = Fix A.
- Mensonge du cache **confirmé à froid** : `cacheW` 24/40 puis 32/56
  alors que `instF` (instance neuve) recharge correctement 10/12 depuis
  l'ES. Mécanisme exact = `service.ts:381-401` (transaction commit RAM
  → `saveProjectKG` throw → cache laissé en avance, epoch non bumpée
  `service.ts:280-282`). La colonne `instF` **prouve** le Fix A : une
  instance neuve lit déjà la vérité.

**Fix path re-pointé :**
1. **Fix A (correctness, inconditionnel, ~2 lignes `service.ts`) :** sur
   échec/throw `saveProjectKG` → évincer l'entrée cache
   (`this.instances.delete(pid)`) ⇒ prochain accès recharge l'ES
   (comportement `instF`). + message d'erreur sans ambiguïté (« NON
   persisté, vue invalidée, ré-émettre en plus petits lots »).
2. **Fix B (cause racine, le vrai §1) :** réparer le réassemblage socket
   entrant **côté C#** (framing length-prefixé / lecture jusqu'à JSON
   complet). Tant que B n'est pas livré, tout whole-blob > ~4–8 KiB est
   perdu — **le bench ne peut PAS passer**. Optionnel : sortir du
   whole-blob (writes delta) pour que le payload ne croisse pas avec
   l'action_log.

État .rvt : la .rvt active porte maintenant un blob **`Demo-repro`
(10 n / 12 a)** laissé par la sonde (vierge au départ → pas de restore).
Ce n'est PAS la fixture `Demo` du bench — rouvrir la .rvt de bench si
besoin.

## 2026-05-19 — 🔴 DÉFAUT DE BASE : write timeouté = PERDU (pas commité), le système ment

Verdict A/B run 2 (steered + 3 fixes) puis reproduction à froid. **Le run 2
ne tranche pas §10.6 : comparaison VOID.** PoC a persisté **32 nœuds
durables** (0 arête — gap prompt symétrique, séparé) ; **V1 = 4 nœuds
(fondation), le seed s'évapore**. Totaux : V1 tokens +13,6 %, wall ×2,14,
turns ≈, cost −4,6 % — mais le « moins cher » V1 est un **artefact** (il
fait moins de vrai travail + scénarios aval vacants), pas une qualité.
V1 **n'est PAS ≥ PoC** tel qu'architecturé.

**Root cause reproduit à froid (protocole manuel décomposé, vérité =
`kg_blob_read` brut hors process, pas la narration agent) :**
- Petits writes (≤ ~15 mutations : fondation 4 ; +1 mur ; +5 murs×3=15) →
  `success:true` **synchrone**, **durables en ES** (cross-process : ES =
  6 murs / 12 arêtes / turn 3), **même sous session Claude**.
- Gros write (~42 mutations : 14 murs×3) sous session Claude →
  `success:false "Command timed out after 2 minutes: kg_blob_write"` →
  **ES INCHANGÉ (6/12/turn 3)**. Le write timeouté est **PERDU, PAS
  commité**. Triple-confirmé (kg-seed-check ×2 + garde de la sonde).
- **« timeout-but-commits » RÉFUTÉ** (au moins pour le gros write).
  C'était presque sûrement toujours un faux positif same-process : la
  mutation est appliquée **en mémoire** (cache KgService) avant le
  persist ; `kg_query` in-session lit ce cache (montre les nœuds) ; l'ES
  ne les a jamais ; process neuf → reload ES → disparus. **`kg_query`
  succès ≠ durable.**
- Défaut de 2ᵉ ordre : l'agent **hallucine** « ça commit en arrière-plan,
  keep polling, classic timeout-but-commits » que l'ES brut contredit à
  plat. Le système **masque** la perte (lore + cache + narration).

**Mécanisme.** `kg_blob_write` C# = whole-blob, sur ExternalEvent à
l'idle Revit. Quiescent (sondes) : ~23 ms pour 32 nœuds. Sous session
Claude qui dispute l'idle : un write modéré (~42 mut.) n'obtient pas de
créneau idle sous le cap socket 120 s → timeout → perdu. Corrélé à
(taille write × contention live), **pas** aux octets (c'est un *hang*
120 s, pas le fast-fail « Invalid JSON » ~8 KiB).

**Correction d'honnêteté.** Mon « 120 s = artefact live inoffensif, pas
un défaut, run 2 sûr » d'il y a plusieurs entrées était **FAUX** : c'est
une **perte de données + un mensonge système** (memory-ahead-of-ES + lore
+ narration), au-dessus du seuil sous contention. Les sondes offline ne
pouvaient pas le voir (quiescent + petits payloads) ; le run 2 était
nécessaire et l'a exposé.

**Ce qui marche (acté) :** fix S4 (reject atomique propre, 0/5 leaké
vérifié) ; fixes env poc-kg (KG_PYTHON + command node absolu) — PoC run 2
0 erreur ; scénarios sans gros seed rapides/comparables. **Le mécanisme
KG est SAIN sous le seuil** (incrémental durable & synchrone même en
session live) → projet **non condamné**, défaut **localisé**.

**Pending = 1 test décisif non facturable :** `kg-durability-repro.mjs`
**quiescent** (aucune session Claude) sur .rvt vierge → classe le seuil
en *contention-driven* (✅ mécanisme sain → fix architectural) vs
*coût-C#-write* (🔴 §1 en cause). Sondes antérieures (write 32-nœuds
~23 ms quiescent) prédisent fortement le cas ✅.

**Fix path (3 niveaux), à faire après le test :**
1. **Correction immédiate :** sur échec/timeout `kg_blob_write`,
   `KgService` ne doit PAS laisser le cache montrer la mutation comme
   persistée (rollback mémoire OU marquer dirty + remonter) — **cesser
   de mentir**.
2. **Opérationnel :** seed en petits lots réellement commités, chaque
   lot vérifié en ES, jamais sur la foi du `success` in-process.
3. **Structurel :** write-behind (journal local = vérité immédiate,
   checkpoint ES async) — le « best of both worlds ».

État .rvt : blob `Demo` = 10 nœuds (4 fond. + 6 murs), P4 absent.
Outils ajoutés cette session : `server/scripts/kg-{es-probe,svc-probe,
seed-check,durability-repro}.mjs`. Fixes : prompts 20_s2 / 40_s4 /
run_live SUFFIX ; .mcp.json poc-kg KG_PYTHON + 2 profils command→node
absolu. Reprise demain : voir le bloc « état figé » + commande sonde.

## 2026-05-18 — ✅ MCP `revit · × failed` : `command:"node"` → node conda absolu

Symptôme : Claude Code redémarré hors invite conda → `Project MCP
(…/profiles/v1-kg/.mcp.json) revit · × failed` (idem poc-kg). Cause
vérifiée : les 2 `.mcp.json` avaient `"command": "node"` ; or **`node`
n'est PAS sur le PATH système** (uniquement dans l'env conda `revitmcp`).
Le run 1 marchait car `run_live.py` était lancé depuis l'invite
`(revitmcp)` activée (PATH avec node) ; un Claude Code interactif lancé
ailleurs ne trouve pas `node`. `node --check build/index.js` OK des deux
côtés → ce n'est PAS un crash de build, juste l'exe introuvable.
**Correctif** (même classe que le repoint KG_PYTHON, 1 valeur, réversible,
suivi git) : `command` = chemin absolu
`C:/Users/lauro/AppData/Local/anaconda3/envs/revitmcp/node.exe` dans
**v1-kg ET poc-kg** (poc-kg aurait échoué pareil au run 2). JSON
re-validés, exe vérifié présent ; `_comment` ajouté/maj des deux côtés.
**Action utilisateur : redémarrer Claude Code (reconnexion MCP) + ré-
approuver les 2 profils — inerte sans restart**, comme le fix KG_PYTHON.

## 2026-05-18 — ✅ poc-kg débloqué : KG_PYTHON repointé (correctif vérifié)

Le profil **poc-kg** (baseline du run 2) était hard-bloqué : son
`.mcp.json` `KG_PYTHON` = `…/envs/revitmcp/python.exe` **inexistant**
(l'env conda `revitmcp` est node-only) → sidecar PoC `spawn ENOENT` → tous
les `kg_*` PoC morts → A/B du run 2 compromis. Diagnostic empirique (pas
de devinette) : base anaconda `C:/Users/lauro/AppData/Local/anaconda3/
python.exe` **existe**, Python 3.12.7, **networkx 3.3 déjà présent**
(`requirements.txt` = `networkx>=3.0` satisfait, zéro install).
`poc-kg/.mcp.json` `KG_PYTHON` repointé dessus ; JSON re-validé ;
`import networkx` OK via cet exe. **Action utilisateur restante :
redémarrer Claude Code + re-approuver le profil poc-kg (BENCHMARK-v1.md
§0) — l'édition .mcp.json est inerte jusqu'au restart.** Mémoire
[[poc-kg-live-sidecar-blocker]] passée à RESOLVED.

## 2026-05-18 — ✅ check seed en 1 commande + fix S4 (correction, non facturable)

Deux livrables non facturables, suite à l'analyse du dump v1 réel
(`nodes=9 edges=0` = fondation + 5 Level S4).

- **`server/scripts/kg-seed-check.mjs`** (lecture seule, zéro-dep, sans
  Claude/harness) : `kg_blob_read` live OU `--file <dump>` hors-ligne →
  escalier de diagnostic : VIDE / FONDATION SEULEMENT / PARTIEL (Wall
  X/20, Window Y/8) / NŒUDS SANS ARÊTES / ARÊTES PARTIELLES (E/56) /
  ✅ SEED OK. Juge sur **Wall=20, Window=8, arêtes=56** (les Level
  cumulés par S4 n'invalident pas — testé : dump connu → « FONDATION
  SEULEMENT », FAIL exit 1). Exit 0/1/2 → scriptable après chaque run.
- **Fix `prompts/40_s4.txt`** : l'« invalide » d'origine (`elevation:
  "abc"`) **n'était PAS rejeté** par le KG. Vérifié dans le cœur :
  `add_node` (`project-kg.ts:114-158`) ne valide que la **présence des
  clés** (manquante / inconnue), **jamais le type des valeurs** ; c'est
  un **port 1:1 de l'upstream** (25/25 cœur iso) → le **PoC gelé se
  comporte pareil**. Donc S4 ne pouvait observer aucun rollback (le lot
  commitait légitimement les 5, dont `elevation:"abc"`) — défaut de
  *prompt* (mismatch prompt↔contrat, même famille que la cause racine
  `00_seed`), **symétrique PoC/V1**, ni bug V1 ni signal perf. Nouveau
  S4 : l'élément invalide = un Level **sans `elevation`** (clé requise
  manquante → `Missing required attrs` → ValueError → rollback atomique
  réel), instruction explicite de ne pas le « réparer », vérif = compte
  de Level inchangé. Servi identiquement aux 2 stacks (même schéma
  vendored) → équitable, comme les fixes précédents.

Rappel inchangé : le bloquant reste **le seed qui sous-persiste** (4
fondation, 0 mur/fenêtre, 0 arête) à travers les runs ; à trancher par
un run 2 propre + `kg-seed-check` (PASS = 32/56, sinon où ça cale).

## 2026-05-18 — ✅ 2ᵉ probe : le chemin TS RÉEL est sain — question 120 s CLOSE

Question laissée ouverte par le profil offline tranchée, non facturable.
`server/scripts/kg-svc-probe.mjs` instancie le **vrai `KgService`** (aucun
arg ⇒ `SocketKgBlobTransport` + `SocketKgDocStateProvider` via
`withRevitConnection`/`RevitClientConnection`, mutex global, cache §5,
queue sérialisée, `BlobKgPersistence`) et rejoue la séquence S1
(modify 1 attr → diff_since → query) ×8 — **sans Claude, sans MCP, sans
harness**. Serveur rebuildé d'abord (conda env sur PATH ; le `prebuild`
`npm run clean` exigeait `npm` résoluble — `tsc` clean).

Résultat (p50 / max, Revit live, chemin de prod complet) :

| op (via KgService.call) | p50 | max |
|---|---|---|
| `modify_element` (= l'edit S1, getKg+Tx+save) | **18 ms** | **32 ms** |
| `diff_since` | 19 ms | 23 ms |
| `query` | 12 ms | 15 ms |

- `modify` iter1 (cache FROID, inclut `loadProjectKG`/`kg_blob_read`) =
  **32 ms** ; iter≥2 (chaud) p50 **17 ms** → **le cache §5 TIENT** : nos
  écritures ES filtrées par nom de Tx ne bumpent pas l'epoch ⇒ **pas de
  reload full-blob par op** (step 5 validé bout-en-bout dans le vrai
  service, ce que le 1ᵉʳ probe ne pouvait pas montrer).
- **Zéro stall 120 s. Max sur 26 `service.call` = 32 ms.**

**Verdict (les 2 probes concordent).** Le chemin TS de prod est aussi
rapide que le socket brut (dizaines de ms). Le « `kg_modify_element` →
Command timed out after 2 minutes, commit quand même » documenté
([[project-demo-kg]]) n'est **PAS un défaut TS/transport/service
reproductible** : c'est un **artefact de session live** (Revit
non-quiescent — `ExternalEvent` en contention avec la longue session
`claude -p`), ni un coût par-op, ni un bug code. Tout le défaut perf v1
= amplification boucle-agent, désormais traitée par les 3 fixes Étape 2.
**Run 2 facturable = sûr et fondé.** (Le .rvt porte un blob « es-probe »
+ 2 Level `svcprobe_*` ; `run_live`/protocole reseedent la fondation.)

## 2026-05-18 — ✅ Étape 2 : 3 fixes prompts/steering (anti-amplification), non facturables

Suite au profil offline, les 3 fixes ciblant la racine (amplification
boucle-agent) sont appliqués. **Aucune source v1 touchée ; aucun run
facturable.**

- **(a) `prompts/20_s2.txt`** : retrait du « after every edit restate the
  full current project state » (×10 → 10 `kg_query` 32-noeuds + 10
  restatements). Remplacé par 1 vérification finale unique (report des
  hauteurs murs 1-10). Intent du scénario préservé (10 edits séquentiels
  persistés, correctness toujours scorable). Vérifié : seul `20_s2` portait
  ce motif — s1 (diff = test correctness légitime), s3 (query), s4 (batch
  atomique + report unique), s5 (analyse drift), s6 (1 edit bulk + confirm
  unique) intacts.
- **(b) `run_live.py` `SUFFIX`** : passé de `{profil}` à
  `{profil}{seed|edit}`. Le paragraphe lourd « discover schema + bulk
  ordonné par dépendance » ne va plus que sur le **seed** ; les scénarios
  edit reçoivent un steering **lean** (peu d'appels, pas de restate
  gratuit). Classifieur : `"seed" in scen.lower()` → généralise à tous les
  jeux (`prompts/`, `prompts_bulkN/`, `prompts-probe/`…). `--steer kg-many`
  inchangé/valide (la classe s'applique dans le profil). Log enrichi
  `[label] scen (class)`. `py_compile` OK.
- **(c)** clause documentée ajoutée à TOUS les suffixes `kg`/`kg-many`
  (seed+edit) : « un write peut signaler un timeout tout en ayant commité :
  vérifier par UNE query avant de retenter, jamais de retry aveugle » —
  coupe la classe de tours défensifs sur le faux-négatif documenté
  ([[project-demo-kg]]). `flat` non touché (couche store_*, baseline).

`BENCHMARK-v1.md` annoté : run 2 = nouveau point de référence des deux
côtés (prompts servis identiques, A/B équitable), non comparable aux runs
partiels d'avant-fix ; garder `*-nosteer`. Reste ouvert (non bloquant,
non facturable) : 2ᵉ probe via le vrai chemin `KgService`/
`withRevitConnection` pour clore la question du stall ExternalEvent 120 s
occasionnel (Revit non-quiescent en session live) avant tout run
facturable — `withRevitConnection` = socket neuve/op (fidèle au probe),
donc pas un défaut transport persistant ; reste l'hypothèse idle-Revit.

## 2026-05-18 — ✅ PROFIL OFFLINE : l'infra est INNOCENTE, racine = boucle-agent

Étape 1 du hand-off exécutée : micro-probe instrumenté
`server/scripts/kg-es-probe.mjs` (zéro-dep, droit au socket Revit, **sans
Claude, sans le harness, sans le serveur TS** — fidèle à la prod :
`SocketClient.ts:133` envoie aussi un `socket.write(JSON.stringify())`
non-framé unique). Chronométrage de N a/r isolés + balayage taille + le
triplet exact d'une mutation v1 à froid. Garde-fou non-destructif (lit le
blob, refuse un KG tiers sauf `--force`). Demo (661 o, fixture 4-noeuds
re-seedable) flushée sur accord user (`--force --no-restore`). **Non
facturable. Aucun run harness lancé.**

Résultat (p50, Revit 2025 live) :

| op | p50 | suspect | verdict |
|---|---|---|---|
| `kg_doc_state` (poll §5, chaque getKg) | **13 ms** | #1 | falsifié |
| `kg_blob_read` (reload cache froid) | **11 ms** | #3 | falsifié |
| `kg_blob_write` (1 noeud, 1 Tx Revit) | **21 ms** | infra | rapide |
| `kg_blob_write` k=32 / 4,2 KiB (taille Demo) | **23 ms** | #2 | **plat** vs k=1 (×1,0) → PAS O(graphe) |
| **triplet v1 (doc_state→read→write, k=32)** | **47 ms** | — | coût infra d'UN tour d'edit |

**Verdict (règle du JOURNAL).** Infra ≈ **17 ms/op** ; borne basse infra
de tout `10_s1` = 47 ms × 20 tours ≈ **931 ms**. Observé : **597 000 ms**.
→ l'infra = **~0,16 %** du wall ; les **~99,84 %** = la boucle-agent.
Suspects #1/#2/#3 (poll §5 / saveSnapshot O(graphe) / reload cache froid)
**falsifiés**. La racine est le **suspect #4 — amplification boucle-agent** :
les prompts s1/s2 forcent « restate the full current project state » à
chaque edit → re-query + raisonnement complets par tour → ~20 tours pour
1 edit trivial. **Le substrat ES v1 est rapide ; ce n'est PAS un défaut
perf v1 ni le datum §1.** Ne PAS réécrire l'infra v1.

**Finding secondaire (séparé, priorité basse).** `kg_blob_write` échoue
côté Revit avec `Invalid JSON` entre **4,2 KiB (k=32, OK)** et **8,2 KiB
(k=64, ÉCHEC)** : le serveur socket C# ne réassemble PAS une requête
entrante multi-segment (il parse le 1ᵉʳ segment TCP). Fidèle à la prod
(même `write()` non-framé). **Sans effet sur le bench 32 noeuds (4,2 KiB) ;
plafonne l'échelle projet** — item Stage 2 (framing requête entrant
C#), PAS le bloquant.

**§10.6 recadré.** Le bloquant n'était pas « v1 lent » mais « le harnais
de bench amplifie 1 edit en 20 tours via un prompt qui force le restate
complet ». Décision de la suite = **prompts/steering** (réduire le
restate, borner les tours), pas l'infra — **choix user** (Étape 2). Le
profil est l'artefact dans `kg-es-probe.mjs` (rejouable, non facturable).

## 2026-05-18 — ⚠️ DÉFAUT PERF v1 (bloquant §10.6) — hand-off session fraîche

`kg_schema` a débloqué le seed **en live** (`00_seed` err=False, 13
turns, 296 s). MAIS la suite révèle un **défaut de performance v1
inacceptable**, pas un coût latence « attendu » :

| sc | turns | wall | err | tâche |
|---|---|---|---|---|
| 00_seed | 13 | 296 s | ok | build (lourd, ~ok) |
| 10_s1 | 20 | **597 s** | ok | **monter la hauteur d'1 mur** |
| 20_s2 | — | 600 s | **TIMEOUT** | 10 edits de hauteur |

**`s1` = UN edit trivial → ~10 min / 20 turns. Incompréhensible et
inacceptable.** Ce n'est PAS le datum §10.6 ; c'est un bug de perf à
corriger avant tout verdict. Ne plus lancer de run facturable tant que ce
n'est pas élucidé **offline/instrumenté**.

**Suspects (à profiler, par ordre de probabilité) :**

1. **Coût par appel KG démultiplié.** Chaque op KG v1 = jusqu'à 3 a/r
   socket : `kg_doc_state` (poll §5 à **chaque** `getKg`, même en
   lecture, même si rien n'a changé) + `kg_blob_read` (cache miss) +
   `kg_blob_write` (chaque mutation = une **Transaction Revit**).
   `withRevitConnection` ouvre **une nouvelle socket par `sendCommand`**
   et **sérialise tout via un mutex global**. Chaque commande = un
   `ExternalEvent` traité par Revit à l'idle (`RaiseAndWaitForCompletion`).
   → 1 tâche agent de N tours × 2-3 a/r × latence ExternalEvent.
2. **`saveSnapshot` réécrit le blob ENTIER à chaque mutation**
   (`kg_blob_write` = tout le `ProjectKG` re-sérialisé + Tx Revit) →
   O(graphe) par edit, grossit avec le projet.
3. **Cache froid par scénario** : chaque `claude -p` = process MCP neuf =
   `KgService` cache vide → 1ᵉʳ op recharge tout le graphe ES.
4. **Amplification agent** : « restate the full current project state »
   à chaque edit (prompts s1/s2) → re-query complet par tour ; combiné à
   des outils lents → boucle de 20 tours pour 1 edit. Symptôme, pas la
   racine (la racine = latence par op).

**Premier pas recommandé (session fraîche, NON facturable) :**
micro-probe instrumenté — chronométrer **N `kg_blob_read`/`write`/
`kg_doc_state` séquentiels contre Revit réel, sans Claude** (étendre
`server/scripts/kg-es-smoke.mjs`). Ça isole « 1 op ES = 0,5 s ou 30 s ? »
→ sépare latence-infra de l'amplification-agent. Si infra ≈ 0,5 s : le
problème est la boucle agent / le poll §5. Si infra ≈ 10-30 s : le
problème est ExternalEvent/socket/`saveSnapshot`. Profiler AVANT de
toucher au code ; ne PAS re-lancer le harness facturable pour debugger.

**État acquis (rappel) :** v1 fonctionnellement prouvé hors-perf
(63/63 TS, fumée ES 8/8, repro offline 32 nodes, seed live OK). Le
**seul** bloquant restant = cette latence par-op. §10.6 en suspens
jusqu'à résolution.

## 2026-05-18 — `kg_schema` exposé : la découvrabilité du schéma manquait

Run 2 post-fix-prompt : v1 seed re-timeout (180 s). Dump (gratuit) :
`nodes=4` (`N0,N1,GEN_200,WIN_0610` — le windowtype du prompt corrigé
**a bien été créé**), `edges=0` → l'agent bloque maintenant sur les
**20 murs**. Repro offline = 20 murs OK avec les bons attrs. Diff
offline↔live = **moi je lisais `schema.ts`, l'agent non**.

**Cause racine structurelle (frappe aussi le PoC) :** KG à schéma typé
strict mais **aucun tool de découverte de schéma** (tools = add/modify/
soft_delete/query/diff_since/transaction_demo/modify_where). L'agent
**devine** les attrs requis de `Wall`/`Window` → rejet du lot atomique →
re-essai → chaque essai = un a/r ES lent → thrash jusqu'au timeout. PoC
« passe » car outils single + persistance instantanée → brute-force de la
forme en quelques s ; v1 (atomique + ES lent) ne converge jamais. La
méthode `schema` existait (ex-`m_sidecar`) — **jamais exposée en tool**.

**Fix (option A, non facturable, 63/63) :**
- **`server/src/tools/kg_schema.ts`** — nouveau tool → `service.call
  ("schema")`, filtre `node_type` optionnel (token-cheap). Auto-découvert
  par `register.ts`.
- `kg_add_element` description : « call kg_schema first ».
- `run_live.py` `SUFFIX["kg-many"]` : « FIRST discover required/optional
  attrs (use a schema tool if available) … » — **agnostique** : v1
  utilise `kg_schema`, le PoC gelé (sans ce tool) retombe sur
  l'error-driven (sa réalité) → on benchmarke les surfaces réellement
  livrées, équitable.
- `--timeout` 180 → **600** (le seed v1 est borné par la latence ES
  ~5-6 min ; 180 false-kill un v1 qui marche ; la légèreté vient du
  repro offline, pas d'un timeout court).
- `seed_repro.mjs` : préambule « découverte schéma » → prouve offline
  que le tool rend le contrat exact (Wall/Window required) et que le
  seed complet se construit (32 nodes/48 edges).

Run 2 prêt (facturable, user) avec la vraie correction structurelle.

## 2026-05-18 — Cause racine trouvée HORS-LIGNE en ~10 ms : prompt seed ≠ schéma

Boucle de debug allégée (demande user : 600 s/timeout = trop lourd).
`server/scripts/seed_repro.mjs` rejoue le seed 00_seed.txt contre le KG
**en mémoire**, zéro Revit/API, instantané. Verdict immédiat :

```
OK   levels+type (3)        OK   20 walls (20, 40 edges)
FAIL 8 windows: add_element element[0] (node_type=Window) failed:
     Missing required attrs for Window: ['type_ref']
(avec un FamilyType fenêtre d'abord → seed complet : 32 nodes, 48 edges)
```

**Cause racine définitive — ni v1, ni le merge, ni la latence :** le
prompt `00_seed.txt` spécifie « a wall type GEN_200 » (→ `Wall.type_ref`
OK) mais **aucun type de fenêtre**, alors que le schéma typé strict
**exige `Window.type_ref`** (un FamilyType). L'agent suivant le prompt
crée des fenêtres invalides → échec. **Frappe les DEUX stacks** (même
schéma vendored) → les runs « v1 mauvais » = ce mismatch prompt/schéma +
thrash atomique, pas un défaut v1. En v1 (lots atomiques + steering) le
thrash va au timeout ; en PoC (single) l'agent grappillait → fausse
asymétrie.

**Corrections (non facturables) :**
- `prompts/00_seed.txt` : ajout d'un *window family type* « WIN_0610 »
  + fenêtres « of type WIN_0610 » (miroir du wall type déjà présent).
  Symétrique : `run_live` sert ce prompt aux 2 stacks → A/B équitable.
  Repro prouve : seed complet se construit (32 nodes/48 edges).
- `run_live.py` : défaut `--timeout` 600 → **180 s** (un vrai blocage
  échoue en 3 min, pas 10).
- `seed_repro.mjs` tracké : débogueur hors-ligne ; le harness facturable
  ne tourne QUE quand le repro passe.

**Méthodo actée :** debug seeds/scénarios **offline d'abord** (gratuit,
instantané), live A/B seulement ensuite. Run 2 prêt à relancer (user).

## 2026-05-18 — Étape 6 run 2 (steered) : seed timeout → fix erreurs de lot lisibles

Run 2 v1 (merge + `--steer kg-many`) : seed **timeout 600 s** à nouveau.
Dump : `turn=1`, 3 nodes **en 1 appel** (`kg_add_element([N0,N1,GEN_200])`)
→ l'agent **batche bien**. Puis **0** jusqu'au kill : le lot suivant
(20 murs/8 fenêtres) échoue à chaque tentative, rollback atomique → rien,
l'agent tâtonne en aveugle. Préconditions OK (vierge, Switch, pas de
dialogue ; 3 nodes persistés prouvent le chemin Revit/ES).

**Défaut révélé par le merge (pas un bug) :** un outil atomique de lot
doit rendre l'échec **lisible par élément**. Avant, l'erreur core
remontait sans index → sur un lot de N, l'agent ne sait pas QUOI
corriger. (Outils single du run 1 : retour par élément → l'agent créait
wall_001 OK.)

**Fixes (non facturables, 63/63 vert, `core/`/`persist.ts` intacts) :**

1. `service.ts` : helper `atItem(opLabel,i,ident,fn)` autour de chaque
   élément des mutateurs list-native — enrichit le message
   (`add_element element[7] (node_type=Wall) failed: Missing required
   attrs for Wall: ['height']`) et **re-lève le même objet** (type
   préservé → `transaction()` rollback **total** : atomicité intacte).
   Nouveau test verrouille index+identité.
2. `run_live.py` `SUFFIX["kg-many"]` : « FEW bulk calls, many per call,
   **dependency-ordered** (levels/types → walls → windows), never one
   call per element » au lieu de « ONE call » (le méga-appel monolithique
   est impossible : les fenêtres référencent des murs aux ids
   auto-alloués). Agnostique de la forme (vaut v1 liste & PoC `_many`).

Run 2 à refaire avec ces fixes (facturable, décision user). Build v1
déjà rebuildé ; `.mcp.json` inchangés (pas de ré-approbation).

## 2026-05-18 — Fusion single/`_many` : outils KG list-native (défaut de conception corrigé)

Relevé par l'utilisateur : les commandes C# upstream sont **list-native
par design** (`create_level(List<…>)`, `delete_element(string[])`) ; le
split KG `single` vs `_many` était une quasi-redondance (raison d'être =
l'A/B single-vs-bulk du PoC, **épuisée** depuis que le bulk est le
défaut). Décidé (avec l'utilisateur) : **fusionner maintenant, avant le
run 2, noms d'outils conservés**.

**Couche outil seulement — `core/` (25) et `persist.ts` (19) NON
touchés.**

- `service.ts` : `mAddElement` prend `elements:[…]` (1..N, atomique, 1
  turn — absorbe `add_many`) ; `mModifyElement` prend `edits:[{llm_id,
  updates}]` (absorbe `modify_many`) ; `mSoftDelete` prend `llm_ids:[…]`.
  `add_many`/`modify_many` retirés du dispatch. `modify_where` conservé
  (sélection par prédicat — besoin distinct, pas redondant).
- Outils : `kg_add_element`/`kg_modify_element`/`kg_soft_delete` schémas
  list-native (mêmes noms). `kg_add_elements_many.ts` /
  `kg_modify_elements_many.ts` **supprimés**. `kg_modify_where.ts`
  rebranché `kgManyEnabled`→`kgToolsEnabled`.
- `mode.ts` : `kgManyEnabled()` supprimé ; ne reste que le gate on/off
  (`flat/off`). `kg-many` = alias inoffensif « KG on » (configs/PoC).
- `run_live.py` : `SUFFIX["kg-many"]` rendu **agnostique de la forme**
  (« N en UN appel » — vaut v1 liste & PoC `_many`). `BENCHMARK-v1.md`
  régime mis à jour.

Suite **62/62** (25 core + 19 persist + 18 service réécrits), build prod
`tsc` vert. Conséquence étape 6 : le run 2 comparera la **surface
réellement livrée** v1 (list-native) vs PoC gelé (split) — plus honnête ;
le run 1 a déjà isolé le coût substrat.

## 2026-05-18 — Étape 6, run 1 (sans steering) : le bulk est INDISPENSABLE à v1

Premier A/B live exécuté (poste user, Revit 2025). **Résultat clé, pas un
verdict** : sans steering bulk, l'A/B n'est pas apples-to-apples et v1
paraît mauvais — pour une raison méthodologique, **pas** un bug v1.

| sc | v1 out/turns/wall | PoC out/turns/wall |
|---|---|---|
| seed | 17661/25/**351s** | 14445/21/232s |
| s1 | 2475/5/40s | 9928/18/209s |
| s2 | **timeout 600s** | 3702/7/81s |
| s3 | 1613/4/30s | 5116/9/88s |
| s4 | 7033/15/108s | 5423/8/125s |
| s5 | 15939/14/394s | 6772/8/113s |
| s6 | 1453/5/30s | 7306/11/176s |

Dump d'état v1 (cohérent, **persistance v1 prouvée saine**) : `project_id=
Demo`, log 1→13 sans trou ; l'agent a persisté **1 mur/1 fenêtre au lieu
de 20/8** au seed (résumé du répétitif), `s2` a tourné en rond (murs 2→10
absents) → timeout, scénarios suivants sur graphe quasi-vide. La latence
ES réelle (3 a/r Revit/op) **modifie le comportement de l'agent** quand le
bulk n'est pas forcé.

**Diagnostic** : `run_live --kg-dir` applique `SUFFIX["kg"]` générique,
**pas** `SUFFIX["kg-many"]` (« prefer the *_many bulk variants ») — le
caveat déjà documenté. Or la *policy livrée* claude-in-revit force le
bulk : 20 murs = 1 `kg_add_elements_many` = **1 Tx ES** au lieu de 20.
Sans steering bulk on teste une config que personne ne livre.

**Le run 1 n'est pas perdu** : il *prouve* que le bulk est la condition
de viabilité de l'internalisation ES (le « pourquoi » de la
bulk-variant policy).

**Fix (in-scope, non facturable)** : `run_live.py` reçoit `--steer
{flat,kg,kg-many}` (override du suffixe pour tous les profils ; défaut
inchangé). `BENCHMARK-v1.md` impose `--steer kg-many` sur les 2 stacks
(run 2 = vraie baseline) ; garder le run 1 comme preuve
(`out\*-nosteer`). Re-approbation MCP non requise (les `.mcp.json` n'ont
pas changé, seulement `run_live.py`/doc).

**Prochaine étape : run 2 facturable (décision user).**

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
