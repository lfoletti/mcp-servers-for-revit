/**
 * graph.ts — `MultiDiGraph` minimal, adjacence maison, zéro dépendance.
 *
 * Port du sous-ensemble de `networkx.MultiDiGraph` réellement utilisé par
 * `ProjectKG` (DESIGN-internalize-es.md §7 : "le vrai morceau ; ordre
 * d'itération de `find_by_type` = ordre d'insertion"). On reproduit donc
 * fidèlement networkx :
 *
 *  - `_nodes` : `Map` ordonnée par insertion. `nodes(data=True)` itère dans
 *    cet ordre → `find_by_type` / `to_dict` stables et iso vs Python.
 *  - clé d'arête = `edge_type` (`MultiDiGraph` keyed) : au plus une arête de
 *    chaque type entre `(src, dst)`. Re-`add_edge` du même triplet **met à
 *    jour** le dict d'attributs (sémantique `networkx`, pas de doublon).
 *  - `add_edge` auto-crée les nœuds manquants (fidélité networkx) ;
 *    `ProjectKG` garde de toute façon ses propres `KeyError` en amont.
 *  - `_node[n]` renvoie le **dict vivant** : `ProjectKG` mute les attrs en
 *    place (`node[DELETED_AT] = ...`). Le `_pred` de networkx n'est pas
 *    porté (non utilisé par la surface `ProjectKG`).
 */

export type Attrs = Record<string, any>;

export class MultiDiGraph {
  /** id → attrs (dict vivant). Ordre d'insertion = ordre d'itération. */
  private _nodes = new Map<string, Attrs>();
  /** Successeurs : src → dst → edge_type → attrs (dict vivant). */
  private _adj = new Map<string, Map<string, Map<string, Attrs>>>();

  // ----- Nodes --------------------------------------------------------

  has_node(n: string): boolean {
    return this._nodes.has(n);
  }

  /** networkx : nouveau nœud → créé ; nœud existant → attrs *mis à jour*. */
  add_node(n: string, attrs: Attrs = {}): void {
    const existing = this._nodes.get(n);
    if (existing) {
      Object.assign(existing, attrs);
      return;
    }
    this._nodes.set(n, { ...attrs });
    this._adj.set(n, new Map());
  }

  /** Le dict d'attrs **vivant** (mutable) — appelants : vérifier `has_node`. */
  node(n: string): Attrs {
    const a = this._nodes.get(n);
    if (a === undefined) throw new Error(`node not in graph: ${n}`);
    return a;
  }

  /** `nodes(data=True)` : `[id, attrs]` en ordre d'insertion. */
  *nodes_data(): IterableIterator<[string, Attrs]> {
    yield* this._nodes.entries();
  }

  // ----- Edges --------------------------------------------------------

  add_edge(u: string, v: string, key: string, attrs: Attrs = {}): void {
    if (!this._nodes.has(u)) this.add_node(u);
    if (!this._nodes.has(v)) this.add_node(v);
    let nbrs = this._adj.get(u)!;
    let keydict = nbrs.get(v);
    if (keydict === undefined) {
      keydict = new Map();
      nbrs.set(v, keydict);
    }
    const dd = keydict.get(key);
    if (dd !== undefined) {
      Object.assign(dd, attrs); // networkx : met à jour le datadict existant
    } else {
      keydict.set(key, { ...attrs });
    }
  }

  has_edge(u: string, v: string, key: string): boolean {
    return this._adj.get(u)?.get(v)?.has(key) ?? false;
  }

  /** Retire l'arête typée. networkx purge l'entrée `(u,v)` si plus d'arête. */
  remove_edge(u: string, v: string, key: string): void {
    const keydict = this._adj.get(u)?.get(v);
    if (keydict === undefined || !keydict.has(key)) return;
    keydict.delete(key);
    if (keydict.size === 0) this._adj.get(u)!.delete(v);
  }

  /** `edges(keys=True, data=True)` : ordre d'adjacence networkx. */
  *edges_data(): IterableIterator<[string, string, string, Attrs]> {
    for (const [u, nbrs] of this._adj) {
      for (const [v, keydict] of nbrs) {
        for (const [k, dd] of keydict) {
          yield [u, v, k, dd];
        }
      }
    }
  }

  number_of_edges(): number {
    let total = 0;
    for (const nbrs of this._adj.values()) {
      for (const keydict of nbrs.values()) total += keydict.size;
    }
    return total;
  }
}
