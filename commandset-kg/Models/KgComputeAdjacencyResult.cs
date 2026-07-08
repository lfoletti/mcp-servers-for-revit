using System.Collections.Generic;
using Newtonsoft.Json;

namespace RevitMCPKgCommandSet.Models
{
    public class KgAdjacencyPairView
    {
        [JsonProperty("src")] public string Src { get; set; }
        [JsonProperty("dst")] public string Dst { get; set; }
        [JsonProperty("boundary_type")] public string BoundaryType { get; set; }
        [JsonProperty("via")] public List<string> Via { get; set; }
    }

    public class KgComputeAdjacencyResult
    {
        [JsonProperty("rooms")] public int Rooms { get; set; }
        [JsonProperty("pairs")] public int Pairs { get; set; }
        [JsonProperty("separation_lines")] public int SeparationLines { get; set; }
        [JsonProperty("computed_at_turn")] public int ComputedAtTurn { get; set; }
        [JsonProperty("adjacencies")] public List<KgAdjacencyPairView> Adjacencies { get; set; }
    }
}
