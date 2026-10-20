import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// True when the module was started directly with `node file.ts`.
export function isMain(metaUrl: string): boolean {
  return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
