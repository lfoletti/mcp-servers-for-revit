using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using RevitMCPCommandSet.Models.KnowledgeGraph;

namespace RevitMCPCommandSet.Services.KnowledgeGraph
{
    /// <summary>
    /// Source unique des spécificités ExtensibleStorage du KG v1
    /// (DESIGN-internalize-es.md §3, §4). Tout le reste (chunking, schéma de
    /// blob, compaction, versioning) vit côté TypeScript
    /// (`server/src/kg/persist.ts`) ; ici l'ES n'est qu'un **coffre à
    /// blob(s) JSON versionné(s)** qui voyage avec le `.rvt` — on ne mappe
    /// PAS les attributs KG sur des Field typés (NODE_TYPES évolue, un
    /// schéma ES est figé une fois diffusé — §3).
    ///
    /// Faits ES encodés ici (vérifiés doc Autodesk, §3) :
    ///  - ES dispo depuis Revit 2012, `DataStorage` depuis 2013 → OK pour
    ///    toutes les cibles R20–R26 du .csproj ;
    ///  - écriture dans une `Transaction` obligatoire, **lecture non** ;
    ///  - `DataStorage.Create(doc)` + `SetEntity` = le pattern « donnée de
    ///    projet sans élément hôte » → **une seule** `DataStorage` globale,
    ///    pas d'Entity par élément (§4, décision §0.3) ;
    ///  - Field `string` (plafond 16 Mo/objet — borné côté TS), `int`, et
    ///    `Array&lt;string&gt;` (les chunks de log) : aucun flottant /
    ///    `XYZ`, donc **aucune unité** à déclarer (§3).
    /// </summary>
    public static class KgExtensibleStorage
    {
        /// <summary>
        /// GUID du schéma — **CONSTANT À VIE**. Le changer orpheline tous
        /// les blobs déjà écrits dans des `.rvt` existants (le schéma est
        /// figé une fois diffusé, §3). Ne jamais régénérer.
        /// </summary>
        private static readonly Guid SchemaGuid =
            new Guid("B9F7B0E2-1C3D-4A5E-8F60-7A8B9C0D1E2F");

        private const string SchemaName = "RevitMcpKnowledgeGraph";
        private const string VendorId = "MCPSERVERSFORREVIT";

        /// <summary>
        /// Nom de la `Transaction` d'écriture KG. **Public et partagé** :
        /// `KgDocumentWatcher` filtre les `DocumentChanged` portant ce nom
        /// pour ne PAS invalider le cache serveur sur nos propres écritures
        /// ES (§5, « cache longue durée pour les écritures-outils »). Une
        /// seule source pour ce littéral → le filtre ne peut pas dériver.
        /// </summary>
        public const string WriteTransactionName = "KG blob write";

        // Noms de Field — identifiants ES (lettre/chiffre/underscore, pas de
        // chiffre en tête). Figés : ils font partie du schéma diffusé.
        private const string FieldGraph = "graph";
        private const string FieldLogChunks = "log_chunks";
        private const string FieldLogSchemaVersion = "log_schema_version";

        /// <summary>
        /// Récupère le schéma (déjà enregistré dans la session) ou le
        /// construit. Idempotent : <see cref="Schema.Lookup"/> survit entre
        /// commandes et entre documents d'une même session Revit.
        /// </summary>
        public static Schema GetOrCreateSchema()
        {
            Schema schema = Schema.Lookup(SchemaGuid);
            if (schema != null)
                return schema;

            var builder = new SchemaBuilder(SchemaGuid);
            builder.SetSchemaName(SchemaName);
            // Public : le serveur MCP (add-in tiers) lit/écrit ce blob ;
            // pas de restriction Vendor/Application (§3, niveaux d'accès).
            builder.SetReadAccessLevel(AccessLevel.Public);
            builder.SetWriteAccessLevel(AccessLevel.Public);
            // VendorId requis dès qu'un accès est Vendor/Application ; pour
            // Public il est optionnel mais on le pose toujours (recommandé).
            builder.SetVendorId(VendorId);

            builder.AddSimpleField(FieldGraph, typeof(string));
            builder.AddArrayField(FieldLogChunks, typeof(string));
            builder.AddSimpleField(FieldLogSchemaVersion, typeof(int));

            return builder.Finish();
        }

        /// <summary>
        /// La `DataStorage` globale portant notre Entity, ou <c>null</c> si
        /// absente (premier usage, ou « Purge Unused » l'a élaguée).
        /// </summary>
        public static DataStorage FindDataStorage(Document doc, Schema schema)
        {
            // `ExtensibleStorageFilter` (Revit ≥ 2018, OK R20+) : ne ramène
            // que les éléments portant une Entity de CE schéma.
            var collector = new FilteredElementCollector(doc)
                .OfClass(typeof(DataStorage))
                .WherePasses(new ExtensibleStorageFilter(schema.GUID));

            foreach (DataStorage ds in collector.Cast<DataStorage>())
            {
                Entity e = ds.GetEntity(schema);
                if (e != null && e.IsValid())
                    return ds;
            }
            return null;
        }

        /// <summary>
        /// Lit l'enregistrement. <b>Pas de <c>Transaction</c></b> (lecture
        /// ES). <c>Exists=false</c> si la `DataStorage` est absente — on ne
        /// crée RIEN en lecture (recreate-if-missing = côté write).
        /// </summary>
        public static KgBlobReadResult Read(Document doc)
        {
            Schema schema = GetOrCreateSchema();
            DataStorage ds = FindDataStorage(doc, schema);
            if (ds == null)
                return new KgBlobReadResult { Exists = false };

            Entity entity = ds.GetEntity(schema);
            // Tous les Field sont toujours posés ensemble à l'écriture →
            // si l'Entity est valide, les trois champs sont présents.
            IList<string> chunks = entity.Get<IList<string>>(FieldLogChunks);
            return new KgBlobReadResult
            {
                Exists = true,
                Graph = entity.Get<string>(FieldGraph) ?? string.Empty,
                LogChunks = chunks != null
                    ? new List<string>(chunks)
                    : new List<string>(),
                LogSchemaVersion = entity.Get<int>(FieldLogSchemaVersion),
            };
        }

        /// <summary>
        /// Écrit l'enregistrement complet <b>dans une <c>Transaction</c></b>
        /// (atomicité Stage 2 « gratuite », §1) ; (re)crée la `DataStorage`
        /// si absente (recreate-if-missing, §4). Renvoie si une création a
        /// eu lieu.
        /// </summary>
        public static bool Write(Document doc, KgBlobWriteParams data)
        {
            Schema schema = GetOrCreateSchema();
            bool created = false;

            using (var tx = new Transaction(doc, WriteTransactionName))
            {
                tx.Start();

                DataStorage ds = FindDataStorage(doc, schema);
                if (ds == null)
                {
                    ds = DataStorage.Create(doc);
                    created = true;
                }

                var entity = new Entity(schema);
                // ES rejette une string null → on borne sur "" / liste vide.
                entity.Set<string>(FieldGraph, data.Graph ?? string.Empty);

                var chunks = data.LogChunks ?? new List<string>();
                // Chaque élément de l'Array ES doit être non-null ; le
                // découpage 16 Mo/string est garanti côté TS (persist.ts).
                IList<string> safeChunks =
                    chunks.Select(c => c ?? string.Empty).ToList();
                entity.Set<IList<string>>(FieldLogChunks, safeChunks);

                entity.Set<int>(
                    FieldLogSchemaVersion, data.LogSchemaVersion);

                ds.SetEntity(entity);
                tx.Commit();
            }
            return created;
        }
    }
}
