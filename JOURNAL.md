# JOURNAL

Journal de bord du travail KG. Convention reprise du projet source
(*claude-in-revit* — cf. les références « JOURNAL session … » dans
`kg_bridge/vendor/project_kg.py`). Entrée la plus récente en haut.

---

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
