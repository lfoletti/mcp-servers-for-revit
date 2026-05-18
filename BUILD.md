# BUILD — pipeline C# (add-in Revit + command set) → exécution

> Comment compiler, déployer et lancer le plugin Revit + le serveur MCP.
> La partie TS (étapes 1–5, suite `npm test`) est documentée dans
> `JOURNAL.md` ; ici = la chaîne C#/Revit, **non vérifiable hors d'un poste
> Windows + Revit installé** (l'env de dev n'a que node).

---

## 0. Vue d'ensemble

Deux projets .NET dans `mcp-servers-for-revit.sln` :

| Projet | Produit | Rôle |
|---|---|---|
| `plugin/RevitMCPPlugin.csproj` | `RevitMCPPlugin.dll` | l'**add-in** Revit (`IExternalApplication` = `revit_mcp_plugin.Core.Application`), ruban + serveur socket |
| `commandset/RevitMCPCommandSet.csproj` | `RevitMCPCommandSet.dll` + `command.json` | le **jeu de commandes** chargé dynamiquement (dont nos `kg_blob_read` / `kg_blob_write` / `kg_doc_state`) |

Manifeste add-in : `plugin/mcp-servers-for-revit.addin` (Type=Application).

Chaîne d'exécution v1 :

```
client MCP ──stdio──> serveur TS (server/build/index.js)
   kgService → SocketKgBlobTransport ──TCP localhost:8080──> add-in Revit
   → commandes C# kg_blob_read/write/doc_state → ExtensibleStorage du .rvt
```

---

## 1. Prérequis

- **Windows** + la version de Revit visée **installée** (pour exécuter).
- **.NET SDK** : `dotnet` suffit pour R25/R26 (`net8.0-windows`). Pour
  R20–R24 (`net48`), build via Visual Studio 2022 ou `msbuild` Full
  Framework.
- Accès NuGet (1er build) : `Nice3point.Revit.Api.*`, `RevitMCPSDK`,
  `Newtonsoft.Json`.
- Node (serveur MCP) : ici uniquement via l'env conda `revitmcp`
  (`C:\Users\lauro\AppData\Local\anaconda3\envs\revitmcp`, Node v25.x).

---

## 2. Compiler

Les configurations de solution sont **versionnées par Revit** et toutes
en plateforme **`Any CPU`** (le `x64` est forcé *dans* les `.csproj` via
`<PlatformTarget>x64</PlatformTarget>` — l'étiquette solution reste
« Any CPU »).

Configs valides : `Debug R20`…`Debug R26`, `Release R20`…`Release R26`.
Prendre celle de la version installée (R25 = Revit 2025, etc.).

```powershell
# depuis la racine du repo
dotnet build mcp-servers-for-revit.sln -c "Debug R25"
```

> ⚠️ **NE PAS** ajouter `-p:Platform=x64` : la solution ne définit que
> `…|Any CPU` → erreur **MSB4126** (« configuration de solution non
> valide ») et le restore échoue dans la foulée. Si besoin d'être
> explicite : `-p:Platform="Any CPU"`.

### Build minimal pour déployer (recommandé)

Construire la solution entière échoue tant que le **projet de tests C#**
`tests\commandset\RevitMCPCommandSet.Tests.csproj` ne build pas (cf. §6,
`MSB4062`). Ce projet est **inutile pour exécuter l'add-in / l'étape 6**.
Construire les deux seuls projets *runtime*, directement (pas le `.sln`) :

```powershell
dotnet build plugin\RevitMCPPlugin.csproj          -c "Debug R25"
dotnet build commandset\RevitMCPCommandSet.csproj  -c "Debug R25"
```

Le second compile **réellement** le C# KG des étapes 3 & 5
(`commandset\…\KnowledgeGraph\`) et déclenche `DeployCommandSet` (auto-copie
en `Debug`). Combiné au plugin (déjà OK), l'add-in est entièrement déployé.

> Le projet de tests C# (`RevitMCPCommandSet.Tests`) utilise un SDK
> **différent** (`Nice3point.Revit.Sdk`) et des configs nommées avec un
> **point** (`Debug.R25`, pas `Debug R25`). Il est hors du chemin
> « déployer + étape 6 ». Voir §6 pour le rendre vert.

---

## 3. Déploiement (automatique en `Debug`)

Cibles MSBuild post-build :

- `RevitMCPPlugin.csproj` → cible **`CopyFiles`** : assemble dans
  `plugin\bin\AddIn <ver> <Config>\` puis, **en `Debug` uniquement**,
  copie récursivement dans
  `%AppData%\Autodesk\Revit\Addins\<ver>\`
  (le `.addin` à la racine + `revit_mcp_plugin\RevitMCPPlugin.dll`).
- `RevitMCPCommandSet.csproj` → cible **`DeployCommandSet`** : copie
  `RevitMCPCommandSet.dll` + `command.json` dans la sortie AddIn du
  plugin et, **en `Debug`**, dans
  `%AppData%\Autodesk\Revit\Addins\<ver>\revit_mcp_plugin\Commands\…`.

Arbre installé attendu (Revit 2025) — chemins **exacts** dérivés des
cibles MSBuild (`CopyFiles` plugin + `DeployCommandSet` commandset) :

```
%AppData%\Autodesk\Revit\Addins\2025\
    mcp-servers-for-revit.addin                                         (plugin)
    revit_mcp_plugin\RevitMCPPlugin.dll                                 (plugin)
    revit_mcp_plugin\Commands\RevitMCPCommandSet\command.json           (commandset)
    revit_mcp_plugin\Commands\RevitMCPCommandSet\2025\RevitMCPCommandSet.dll
```

> ⚠️ `command.json` est sous `…\Commands\RevitMCPCommandSet\` (= la prop
> MSBuild `RevitAddinsDir`), **pas** directement sous `…\Commands\`. Le
> DLL est dans le sous-dossier de version `…\RevitMCPCommandSet\2025\`.

Sortie binaire intermédiaire du plugin : `plugin\bin\Debug\2025\RevitMCPPlugin.dll`.

**`Release`**, ou si l'auto-copie `Debug` ne s'est pas faite : déployer
manuellement (toujours fiable — l'arbre de staging est complet dès que le
build passe) :

```powershell
$dst = Join-Path $env:APPDATA 'Autodesk\Revit\Addins\2025'
robocopy "plugin\bin\AddIn 2025 Debug R25" $dst /E
```

> ⚠️ Vérifier l'install avec un **chemin littéral**, pas une variable, et
> **sans** `-ErrorAction SilentlyContinue` (qui masque un `$root` non
> défini → faux « rien d'installé »). La présence de
> `plugin\bin\AddIn <ver> <cfg>\` peuplé **prouve** que le build a réussi
> (les deux projets, code KG inclus) — c'est le contrôle de référence.

---

## 4. Côté Revit

1. Lancer Revit → avertissement add-in non signé → **« Toujours charger »**.
2. Panneau ruban **« Revit MCP Plugin »** :
   - **Settings** : activer le command set `RevitMCPCommandSet`
     (registre `Commands\commandRegistry.json` géré par `PathManager`).
   - **Revit MCP / Switch** : démarre/arrête le serveur socket
     (`localhost:8080`, cf. `server/src/utils/ConnectionManager.ts`).
3. Ouvrir un `.rvt`, cliquer **Switch**.

---

## 5. Serveur MCP (TS)

```powershell
cd server; npm install; npm run build      # via le node de l'env conda revitmcp
```

Config client MCP (v1 — **plus** de variables sidecar `KG_PYTHON`/`KG_HOME`) :

```json
{ "mcpServers": { "revit": {
  "command": "node",
  "args": ["C:/ABSOLU/.../server/build/index.js"]
} } }
```

`KG_BENCH_MODE` : `kg` (défaut, outils KG) | `flat` (baseline pure).

---

## 6. Dépannage

| Symptôme | Cause / fix |
|---|---|
| `MSB4126 … "Debug R25\|x64" n'est pas valide` | Ne pas passer `-p:Platform=x64` ; la solution est en `Any CPU` (§2). |
| `warning CS0618 'ElementId.ElementId(int)' est obsolète` (CreatePoint/Line/SurfaceElementEventHandler…) | **Pré-existant amont**, bénin (déprécation Revit 2024, pas une erreur). Hors périmètre KG v1 — ne pas « corriger » (on ne touche pas l'amont sans raison). |
| `MSB4062 … Sdk.GenerateCompatibleDefineConstants … net10.0\Nice3point.Revit.Sdk.dll … System.Runtime, Version=10.0.0.0 introuvable` | Vient **du projet de tests** `RevitMCPCommandSet.Tests` (SDK `Nice3point.Revit.Sdk/6.1.0` dont les tâches MSBuild ciblent **net10.0**) ; le `dotnet` installé n'a pas le runtime .NET 10. **Pas** une erreur de code KG. **Contournement** : ne pas builder le `.sln`, builder les 2 projets runtime directement (§2 « Build minimal »). **Correctif propre** : installer le **.NET 10 SDK** ; ou épingler `Nice3point.Revit.Sdk` à une version dont les tâches ciblent un runtime présent (net8.0). |
| `Générer a échoué … 1 erreur` mais `RevitMCPPlugin a réussi` | L'erreur vient soit du **projet de tests** (ligne ci-dessus, fréquent), soit de `RevitMCPCommandSet`. Isoler via le build minimal §2 et lire la ligne `: error CSxxxx`. |
| Add-in absent du ruban | Build en `Release` (pas d'auto-copie) ou Revit ≠ version de la config ; vérifier l'arbre §3. |
| Le serveur TS ne se connecte pas | Cliquer **Switch** dans Revit (socket non démarré) ; port 8080 libre. |

---

## 7. Statut connu (à la dernière exécution)

- TS étapes 1–5 : **60/60** vert, `tsc` prod vert (cf. `JOURNAL.md`).
- C# `RevitMCPPlugin` : **compile** (`Debug R25`).
- C# `RevitMCPCommandSet` (étapes 3 & 5,
  `commandset/{Commands,Services,Models}/KnowledgeGraph/`) : **compile
  vert** (`Debug R25`) — confirmé par l'arbre de staging
  `plugin\bin\AddIn 2025 Debug R25\` complet (plugin + commandset). Seuls
  warnings = `CS0618`/`CS0168` **amont pré-existants** (non touchés :
  hors périmètre KG v1). Le C# des 5 étapes est donc compilable.
- Build `.sln` entier : **bloqué par `RevitMCPCommandSet.Tests`**
  (`MSB4062`, outillage `Nice3point.Revit.Sdk` net10 manquant — §6).
  **Pas** une erreur du code KG ; contourné par le build minimal §2.
- Projet de tests C# `RevitMCPCommandSet.Tests` : vert nécessite .NET 10
  SDK (ou épinglage `Nice3point.Revit.Sdk`) — hors chemin étape 6.
- **Reste à faire** : déployer dans `Addins\2025\` (auto en Debug, sinon
  robocopy §3), puis étape 6 (re-bench, requiert Revit lancé).
