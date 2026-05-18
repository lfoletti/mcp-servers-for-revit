using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.KnowledgeGraph;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.KnowledgeGraph
{
    /// <summary>
    /// <c>kg_doc_state</c> — signal d'invalidation du cache serveur
    /// (DESIGN-internalize-es.md §5, §10.5). Renvoie l'epoch monotone +
    /// l'identité document (+ le drift récent, base de `kg_detect_drift`
    /// Stage 2). Sans `Transaction` (pure lecture). Moule exact de
    /// <c>CreateLevelCommand</c>. Param optionnel <c>since_epoch</c>.
    /// </summary>
    public class KgDocStateCommand : ExternalEventCommandBase
    {
        private KgDocStateEventHandler _handler =>
            (KgDocStateEventHandler)Handler;

        /// <summary>Doit matcher le nom d'outil MCP / la clé command.json.</summary>
        public override string CommandName => "kg_doc_state";

        public KgDocStateCommand(UIApplication uiApp)
            : base(new KgDocStateEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                long sinceEpoch = 0;
                JToken tok = parameters?["since_epoch"];
                if (tok != null && tok.Type != JTokenType.Null)
                    sinceEpoch = tok.Value<long>();

                _handler.SetParameters(sinceEpoch);

                if (RaiseAndWaitForCompletion(10000))
                    return _handler.Result;

                throw new TimeoutException("kg_doc_state timed out");
            }
            catch (Exception ex)
            {
                throw new Exception($"kg_doc_state failed: {ex.Message}");
            }
        }
    }
}
