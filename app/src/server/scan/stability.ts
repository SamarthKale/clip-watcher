import fs from 'node:fs';

/**
 * A file is stable when its size and modification time are unchanged across
 * `stableMs` and it can be opened for reading (i.e. nothing holds it exclusively).
 */
export async function isStable(file: string, stableMs: number): Promise<boolean> {
  try {
    const a = await fs.promises.stat(file);
    await new Promise((r) => setTimeout(r, stableMs));
    const b = await fs.promises.stat(file);
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false;
    const fh = await fs.promises.open(file, 'r');
    await fh.close();
    return true;
  } catch {
    return false;
  }
}
