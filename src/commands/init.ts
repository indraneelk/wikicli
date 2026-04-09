import { Command } from "commander";
import { existsSync } from "fs";
import { join } from "path";
import { getDefaultConfig, configToYaml } from "../lib/config.js";
import { ensureDir, writeText } from "../lib/files.js";
import { saveManifest, loadManifest } from "../lib/manifest.js";

export const initCommand = new Command("init")
  .description("Initialize a new wikic project")
  .option("-p, --project <name>", "Project name")
  .action((opts) => {
    const dir = process.cwd();
    const configPath = join(dir, "config.yaml");

    if (existsSync(configPath)) {
      console.error("Error: config.yaml already exists. Project already initialized.");
      process.exit(1);
    }

    const config = getDefaultConfig();
    if (opts.project) config.project = opts.project;

    // Create directories
    ensureDir(join(dir, config.sources_dir));
    ensureDir(join(dir, config.output_dir, "summaries"));
    ensureDir(join(dir, config.output_dir, "concepts"));
    ensureDir(join(dir, config.output_dir, "queries"));
    ensureDir(join(dir, ".wikic"));

    // Write config
    writeText(configPath, configToYaml(config));

    // Initialize empty manifest
    saveManifest(dir, loadManifest(dir));

    // Write initial index
    writeText(
      join(dir, config.output_dir, "index.md"),
      "# Wiki Index\n\nNo articles yet. Run `wikic compile` after adding sources.\n"
    );

    console.log(JSON.stringify({
      ok: true,
      project: config.project,
      sources_dir: config.sources_dir,
      output_dir: config.output_dir,
    }));
  });
