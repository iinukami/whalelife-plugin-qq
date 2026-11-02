/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Runs ONLY in the owned protocol child, never in WhaleLife or its plugin worker.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const root = process.env.WHALE_QQ_ENGINE_ROOT;
const profile = process.env.WHALE_QQ_PROFILE;
if (!root || !profile || !path.isAbsolute(root) || !path.isAbsolute(profile)) throw Error('Missing owned engine paths');
let ending = false;
function stop() { if (!ending) { ending = true; process.exit(0); } }
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'stop') stop(); });
input.on('close', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
// Pin QQ storage BEFORE NapCat creates login/session objects. This adapter only
// redirects the data directory; no platform protocol or native binary is altered.
const original = process.dlopen;
const expected = path.join(root, 'wrapper.node').toLowerCase();
process.dlopen = function (mod, file, ...rest) {
  const result = original.call(process, mod, file, ...rest);
  if (path.resolve(String(file)).toLowerCase() === expected) {
    const util = mod.exports.NodeQQNTWrapperUtil;
    if (!util || typeof util.getNTUserDataInfoConfig !== 'function') throw Error('Unsupported QQ storage API');
    // Native properties are non-configurable. Keep the original exports intact
    // and supply a JS facade for the single storage-location query.
    const isolatedUtil = Object.create(util, { getNTUserDataInfoConfig: { value: () => profile } });
    mod.exports = Object.create(mod.exports, { NodeQQNTWrapperUtil: { value: isolatedUtil } });
    if (mod.exports.NodeQQNTWrapperUtil.getNTUserDataInfoConfig() !== profile) throw Error('QQ storage isolation failed');
    fs.writeFileSync(path.join(profile, 'storage-isolated.json'), JSON.stringify({ version: 1 }));
  }
  return result;
};
process.env.NAPCAT_WORKDIR = path.join(profile, 'runtime');
process.env.NAPCAT_DISABLE_MULTI_PROCESS = '1';
process.env.NAPCAT_DISABLE_PIPE = '1';
process.env.NAPCAT_DISABLE_TIME_SYNC = '1';
// A standalone profile must never inherit password/automatic-account selection.
for (const name of ['ACCOUNT','NAPCAT_QUICK_ACCOUNT','NAPCAT_QUICK_PASSWORD','NAPCAT_QUICK_PASSWORD_MD5']) delete process.env[name];
import(pathToFileURL(path.join(root, 'index.js')).href).catch(() => {
  fs.writeFileSync(path.join(profile, 'startup-error.json'), JSON.stringify({ code: 'engine_boot_failed' }));
  stop();
});
