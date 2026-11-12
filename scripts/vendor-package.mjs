/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function ensurePlainDirectory(path) {
  const absolute = resolve(path), parent = dirname(absolute);
  if (parent !== absolute) await ensurePlainDirectory(parent);
  let stat;
  try { stat = await lstat(absolute); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(absolute); stat = await lstat(absolute); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) throw Error('Unsafe package directory: ' + absolute);
  return absolute;
}

async function plainFile(path) {
  const absolute = resolve(path), stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) throw Error('Unsafe package file: ' + absolute);
  return absolute;
}

export async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(await plainFile(path))) hash.update(chunk);
  return hash.digest('hex');
}

export async function fileInventory(root) {
  const base = resolve(root), files = {};
  const stat = await lstat(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(base), base)) throw Error('Unsafe package inventory root');
  async function visit(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), relative = prefix + name, item = await lstat(path);
      if (item.isSymbolicLink() || !samePath(await realpath(path), path)) throw Error('Package links are not allowed: ' + relative);
      if (item.isDirectory()) await visit(path, relative + '/');
      else if (item.isFile()) files[relative] = await digestFile(path);
      else throw Error('Unexpected package file type: ' + relative);
    }
  }
  await visit(base, '');
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function inventoryDigest(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// Validate the entire ZIP before writing anything. The archive itself is first
// copied into an owned staging directory and checked against the locked digest.
const extractScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:WHALE_PACKAGE_ARCHIVE)
try {
  $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  if ($zip.Entries.Count -gt 10000) { throw 'Too many ZIP entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if (!$name -or $name.Contains('\') -or $name.StartsWith('/') -or $name -match '[<>:"|?*\x00-\x1f]') { throw 'Unsafe ZIP path' }
    $parts = $name.TrimEnd('/').Split('/')
    foreach ($part in $parts) {
      if (!$part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe ZIP path component' }
    }
    if (!$names.Add($name.TrimEnd('/'))) { throw 'Duplicate ZIP entry' }
    $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($kind -ne 0 -and $kind -ne 0x4000 -and $kind -ne 0x8000) { throw 'ZIP links or special files are not allowed' }
    if (($entry.ExternalAttributes -band 0x400) -ne 0) { throw 'ZIP reparse points are not allowed' }
    $total += $entry.Length
    if ($total -gt 2147483648) { throw 'ZIP is too large' }
  }
  [IO.Compression.ZipFile]::ExtractToDirectory($env:WHALE_PACKAGE_ARCHIVE, $env:WHALE_PACKAGE_DEST)
} finally { $zip.Dispose() }
`;

export async function extractLockedArchive(archive, sha256, destination) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('NapCat desktop components require Windows x64 preparation');
  if (!/^[a-f0-9]{64}$/.test(sha256) || await digestFile(archive) !== sha256) throw Error('NapCat archive checksum mismatch');
  await ensurePlainDirectory(destination);
  if ((await readdir(destination)).length) throw Error('Extraction requires an empty owned directory');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', extractScript], {
    windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    env: { ...process.env, WHALE_PACKAGE_ARCHIVE: resolve(archive), WHALE_PACKAGE_DEST: resolve(destination) },
    stdio: 'pipe',
  });
  return fileInventory(destination);
}

export const vendorKinds = {
  shell: { lock: 'engine.lock.json', archive: 'NapCat.Shell.Windows.Node.zip', directory: 'napcat', manifest: 'engine-manifest.json', required: ['node.exe', 'index.js', 'wrapper.node', 'napcat/napcat.mjs'] },
  framework: { lock: 'desktop-engine.lock.json', archive: 'NapCat.Framework.zip', directory: 'napcat-framework', manifest: 'desktop-manifest.json', required: ['napimain.exe', 'napiloader.dll', 'nativeLoader.cjs', 'napcat.mjs'] },
};

export function attribution(kind, lock) {
  return kind === 'shell'
    ? `NapCatQQ ${lock.version}\nCopyright © 2024 Mlikiowa\n${lock.source}\nOriginal official Windows Node release; private non-commercial use.\nRuntime files remain unmodified. WhaleLife's launcher is separate.\n`
    : `NapCatQQ Framework ${lock.version}\nCopyright © 2024 Mlikiowa\n${lock.source}\nOfficial native desktop loader; runtime files remain unmodified.\nPrivate non-commercial use under the accompanying license.\n`;
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function removeOwnedStage(stage, parent) {
  if (!samePath(dirname(resolve(stage)), resolve(parent)) || !samePath(await realpath(parent), resolve(parent))) throw Error('Unsafe staging cleanup');
  await fileInventory(stage); // Refuse a changed link/reparse point anywhere in the owned tree.
  await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export async function prepareVendor(root, kind, options = {}) {
  const spec = vendorKinds[kind];
  if (!spec) throw Error('Unknown NapCat package kind');
  root = await ensurePlainDirectory(root);
  const lock = JSON.parse(await readFile(await plainFile(join(root, spec.lock)), 'utf8'));
  const expected = JSON.parse(await readFile(await plainFile(join(root, 'third-party/napcat/INTEGRITY.json')), 'utf8'));
  if (lock.version !== expected.version || expected[kind]?.archiveSha256 !== lock.sha256) throw Error('NapCat lock and trusted inventory disagree');
  const archive = options.archive ? resolve(options.archive) : join(root, '.artifacts/vendor', spec.archive);
  try { await plainFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Error(`Missing ${spec.archive}. Obtain the unchanged NapCat ${lock.version} component asset from this plugin's release, then run with --archive <path>, or place it in .artifacts/vendor/. No upstream download is attempted.`);
  }
  const vendor = await ensurePlainDirectory(join(root, 'vendor'));
  const destination = join(vendor, spec.directory), manifestPath = join(vendor, spec.manifest);
  if (await exists(destination)) await fileInventory(destination);
  if (await exists(manifestPath)) await plainFile(manifestPath);
  const mutexPath = join(vendor, `.prepare-${kind}.lock`);
  const mutex = await open(mutexPath, 'wx');
  let stage, preserveStage = false;
  try {
    stage = await mkdtemp(join(vendor, `.prepare-${kind}-`));
    const stagedArchive = join(stage, 'package.zip'), prepared = join(stage, 'component'), preparedManifest = join(stage, 'manifest.json');
    await copyFile(archive, stagedArchive);
    const files = await extractLockedArchive(stagedArchive, lock.sha256, prepared);
    for (const name of spec.required) if (!files[name]) throw Error('NapCat archive is missing required file: ' + name);
    // Git checkouts may use LF or CRLF; preserve the license text with a stable
    // newline convention so its trusted inventory digest is reproducible.
    const license = await readFile(await plainFile(join(root, 'third-party/napcat/LICENSE')), 'utf8');
    await writeFile(join(prepared, 'NAPCAT-LICENSE.txt'), license.replace(/\r\n?/g, '\n'));
    await writeFile(join(prepared, 'ATTRIBUTION.txt'), attribution(kind, lock));
    const finalFiles = await fileInventory(prepared);
    if (inventoryDigest(finalFiles) !== expected[kind].filesSha256) throw Error('Prepared NapCat inventory does not match the trusted original package');
    await writeFile(preparedManifest, JSON.stringify({ ...lock, files: finalFiles }, null, 2) + '\n');
    const oldDirectory = join(stage, 'previous-component'), oldManifest = join(stage, 'previous-manifest.json');
    let movedDirectory = false, movedManifest = false, installedDirectory = false, installedManifest = false;
    try {
      if (await exists(destination)) { await rename(destination, oldDirectory); movedDirectory = true; }
      if (await exists(manifestPath)) { await rename(manifestPath, oldManifest); movedManifest = true; }
      await rename(prepared, destination); installedDirectory = true;
      await rename(preparedManifest, manifestPath); installedManifest = true;
    } catch (error) {
      try {
        if (installedManifest) await rename(manifestPath, preparedManifest);
        if (installedDirectory) await rename(destination, prepared);
        if (movedManifest) await rename(oldManifest, manifestPath);
        if (movedDirectory) await rename(oldDirectory, destination);
      } catch (restoreError) { preserveStage = true; throw new AggregateError([error, restoreError], 'NapCat preparation failed; recovery files retained at ' + stage); }
      throw error;
    }
    return { name: lock.name, version: lock.version, files: Object.keys(finalFiles).length, destination };
  } finally {
    try { if (stage && !preserveStage) await removeOwnedStage(stage, vendor); }
    finally { await mutex.close(); await unlink(mutexPath); }
  }
}

export function parseArchiveArguments(args) {
  if (!args.length) return {};
  if (args.length === 2 && args[0] === '--archive' && args[1]) return { archive: args[1] };
  throw Error('Usage: --archive <path-to-original-NapCat-zip> (optional; defaults to .artifacts/vendor/)');
}
