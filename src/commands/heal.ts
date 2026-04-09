import { Command } from "commander";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { loadManifest, saveManifest } from "../lib/manifest.js";
import { readText, writeText, listMarkdownFiles } from "../lib/files.js";
import { llmCall } from "../lib/llm.js";
import { HEAL_SYSTEM, buildHealPrompt } from "../prompts/heal.js";

export const healCommand = new Command("heal")
  .description("LLM-powered fix for wiki issues (broken links, missing content)")
  .action(async () => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);
    const knownSlugs = Object.keys(manifest.concepts);
    const conceptsDir = join(dir, config.output_dir, "concepts");
    const conceptFiles = listMarkdownFiles(conceptsDir);

    let healed = 0;
    const healErrors: string[] = [];

    for (const file of conceptFiles) {
      const content = readText(file);
      const relPath = file.replace(dir + "/", "");
      const errors: string[] = [];

      // Detect issues
      const wikilinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of wikilinks) {
        const slug = link.replace(/\[\[|\]\]/g, "").toLowerCase();
        if (!knownSlugs.includes(slug)) {
          errors.push(`Broken wikilink: ${link}`);
        }
      }

      if (!content.startsWith("---")) {
        errors.push("Missing YAML frontmatter");
      }

      const requiredSections = ["## Definition", "## How it Works"];
      for (const section of requiredSections) {
        if (!content.includes(section)) {
          errors.push(`Missing section: ${section}`);
        }
      }

      if (errors.length === 0) continue;

      console.error(`  Healing ${relPath} (${errors.length} issues)...`);
      const resp = await llmCall(
        HEAL_SYSTEM,
        buildHealPrompt(content, errors, knownSlugs),
        config
      );

      if (!resp.ok) {
        healErrors.push(`Heal failed for ${relPath}: ${resp.error}`);
        continue;
      }

      writeText(file, resp.text);
      healed++;
    }

    saveManifest(dir, manifest);

    console.log(JSON.stringify({
      ok: healErrors.length === 0,
      healed,
      errors: healErrors,
    }));
  });
