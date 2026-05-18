using System;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Models.KnowledgeGraph;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.KnowledgeGraph
{
    /// <summary>
    /// Handler de <c>kg_blob_read</c> — moule des <c>*EventHandler</c>
    /// existants (cf. <c>GetCurrentViewInfoEventHandler</c> : lecture pure,
    /// pas de <c>Transaction</c>). Tourne sur le thread API Revit via
    /// l'ExternalEvent (obligatoire même en lecture : FilteredElementCollector
    /// / GetEntity). DESIGN-internalize-es.md §4, §8, §10.3.
    /// </summary>
    public class KgBlobReadEventHandler
        : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent =
            new ManualResetEvent(false);

        /// <summary>Résultat (output).</summary>
        public AIResult<KgBlobReadResult> Result { get; private set; }

        public void Execute(UIApplication app)
        {
            try
            {
                Document doc = app.ActiveUIDocument?.Document;
                if (doc == null)
                    throw new InvalidOperationException(
                        "No active Revit document for kg_blob_read");

                KgBlobReadResult payload = KgExtensibleStorage.Read(doc);

                Result = new AIResult<KgBlobReadResult>
                {
                    Success = true,
                    Message = payload.Exists
                        ? "KG blob read"
                        : "No KG DataStorage (absent / purged)",
                    Response = payload,
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgBlobReadResult>
                {
                    Success = false,
                    Message = $"kg_blob_read failed: {ex.Message}",
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

        public string GetName() => "KG Blob Read";
    }
}
