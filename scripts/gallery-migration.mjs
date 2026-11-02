/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Installer-only migration. The old choice comes from public status, never host private state.
export function migrateGalleryChoice(plugins, config) {
  if (!Array.isArray(plugins) || !config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid migration snapshot');
  if (config.galleryEnabled !== undefined) {
    if (typeof config.galleryEnabled !== 'boolean') throw Error('Invalid gallery choice');
    return { ...config };
  }
  const legacy = plugins.find(p => p.id === 'qq/gallery');
  if (!legacy) return { ...config };
  if (typeof legacy.enabled !== 'boolean') throw Error('Missing public legacy enabled state');
  return { ...config, galleryEnabled: legacy.enabled };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (!option('--target')) throw Error('Specify --target for the installed QQ directory');
  const target = resolve(option('--target')), url = new URL(option('--base') ?? 'http://127.0.0.1:9270');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw Error('Use the authenticated local host API');
  const dir = join(target, 'data'), path = join(dir, 'config.json');
  for (const root of [target, dir]) if (resolve(await realpath(root)) !== root || (await lstat(root)).isSymbolicLink()) throw Error('Unexpected installation path');
  if ((await lstat(path)).isSymbolicLink()) throw Error('Config must not be a link');
  const login = await fetch(url.origin + '/api/login', { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
  if (!login.ok) throw Error('Authentication failed');
  const cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  const api = async path => { const r = await fetch(url.origin + path, { headers: { Cookie: cookie, Origin: url.origin }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw Error('API status ' + r.status); return r.json(); };
  const { plugins } = await api('/api/status'), { config: current } = await api('/plugins/qq/config');
  const before = await readFile(path, 'utf8'), raw = JSON.parse(before);
  // Public config redacts the token and may include defaults absent from the old disk file.
  if (!!raw.accessToken !== current.hasAccessToken || Object.entries(raw).some(([k, v]) => k !== 'accessToken' && JSON.stringify(v) !== JSON.stringify(current[k])))
    throw Error('Disk and running configuration differ; preserve pending changes');
  const next = migrateGalleryChoice(plugins, raw), changed = JSON.stringify(next) !== JSON.stringify(raw);
  if (args.includes('--apply') && changed) {
    await writeFile(join(dir, 'config-before-builtin-gallery.json'), before, { flag: 'wx' });
    if (await readFile(path, 'utf8') !== before) throw Error('Config changed; refresh migration snapshot');
    const pending = join(dir, 'config-builtin-gallery.pending');
    await writeFile(pending, JSON.stringify(next, null, 2), { flag: 'wx' }); await rename(pending, path);
  }
  console.log(JSON.stringify({ changed, applied: args.includes('--apply') && changed, galleryEnabled: next.galleryEnabled ?? true, reloadRequired: changed }));
}
