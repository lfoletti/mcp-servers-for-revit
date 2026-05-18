using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.KnowledgeGraph;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.KnowledgeGraph
{
    /// <summary>
    /// <c>kg_blob_read</c> — lit la <c>DataStorage</c> globale du KG
    /// (graphe vivant + chunks de log). Aucun paramètre (opère sur le
    /// document actif). Réalise le port <c>KgBlobTransport.read</c> de
    /// `server/src/kg/persist.ts` : <c>exists=false</c> ⇒ le TS mappe sur
    /// <c>null</c> (pas d'erreur — recreate-if-missing porté par
    /// <c>kg_blob_write</c>). Moule exact de <c>CreateLevelCommand</c>.
    /// DESIGN-internalize-es.md §4, §8, §10.3.
    /// </summary>
    public class KgBlobReadCommand : ExternalEventCommandBase
    {
        private KgBlobReadEventHandler _handler =>
            (KgBlobReadEventHandler)Handler;

        /// <summary>Doit matcher le nom d'outil MCP / la clé command.json.</summary>
        public override string CommandName => "kg_blob_read";

        public KgBlobReadCommand(UIApplication uiApp)
            : base(new KgBlobReadEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                if (RaiseAndWaitForCompletion(15000))
                    return _handler.Result;

                throw new TimeoutException("kg_blob_read timed out");
            }
            catch (Exception ex)
            {
                throw new Exception($"kg_blob_read failed: {ex.Message}");
            }
        }
    }
}
