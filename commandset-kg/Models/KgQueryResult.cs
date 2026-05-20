using System.Collections.Generic;
using Newtonsoft.Json;

namespace RevitMCPKgCommandSet.Models
{
    public class KgQueryResult
    {
        [JsonProperty("count")] public int Count { get; set; }
        [JsonProperty("nodes")] public List<KgNodeView> Nodes { get; set; }
    }
}
