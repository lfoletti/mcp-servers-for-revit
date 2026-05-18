/**
 * pyjson.ts — fidélité de sérialisation Python → TS.
 *
 * `ProjectKG.persist()` fait `json.dump(to_dict(), indent=2, sort_keys=True)`.
 * `JSON.stringify` n'est PAS iso (DESIGN-internalize-es.md §7, piège nommé) :
 *
 *  - **ordre des clés** : `sort_keys=True` trie récursivement → on trie.
 *  - **`ensure_ascii=True`** (défaut Python) : tout caractère hors
 *    `0x20..0x7E` est échappé `\uXXXX` ; `JSON.stringify` ne l'échappe pas.
 *    Projet francophone → noms accentués fréquents : on échappe comme Python
 *    pour rester compatible des blobs écrits par le sidecar Python.
 *  - **`None` → `null`** : géré en amont (`to_dict()` produit déjà `null`) ;
 *    `undefined` défensivement mappé sur `null`.
 *  - **`1.0` → `1`** : JS ne distingue pas `float` de `int`. Un `1.0` Python
 *    serait redumpé `1`. C'est une **delta connue et acceptée** : `JSON.parse`
 *    relit de toute façon `1.0` comme `1`, et aucun test n'asserte les octets
 *    bruts du fichier (round-trip sémantique uniquement). Documenté ici.
 *  - **NaN/Infinity** : Python `allow_nan=True` écrit `NaN`/`Infinity` ;
 *    on fait pareil (improbable dans le KG, mais fidèle).
 *
 * `pyInt` / `pyStr` / `pyReprList` reproduisent `int()`, `str()` et le `repr`
 * d'une `list[str]` (utilisé dans les messages d'erreur `.format(sorted(...))`).
 */

function escapePyString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20 || c > 0x7e) {
      // Python json: control chars (<0x20) without a named escape and every
      // non-ASCII char (>0x7E, incl. 0x7F) → \uXXXX. JS strings are UTF-16,
      // so emitting one \uXXXX per code unit matches CPython's surrogate-pair
      // escaping for astral characters.
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  // JS has no int/float distinction → integral values print without `.0`
  // (the documented `1.0`→`1` delta). Matches `str(int)` for integers and is
  // a superset-safe choice for the round-trip the tests exercise.
  return String(n);
}

function serialize(value: unknown, indentLevel: number): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string") return escapePyString(value as string);
  if (t === "number") return formatNumber(value as number);
  if (t === "boolean") return value ? "true" : "false";

  const pad = "  ".repeat(indentLevel + 1);
  const closePad = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map(
      (v) => pad + serialize(v, indentLevel + 1)
    );
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }

  // Plain object → JSON object with sorted keys (Python `sort_keys=True`).
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "{}";
  const items = keys.map(
    (k) => pad + escapePyString(k) + ": " + serialize(obj[k], indentLevel + 1)
  );
  return "{\n" + items.join(",\n") + "\n" + closePad + "}";
}

/** Équivalent de `json.dumps(obj, indent=2, sort_keys=True)` (ensure_ascii). */
export function pyJsonDump(obj: unknown): string {
  return serialize(obj, 0);
}

/** Équivalent de `int(x)` pour les cas utilisés (`number` / `str` entière). */
export function pyInt(x: unknown): number {
  if (typeof x === "number") return Math.trunc(x);
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string") {
    const s = x.trim();
    if (!/^[+-]?\d+$/.test(s)) {
      throw new Error(`invalid literal for int(): ${JSON.stringify(x)}`);
    }
    return Math.trunc(Number(s));
  }
  throw new Error(`int() argument not supported: ${String(x)}`);
}

/** Équivalent de `str(x)` pour les cas utilisés (provenance `_origin`). */
export function pyStr(x: unknown): string {
  if (x === null || x === undefined) return "None";
  if (typeof x === "boolean") return x ? "True" : "False";
  return String(x);
}

/** `repr()` d'une `list[str]` — pour les messages `.format(sorted(...))`. */
export function pyReprList(items: string[]): string {
  return "[" + items.map((s) => `'${s}'`).join(", ") + "]";
}
