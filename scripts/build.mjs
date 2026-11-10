/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const target = resolve('dist/qq');
const attachLock = JSON.parse(await readFile('attach-engine.lock.json', 'utf8'));
if (process.argv.includes('--desktop') && createHash('sha256').update(await readFile('node_modules/frida/build/frida_binding.node')).digest('hex') !== attachLock.bindingSha256)
  throw Error('Native attach component checksum mismatch; run prepare:attach');
await mkdir(target, { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: target + '/main.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: false });
await writeFile(target + '/index.ts', "export { apply } from './main.js';\n");
await writeFile(target + '/main.d.ts', "export function apply(ctx: import('whalelife').Context): Promise<void>;\n");
await copyFile('plugin.yaml', target + '/plugin.yaml');
await mkdir(target + '/sub/gallery', { recursive: true });
await build({ entryPoints: ['src/gallery-bridge.ts'], outfile: target + '/sub/gallery/index.ts', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
await copyFile('sub/gallery/plugin.yaml', target + '/sub/gallery/plugin.yaml');
await copyFile('README.md', target + '/README.md');
await copyFile('MINIAPP-SHARING.md', target + '/MINIAPP-SHARING.md');
for (const file of ['LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'])
  await copyFile(file, target + '/' + file);
await mkdir(target + '/scripts', { recursive: true });
await copyFile('scripts/gallery-migration.mjs', target + '/scripts/gallery-migration.mjs');
await cp('managed', target + '/managed', { recursive: true });
await cp('attach', target + '/attach', { recursive: true });
if (process.argv.includes('--desktop')) await cp('vendor', target + '/vendor', { recursive: true });
await copyFile('engine.lock.json', target + '/engine.lock.json');
await copyFile('desktop-engine.lock.json', target + '/desktop-engine.lock.json');
await copyFile('attach-engine.lock.json', target + '/attach-engine.lock.json');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(target + '/package.json', JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license, private: true, type: 'module', engines: pkg.engines, dependencies: pkg.dependencies }, null, 2));
const npm = resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js');
const result = spawnSync(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw Error('Release dependency installation failed');
if (process.argv.includes('--desktop')) await copyFile('node_modules/frida/build/frida_binding.node', target + '/node_modules/frida/build/frida_binding.node');
console.log('Plugin package ready: ' + target);
