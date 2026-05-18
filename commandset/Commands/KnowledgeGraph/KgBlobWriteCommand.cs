using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Models.KnowledgeGraph;
using RevitMCPCommandSet.Services.KnowledgeGraph;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.KnowledgeGraph
{
    /// <summary>
    /// <c>kg_blob_write</c> — écrit l'enregistrement complet
    /// (<c>{ graph, log_chunks, log_schema_version }</c>) dans l'unique
    /// <c>DataStorage</c> globale, au sein d'une <c>Transaction</c> Revit
    /// (atomicité Stage 2, §1) ; recreate-if-missing (§4). Réalise le port
    /// <c>KgBlobTransport.write</c> de `server/src/kg/persist.ts`. Moule
    /// exact de <c>CreateLevelCommand</c>. DESIGN-internalize-es.md §1, §4,
    /// §8, §10.3.
    /// </summary>
    public class KgBlobWriteCommand : ExternalEventCommandBase
    {
        private KgBlobWriteEventHandler _handler =>
            (KgBlobWriteEventHandler)Handler;

        /// <summary>Doit matcher le nom d'outil MCP / la clé command.json.</summary>
        public override string CommandName => "kg_blob_write";

        public KgBlobWriteCommand(UIApplication uiApp)
            : base(new KgBlobWriteEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                KgBlobWriteParams data =
                    parameters?.ToObject<KgBlobWriteParams>();
                if (data == null)
                    throw new ArgumentNullException(
                        nameof(data), "No KG blob data provided");

                _handler.SetParameters(data);

                // Tx ES potentiellement grosse (graphe + log chunké) :
                // marge confortable vs les 15 s des commandes légères.
                if (RaiseAndWaitForCompletion(30000))
                    return _handler.Result;

                throw new TimeoutException("kg_blob_write timed out");
            }
            catch (Exception ex)
            {
                throw new Exception($"kg_blob_write failed: {ex.Message}");
            }
        }
    }
}
