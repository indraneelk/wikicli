import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, saveManifest, removeSource } from "../lib/manifest.js";
import { removeFile } from "../lib/files.js";

export const removeCommand = new Command("remove")
  .description("Remove a source and its orphaned concepts")
  .argument("<source>", "Source path to remove (relative to project root)")
  .action((sourcePath: string) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);

    if (!manifest.sources[sourcePath]) {
      console.log(JSON.stringify({
        ok: false,
        error: `Source not found in manifest: ${sourcePath}`,
      }));
      return;
    }

    // Remove summary file
    const summaryPath = manifest.sources[sourcePath].summary_path;
    if (summaryPath) {
      removeFile(join(dir, summaryPath));
    }

    // Remove source from manifest and get orphaned concepts
    const orphaned = removeSource(manifest, sourcePath);

    // Remove orphaned concept article files
    for (const slug of orphaned) {
      const articlePath = join(dir, config.output_dir, "concepts", `${slug}.md`);
      removeFile(articlePath);
    }

    // Remove source file
    removeFile(join(dir, sourcePath));

    saveManifest(dir, manifest);

    console.log(JSON.stringify({
      ok: true,
      removed_source: sourcePath,
      orphaned_concepts: orphaned,
      remaining_sources: Object.keys(manifest.sources).length,
      remaining_concepts: Object.keys(manifest.concepts).length,
    }));
  });
