/**
 * errors.ts — équivalents TS des exceptions Python levées par `ProjectKG`.
 *
 * Le port doit être *iso-comportement* vs `kg_bridge/vendor/project_kg.py`
 * (DESIGN-internalize-es.md §7). Les 31 tests upstream
 * (`claude-in-revit/tests/test_project_kg.py`) utilisent
 * `pytest.raises(ValueError, match=...)` / `pytest.raises(KeyError)` ; on
 * reproduit donc deux types nommés distincts, avec un message portant le
 * texte exact du `.format(...)` Python (le `match=` est un *search* regex
 * sur `str(exc)`).
 */

/** Pendant de `ValueError` (validation de schéma / type / id). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/**
 * Pendant de `KeyError`. Python lève `KeyError(llm_id)` (ou un message) :
 * on conserve la clé pour qui veut l'inspecter, et `message` = la clé brute
 * (les tests upstream ne testent que le *type*, jamais le repr quoté de
 * `str(KeyError(...))`).
 */
export class KeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(key);
    this.name = "KeyError";
    this.key = key;
  }
}
