import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** An absolute path inside `modules/ocr/test/fixtures`. */
export function fixturesDir(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
}

/** True when the folder holds at least one receipt image or PDF. */
export function hasImages(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => /\.(jpe?g|png|webp|pdf)$/i.test(f));
}
