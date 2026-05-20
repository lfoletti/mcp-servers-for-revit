using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;

namespace RevitMCPKgCommandSet.Services
{
    public static class KgV2ExtensibleStorage
    {
        private static readonly Guid SchemaGuid =
            new Guid("A3F7D2E8-9B6C-4D5A-8E1F-3C4B5A6D7E8F");

        private const string SchemaName = "RevitMcpKnowledgeGraphV2";
        private const string VendorId = "MCPSERVERSFORREVIT";

        public const string WriteTransactionName = "KG v2 delta write";

        private const string FieldJsonl = "jsonl";
        private const string FieldSchemaVersion = "schema_version";

        public const int CurrentSchemaVersion = 1;

        public static Schema GetOrCreateSchema()
        {
            Schema schema = Schema.Lookup(SchemaGuid);
            if (schema != null) return schema;

            var builder = new SchemaBuilder(SchemaGuid);
            builder.SetSchemaName(SchemaName);
            builder.SetReadAccessLevel(AccessLevel.Public);
            builder.SetWriteAccessLevel(AccessLevel.Public);
            builder.SetVendorId(VendorId);

            builder.AddSimpleField(FieldJsonl, typeof(string));
            builder.AddSimpleField(FieldSchemaVersion, typeof(int));

            return builder.Finish();
        }

        public static DataStorage FindDataStorage(Document doc, Schema schema)
        {
            var collector = new FilteredElementCollector(doc)
                .OfClass(typeof(DataStorage))
                .WherePasses(new ExtensibleStorageFilter(schema.GUID));

            foreach (DataStorage ds in collector.Cast<DataStorage>())
            {
                Entity e = ds.GetEntity(schema);
                if (e != null && e.IsValid()) return ds;
            }
            return null;
        }

        public static string Read(Document doc)
        {
            if (doc == null) return null;
            var schema = GetOrCreateSchema();
            var ds = FindDataStorage(doc, schema);
            if (ds == null) return null;
            var entity = ds.GetEntity(schema);
            return entity.Get<string>(FieldJsonl) ?? string.Empty;
        }

        public static int ReadSchemaVersion(Document doc)
        {
            if (doc == null) return 0;
            var schema = GetOrCreateSchema();
            var ds = FindDataStorage(doc, schema);
            if (ds == null) return 0;
            var entity = ds.GetEntity(schema);
            return entity.Get<int>(FieldSchemaVersion);
        }

        public static void Write(Document doc, string jsonl)
        {
            if (doc == null) return;
            var schema = GetOrCreateSchema();
            using var tx = new Transaction(doc, WriteTransactionName);
            tx.Start();
            var ds = FindDataStorage(doc, schema);
            if (ds == null) ds = DataStorage.Create(doc);
            var entity = new Entity(schema);
            entity.Set<string>(FieldJsonl, jsonl ?? string.Empty);
            entity.Set<int>(FieldSchemaVersion, CurrentSchemaVersion);
            ds.SetEntity(entity);
            tx.Commit();
        }
    }
}
