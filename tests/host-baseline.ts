/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { execFileSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { boot } from '../../whalelife/core/index.ts';
import { temporaryDirectory } from './temporary-directory.ts';

export const activePersonaMinimum = 'eb229985f59a12c82b326da0bc114b0bd55b3390';
export const positiveBaselines = ['current', activePersonaMinimum] as const;

export async function baselineBoot(baseline: typeof positiveBaselines[number]): Promise<typeof boot | undefined> {
  if (baseline === 'current') return undefined;
  const host = fileURLToPath(new URL('../../whalelife', import.meta.url));
  const root = await temporaryDirectory('whale-qq-minimum-host-');
  const archive = join(root, 'host.tar');
  execFileSync('git', ['-c', `safe.directory=${host.replaceAll('\\', '/')}`, '-C', host,
    'archive', '--format=tar', '--output=' + archive, baseline, 'core', 'market', 'package.json']);
  execFileSync('tar', ['-xf', archive, '-C', root]);
  await symlink(join(host, 'node_modules'), join(root, 'node_modules'), 'junction');
  return (await import(pathToFileURL(join(root, 'core/index.ts')).href)).boot;
}
