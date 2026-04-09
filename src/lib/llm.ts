import { execFile } from "child_process";
import { loadConfig, WikicConfig } from "./config.js";

export interface LLMResponse {
  text: string;
  ok: boolean;
  error?: string;
}

/**
 * Call an LLM with a system prompt and user message.
 * Uses claude -p by default, but supports other providers.
 */
export async function llmCall(
  systemPrompt: string,
  userMessage: string,
  config?: WikicConfig
): Promise<LLMResponse> {
  const cfg = config ?? loadConfig();
  const provider = cfg.llm.provider;

  switch (provider) {
    case "claude-cli":
      return claudeCliCall(systemPrompt, userMessage, cfg.llm.model);
    default:
      return {
        text: "",
        ok: false,
        error: `Provider "${provider}" not yet implemented. Use "claude-cli".`,
      };
  }
}

async function claudeCliCall(
  systemPrompt: string,
  userMessage: string,
  model?: string
): Promise<LLMResponse> {
  const combinedPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
  const args = ["-p", combinedPrompt, "--output-format", "text"];
  if (model) {
    args.push("--model", model);
  }

  return new Promise((resolve) => {
    execFile("claude", args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          text: "",
          ok: false,
          error: `claude CLI error: ${err.message}\n${stderr}`,
        });
      } else {
        resolve({ text: stdout.trim(), ok: true });
      }
    });
  });
}
