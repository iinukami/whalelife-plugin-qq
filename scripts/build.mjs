/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { build } from 'esbuild';
import { copyFile, writeFile, readFile, lstat, realpath, mkdtemp, rename, rm, open, unlink } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensurePlainDirectory, fileInventory, inventoryDigest } from './vendor-package.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const legal = ['LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'];
const copied = ['plugin.yaml', 'README.md', 'MINIAPP-SHARING.md', 'VIDEO-SHARING.md', 'TEXT-DELIVERY.md',
  ...legal, 'engine.lock.json', 'desktop-engine.lock.json', 'attach-engine.lock.json',
  'scripts/gallery-migration.mjs', 'sub/gallery/plugin.yaml',
  'managed/bootstrap.cjs', 'managed/windows-job.cs', 'managed/windows-job.ps1',
  'attach/worker.mjs', 'attach/agent.cjs', 'attach/diagnostics.cjs', 'attach/napi.js', 'attach/FRIDA-COPYING.txt', 'attach/THIRD-PARTY.md',
  'third-party/napcat/LICENSE', 'third-party/napcat/INTEGRITY.json'];
const generated = ['main.js', 'index.ts', 'main.d.ts', 'sub/gallery/index.ts', 'package.json', 'package-lock.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function regularFile(root, name) {
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw Error('Unsafe package path: ' + name);
  let parent = dirname(path);
  while (!samePath(parent, root)) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Unsafe package directory: ' + name);
    parent = dirname(parent);
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe package file: ' + name);
  return path;
}
async function copy(root, stage, name, expected) {
  const source = await regularFile(root, name);
  if (expected && digest(await readFile(source)) !== expected) throw Error('Package checksum mismatch: ' + name);
  await ensurePlainDirectory(dirname(join(stage, name)));
  await copyFile(source, join(stage, name));
  if (expected && digest(await readFile(join(stage, name))) !== expected) throw Error('Package changed during copy: ' + name);
}
export function releaseMetadata(pkg, sourceLock) {
  if (sourceLock.lockfileVersion !== 3 || sourceLock.version !== pkg.version ||
      JSON.stringify(sourceLock.packages[''].dependencies) !== JSON.stringify(pkg.dependencies))
    throw Error('Source package and dependency lock disagree');
  const manifest = { name: pkg.name, version: pkg.version, license: pkg.license, private: true,
    type: 'module', engines: pkg.engines, dependencies: pkg.dependencies,
    ...(pkg.overrides ? { overrides: pkg.overrides } : {}) };
  const lock = structuredClone(sourceLock);
  lock.packages[''] = { name: pkg.name, version: pkg.version, license: pkg.license,
    engines: pkg.engines, dependencies: pkg.dependencies };
  return { manifest, lock };
}
export async function desktopFiles(root, stage) {
  const trusted = JSON.parse(await readFile(await regularFile(root, 'third-party/napcat/INTEGRITY.json'), 'utf8'));
  const paths = [];
  for (const [kind, directory, lockName, manifestName] of [
    ['shell', 'napcat', 'engine.lock.json', 'engine-manifest.json'],
    ['framework', 'napcat-framework', 'desktop-engine.lock.json', 'desktop-manifest.json']]) {
    const lock = JSON.parse(await readFile(await regularFile(root, lockName), 'utf8'));
    const name = 'vendor/' + manifestName;
    const manifest = JSON.parse(await readFile(await regularFile(root, name), 'utf8'));
    if (trusted.version !== lock.version || trusted[kind].archiveSha256 !== lock.sha256 ||
        manifest.version !== lock.version || manifest.sha256 !== lock.sha256 ||
        manifest.platform !== lock.platform || inventoryDigest(manifest.files) !== trusted[kind].filesSha256)
      throw Error('Untrusted NapCat inventory; run the matching prepare command with the original archive');
    for (const [file, hash] of Object.entries(manifest.files)) {
      const path = 'vendor/' + directory + '/' + file;
      await copy(root, stage, path, hash); paths.push(path);
    }
    // Only public locked metadata and the verified inventory enter the release.
    const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    await writeFile(join(stage, name), JSON.stringify({ ...lock, files }, null, 2) + '\n'); paths.push(name);
  }
  const attach = JSON.parse(await readFile(await regularFile(root, 'attach-engine.lock.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(await regularFile(root, 'package.json'), 'utf8'));
  if (process.platform !== 'win32' || process.arch !== 'x64' || attach.version !== pkg.dependencies.frida)
    throw Error('Desktop package requires the locked Windows x64 Frida version');
  const binding = 'node_modules/frida/build/frida_binding.node';
  await copy(root, stage, binding, attach.bindingSha256);
  return paths;
}
async function removeStage(path, parent) {
  if (!samePath(dirname(path), parent) || !samePath(await realpath(parent), parent)) throw Error('Unsafe build cleanup path');
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Build directory became a link');
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
export async function buildRelease(root, desktop = false) {
  root = resolve(root);
  await ensurePlainDirectory(root);
  const parent = join(root, 'dist'), target = join(parent, 'qq');
  await ensurePlainDirectory(parent);
  const old = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (old && (!old.isDirectory() || old.isSymbolicLink())) throw Error('Unsafe existing release directory');
  const lockPath = join(parent, '.qq-build.lock');
  const lease = await open(lockPath, 'wx');
  let stage, backup, published = false;
  try {
    stage = await mkdtemp(join(parent, '.qq-build-'));
    const pkg = JSON.parse(await readFile(await regularFile(root, 'package.json'), 'utf8'));
    const sourceLockBytes = await readFile(await regularFile(root, 'package-lock.json'), 'utf8');
    const sourceLock = JSON.parse(sourceLockBytes);
    const { manifest, lock } = releaseMetadata(pkg, sourceLock);
    for (const name of copied) await copy(root, stage, name);
    await build({ absWorkingDir: root, entryPoints: ['src/index.ts'], outfile: join(stage, 'main.js'), bundle: true,
      platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: false });
    await build({ absWorkingDir: root, entryPoints: ['src/gallery-bridge.ts'], outfile: join(stage, 'sub/gallery/index.ts'), bundle: true,
      platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: false });
    await writeFile(join(stage, 'index.ts'), "export { apply } from './main.js';\n");
    await writeFile(join(stage, 'main.d.ts'), "export function apply(ctx: import('whalelife').Context): Promise<void>;\n");
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const lockBytes = JSON.stringify(lock, null, 2) + '\n';
    await writeFile(join(stage, 'package-lock.json'), lockBytes);
    const npm = resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js');
    const installed = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'],
      { cwd: stage, stdio: 'inherit', windowsHide: true, timeout: 300000 });
    if (installed.error || installed.status !== 0) throw Error('Locked release dependency installation failed', { cause: installed.error });
    if (await readFile(join(stage, 'package-lock.json'), 'utf8') !== lockBytes) throw Error('Release lock changed during installation');
    const vendor = desktop ? await desktopFiles(root, stage) : [];
    const allowed = new Set([...copied, ...generated, ...vendor]);
    const files = await fileInventory(stage);
    for (const name of Object.keys(files)) if (!allowed.has(name) && !name.startsWith('node_modules/')) throw Error('Unexpected release file: ' + name);
    for (const name of allowed) if (!files[name]) throw Error('Missing release file: ' + name);
    await writeFile(join(stage, 'BUILD.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
      mode: desktop ? 'desktop' : 'external', platform: process.platform + '-' + process.arch,
      sourceLockSha256: digest(sourceLockBytes), files }, null, 2) + '\n');
    if (await readFile(join(root, 'package-lock.json'), 'utf8') !== sourceLockBytes) throw Error('Source lock changed during build; retry with a stable checkout');
    // Publish only after every check succeeds. The old output is never an input.
    if (old) {
      backup = await mkdtemp(join(parent, '.qq-old-')); await removeStage(backup, parent);
      await rename(target, backup);
    }
    try { await rename(stage, target); published = true; }
    catch (error) { if (backup) { await rename(backup, target); backup = undefined; } throw error; }
    if (backup) { await removeStage(backup, parent); backup = undefined; }
    console.log('Plugin package ready: ' + target);
    return target;
  } finally {
    try { if (stage && !published) await removeStage(stage, parent); }
    finally { await lease.close(); await unlink(lockPath); }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).some(arg => arg !== '--desktop')) throw Error('Usage: node scripts/build.mjs [--desktop]');
  await buildRelease(repo, process.argv.includes('--desktop'));
}
