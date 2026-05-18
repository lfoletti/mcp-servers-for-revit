using System.Collections.Generic;
using Newtonsoft.Json;

namespace RevitMCPCommandSet.Models.KnowledgeGraph
{
    // DTOs du contrat blob KG v1 (DESIGN-internalize-es.md §3, §4, §10.3).
    //
    // Les clés JSON sont figées en snake_case via [JsonProperty] pour
    // matcher 1:1 le `KgBlobRecord` TypeScript de `server/src/kg/persist.ts`
    // ({ graph, log_chunks, log_schema_version }) — indépendamment de tout
    // réglage de casing global du sérialiseur. C# = coffre à blobs « bête »,
    // toute la politique (chunking, schéma, compaction) vit côté TS.

    /// <summary>
    /// Paramètres de <c>kg_blob_write</c> : l'enregistrement complet à
    /// persister dans l'unique <c>DataStorage</c> globale (un champ string
    /// pour le graphe, un Array&lt;string&gt; pour les chunks de log, un int
    /// de version du log).
    /// </summary>
    public class KgBlobWriteParams
    {
        [JsonProperty("graph")]
        public string Graph { get; set; }

        [JsonProperty("log_chunks")]
        public List<string> LogChunks { get; set; }

        [JsonProperty("log_schema_version")]
        public int LogSchemaVersion { get; set; }
    }

    /// <summary>
    /// Charge utile de <c>kg_blob_read</c>. <see cref="Exists"/> = false ⇒
    /// la <c>DataStorage</c> est absente (premier usage, ou « Purge
    /// Unused ») ; côté TS le transport mappe ce cas sur <c>null</c> (cf.
    /// `KgBlobTransport.read` → `loadGraph` renvoie null, pas d'erreur).
    /// La lecture ES n'exige PAS de <c>Transaction</c> et ne crée rien
    /// (recreate-if-missing est porté par <c>kg_blob_write</c>).
    /// </summary>
    public class KgBlobReadResult
    {
        [JsonProperty("exists")]
        public bool Exists { get; set; }

        [JsonProperty("graph")]
        public string Graph { get; set; } = string.Empty;

        [JsonProperty("log_chunks")]
        public List<string> LogChunks { get; set; } = new List<string>();

        [JsonProperty("log_schema_version")]
        public int LogSchemaVersion { get; set; }
    }

    /// <summary>Issue de <c>kg_blob_write</c> (informatif).</summary>
    public class KgBlobWriteResult
    {
        [JsonProperty("wrote")]
        public bool Wrote { get; set; }

        /// <summary>true si la <c>DataStorage</c> a dû être (re)créée
        /// (recreate-if-missing, DESIGN-internalize-es.md §4).</summary>
        [JsonProperty("created_data_storage")]
        public bool CreatedDataStorage { get; set; }
    }

    /// <summary>Paramètres de <c>kg_doc_state</c>.</summary>
    public class KgDocStateParams
    {
        /// <summary>Ne renvoyer le drift que pour <c>epoch &gt; since_epoch</c>
        /// (0 ⇒ tout le buffer retenu). Le serveur passe le dernier epoch
        /// qu'il a vu.</summary>
        [JsonProperty("since_epoch")]
        public long SinceEpoch { get; set; }
    }

    /// <summary>
    /// Charge utile de <c>kg_doc_state</c> (DESIGN-internalize-es.md §5,
    /// §10.5). <c>epoch</c> monotone + identité document = signal
    /// d'invalidation du cache serveur ; les *_ids sont la **base de
    /// `kg_detect_drift`** (Stage 2, non consommée à l'étape 5).
    /// </summary>
    public class KgDocStateResult
    {
        [JsonProperty("epoch")]
        public long Epoch { get; set; }

        /// <summary>Identité stable du document (PathName, sinon Title) :
        /// un changement ⇒ document ouvert/basculé ⇒ reload.</summary>
        [JsonProperty("doc_key")]
        public string DocKey { get; set; } = string.Empty;

        [JsonProperty("doc_title")]
        public string DocTitle { get; set; } = string.Empty;

        [JsonProperty("deleted_ids")]
        public List<long> DeletedIds { get; set; } = new List<long>();

        [JsonProperty("added_ids")]
        public List<long> AddedIds { get; set; } = new List<long>();

        [JsonProperty("modified_ids")]
        public List<long> ModifiedIds { get; set; } = new List<long>();
    }
}
