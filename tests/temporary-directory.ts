/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { after } from 'node:test';
import { mkdir, mkdtemp, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = resolve(fileURLToPath(new URL('../.artifacts/tests/', import.meta.url)));
const owned = new Set<string>();
export async function temporaryDirectory(prefix: string) {
  if (!/^whale-[a-z0-9-]+-$/.test(prefix)) throw Error('Invalid test prefix');
  await mkdir(base, { recursive: true });
  if (resolve(await realpath(base)) !== base || (await lstat(base)).isSymbolicLink()) throw Error('Unsafe test root');
  const directory = await mkdtemp(join(base, prefix));
  owned.add(directory); // Register before starting resources or creating the fixture.
  return directory;
}
after(async () => {
  for (const directory of owned) {
    if (dirname(resolve(directory)) !== base || resolve(await realpath(base)) !== base) throw Error('Unsafe test cleanup path');
    try { if ((await lstat(directory)).isSymbolicLink()) throw Error('Test root became a link'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    owned.delete(directory);
  }
});
