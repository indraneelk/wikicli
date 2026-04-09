/**
 * Normalize a concept name to a URL-safe slug.
 * "On-Device Processing" → "on-device-processing"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
