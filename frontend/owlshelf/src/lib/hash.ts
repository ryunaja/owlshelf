/**
 * hash.ts — content addressing for media (plan §8.1).
 *
 * One implementation, because the migration and the capture path must agree:
 * a blob staged from a legacy `data:` URL and the same image captured again
 * have to land on the same `files` row, or the store grows a duplicate per
 * re-upload.
 */

/** Lowercase hex SHA-256 of the bytes. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
