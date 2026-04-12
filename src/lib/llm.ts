import { execFile, spawn } from "child_process";
import { loadConfig } from "./config.js";
import type { WikicConfig } from "./config.js";

export interface LLMResponse {
  text: string;
  ok: boolean;
  error?: string;
}

export const OPENCODE_FREE_MODELS = [
  "opencode/big-pickle",
  "opencode/minimax-m2-5-free",
  "opencode/qwen3-6-plus-free",
  "opencode/nemotron-3-super-free",
] as const;

/**
 * Call an LLM with a system prompt and user message.
 * Supports claude-cli and opencode-cli providers.
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
    case "opencode-cli":
      return opencodeCliCall(
        systemPrompt,
        userMessage,
        cfg.llm.model ?? OPENCODE_FREE_MODELS[0]
      );
    default:
      return {
        text: "",
        ok: false,
        error: `Provider "${provider}" not yet implemented. Use "claude-cli" or "opencode-cli".`,
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
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    execFile(
      "claude",
      args,
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            text: "",
            ok: false,
            error: `claude CLI error: ${err.message}\n${stderr}`,
          });
        } else {
          resolve({ text: stdout.trim(), ok: true });
        }
      }
    );
  });
}

async function opencodeCliCall(
  systemPrompt: string,
  userMessage: string,
  model: string
): Promise<LLMResponse> {
  const combinedPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
  // opencode CLI contract: `opencode run <prompt> --model <id> --format json`
  // The prompt is passed as a single positional argument (no shell expansion via spawn).
  // If the CLI changes to require stdin or a flag for the prompt, extractOpencodeText
  // will fall back to raw stdout and output may be empty or unexpected.
  const args = ["run", combinedPrompt, "--model", model, "--format", "json"];

  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          text: "",
          ok: false,
          error: `opencode error (exit ${code}): ${stderr.slice(0, 500)}`,
        });
        return;
      }
      resolve({ text: extractOpencodeText(stdout).trim(), ok: true });
    });

    child.on("error", (err) => {
      resolve({
        text: "",
        ok: false,
        error: `opencode spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Extracts assistant text from opencode --format json event stream.
 * CLI format (opencode run --format json): each line is a JSON event.
 * Text events have: { "type": "text", "part": { "type": "text", "text": "..." } }
 * Falls back to raw stdout if no structured events are found.
 */
export function extractOpencodeText(output: string): string {
  const lines = output.split('\n').filter(l => l.trim());
  const parts: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // CLI event format: { type: "text", part: { type: "text", text: "..." } }
      if (
        event.type === 'text' &&
        event.part?.type === 'text' &&
        typeof event.part.text === 'string'
      ) {
        parts.push(event.part.text);
      }
    } catch {
      // non-JSON line — skip
    }
  }

  if (parts.length > 0) return parts.join('');
  return output; // fallback: return raw stdout
}
