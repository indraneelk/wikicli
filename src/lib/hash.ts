import { createHash } from "crypto";
import { readFileSync } from "fs";

export function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

export function hashString(str: string): string {
  return "sha256:" + createHash("sha256").update(str).digest("hex");
}
