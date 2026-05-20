using System.Collections.Generic;
using Newtonsoft.Json;

namespace RevitMCPKgCommandSet.Models
{
    public class KgTraverseReachedNode
    {
        [JsonProperty("llm_id")] public string LlmId { get; set; }
        [JsonProperty("node_type")] public string NodeType { get; set; }
    }

    public class KgTraverseResult
    {
        [JsonProperty("start_id")] public string StartId { get; set; }
        [JsonProperty("step_count")] public int StepCount { get; set; }
        [JsonProperty("count")] public int Count { get; set; }
        [JsonProperty("reached")] public List<KgTraverseReachedNode> Reached { get; set; }
    }
}
