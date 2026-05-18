# v1 — KG internalisé dans le `.rvt` (ExtensibleStorage), sidecar supprimé

> **Spec d'architecture de la branche `feat/kg-v1-internalized`.**
> Le PoC (`feat/kg-memory-poc`, `PR_BODY.md`, benchmark) reste **gelé** à
> son commit : c'est la pièce à conviction *et* la baseline de comparaison
> — la v1 devra reprouver qu'elle est ≥ PoC. Rédigé pour un dev Python/JS
> qui ne connaît ni C# ni TypeScript.

---

## 0. Décisions actées (résumé exécutif)

1. **Le sidecar Python est entièrement supprimé.** `ProjectKG` est porté
   en **TypeScript** dans le serveur. Conséquence dure : le portage des
   **821 tests** passe d'optionnel à **chemin critique**.
2. **Identité ≠ liaison.** Le `llm_id` (compteur `_next_llm_id`) reste la
   **clé primaire** des nodes. L'`ElementId` Revit ne sert **que** de
   liaison node↔élément, via une **`Map<ElementId, llm_id>` globale** —
   il remplace l'attribut `_revit_id` + tout le `full_rescan`, **pas** le
   `llm_id`.
3. **Pas d'ancre par élément.** La liaison passe par la `Map` globale, pas
   par une Entity collée à chaque élément → le piège copier-coller
   disparaît, et il n'y a qu'une seule `DataStorage`.
4. **`action_log` séparé du graphe vivant.** Deux conteneurs distincts
   (mitigation du plafond 16 Mo/string) ; le log est un `Array<string>`
   chunké et compactable.
5. **Le graphe en mémoire est un cache du `.rvt`.** Un protocole
   d'invalidation (événements de l'add-in C#) est requis — indissociable
   du bénéfice « détection de drift » (Stage 2).
6. **Worksharing : blob global suffit pour le PoC/mono-session.** L'hybride
   par-élément est l'endgame *différé*, pas le périmètre v1.
7. **Branche dédiée, pas fork.** Mêmes `server/` (TS) + `commandset/`
   (C#) comme base ; fork seulement si la v1 cesse de viser l'upstream.

---

## 1. Contexte & objectif

Le PoC externalise le KG (`kg_bridge/vendor/project_kg.py`, `ProjectKG`
sur `networkx.MultiDiGraph`) en `<project_id>.kg.json` via un sidecar
Python (`kg_sidecar.py`) spawné par `server/src/kg/bridge.ts`.

La v1 vise : (a) **internaliser** le KG dans le `.rvt` via
ExtensibleStorage (plus de `.json` orphelin ; le graphe ne peut plus se
séparer du modèle), et (b) **supprimer le sidecar** (un seul runtime,
mergeable upstream). L'atomicité Stage 2 (muter Revit + muter le KG, ou
rien) devient quasi gratuite : l'écriture ES se fait dans une `Transaction`
Revit.

## 2. Identité vs liaison — `llm_id` vs `ElementId`

**Le `llm_id` reste la clé primaire.** L'`ElementId` auto-incrémental ne
peut PAS le remplacer, pour quatre raisons dont une déjà gravée dans le
code :

1. **Les nodes KG-only n'ont aucun `ElementId`.** `DxfImportContext`,
   `Stair` (option A), tout type `rebuilt_by_rescan: False` — pas
   d'élément Revit, donc pas d'id. Rédhibitoire seul.
2. **Revit recycle les `ElementId` supprimés.** `snapshot_revit_id_map_typed`
   documente le crash : *« un ElementId recyclé par Revit … réattribué à
   un ModelLine … → crash Phase 2d »*. Une clé primaire réattribuable =
   tombstones qui collisionnent avec de futurs éléments.
3. **Le node existe avant l'élément Revit** (flux Stage 2 :
   créer node → créer élément → lier ; + cas « création Revit échoue,
   rollback » : le node a une identité, aucun `ElementId`).
4. **Stabilité agent/UX.** `wall_007` est stable pour le LLM à travers les
   rescans (tout le sens de `snapshot_revit_id_map`) ; un entier opaque
   ne l'est pas.

**Donc** : le compteur `_next_llm_id` est conservé. L'`ElementId` est une
liaison transitoire, recyclable, portée par la **`Map<ElementId, llm_id>`
de l'Entity globale** (Revit remappe lui-même les clés `ElementId` au
copier/transmit). Cette Map remplace `_revit_id` + `full_rescan` +
`find_by_revit_id`.

## 3. ExtensibleStorage — faits vérifiés (doc Autodesk)

| Point | Confirmé |
|---|---|
| Types de `Field` | `int, short, byte, double, float, bool, string, GUID, ElementId, XYZ, UV` + sous-`Entity` + `Array<simple>` + `Map<clé,valeur>` |
| `Map` — types de clé | `int, short, byte, string, bool, ElementId, GUID` |
| Unités obligatoires | oui pour `XYZ/UV` et flottants dimensionnels |
| Écriture dans une `Transaction` | obligatoire (lecture non) → atomicité Stage 2 gratuite |
| `DataStorage.Create(doc)` + `SetEntity` | pattern « donnée de projet sans élément hôte » |
| Niveaux d'accès | `Public / Vendor / Application` |
| **Limite string** | **16 Mo par objet string** → cf. §4 |

Conséquence majeure : on **ne mappe pas** les attributs KG sur des `Field`
typés (`NODE_TYPES` évolue sans cesse, un schéma ES est figé une fois
diffusé, et les flottants exigeraient une unité par champ). ES =
**conteneur de blob(s) JSON versionné(s) + un entier de version**, on
parse soi-même. ES est un coffre qui voyage avec le `.rvt`, pas une base
relationnelle.

*(Source distincte à valider sur The Building Coder / Tammik au moment de
coder : remap `ElementId` au copier/transmit, douleur du versioning de
schéma cross-fichiers, persistance `ElementId` inter-sessions.)*

## 4. Granularité retenue

**Une seule `DataStorage` globale**, deux conteneurs distincts :

- **Graphe vivant** (nodes, edges, `counters`, `turn`, tombstones, types
  KG-only, `Map<ElementId,llm_id>`) — borné, un champ string JSON
  versionné `{schema_version, data}`.
- **`action_log`** — append-only, le poste qui grossit sans borne (une
  entrée `before/after` par `create/modify/delete`). Stocké à part en
  **`Array<string>` chunké**, rotatable/compactable. `diff_since()` n'a
  besoin que d'une fenêtre récente — rien n'oblige à tout garder en ES.

Pas d'Entity par élément (cf. décision 3). Recréer-si-absent la
`DataStorage` au chargement (risque « Purge Unused »).

### Conservation des nodes périmés (le point dur)

ES meurt avec son élément hôte ; or `soft_delete()` garde le node
(`deleted_at_turn`). Trois familles sans élément support : tombstones,
`action_log`, types KG-only (`rebuilt_by_rescan: False` — invariant
**déjà** présent dans le schéma). Comme tout vit dans la `DataStorage`
globale et **pas** sur les éléments, supprimer un mur dans Revit ne perd
rien. Un handler **`DocumentChanged`** (add-in C#) bascule
`deleted_at_turn` quand `GetDeletedElementIds()` contient l'`ElementId`
d'un node lié, puis retire l'entrée de la `Map` (un id recyclé ne doit pas
re-résoudre vers le tombstone). C'est aussi la détection de drift Stage 2.

## 5. Cohérence cache ↔ `.rvt`

Le graphe TS vit en mémoire dans le serveur MCP : **c'est un cache** du
blob ES.

- **Écritures via les outils KG → reflétées immédiatement, aucun reboot.**
  Identique au comportement sidecar actuel (graphe tenu en mémoire dans le
  process). Survit au restart du serveur via *reload* depuis l'ES (pas via
  la RAM). Le serveur MCP est lancé/arrêté par le client (Claude Code),
  pas un démon à redémarrer à la main.
- **Surcoût nouveau** : le `.rvt` est aussi modifié par l'humain et par
  Revit (édition manuelle, fermeture/réouverture, bascule de document).
  Ces changements **ne sont pas reflétés** sans protocole d'invalidation
  piloté par les événements de l'add-in (`DocumentChanged`,
  `DocumentOpened`, `DocumentSynchronizingWithCentral`).

| Design d'invalidation | Coût | Cohérence |
|---|---|---|
| Cache longue durée + signal d'invalidation | rapide (0 a/r lecture) | complexe à câbler |
| Recharger le blob à chaque opération KG | 1 a/r WebSocket/op | toujours cohérent |

**PoC v1** : recharger à l'ouverture de document + sur signal
`DocumentChanged` ; cache longue durée pour les écritures-outils. Ce
protocole est **indissociable** du bénéfice drift : pas de « le store ne
peut pas mentir » sans « le store peut changer sous moi ».

## 6. Worksharing (endgame différé)

Une `DataStorage` globale = **un** élément Revit = **un** verrou d'emprunt
(borrow). En modèle central : les écritures KG de l'agent sérialisent
contre le Sync-to-Central d'autres utilisateurs touchant cette même
`DataStorage` ; un STC d'autrui sur le *modèle* drifte le graphe → reload
(cf. §5, fréquence accrue). L'agent reste **mono-session** (une session
Revit, une machine) — le conflit n'est pas « deux agents », c'est
agent vs STC humains.

Mitigations : workset dédié pour la `DataStorage`, emprunt juste le temps
de la Tx d'écriture puis relâche, recréer-si-absent. C'est l'unique axe où
le blob global a un vrai coût, et le meilleur argument futur pour basculer
*les attributs des nodes vivants* en **par-élément** (possédés avec leur
élément, pas de verrou global) tout en gardant log + tombstones + KG-only
en global — **hybride différé, hors périmètre v1**.

*(Liens Revit : `ElementId` est par-document ; la `Map` ne couvre que le
document hôte. Hors périmètre v1, noté.)*

## 7. Le port — TS obligatoire, 821 tests sur le chemin critique

Supprimer le sidecar rend le port de `project_kg.py` **obligatoire** (il
ne tourne plus nulle part sinon). Le coût réel n'est pas la syntaxe, c'est
de **ne pas perdre le filet** : `project_kg.py` est une copie byte-for-byte
d'un module de prod à **821 tests** ; le port n'est correct que si la
suite de tests est portée *et* maintenue en phase avec la référence
Python.

Subtilités où un port dérive silencieusement :

| `project_kg.py` (Python) | Équivalent TS | Risque |
|---|---|---|
| `networkx.MultiDiGraph` | `graphology` (multigraphe) ou adjacence maison | ⚠️ le vrai morceau ; ordre d'itération de `find_by_type` = ordre d'insertion |
| `copy.deepcopy(to_dict())` | `structuredClone()` (natif Node) | sémantique exacte du rollback `transaction()` |
| `NODE_TYPES` (sets required/optional) | objets + `Set`, ou `zod` (déjà dépendance) | faible |
| `json.dump(sort_keys=True, indent=2)` | `JSON.stringify` | ⚠️ ordre des clés, `1.0`→`1` (Python int/float vs `number` JS), `None`→`null` — compat des blobs existants |

## 8. C# pour un dev Python/JS

Le C# n'est *pas* une réécriture du projet : l'API Revit (`Transaction`,
`Element`, `ExtensibleStorage`) n'existe qu'en .NET, dans le process
Revit. On *ajoute* 2-3 commandes sur le moule exact de
`CreateLevelCommand.cs` : `kg_blob_read` (lit la `DataStorage`, sans Tx),
`kg_blob_write` (Tx + écriture chunkée), + handlers `DocumentChanged` /
`DocumentOpened`. Repères : `async/await` ≈ JS ; LINQ ≈
compréhensions/`.filter().map()` ; typage fort = le compilateur attrape
avant exécution ce qu'un dev Python voit en prod ; NuGet ≈ pip/npm ;
xUnit/NUnit (`tests/commandset/` existe déjà).

## 9. Organisation repo

PoC gelé = preuve + baseline. v1 = branche `feat/kg-v1-internalized`
*depuis* `feat/kg-memory-poc` (hérite des `kg_*.ts` réutilisables + du
harness de benchmark ; brancher *depuis* ne modifie pas le PoC). Fork
seulement si la v1 diverge durablement de l'objectif upstream.

Layout cible :

```
server/src/kg/core/            ← port TS de project_kg.py (le cœur)
server/src/kg/core/__tests__/  ← les 821 tests portés (chemin critique)
server/src/kg/persist.ts       ← contrat lecture/écriture du blob ES via WebSocket
server/src/tools/kg_*.ts       ← réutilisés, rebranchés sur core/ (plus sur le sidecar)
commandset/Commands/KnowledgeGraph/  ← kg_blob_read / kg_blob_write
commandset/Services/KnowledgeGraph/  ← handlers + DocumentChanged/Opened/Sync
reference/                     ← pointe sur kg_bridge/vendor/project_kg.py (SPEC figée du port)
DESIGN-internalize-es.md       ← cette spec (trackée sur la branche v1)
```

`kg_bridge/` (Python) sera retiré sur la branche v1 une fois le port TS
vert. La référence du port reste `kg_bridge/vendor/project_kg.py` (821
tests upstream) tant que le port n'est pas terminé — non dupliquée pour
éviter la divergence.

## 10. Plan d'implémentation (ordonné)

1. **Port TS de `ProjectKG`** dans `server/src/kg/core/` + portage de la
   suite des 821 tests (chemin critique : rien ne part tant que ce n'est
   pas vert et iso-comportement vs le fichier Python).
2. **Contrat `persist.ts`** : interface lecture/écriture du blob
   (graphe vivant + `action_log` chunké), agnostique du transport.
3. **Commandes C#** `kg_blob_read` / `kg_blob_write` (moule
   `CreateLevelCommand.cs`) + `DataStorage` recreate-if-missing.
4. **Rebrancher les `kg_*.ts`** sur `core/` (retirer `bridge.ts`
   sidecar) ; retirer `kg_bridge/`.
5. **Protocole de cohérence** : handlers `DocumentChanged` /
   `DocumentOpened` → invalidation/reload (§5). C'est aussi la base de
   `kg_detect_drift` (Stage 2).
6. **Re-bench** v1 vs PoC sur le harness hérité (prouver v1 ≥ PoC).
7. *(Différé)* hybride par-élément pour le worksharing (§6).

---

## Sources

- [Autodesk — Extensible Storage (Revit API Developer's Guide)](https://help.autodesk.com/cloudhelp/2024/ESP/Revit-API/files/Revit_API_Developers_Guide/Advanced_Topics/Storing_Data_in_the_Revit_model/Revit_API_Revit_API_Developers_Guide_Advanced_Topics_Storing_Data_in_the_Revit_model_Extensible_Storage_html.html)
- [archi-lab — what, why & how of the Extensible Storage](https://archi-lab.net/what-why-and-how-of-the-extensible-storage/)
- [The Building Coder — Extensible Storage (Jeremy Tammik)](https://thebuildingcoder.typepad.com/blog/2011/04/extensible-storage.html)
- Page d'origine fournie : Autodesk RVT 2013 API Dev Guide, « Extensible Storage » (viewer CaaS — contenu identique à la version 2024).
