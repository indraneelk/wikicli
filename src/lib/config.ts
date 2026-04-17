import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

export interface WikicConfig {
  version: number;
  project: string;
  description: string;
  sources_dir: string;
  output_dir: string;
  llm: {
    provider: "claude-cli" | "anthropic" | "openai" | "ollama" | "opencode-cli" | "codex-cli";
    model?: string;
  };
  compiler: {
    max_parallel: number;
    summary_max_tokens: number;
    article_max_tokens: number;
    auto_lint: boolean;
    chunk_threshold: number;
    chunk_size: number;
    min_chunk_size: number;
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
    chunk_threshold: 12000,
    chunk_size: 8000,
    min_chunk_size: 1500,
  },
};

export function getDefaultConfig(): WikicConfig {
  return {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_CONFIG.llm },
    compiler: { ...DEFAULT_CONFIG.compiler },
  };
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
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    llm: { ...DEFAULT_CONFIG.llm, ...parsed?.llm },
    compiler: { ...DEFAULT_CONFIG.compiler, ...parsed?.compiler },
  };
}

export function saveConfig(dir: string, config: WikicConfig): void {
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, configToYaml(config), "utf-8");
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
    `  chunk_threshold: ${config.compiler.chunk_threshold}`,
    `  chunk_size: ${config.compiler.chunk_size}`,
    `  min_chunk_size: ${config.compiler.min_chunk_size}`,
  ];
  return lines.join("\n") + "\n";
}
