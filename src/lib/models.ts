import { OPENCODE_FREE_MODELS } from "./llm.js";

export const CLAUDE_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export const CODEX_MODELS = [
  "codex-mini-latest",
  "o4-mini",
  "o3",
] as const;

export function listProviderModels(provider: string): string[] {
  switch (provider) {
    case "opencode-cli":
      return [...OPENCODE_FREE_MODELS];
    case "claude-cli":
      return [...CLAUDE_MODELS];
    case "codex-cli":
      return [...CODEX_MODELS];
    default:
      return [];
  }
}
