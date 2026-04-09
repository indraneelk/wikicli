import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { loadManifest } from "../lib/manifest.js";

export const statusCommand = new Command("status")
  .description("Show wiki project status as JSON")
  .action(() => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);

    const sources = Object.entries(manifest.sources);
    const concepts = Object.entries(manifest.concepts);

    const pendingSources = sources.filter(([, e]) => e.status === "pending").length;
    const compiledSources = sources.filter(([, e]) => e.status === "compiled").length;
    const errorSources = sources.filter(([, e]) => e.status === "error").length;

    const lastCompiled = sources
      .map(([, e]) => e.compiled_at)
      .filter(Boolean)
      .sort()
      .pop() || null;

    console.log(JSON.stringify({
      ok: true,
      project: config.project,
      sources: {
        total: sources.length,
        pending: pendingSources,
        compiled: compiledSources,
        error: errorSources,
      },
      concepts: {
        total: concepts.length,
        slugs: concepts.map(([slug]) => slug).sort(),
      },
      last_compiled: lastCompiled,
    }));
  });
