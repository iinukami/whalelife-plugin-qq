/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, until } from './fixture.ts';
import { temporaryDirectory } from './temporary-directory.ts';
const { fileInventory } = await import(new URL('../scripts/vendor-package.mjs', import.meta.url).href);

type Build = { name: string; version: string; mode: 'desktop' | 'external'; platform: string; files: Record<string, string> };
const packagePath = resolve(process.env.QQ_RELEASE_TEST_PACKAGE ?? fileURLToPath(new URL('../dist/qq', import.meta.url)));
const sourceHost = fileURLToPath(new URL('../../whalelife', import.meta.url));
const baselines = [
  { name: 'current', ref: 'HEAD', supported: true },
  { name: 'first active-persona host', ref: 'eb229985f59a12c82b326da0bc114b0bd55b3390', supported: true },
  { name: 'released v0.1.2', ref: 'refs/tags/v0.1.2^{commit}', expected: '7e7a5cb398c1b77c5970043bfb0ce809cfb5f790', supported: false },
  { name: 'former minimum', ref: 'refs/tags/213b52b^{commit}', expected: '7c8e3898b2bc7cb0b892eb0ab2feec0ca9c8aaf0', supported: false },
] as const;

async function verifyRelease(root: string): Promise<Build> {
  const actual: Record<string, string> = await fileInventory(root);
  assert.ok(actual['BUILD.json'], 'Release must include a BUILD inventory');
  const build = JSON.parse(await readFile(join(root, 'BUILD.json'), 'utf8')) as Build;
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(build.name, 'whalelife-plugin-qq');
  assert.equal(build.version, pkg.version);
  assert.ok(build.mode === 'desktop' || build.mode === 'external');
  delete actual['BUILD.json'];
  assert.deepEqual(actual, build.files, 'All release files, including vendor and dependencies, must match BUILD exactly');
  const forbidden = /^(?:data|config|memory|logs|backups|\.git|\.artifacts)(?:\/|$)/i;
  for (const name of Object.keys(actual)) {
    assert.equal(forbidden.test(name), false, 'Private or development data in release: ' + name);
    if (name.startsWith('sub/')) assert.ok(name === 'sub/gallery/index.ts' || name === 'sub/gallery/plugin.yaml', 'Foreign plugin in release: ' + name);
  }
  assert.equal(Object.keys(actual).some(name => name.startsWith('vendor/')), build.mode === 'desktop');
  return build;
}

async function snapshotHost(t: TestContext, baseline: typeof baselines[number]) {
  const root = await temporaryDirectory('whale-release-host-');
  const gitArgs = ['-c', `safe.directory=${sourceHost.replaceAll('\\', '/')}`, '-C', sourceHost];
  const commit = execFileSync('git', [...gitArgs, 'rev-parse', baseline.ref], { encoding: 'utf8' }).trim();
  if ('expected' in baseline) assert.equal(commit, baseline.expected, 'Frozen host tag must not move');
  assert.match(commit, /^[a-f0-9]{40}$/);
  // Newer hosts load their bundled catalogs during import; the frozen minimum predates them.
  const hostFiles = execFileSync('git', [...gitArgs, 'ls-tree', '--name-only', commit, '--',
    'core', 'package.json', 'market'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  execFileSync('git', [...gitArgs, 'archive', '--format=tar', '--output=' + join(root, 'host.tar'), commit, ...hostFiles]);
  execFileSync('tar', ['-xf', join(root, 'host.tar'), '-C', root]);
  await symlink(join(sourceHost, 'node_modules'), join(root, 'node_modules'), 'junction');
  t.diagnostic(`Release installation host ${baseline.name}: ${commit}`);
  return (await import(pathToFileURL(join(root, 'core/index.ts')).href)).boot;
}

const nativeProbe = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2], desktop = process.argv[3] === 'desktop';
const require = createRequire(join(root, 'package.json'));
const sharp = require('sharp');
const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#4f86c6' } }).png().toBuffer();
const image = await sharp(png).metadata();
assert.equal(image.width, 3); assert.equal(image.height, 2); assert.equal(image.format, 'png');
let bindingHash = null, fridaVersion = null;
if (desktop) {
  const lock = JSON.parse(await readFile(join(root, 'attach-engine.lock.json'), 'utf8'));
  const binding = await readFile(join(root, 'node_modules/frida/build/frida_binding.node'));
  bindingHash = createHash('sha256').update(binding).digest('hex');
  assert.equal(bindingHash, lock.bindingSha256);
  fridaVersion = JSON.parse(await readFile(join(root, 'node_modules/frida/package.json'), 'utf8')).version;
  assert.equal(fridaVersion, lock.version);
  const frida = await import(pathToFileURL(require.resolve('frida')).href);
  assert.equal(typeof frida.attach, 'function');
  // Loading the native binding is sufficient here. Never enumerate or attach
  // to any user process, and never start QQ or NapCat during package acceptance.
}
console.log(JSON.stringify({ sharp: 'png-3x2', fridaVersion, bindingHash }));
`;

for (const baseline of baselines) test(`independent release installation on ${baseline.name}: ${baseline.supported ? 'follow the active persona on receive/send and restart' : 'require a host upgrade before QQ can connect'}`,
  { timeout: 180000 }, async t => {
    const release = await verifyRelease(packagePath);
    const hostBoot = await snapshotHost(t, baseline);
    const f = await fixture(t, { temporaryDirectory, hostBoot, packagePath, includeQzone: false, includeVendor: true,
      config: { galleryEnabled: false }, preparePlugin: async installed => {
        // Preserve the shape of an actual 0.24 installation with a fixed persona.
        const path = join(installed, 'data/config.json');
        const legacy = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...legacy, personaId: 'b' }));
        // The fixture has added only synthetic configuration. Verify the
        // installed release bytes before booting any plugin from this copy.
        const copied = await fileInventory(installed);
        for (const [name, hash] of Object.entries(release.files)) assert.equal(copied[name], hash, 'Installed byte differs: ' + name);
      }, prepareHost: async root => {
        await writeFile(join(root,'a.md'),'SYNTHETIC_RELEASE_ACTIVE_PERSONA');
        await writeFile(join(root,'b.md'),'SYNTHETIC_RELEASE_OLD_FIXED_PERSONA');
      } });
    const installed = join(f.root, 'plugins/qq');
    assert.equal(f.app.runtime.records.has('qzone'), false);
    assert.equal(f.app.runtime.records.has('gallery'), false);
    assert.equal(f.app.runtime.records.has('surf'), false);
    assert.equal(f.app.runtime.records.has('bilibili'), false);
    assert.deepEqual((await readdir(join(installed, 'sub'))).sort(), ['gallery']);

    const probe = join(f.root, 'native-probe.mjs');
    await writeFile(probe, nativeProbe);
    const probeOutput = execFileSync(process.execPath, [probe, installed, release.mode], {
      cwd: f.root, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const native = JSON.parse(probeOutput.trim().split(/\r?\n/).at(-1)!);
    assert.equal(native.sharp, 'png-3x2');
    assert.equal(native.bindingHash !== null, release.mode === 'desktop');
    t.diagnostic(`Release ${release.version} ${release.mode}: Sharp passed${native.fridaVersion ? ', Frida ' + native.fridaVersion + ' binding verified/imported' : ''}`);

    if (!baseline.supported) {
      const blocked = async () => {
        const status = await f.status();
        assert.notEqual(status.state, 'online');
        assert.match(status.error, /升级|更新/);
        assert.match(status.error, /人格/);
        assert.equal(f.connects(), 0, 'The stored fixed persona must not start an unsupported QQ connection');
      };
      await blocked();
      const attempted = await f.save({ enabled: true, personaId: 'b' });
      assert.equal(attempted.ok, false);
      assert.match(await attempted.text(), /升级|更新/);
      await f.app.runtime.action('qq', 'stop');
      await f.app.runtime.action('qq', 'start');
      await blocked();
      assert.equal(f.calls.length, 0);
      assert.equal(f.generations.length, 0);
      assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
      return;
    }

    f.setGenerate(async () => ({ text: 'RELEASE_SMOKE_REPLY', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    await f.online();
    const sent = () => f.calls.filter(call => call.action === 'send_private_msg');
    const delivered = (id: string) => until(async () => (await f.status()).recent.some((row: any) => row.messageId === id && row.status === 'sent'));
    f.send({ message_id: 71001, message: [{ type: 'text', data: { text: 'SYNTHETIC_RELEASE_INPUT' } }] });
    await delivered('71001');
    assert.equal(f.generations.length, 1); assert.equal(sent().length, 1);
    const system = JSON.stringify(f.generations[0].messages.filter((m: { role: string }) => m.role === 'system'));
    assert.match(system, /SYNTHETIC_RELEASE_ACTIVE_PERSONA/);
    assert.doesNotMatch(system, /SYNTHETIC_RELEASE_OLD_FIXED_PERSONA/);
    assert.equal(sent()[0].params.user_id, 200002);
    assert.deepEqual(sent()[0].params.message, [{ type: 'text', data: { text: 'RELEASE_SMOKE_REPLY' } }]);
    const socket = f.socket();
    await f.app.runtime.action('qq', 'stop');
    await until(() => socket.readyState === 3);
    assert.equal((await f.request('/plugins/qq/settings')).status, 404);
    assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
    await f.app.runtime.action('qq', 'start'); await f.online();
    f.send({ message_id: 71001, message: [{ type: 'text', data: { text: 'SYNTHETIC_RELEASE_INPUT' } }] });
    await delivered('71001');
    assert.equal(f.generations.length, 1); assert.equal(sent().length, 1, 'Completed inbound reply must not replay');
    f.send({ message_id: 71002, message: [{ type: 'text', data: { text: 'SYNTHETIC_FRESH_INPUT' } }] });
    await delivered('71002');
    assert.equal(f.generations.length, 2); assert.equal(sent().length, 2, 'Fresh input must still work after restart');
    assert.equal(f.modelCalls.length, 0, 'No HTTP model calls are needed for isolated acceptance');
    assert.ok(f.calls.every(call => ['get_login_info', 'send_private_msg'].includes(call.action)), 'Only the local OneBot mock may be used');
    assert.equal(await f.app.runtime.services.get('witness')!.value.ping(), 'alive');
  });
