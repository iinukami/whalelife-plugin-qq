/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, readdir, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { temporaryDirectory } from './temporary-directory.ts';
// Build scripts are JavaScript so they can run before development TypeScript setup.
// @ts-expect-error local build script has no declaration file
import { buildRelease, releaseMetadata, desktopFiles } from '../scripts/build.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await temporaryDirectory('whale-qq-release-');
  for (const dir of ['attach', 'managed', 'third-party', 'sub'])
    await cp(join(source, dir), join(root, dir), { recursive: true });
  for (const name of ['plugin.yaml', 'README.md', 'MINIAPP-SHARING.md', 'VIDEO-SHARING.md', 'TEXT-DELIVERY.md', 'LICENSE',
    'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'engine.lock.json', 'desktop-engine.lock.json', 'attach-engine.lock.json'])
    await cp(join(source, name), join(root, name));
  await mkdir(join(root, 'scripts')); await cp(join(source, 'scripts/gallery-migration.mjs'), join(root, 'scripts/gallery-migration.mjs'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/index.ts'), 'export function apply() {}\n');
  await writeFile(join(root, 'src/gallery-bridge.ts'), 'export function apply() {}\n');
  const pkg = { name: 'synthetic-qq-build', version: '0.0.0', license: 'AGPL-3.0-only', dependencies: {} };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
  return root;
}
test('empty staging drops old private/foreign/desktop files, excludes source extras, and emits reproducible hashes', async () => {
  const root = await fixture(), target = join(root, 'dist/qq');
  for (const path of ['data/synthetic.txt', 'sub/qzone/synthetic.js', 'vendor/old.dll', 'obsolete.js']) {
    const file = join(target, path); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'SYNTHETIC_ONLY');
  }
  await writeFile(join(root, 'attach/unwanted.txt'), 'SYNTHETIC_ONLY');
  await buildRelease(root);
  const first = JSON.parse(await readFile(join(target, 'BUILD.json'), 'utf8'));
  assert.equal(first.mode, 'external');
  assert.ok(!Object.keys(first.files).some(p => /^(data|vendor|sub\/qzone)\//.test(p) || p.endsWith('unwanted.txt')));
  for (const [path, expected] of Object.entries(first.files)) assert.equal(hash(await readFile(join(target, path))), expected);
  for (const path of ['data', 'sub/qzone', 'vendor', 'obsolete.js', 'attach/unwanted.txt'])
    await assert.rejects(readFile(join(target, path)), { code: 'ENOENT' });
  await buildRelease(root);
  assert.deepEqual(JSON.parse(await readFile(join(target, 'BUILD.json'), 'utf8')), first);
  assert.deepEqual(await readdir(join(root, 'dist')), ['qq']);
});
test('failed build preserves the prior complete output and cleans its staging directory', async () => {
  const root = await fixture(), target = join(root, 'dist/qq');
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'last-good.txt'), 'LAST_GOOD');
  await writeFile(join(root, 'src/index.ts'), 'export broken ???');
  await assert.rejects(buildRelease(root));
  assert.equal(await readFile(join(target, 'last-good.txt'), 'utf8'), 'LAST_GOOD');
  assert.deepEqual(await readdir(join(root, 'dist')), ['qq']);
});
test('release construction refuses redirected output and input paths without altering external files', async () => {
  const root = await fixture(), outside = await temporaryDirectory('whale-qq-release-outside-');
  await writeFile(join(outside, 'keep.txt'), 'KEEP');
  await symlink(outside, join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildRelease(root), /link|directory|path/i);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'KEEP');
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  const inputRoot = await fixture();
  await rename(join(inputRoot, 'attach'), join(inputRoot, 'saved-attach'));
  await symlink(outside, join(inputRoot, 'attach'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildRelease(inputRoot), /directory|path/i);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.deepEqual(await readdir(join(inputRoot, 'dist')), []);
});
test('release metadata preserves locked dependency records and overrides without floating resolution', async () => {
  const pkg = { name: 'qq', version: '1.0.0', dependencies: { a: '1.2.3' }, overrides: { a: { b: '1.0.0' } } };
  const input = { version: pkg.version, lockfileVersion: 3, packages: { '': { dependencies: pkg.dependencies, devDependencies: { dev: '1' } },
    'node_modules/a': { version: '1.2.3', integrity: 'sha512-synthetic' }, 'node_modules/dev': { version: '1', dev: true } } };
  const { manifest, lock } = releaseMetadata(pkg, input);
  assert.deepEqual(manifest.overrides, pkg.overrides);
  assert.deepEqual(lock.packages['node_modules/a'], input.packages['node_modules/a']);
  assert.equal(lock.packages[''].devDependencies, undefined);
  assert.deepEqual(input.packages[''].devDependencies, { dev: '1' });
  assert.throws(() => releaseMetadata({ ...pkg, dependencies: { a: '2' } }, input), /disagree/);
});
test('desktop copying excludes unlisted files and reconstructs public manifest metadata',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const root = await fixture(), stage = await temporaryDirectory('whale-qq-desktop-stage-');
  const integrity: any = { version: '4.18.41' };
  for (const [kind, dir, lockName, manifestName] of [
    ['shell', 'napcat', 'engine.lock.json', 'engine-manifest.json'],
    ['framework', 'napcat-framework', 'desktop-engine.lock.json', 'desktop-manifest.json']]) {
    const lock = JSON.parse(await readFile(join(root, lockName), 'utf8'));
    const files = { 'runtime.bin': hash('SYNTHETIC_RUNTIME') };
    integrity[kind] = { archiveSha256: lock.sha256, filesSha256: hash(JSON.stringify(files)) };
    await mkdir(join(root, 'vendor', dir), { recursive: true });
    await writeFile(join(root, 'vendor', dir, 'runtime.bin'), 'SYNTHETIC_RUNTIME');
    await writeFile(join(root, 'vendor', dir, 'private-unlisted.txt'), 'SYNTHETIC_PRIVATE');
    await writeFile(join(root, 'vendor', manifestName), JSON.stringify({ ...lock, files,
      source: 'SYNTHETIC_PRIVATE_SOURCE', privateExtra: 'SYNTHETIC_PRIVATE' }));
  }
  await writeFile(join(root, 'third-party/napcat/INTEGRITY.json'), JSON.stringify(integrity));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  pkg.dependencies.frida = '17.24.0'; await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await mkdir(join(root, 'node_modules/frida/build'), { recursive: true });
  await writeFile(join(root, 'node_modules/frida/build/frida_binding.node'), 'SYNTHETIC_BINDING');
  await writeFile(join(root, 'attach-engine.lock.json'), JSON.stringify({ version: '17.24.0', bindingSha256: hash('SYNTHETIC_BINDING') }));
  await desktopFiles(root, stage);
  for (const [dir, manifestName, lockName] of [['napcat', 'engine-manifest.json', 'engine.lock.json'], ['napcat-framework', 'desktop-manifest.json', 'desktop-engine.lock.json']]) {
    const actual = JSON.parse(await readFile(join(stage, 'vendor', manifestName), 'utf8'));
    const locked = JSON.parse(await readFile(join(root, lockName), 'utf8'));
    assert.equal(actual.privateExtra, undefined); assert.equal(actual.source, locked.source);
    await assert.rejects(readFile(join(stage, 'vendor', dir, 'private-unlisted.txt')), { code: 'ENOENT' });
  }
});
