# `server/src/kg/core/__tests__/` — suite portée (chemin critique)

Portage **1:1** de `claude-in-revit/tests/test_project_kg.py` — **le** fichier
de tests qui couvre `lib/project_kg.py`, dont `kg_bridge/vendor/project_kg.py`
est une copie **byte-for-byte** (SHA256 vérifié identique). 25 tests.

> Le « 821 » de la spec est le total de la suite upstream *entière* (dwg,
> tools, kg_sync, …), pas le périmètre de `project_kg.py`. Le binding Revit
> (`kg_sync.py` / `test_kg_sync.py`) est **hors scope** ici — le docstring du
> module Python l'exclut explicitement (« Revit binding … is NOT in scope »).
> Iso-comportement = `test_project_kg.py` vert à 100 %.

C'est le **chemin critique** de la v1 : supprimer le sidecar Python retire
le filet « 821 tests passants ». Le port TS n'est correct que si cette
suite est **verte et iso-comportement** vs le fichier Python de référence.
Rien d'autre du plan (spec §10) ne démarre tant que ce n'est pas le cas.

Pièges couverts (spec §7) : ordre d'itération de `find_by_type`
(= ordre d'insertion), sémantique exacte du rollback de `transaction()`
(`persistence roundtrip`, `transaction rolls back on exception`),
sérialisation `json.dump(sort_keys=True, indent=2)` vs `JSON.stringify`
(`1.0`→`1` documentée, `None`→`null`, ordre des clés — `pyjson.ts`).

## Lancer

```
cd server
npm test          # pretest: tsc -p tsconfig.test.json → build-test/, puis node --test
```

Runner = `node:test` intégré, **zéro dépendance** (cf. `tsconfig.test.json`).
Les tests ne partent pas dans le paquet npm (`tsconfig.json` exclut
`__tests__` ; `files: ["build"]`).

**Statut : 25/25 verts, iso-comportement vs le Python de référence.**
