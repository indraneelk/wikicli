import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, dirname, extname, basename } from "path";

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

export function writeText(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

export function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extname(f) === ".md")
    .map((f) => join(dir, f));
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

export function removeFile(path: string): boolean {
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

export function basenameNoExt(path: string): string {
  return basename(path, extname(path));
}
