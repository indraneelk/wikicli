import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface SourceEntry {
  hash: string;
  size_bytes: number;
  added_at: string;
  compiled_at: string | null;
  summary_path: string | null;
  status: "pending" | "compiled" | "error";
}

export interface ConceptEntry {
  article_path: string;
  sources: string[];
  aliases: string[];
  last_compiled: string | null;
}

export const RELATION_TYPES = [
  "implements",
  "extends",
  "optimizes",
  "contradicts",
  "cites",
  "prerequisite_of",
  "trades_off",
  "derived_from",
] as const;
export type RelationType = typeof RELATION_TYPES[number];

export interface RelationEntry {
  id: string;
  source: string;
  target: string;
  type: RelationType;
  created_at: string;
  evidence?: string;
}

export interface Manifest {
  version: number;
  sources: Record<string, SourceEntry>;
  concepts: Record<string, ConceptEntry>;
}

function emptyManifest(): Manifest {
  return { version: 1, sources: {}, concepts: {} };
}

function manifestPath(dir: string): string {
  return join(dir, ".wikic", "manifest.json");
}

export function loadManifest(dir: string): Manifest {
  const p = manifestPath(dir);
  if (!existsSync(p)) return emptyManifest();
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function saveManifest(dir: string, manifest: Manifest): void {
  const p = manifestPath(dir);
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n");
}

export function addSource(
  manifest: Manifest,
  path: string,
  hash: string,
  sizeBytes: number
): void {
  manifest.sources[path] = {
    hash,
    size_bytes: sizeBytes,
    added_at: new Date().toISOString(),
    compiled_at: null,
    summary_path: null,
    status: "pending",
  };
}

export function removeSource(manifest: Manifest, path: string): string[] {
  delete manifest.sources[path];
  // Find orphaned concepts (only referenced by this source)
  const orphaned: string[] = [];
  for (const [slug, concept] of Object.entries(manifest.concepts)) {
    concept.sources = concept.sources.filter((s) => s !== path);
    if (concept.sources.length === 0) {
      orphaned.push(slug);
      delete manifest.concepts[slug];
    }
  }
  return orphaned;
}

export function upsertConcept(
  manifest: Manifest,
  slug: string,
  sourcePath: string,
  articlePath: string,
  aliases: string[] = []
): void {
  const existing = manifest.concepts[slug];
  if (existing) {
    if (!existing.sources.includes(sourcePath)) {
      existing.sources.push(sourcePath);
    }
    existing.aliases = [...new Set([...existing.aliases, ...aliases])];
  } else {
    manifest.concepts[slug] = {
      article_path: articlePath,
      sources: [sourcePath],
      aliases,
      last_compiled: null,
    };
  }
}

function graphPath(dir: string): string {
  return join(dir, ".wikic", "graph.json");
}

export function loadRelations(dir: string): RelationEntry[] {
  const p = graphPath(dir);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function saveRelations(dir: string, relations: RelationEntry[]): void {
  const p = graphPath(dir);
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(p, JSON.stringify(relations, null, 2) + "\n");
}

export function upsertRelation(
  manifest: Manifest,
  relations: RelationEntry[],
  source: string,
  target: string,
  type: RelationType,
  evidence?: string
): RelationEntry {
  const key = `${source}→${target}→${type}`;
  const existing = relations.find(
    (r) => `${r.source}→${r.target}→${r.type}` === key
  );
  if (existing) {
    if (evidence !== undefined) existing.evidence = evidence;
    return existing;
  }
  const entry: RelationEntry = {
    id: Date.now().toString(),
    source,
    target,
    type,
    created_at: new Date().toISOString(),
    evidence,
  };
  relations.push(entry);
  return entry;
}

export function removeRelation(
  manifest: Manifest,
  relations: RelationEntry[],
  relationId: string
): void {
  const idx = relations.findIndex((r) => r.id === relationId);
  if (idx !== -1) relations.splice(idx, 1);
}

export function getRelationsByType(
  relations: RelationEntry[],
  type: RelationType
): RelationEntry[] {
  return relations.filter((r) => r.type === type);
}

export function getRelationsForConcept(
  relations: RelationEntry[],
  slug: string
): RelationEntry[] {
  return relations.filter((r) => r.source === slug || r.target === slug);
}

export function detectCycle(relations: RelationEntry[]): boolean {
  const graph = new Map<string, string[]>();
  for (const r of relations) {
    if (!graph.has(r.source)) graph.set(r.source, []);
    graph.get(r.source)!.push(r.target);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);
    for (const neighbor of graph.get(node) || []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (recursionStack.has(neighbor)) {
        return true;
      }
    }
    recursionStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}
