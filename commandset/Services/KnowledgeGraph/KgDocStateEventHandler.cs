using System;
using System.Threading;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Models.KnowledgeGraph;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.KnowledgeGraph
{
    /// <summary>
    /// Handler de <c>kg_doc_state</c> — moule des `*EventHandler` existants,
    /// **sans `Transaction`** (pure lecture d'état). Garantit aussi la
    /// souscription aux événements document (lazy/idempotent) : la
    /// surveillance §5 démarre dès la première op KG du serveur.
    /// DESIGN-internalize-es.md §5, §10.5.
    /// </summary>
    public class KgDocStateEventHandler
        : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent =
            new ManualResetEvent(false);

        /// <summary>Borne de drift (input).</summary>
        public long SinceEpoch { get; private set; }

        /// <summary>Résultat (output).</summary>
        public AIResult<KgDocStateResult> Result { get; private set; }

        public void SetParameters(long sinceEpoch)
        {
            SinceEpoch = sinceEpoch;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                KgDocumentWatcher.EnsureSubscribed(app?.Application);
                KgDocStateResult payload =
                    KgDocumentWatcher.Snapshot(SinceEpoch);
                Result = new AIResult<KgDocStateResult>
                {
                    Success = true,
                    Message = "KG doc state",
                    Response = payload,
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgDocStateResult>
                {
                    Success = false,
                    Message = $"kg_doc_state failed: {ex.Message}",
                };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "KG Doc State";
    }
}
