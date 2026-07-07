# NOTE — Ouvrir le MCP Revit à l'exécution arbitraire (session dédiée)

_Rédigé le 2026-07-07. À traiter dans une session Claude Code dédiée, sur ce repo._

## Objectif
Passer d'un **jeu d'outils whitelisté** (accès document, params, requêtes, `kg_v2_*`) à un accès
**générique à tout l'API Revit** : ajouter **un seul outil `revit_execute`** qui exécute du code
fourni par l'agent, dans le contexte API, avec transaction.

## Décisions arrêtées (utilisateur)
- **Langage injecté : C#** (via **Roslyn** `Microsoft.CodeAnalysis.CSharp.Scripting`).
- **Transactions : AUTO-WRAP** (chaque exécution est encadrée par une `Transaction`, avec le
  `SwallowWarningsPreprocessor` déjà présent pour les writes).
- **Sécurité : pleine puissance assumée** (tout l'API Revit exposé — outil perso).

## Rappel architecture du repo (déjà en place, mature)
- **Add-in C#** (`plugin/`) : ruban + service **socket `localhost:8080`** (JSON-RPC).
- **Serveur MCP TypeScript/Node** (`server/`) : parle au socket.
- **`commandset/`** : commandes exécutées via **External Event + Transaction**.
- **Couche KG** (`commandset-kg/` / `kg_bridge/`) synchronisée par hook **`DocumentChanged`**
  → tout create/modify/delete est projeté dans le graphe.
- Revit **2025** (`Debug R25`), `.NET SDK` + `global.json`.

→ Toute la plomberie difficile existe. Il ne manque que la commande générique.

## Plan d'implémentation

### 1. Côté add-in C# — nouvelle commande `execute`
- Créer un handler dans `commandset/…/Commands/` (calquer un handler existant pour
  l'enregistrement + la signature + la sérialisation JSON de la réponse).
- Reçoit `{ code: string }`.
- Exécute dans l'**External Event** existant, **auto-wrap Transaction** :
  ```
  using (var t = new Transaction(doc, "revit_execute")) {
      t.Start();
      // options de warning-swallowing (reutiliser SwallowWarningsPreprocessor)
      var globals = new RevitGlobals { doc=doc, uidoc=uidoc, uiapp=uiapp, app=app };
      var result = await CSharpScript.EvaluateAsync(code, scriptOptions, globals);
      t.Commit();
  }
  ```
- **ScriptOptions** : références aux assemblies `RevitAPI.dll`, `RevitAPIUI.dll`, System.*, et
  usings par défaut (`Autodesk.Revit.DB`, `Autodesk.Revit.UI`, `System`, `System.Linq`,
  `System.Collections.Generic`).
- **Globals** : classe exposant `doc, uidoc, uiapp, app` (+ helper `Print(...)` qui accumule une
  sortie texte à renvoyer).
- **Retour** : `{ ok, output (texte accumulé + valeur de retour du script), error (stacktrace) }`.
- **Cache de compilation** : Roslyn recompile à chaque appel (latence ~100-500 ms au 1er) ;
  option = cacher les scripts compilés par hash du code.

### 2. Côté serveur MCP TypeScript — outil `revit_execute`
- Ajouter `server/src/tools/revit_execute.ts` (calquer un outil existant).
- `inputSchema` : `{ code: string (required) }`.
- Forward `{ command: "execute", code }` sur le socket 8080 → renvoie `output`/`error`.

### 3. Enregistrement
- Déclarer la commande dans le dispatch de l'add-in (`plugin/`) et l'outil dans la liste MCP.

## Bonus (gratuit)
Grâce au hook **`DocumentChanged`**, **tout ce que le code arbitraire modifie est
automatiquement projeté dans le KG** → exécution libre **+** mémoire/audit structurés.

## Garde-fou : auto-OFF après N minutes
Réduire la fenêtre d'exposition (le service = surface RCE tant qu'il tourne) : le
socket-exécuteur **s'arrête tout seul** après N minutes, sans intervention.

- **Mode** : timer d'**inactivité** (réarmé à chaque commande reçue) plutôt qu'absolu → coupe
  quand plus personne ne s'en sert, sans interrompre une session active. _Option_ : ajouter une
  **borne absolue** en plus (ex. 2 h max quoi qu'il arrive).
- **Défaut** : `N = 15 min` (à confirmer).
- **Implémentation (add-in C#)** : un `System.Threading.Timer` (ou tâche) démarré par `start()`,
  **réarmé** dans le handler de commande ; à l'échéance → `stop()` du service (fermer le listener
  socket), sur le thread approprié. Rendre `N` configurable (config add-in / env).
- **UI** : à l'auto-off, l'**icône du bouton repasse au gris** (le bouton lit l'état réel du
  service). Prévoir un rafraîchissement de l'icône + notification _"MCP Revit désactivé
  automatiquement après N min"_.
- **Effet** : même en cas d'oubli, la porte se referme seule → limite le risque « socket ouvert »
  et l'exposition EDR.
- _Écho côté prototype pyRevit_ : `lib/revitmcp_exec.py` peut recevoir le même mécanisme (timer
  qui appelle `stop()`), utile pour tester le comportement rapidement.

## À trancher pendant la session dédiée
- Format exact du **canal de retour** (texte via `Print`, valeur du script, ou JSON).
- **Auto-wrap sur les lectures** : transaction no-op inoffensive, ou détecter read-only ?
  (Décision actuelle = auto-wrap systématique, simple.)
- Gestion des **exceptions** (rollback auto de la transaction) et sérialisation de la stacktrace.
- **Cache** des scripts compilés (perf).
- Éventuellement un **`execute_python`** en complément plus tard.
- **Auto-off** : valeur de `N`, timer d'**inactivité vs borne absolue**, et notification à l'utilisateur au déclenchement.

## Réserves EDR (poste BIM verrouillé)
- Le **serveur MCP Node** et l'**add-in DLL** doivent déjà se charger/tourner sur ce poste
  (le repo est développé ici → a priori OK). L'ajout de `execute` **ne change rien à l'EDR** :
  c'est du code exécuté **dans** Revit/Node déjà autorisés. À reconfirmer au démarrage de session.

## Références
- Repo : https://github.com/lfoletti/mcp-servers-for-revit
- **Prototype pyRevit de la même idée** (preuve de concept, à ne PAS poursuivre — consolider ici) :
  `C:\Users\lauro\Documents\IT\revit_to_rhino\revit_mcp\` — socket + `IExternalEventHandler` +
  outil `revit_execute` en Python stdlib. Montre le pattern socket→ExternalEvent→exec→retour.
- Contrainte EDR & environnement Python du poste : voir la mémoire projet `revit_to_rhino`
  (`.venv` OK mais `pip install` bloqué → stdlib-only ; contexte API Revit = mono-thread).
