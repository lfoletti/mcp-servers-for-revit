# DESIGN — Benchmark Stage-2 : « créer pour de vrai, répondre par tous moyens »

> Statut : **DESIGN seulement** (2026-05-19). Aucun run lancé. Conçu en
> parallèle de la clôture du bench Stage-1 (17×3). Décision go/no-go +
> pilote AVANT toute matrice facturable.

## 0. But (cadrage neutre — à ne pas dévier)

**Évaluer honnêtement les avantages ET inconvénients RÉELS — fiabilité
et coût — de deux approches**, pas prouver qu'une gagne. Le design doit
pouvoir conclure « le KG interne ne vaut pas son coût en contexte
modèle-vivant » si c'est ce que disent les données. Critères de
succès/échec **pré-enregistrés** ci-dessous (§7) pour éviter la
rationalisation a posteriori.

Distinct du bench Stage-1 (couche-mémoire : flat-SQLite vs KG, bâtiment
*décrit* dans le prompt, jamais créé). Stage-2 = **le bâtiment est créé
pour de vrai dans le `.rvt`** ; la vérité-terrain devient **le modèle
Revit réel** ; l'agent répond « au mieux » par **tous** moyens
disponibles (interroger le modèle vivant inclus).

## 1. Les deux stacks (match équitable : les DEUX ont Revit)

| | **A — Revit-direct (no-kg)** | **B — Revit + KG interne (v1)** |
|---|---|---|
| Création | éléments réels dans le `.rvt` | éléments réels dans le `.rvt` |
| Mémoire agent | **aucune** ; ré-interroge le modèle vivant à chaque question | maintient le KG interne (ES) en plus |
| Réponse | `get_current_view_elements` / filtres / requêtes Revit | depuis le KG (`kg_query`/`kg_diff_since`) |
| Différence isolée | — | **uniquement** : maintenir+utiliser un index KG, ou non |

Flat-SQLite est **hors périmètre** Stage-2 (c'est la baseline
couche-mémoire Stage-1, déjà couverte). Option C (flat-Revit-augmenté)
**écartée** par défaut : brouille la question ; A vs B est le fair
fight propre. Mêmes prompts + même steering des deux côtés.

## 2. Pourquoi c'est la bonne question (et ce que ça prouve)

- Stage-1 ne fait que **modéliser** le coût « interroger le modèle
  vivant » (S1 = re-lire O(modèle), S3 = N allers-retours + jointure
  en prompt, S4 = pas de transaction, S5 = drift). Stage-2 le
  **mesure** sur Revit réel → preuve forte, ou réfutation honnête.
- C'est le **steelman du sceptique** (« pourquoi un KG si on a
  Revit ? »). Si B gagne quand même → robuste. Si A gagne → finding
  honnête majeur (la valeur du KG serait surtout hors-ligne/mémoire).
- Mappe la **vraie question produit** : le KG interne vaut-il son
  **coût d'écriture** (dette suite-4 whole-blob, O(état+historique)/op)
  face à « re-query Revit » ? Le compromis central à mesurer :
  **coût d'écriture amorti de B** vs **coût de lecture-modèle par
  question de A** (croise avec : nb de questions, fréquence d'édition,
  taille du modèle).

## 3. Prérequis bloquant : le binding KG ↔ ElementId Revit

Aujourd'hui les nœuds KG v1 ne sont **pas** liés aux `ElementId` du
`.rvt` (`Map<ElementId,llm_id>` explicitement **différé** §2/Stage-2,
cf. mémoire/`DESIGN-internalize-es.md`). **La fiabilité de B en dépend
entièrement** :
- sans binding, « le KG dit 20 murs » n'est pas vérifiable contre « le
  `.rvt` a *ces* 20 murs » ;
- **S5 (drift) est inévaluable** : détecter une édition humaine
  hors-bande du `.rvt` exige que le KG référence les éléments réels.

⇒ Stage-2 **exige et teste** ce binding différé. C'est en soi un
finding : *est-ce que le binding marche / vaut le coût de
construction ?* Honnête : **la fiabilité de B est conditionnée à une
fonctionnalité non encore construite et non prouvée.** Le pilote (§8)
doit valider le binding AVANT toute matrice.

## 3bis. GATE STEP 2 — binding KG↔ElementId : RÉSOLU (2026-05-19, TS-only)

Constat non facturable : le core `ProjectKG` a déjà
`set_revit_id`/`get_revit_id`/`find_by_revit_id`/`snapshot_revit_id_map`
mais **non exposés** (dispatch `service.ts` + outils `kg_*` muets) →
stack B était inévaluable (S5/drift, cross-check par élément).
**Décision utilisateur : exposer (TS-only).** Livré :
`service.ts` case `bind_revit_id` + `mBindRevitId` (list-native 1..N,
atomique via `transaction()`, **pas d'`advance_turn`** — la liaison est
métadonnée framework, ne corrompt pas turn/`diff_since` — `persistOrEvict`
pour durable+cache honnête) ; nouvel outil `kg_bind_revit_id.ts`
(auto-registré). **Aucun C#, aucune modif cœur.** `tsc` clean, suite
**63/63** (0 régression). Vérif offline (InMemory, sans Revit) :
bind → turn inchangé ✓, `_revit_id` visible dans `kg_query` attrs ✓
(⇒ cross-check KG↔.rvt & drift faisables), rollback atomique sur
mauvais lot ✓. **⇒ stack B redevient évaluable** ; la liaison
§2/Stage-2 différée est désormais sur la surface MCP. Steps 1 & 2
verts → reste **step 3 : pilote S1+S3 A vs B (facturable)**.

## 4bis. RÉSULTAT dry-run vérificateur (2026-05-19) + DÉCISION

Probe non facturable (raw socket `ai_element_filter`,
`filterVisibleInCurrentView:false` = **document-wide**, sans Claude) :
- ✅ déterministe cross-process : comptes/catégorie, type/classe/
  famille, **niveau d'un mur** (champ `Level`), élévation, bbox ;
  « aucun élément » = réponse propre parsable (pas un crash).
- ⚠️ schéma retourné **sans `Host`/`HostId`** → relation
  fenêtre→mur-hôte non lisible.
- **DÉCISION utilisateur 2026-05-19 :** *pas* de patch C# ; vérificateur
  déterministe sur **comptes/niveau/type/élévation** ⇒ note **seed,
  S1, S4, S5, S6** déterministe ; **S3 & cs10 = claim-graded**
  (relation host requise, non lisible) — plus faible pour ces 2,
  honnête, zéro nouvelle ingénierie. Sous-risque restant à lever au
  dry-run create-then-read : (i) chemin d'**écriture** create_* en raw
  socket ; (ii) lisibilité de `sill_height` (S6) via `ai_element_filter`
  params ; (iii) **prérequis famille fenêtre** chargée dans le `.rvt`
  (sinon fenêtres non créables — §6).

## 4ter. GATE STEP 1 — PASSÉ (2026-05-19, dry-run create-then-read non facturable)

`ai_element_filter` (lecture, document-wide) + `create_level`/
`create_*` (écriture) + `delete_element` testés en raw socket, sans
Claude, sur le `.rvt` live :
- baseline 3 niveaux → `create_level` 2 → relecture **5** →
  `delete_element {elementIds:[…]}` → relecture **3** (baseline).
  **Round-trip create→read→delete→read prouvé.**
- famille **fenêtre présente** (`FamilyTypeId 175114`, Fenêtres) +
  19 types de murs → **sous-risque (iii) levé**, pas de setup env
  fenêtre requis.
- `delete_element` wire = `{elementIds:[int…]}` ; suppr. d'un niveau
  **cascade** (vues/plans) — comportement Revit, à modéliser dans
  S4/cs10.
- Tout non facturable, `.rvt` laissé propre.
**⇒ Vérificateur Stage-2 FAISABLE.** Reste la lacune host (S3/cs10
claim-graded, décidé §4bis). **Prochaine porte = step 2 : binding
KG↔ElementId** (stack B inévaluable sans, cf. §3).

## 4. Vérité-terrain & vérificateur (la grosse pièce d'ingénierie neuve)

Vérité = **le `.rvt` réel**, indépendante de l'auto-rapport de A *ou*
B. Besoin d'un **lecteur déterministe cross-process des éléments réels**
(comptes par catégorie, type, relations host/level) via le command-set
C# (`get_current_view_elements`/filtres) ou un dump dédié — remplace le
`load_kg_files`/`flat.db` de `verify.py`. **Risque** : ingénierie
réelle ; le query modèle Revit a ses quirks (vues actives, éléments
non visibles, familles). À concevoir + **dry-run non facturable** avant
tout.

## 5. Métriques

**Fiabilité (vs `.rvt` réel) :** correction des réponses ;
fabrication (prétend vs état réel) ; **drift S5** (édition hors-bande
détectée+réconciliée ?) ; **atomicité S4** (batch à échec partiel → le
`.rvt` reste-t-il cohérent ?) ; **staleness de B** (le KG diverge-t-il
du `.rvt` → réponses fausses ? — risque #1 de B, lié dette suite-4 +
cohérence cache↔ES + binding).

**Coût :** tokens / turns / wall / $ — **+ coût par question** : A paie
des allers-retours Revit O(modèle) par requête (S1/S3) ; B paie le
write KG en amont. Exposer **où** chacun gagne (peu de questions → A ;
beaucoup de questions/éditions ou gros modèle → B). Le verdict doit
être une **courbe de compromis**, pas un gagnant unique.

## 6. Scénarios (analogues Stage-1, recadrés « create-for-real »)

seed = créer *réellement* niveaux/murs/fenêtres ; S1 = édition réelle
puis « qu'a changé ? » ; S3 = « fenêtres sur N0 + mur hôte » répondu du
modèle/KG ; S4 = batch atomique avec élément fautif → `.rvt` cohérent ?
S5 = **édition humaine hors-bande** du `.rvt` → détecter+réconcilier ;
S6 = édition bulk d'éléments réels. **Durcissement env requis** : `.rvt`
avec **famille fenêtre chargée**, type de mur, template/unités fixés,
Revit pour **tous** les stacks (pas que v1). Scénarios doivent être
*réellement constructibles* (≠ Stage-1 où la géométrie est
agent-choisie non-fixture).

## 7. Garde-fous de neutralité + critères PRÉ-ENREGISTRÉS

- Mêmes prompts+steering A/B ; vérité = `.rvt` (hors auto-rapport) ;
  détection fabrication des deux côtés ; rapporter coût ET fiabilité
  sans pondérer.
- **Issues admissibles pré-déclarées** (aucune n'est un échec du
  protocole) : (i) B ≥ A fiabilité ET coût → KG interne justifié ;
  (ii) B fiable mais plus cher (dette write) → KG justifié seulement
  si beaucoup de requêtes/éditions — donner le seuil ; (iii) B aussi
  fiable et moins cher en requêtes mais staleness/binding casse S5 →
  KG interne **non fiable** tel quel → finding négatif assumé ;
  (iv) A suffit (Revit-direct fiable et pas si cher) → **le KG interne
  ne vaut pas son coût en contexte modèle-vivant** — conclusion
  publiée telle quelle.

## 8. Plan de-risk (méthodo « pas cher avant facturable »)

1. **Dry-run vérificateur (non facturable)** : peut-on lire
   déterministiquement éléments+relations d'un `.rvt` témoin
   cross-process ? Sinon, stop (pas de grading fiable).
2. **Valider le binding KG↔ElementId (non/peu facturable)** : sans
   lui, B est inévaluable (S5). Go/no-go.
3. **Pilote S1 + S3 seulement, A vs B** (les 2 où le coût
   modèle-vivant est le plus tranchant, vérificateur le plus simple).
   Décision go/no-go matrice complète **sur vu du pilote**.
4. Matrice complète seulement si 1–3 verts.

## 9. Décisions ouvertes (à trancher avec l'utilisateur)

- A vs B strict, ou ajouter C (flat-Revit-augmenté) en 3ᵉ ? (défaut :
  A vs B).
- Binding KG↔ElementId : l'implémenter dans le cadre Stage-2 (chantier
  §2 différé) ou pilote en mode dégradé d'abord ?
- `.rvt` témoin + famille fenêtre : qui le prépare (env utilisateur).
- Séquencement : après clôture complète du 17×3 (recommandé) vs
  entrelacé.

## 11. STEP-3 — design détaillé du pilote (non facturable ; à valider AVANT tout run billable)

**Scénarios (2, create-for-real, analogues S1/S3) :**
- **P1 ≈ S1 (what-changed).** Prompt : créer POUR DE VRAI dans Revit
  N0(0)/N1(3000), type mur GEN_200, 6 murs sur N0 ; puis monter la
  hauteur du mur #3 de +200 mm ; rapporter exactement ce qui a changé
  depuis la création initiale, avec comptes.
- **P3 ≈ S3 (structural query).** Prompt : créer pour de vrai N0,
  GEN_200, 4 murs sur N0, 4 fenêtres chacune hébergée sur un mur
  distinct ; puis : quelles fenêtres sur N0 et quel mur héberge
  chacune ?

**Stacks/profils (les 2 créent du réel ; build v1 courant ; clé serveur
`revit` ; node conda absolu) :**
- **A = `profiles/s2-direct`** — `KG_BENCH_MODE=flat` (kg_* NON
  enregistrés ; outils Revit create/query présents). Steering A :
  « aucun outil de mémoire-projet ; crée tout POUR DE VRAI dans Revit ;
  réponds en INTERROGEANT le modèle vivant (`ai_element_filter`/
  `get_current_view_elements`) ; n'utilise PAS `store_*_data` ».
  ⚠️ caveat : `store_*_data` techniquement présent (mode flat) → le
  steering l'interdit ; toute déviation **notée** (même frontière
  d'interprétation que l'inspection outils flat).
- **B = `profiles/s2-kg`** — `KG_BENCH_MODE=kg-many` (kg_* incl.
  `kg_bind_revit_id` + outils Revit create). Steering B : « crée pour
  de vrai ; pour CHAQUE élément créé, `kg_bind_revit_id(llm_id,
  ElementId rendu)` + enregistre dans le KG ; réponds depuis le KG
  (`kg_query`/`kg_diff_since`) ».

**Vérificateur (`.rvt`-truth) — nouveau script borné :** lit après
chaque scénario via `ai_element_filter` (raw socket, prouvé step 1) :
P1 **déterministe** (modèle final = 6 murs N0 ; #3 hauteur +200 —
sous-check à confirmer non facturable : hauteur lisible via bbox-z ou
params) + le « what-changed » rapporté claim-checké ; P3 **claim-graded**
(host non lisible, décision §4bis) + part déterministe (comptes 4/4/N0).
Joint au coût/turns de `run_live`.

**Reset modèle entre scénarios (critique — la géométrie réelle
s'accumule) :** script non facturable = `ai_element_filter` tous
OST_Walls/OST_Windows/OST_Levels(hors défauts template)/types créés →
`delete_element` (prouvé : delete marche + cascade, step 1). Avant
chaque scénario/profil. B aussi : `kg-reset.mjs` (ES v1) entre
scénarios ; A (flat) auto-reset `revit-data.db`.

**Préconditions / garde-fous :** Revit + Switch ON + `.rvt` bench
propre ; créer les 2 `.mcp.json` ; **approbation MCP interactive des 2
profils** (garde-fou headless récurrent) + **probe headless de-risk** ;
build courant. Scripts vérificateur + reset-modèle **écrits &
dry-runnés non facturable AVANT** le run P1/P3 billable.

**Décisions — RÉSOLUES (2026-05-19, setup ①+② non facturable) :**
(i) ✅ hauteur mur **lisible déterministe via bbox-z** (test : créé
2700 → lu 2700 exact) ; mur→`Level` aussi lu ; `create_line_based_
element` rend l'**ElementId** (Response:[255043]) → flux B
`create→kg_bind_revit_id` validé. (ii) ✅ reset modèle = **delete
scripté** (`kg-rvt-reset.mjs` prouvé : Walls/Windows/Doors + levels
non-protégés → `delete_element`, retour baseline {Walls:0,Levels:3}).
(iii) pilote = **P1+P3** comme gate go/no-go (retenu).
Livré non facturable : `profiles/s2-direct` + `profiles/s2-kg`
`.mcp.json` ; `kg_bridge/benchmark/stage2/verify_rvt.mjs` (lecteur
.rvt-truth déterministe) ; `server/scripts/kg-rvt-reset.mjs`.
**Archive `.rvt` par scénario (demande utilisateur) — PROUVÉ non
facturable :** pas de commande `save` ⇒ via `send_code_to_revit`
(template `Execute(Document document, object[] parameters)`, `return`
sérialisé JSON, `transactionMode:"none"`). Le doc ouvert était
**`Projet1` non sauvé** (`path=""`) ⇒ `document.Save()` impossible.
**Résolu** : `SaveAs` scripté unique → `kg_bridge/benchmark/live/out/
stage2/stage2-bench.rvt` (dans `out/` gitignored). End-to-end validé :
`SaveAs` ok → `Save()` ok → **copie fichier du `.rvt` ouvert ok**
(5,85 Mo, pas de verrou). Séquence/scénario : build → `verify_rvt`
→ `send_code document.Save()` → copie `stage2-bench.rvt` vers
`out/stage2/<scén>__<profil>.rvt` → `kg-rvt-reset` (B aussi
`kg-reset.mjs`).

**③ approbations MCP s2-direct/s2-kg : FAITES (utilisateur « s2
approuvés »).** Reste avant billable : **probe headless de-risk** des
2 profils ; puis **④ run P1+P3** avec la séquence/scénario ci-dessus
(runner Stage-2 dédié à écrire, non facturable).

**Séquence step-3 :** (1) créer profils + scripts vérif/reset
(non-bill.) → (2) dry-run vérif/reset + probe hauteur (non-bill.) →
(3) approbations MCP + probe headless (toi + ~0,2 $) → (4) **run P1+P3
A vs B (billable)** → (5) verdict go/no-go matrice complète.

## 10. Statut

Design seulement. Rien lancé, rien facturé. Le bench Stage-1 17×3
(run flat `b10bfnziw` en cours) se termine en parallèle ; sa clôture
(inspection outils flat + verdict + commit) reste prioritaire avant
d'attaquer le pilote Stage-2.
