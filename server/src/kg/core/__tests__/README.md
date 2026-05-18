# `server/src/kg/core/__tests__/` — suite portée (chemin critique)

Portage des **821 tests** de la référence upstream
(`kg_bridge/vendor/project_kg.py`).

C'est le **chemin critique** de la v1 : supprimer le sidecar Python retire
le filet « 821 tests passants ». Le port TS n'est correct que si cette
suite est **verte et iso-comportement** vs le fichier Python de référence.
Rien d'autre du plan (spec §10) ne démarre tant que ce n'est pas le cas.

Pièges à couvrir explicitement (spec §7) : ordre d'itération de
`find_by_type` (= ordre d'insertion), sémantique exacte du rollback de
`transaction()`, sérialisation `json.dump(sort_keys=True, indent=2)` vs
`JSON.stringify` (`1.0`→`1`, `None`→`null`, ordre des clés — compat des
blobs existants).

**Statut : non encore porté.**
