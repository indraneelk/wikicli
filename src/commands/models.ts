import { Command } from "commander";
import { loadConfig, saveConfig } from "../lib/config.js";
import { listProviderModels } from "../lib/models.js";

const listCommand = new Command("list")
  .description("List available models for the current provider")
  .action(() => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const models = listProviderModels(config.llm.provider);
    console.log(JSON.stringify({
      ok: true,
      provider: config.llm.provider,
      current: config.llm.model ?? null,
      models,
    }));
  });

const setCommand = new Command("set")
  .description("Set the active model in config.yaml")
  .argument("<model>", "Model identifier to use")
  .action((model: string) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const previous = config.llm.model ?? null;
    config.llm.model = model;
    saveConfig(dir, config);
    console.log(JSON.stringify({
      ok: true,
      provider: config.llm.provider,
      previous,
      model,
    }));
  });

export const modelsCommand = new Command("models")
  .description("Manage LLM model selection")
  .addCommand(listCommand)
  .addCommand(setCommand);
