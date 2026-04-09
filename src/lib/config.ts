import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

export interface WikicConfig {
  version: number;
  project: string;
  description: string;
  sources_dir: string;
  output_dir: string;
  llm: {
    provider: "claude-cli" | "anthropic" | "openai" | "ollama";
    model?: string;
  };
  compiler: {
    max_parallel: number;
    summary_max_tokens: number;
    article_max_tokens: number;
    auto_lint: boolean;
  };
}

const DEFAULT_CONFIG: WikicConfig = {
  version: 1,
  project: "my-wiki",
  description: "A wikic project",
  sources_dir: "sources",
  output_dir: "wiki",
  llm: {
    provider: "claude-cli",
  },
  compiler: {
    max_parallel: 3,
    summary_max_tokens: 2000,
    article_max_tokens: 4000,
    auto_lint: true,
  },
};

export function getDefaultConfig(): WikicConfig {
  return { ...DEFAULT_CONFIG };
}

export function loadConfig(dir: string = process.cwd()): WikicConfig {
  const configPath = join(dir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(
      `No config.yaml found in ${dir}. Run 'wikic init' first.`
    );
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function configToYaml(config: WikicConfig): string {
  const lines = [
    `version: ${config.version}`,
    `project: ${config.project}`,
    `description: "${config.description}"`,
    `sources_dir: ${config.sources_dir}`,
    `output_dir: ${config.output_dir}`,
    ``,
    `llm:`,
    `  provider: ${config.llm.provider}`,
    ...(config.llm.model ? [`  model: ${config.llm.model}`] : []),
    ``,
    `compiler:`,
    `  max_parallel: ${config.compiler.max_parallel}`,
    `  summary_max_tokens: ${config.compiler.summary_max_tokens}`,
    `  article_max_tokens: ${config.compiler.article_max_tokens}`,
    `  auto_lint: ${config.compiler.auto_lint}`,
  ];
  return lines.join("\n") + "\n";
}
