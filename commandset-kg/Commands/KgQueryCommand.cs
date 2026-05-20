using System;
using System.Collections.Generic;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPKgCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPKgCommandSet.Commands
{
    public class KgQueryCommand : ExternalEventCommandBase
    {
        private KgQueryEventHandler _handler => (KgQueryEventHandler)Handler;

        public override string CommandName => "kg_query";

        public KgQueryCommand(UIApplication uiApp)
            : base(new KgQueryEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                string nodeType = parameters?["node_type"]?.ToString();
                bool includeSoftDeleted = parameters?["include_soft_deleted"]?.Value<bool>() ?? false;

                Dictionary<string, object> attrsFilter = null;
                var f = parameters?["attrs_filter"];
                if (f is JObject jo) attrsFilter = jo.ToObject<Dictionary<string, object>>();

                _handler.SetParameters(nodeType, attrsFilter, includeSoftDeleted);

                if (RaiseAndWaitForCompletion(10000))
                    return _handler.Result;

                throw new TimeoutException("kg_query timed out");
            }
            catch (Exception ex)
            {
                throw new Exception($"kg_query failed: {ex.Message}");
            }
        }
    }
}
