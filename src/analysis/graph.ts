import type { ExtractedFile } from "./extract.js";
import type { AnalysisRelationship, InventoryFile } from "./types.js";

export function buildRelationships(
  extractedFiles: ExtractedFile[],
  inventoryFiles: InventoryFile[],
  maxRelationships: number,
  signal?: AbortSignal
): AnalysisRelationship[] {
  signal?.throwIfAborted();
  const roles = new Map(inventoryFiles.map((file) => [file.path, file.role]));
  const relationships: AnalysisRelationship[] = [];
  for (const file of extractedFiles) {
    signal?.throwIfAborted();
    for (const target of file.imports) {
      signal?.throwIfAborted();
      if (relationships.length >= maxRelationships) return relationships;
      relationships.push({
        from: file.path,
        to: target,
        kind: roles.get(file.path) === "test" ? "tests" : "imports",
        confidence: "strong",
        source: "built-in import extraction"
      });
    }
  }
  return relationships;
}

export function reverseDependencies(relationships: AnalysisRelationship[], targetPath: string): AnalysisRelationship[] {
  return relationships.filter((relationship) => relationship.to === targetPath);
}
