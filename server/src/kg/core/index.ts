/**
 * core/ — port TS de `ProjectKG` (DESIGN-internalize-es.md §0/§7, §10 étape 1).
 *
 * Surface publique du cœur KG v1. Les `kg_*.ts` (étape 4 du plan) se
 * rebrancheront ici au lieu du sidecar Python (`bridge.ts`).
 */
export { ProjectKG } from "./project-kg.js";
export type { ProjectKGDict } from "./project-kg.js";
export { ValueError, KeyError } from "./errors.js";
export { MultiDiGraph } from "./graph.js";
export type { Attrs } from "./graph.js";
export {
  NODE_TYPES,
  SESSION_NODE_TYPES,
  EDGE_TYPES,
  CREATED_AT,
  MODIFIED_AT,
  DELETED_AT,
  REVIT_ID,
  ORIGIN,
  RESERVED_ATTRS,
} from "./schema.js";
export type { NodeTypeSpec } from "./schema.js";
export { pyJsonDump, pyInt, pyStr, pyReprList } from "./pyjson.js";
