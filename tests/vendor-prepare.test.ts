/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from './temporary-directory.ts';
const { prepareVendor, attribution, vendorKinds, fileInventory, inventoryDigest, ensurePlainDirectory, parseArchiveArguments } = await import(new URL('../scripts/vendor-package.mjs', import.meta.url).href);
const windows = { skip: process.platform !== 'win32' };
type Entry = { name: string; text: string; attributes?: number };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const license = 'SYNTHETIC LICENSE FOR PACKAGE TESTS\n';
const makeZip = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip=[IO.Compression.ZipFile]::Open($env:WHALE_TEST_ZIP,[IO.Compression.ZipArchiveMode]::Create)
try {
  $entries=ConvertFrom-Json $env:WHALE_TEST_ENTRIES
  foreach($item in $entries){
    $entry=$zip.CreateEntry($item.name)
    if($null -ne $item.attributes){$entry.ExternalAttributes=[int]$item.attributes}
    $stream=$entry.Open()
    try {$bytes=[Text.Encoding]::UTF8.GetBytes($item.text);$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
  }
}finally{$zip.Dispose()}
`;
async function fixture(kind: 'shell' | 'framework' = 'shell', custom?: Entry[]) {
  const root = await temporaryDirectory('whale-vendor-prepare-'), spec = vendorKinds[kind];
  await mkdir(join(root, '.artifacts/vendor'), { recursive: true });
  await mkdir(join(root, 'third-party/napcat'), { recursive: true });
  const archive = join(root, '.artifacts/vendor', spec.archive);
  const entries: Entry[] = custom ?? spec.required.map((name: string) => ({ name, text: 'SYNTHETIC:' + name }));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', makeZip], { windowsHide: true, timeout: 30000,
    env: { ...process.env, WHALE_TEST_ZIP: archive, WHALE_TEST_ENTRIES: JSON.stringify(entries) }, stdio: 'pipe' });
  const lock = { name: 'Synthetic NapCat', version: '4.18.41', platform: 'win32-x64', source: 'https://example.invalid/fixture', archive: 'https://example.invalid/never-fetch.zip', sha256: digest(await readFile(archive)) };
  const expectedFiles: Record<string, string> = Object.fromEntries(entries.map(entry => [entry.name, digest(entry.text)]));
  expectedFiles['NAPCAT-LICENSE.txt'] = digest(license);
  expectedFiles['ATTRIBUTION.txt'] = digest(attribution(kind, lock));
  const integrity = { version: lock.version, [kind]: { archiveSha256: lock.sha256, filesSha256: inventoryDigest(expectedFiles) } };
  await writeFile(join(root, spec.lock), JSON.stringify(lock));
  await writeFile(join(root, 'third-party/napcat/LICENSE'), license);
  await writeFile(join(root, 'third-party/napcat/INTEGRITY.json'), JSON.stringify(integrity));
  return { root, kind, spec, archive, lock, expectedFiles, destination: join(root, 'vendor', spec.directory), manifest: join(root, 'vendor', spec.manifest) };
}
async function noStage(root: string) {
  const names = await readdir(join(root, 'vendor')).catch(() => []);
  assert.deepEqual(names.filter((name: string) => name.startsWith('.prepare-')), []);
}

test('cached original archives prepare offline, retain license, and replace obsolete files', windows, async () => {
  const f = await fixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('network must not be called'); };
  try {
    await mkdir(f.destination, { recursive: true });
    await writeFile(join(f.destination, 'obsolete.txt'), 'OLD BUILD RESIDUE');
    await writeFile(f.manifest, 'OLD MANIFEST');
    const result = await prepareVendor(f.root, f.kind);
    assert.equal(result.files, Object.keys(f.expectedFiles).length);
    assert.deepEqual(await fileInventory(f.destination), f.expectedFiles);
    assert.equal(await readFile(join(f.destination, 'NAPCAT-LICENSE.txt'), 'utf8'), license);
    assert.deepEqual(JSON.parse(await readFile(f.manifest, 'utf8')).files, f.expectedFiles);
    await assert.rejects(readFile(join(f.destination, 'obsolete.txt')), { code: 'ENOENT' });
    await noStage(f.root);
  } finally { globalThis.fetch = previousFetch; }
});

test('framework accepts an explicit local original archive without relying on cache', windows, async () => {
  const f = await fixture('framework'), local = join(f.root, 'provided-original.zip');
  await copyFile(f.archive, local); await unlink(f.archive);
  await prepareVendor(f.root, f.kind, { archive: local });
  assert.deepEqual(await fileInventory(f.destination), f.expectedFiles);
  await noStage(f.root);
});

test('license checkout line endings do not change the trusted package inventory', windows, async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'third-party/napcat/LICENSE'), license.replaceAll('\n', '\r\n'));
  await prepareVendor(f.root, f.kind);
  assert.deepEqual(await fileInventory(f.destination), f.expectedFiles);
  assert.equal(await readFile(join(f.destination, 'NAPCAT-LICENSE.txt'), 'utf8'), license);
  await noStage(f.root);
});

test('missing archive reports actionable offline instructions without creating vendor files', windows, async () => {
  const f = await fixture(); await unlink(f.archive);
  await assert.rejects(prepareVendor(f.root, f.kind), /--archive <path>.*No upstream download/);
  await assert.rejects(readdir(join(f.root, 'vendor')), { code: 'ENOENT' });
});

test('wrong archive checksum keeps previous component and manifest intact and cleans staging', windows, async () => {
  const f = await fixture();
  await mkdir(f.destination, { recursive: true }); await writeFile(join(f.destination, 'old.txt'), 'KEEP'); await writeFile(f.manifest, 'KEEP MANIFEST');
  await writeFile(f.archive, 'WRONG ARCHIVE');
  await assert.rejects(prepareVendor(f.root, f.kind), /checksum mismatch/);
  assert.equal(await readFile(join(f.destination, 'old.txt'), 'utf8'), 'KEEP');
  assert.equal(await readFile(f.manifest, 'utf8'), 'KEEP MANIFEST');
  await noStage(f.root);
});

test('trusted inventory rejects changed license or unexpected extracted bytes before replacement', windows, async () => {
  const f = await fixture();
  await mkdir(f.destination, { recursive: true }); await writeFile(join(f.destination, 'old.txt'), 'KEEP'); await writeFile(f.manifest, 'KEEP MANIFEST');
  await writeFile(join(f.root, 'third-party/napcat/LICENSE'), 'CHANGED LICENSE');
  await assert.rejects(prepareVendor(f.root, f.kind), /trusted original package/);
  assert.equal(await readFile(join(f.destination, 'old.txt'), 'utf8'), 'KEEP');
  assert.equal(await readFile(f.manifest, 'utf8'), 'KEEP MANIFEST');
  await noStage(f.root);
});

for (const [label, entry] of [
  ['parent traversal', { name: '../outside.txt', text: 'NO' }],
  ['absolute path', { name: '/outside.txt', text: 'NO' }],
  ['alternate stream', { name: 'normal:stream', text: 'NO' }],
  ['symbolic link', { name: 'link', text: 'outside', attributes: 0xa1ff << 16 }],
] as const) test('ZIP extraction rejects ' + label + ' before writing package files', windows, async () => {
  const f = await fixture('shell', [entry]);
  await assert.rejects(prepareVendor(f.root, f.kind), /Unsafe ZIP|ZIP links/);
  await assert.rejects(readFile(join(f.root, 'outside.txt')), { code: 'ENOENT' });
  await noStage(f.root);
});

test('ZIP extraction rejects case-colliding entries and missing runtime files', windows, async () => {
  const duplicate = await fixture('shell', [{ name: 'same', text: 'ONE' }, { name: 'SAME', text: 'TWO' }]);
  await assert.rejects(prepareVendor(duplicate.root, duplicate.kind), /Duplicate ZIP/);
  await noStage(duplicate.root);
  const missing = await fixture('shell', [{ name: 'readme.txt', text: 'NO RUNTIME' }]);
  await assert.rejects(prepareVendor(missing.root, missing.kind), /missing required file/);
  await noStage(missing.root);
});

test('junction output parents are rejected and cannot write outside the package root', windows, async t => {
  const f = await fixture(), outside = await temporaryDirectory('whale-vendor-outside-');
  await symlink(outside, join(f.root, 'vendor'), 'junction');
  t.after(() => unlink(join(f.root, 'vendor')));
  await assert.rejects(prepareVendor(f.root, f.kind), /Unsafe package directory/);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(ensurePlainDirectory(join(f.root, 'vendor', 'escape')), /Unsafe package directory/);
});

test('inventory ordering is deterministic and CLI rejects unknown or incomplete arguments', () => {
  assert.equal(inventoryDigest({ b: 'b', a: 'a' }), inventoryDigest({ a: 'a', b: 'b' }));
  assert.deepEqual(parseArchiveArguments([]), {});
  assert.deepEqual(parseArchiveArguments(['--archive', 'original.zip']), { archive: 'original.zip' });
  assert.throws(() => parseArchiveArguments(['--archive']), /Usage/);
  assert.throws(() => parseArchiveArguments(['--download']), /Usage/);
});
