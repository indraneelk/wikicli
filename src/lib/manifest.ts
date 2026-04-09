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
