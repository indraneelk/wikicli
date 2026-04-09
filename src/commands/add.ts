import { Command } from "commander";
import { existsSync, copyFileSync, statSync } from "fs";
import { join, basename, resolve } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, saveManifest, addSource } from "../lib/manifest.js";
import { hashFile } from "../lib/hash.js";
import { ensureDir } from "../lib/files.js";

export const addCommand = new Command("add")
  .description("Add source files to the wiki")
  .argument("<paths...>", "File paths or glob patterns to add")
  .action((paths: string[]) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const sourcesDir = join(dir, config.sources_dir);
    ensureDir(sourcesDir);

    const added: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const p of paths) {
      const absPath = resolve(p);

      if (!existsSync(absPath)) {
        errors.push(`File not found: ${p}`);
        continue;
      }

      const fileName = basename(absPath);
      const destPath = join(sourcesDir, fileName);
      const relPath = join(config.sources_dir, fileName);

      // Check if already tracked with same hash
      if (manifest.sources[relPath]) {
        const newHash = hashFile(absPath);
        if (manifest.sources[relPath].hash === newHash) {
          skipped.push(relPath);
          continue;
        }
      }

      // Copy file to sources dir (if not already there)
      if (resolve(absPath) !== resolve(destPath)) {
        copyFileSync(absPath, destPath);
      }

      const hash = hashFile(destPath);
      const size = statSync(destPath).size;
      addSource(manifest, relPath, hash, size);
      added.push(relPath);
    }

    saveManifest(dir, manifest);

    console.log(JSON.stringify({
      ok: true,
      added,
      skipped,
      errors,
      total_sources: Object.keys(manifest.sources).length,
    }));
  });
