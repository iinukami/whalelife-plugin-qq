/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function writeSnapshot(workdir, snapshot) {
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) throw Error('invalid_workdir');
  const file = path.join(workdir, 'connection-diagnostics.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  let ownsTemporary = false;
  try {
    await fs.mkdir(workdir, { recursive: true });
    const normalize = value => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (normalize(await fs.realpath(workdir)) !== normalize(workdir) || (await fs.lstat(workdir)).isSymbolicLink())
      throw Error('linked_workdir');
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw Error('linked_file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await fs.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try { await handle.writeFile(JSON.stringify(snapshot, null, 2) + '\n'); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } catch (error) {
    if (ownsTemporary) await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// Server text is used only to select a fixed category. Never retain or log it.
function reason(info) {
  const text = [info?.tipsTitle, info?.tipsDesc]
    .map(value => typeof value === 'string' ? value.slice(0, 512) : '').join(' ');
  if (/安全|风险|冻结|security|risk/i.test(text)) return 'security';
  if (/其他设备|另一.{0,8}设备|异地|other.{0,16}device|another.{0,16}device|elsewhere/i.test(text)) return 'other_device';
  if (/失效|过期|重新登录|\b(?:user identity|login session|session|login|credentials?) (?:is |has )?(?:invalid|expired)\b|\b(?:invalid|expired) (?:user identity|login session|session|login|credentials?)\b/i.test(text)) return 'login_invalid';
  return 'unknown';
}

function createDiagnosticsInstaller({ writeSnapshot: write = writeSnapshot, now = () => new Date().toISOString() } = {}) {
  return function installDiagnostics(state, session, workdir) {
    if (state.offlineDiagnostics) {
      state.offlineDiagnostics.ensure?.();
      return state.offlineDiagnostics;
    }
    let dirty = false, running, lastStatus, stopped = false;
    let profileInstalled = false, messageInstalled = false;
    const diagnostics = { version: 1, events: [], writeState: 'idle', observerState: 'pending' };
    state.offlineDiagnostics = diagnostics;

    const queue = () => {
      dirty = true;
      if (running) return;
      running = Promise.resolve().then(async () => {
        // Coalesce all pending updates into one latest snapshot. Slow storage
        // never creates a promise/write per native event.
        while (dirty) {
          dirty = false;
          const snapshot = { version: 1, observerState: diagnostics.observerState,
            events: diagnostics.events.map(event => ({ ...event })) };
          diagnostics.writeState = 'writing';
          try { await write(workdir, snapshot); diagnostics.writeState = 'ok'; }
          catch { diagnostics.writeState = 'failed'; }
        }
      }).catch(() => { diagnostics.writeState = 'failed'; }).finally(() => {
        running = undefined;
        if (dirty) queue();
      });
    };
    const record = event => {
      diagnostics.events.push({ at: now(), ...event });
      if (diagnostics.events.length > 32) diagnostics.events.splice(0, diagnostics.events.length - 32);
      queue();
    };
    // No exception from diagnostics may escape into QQ's callback dispatch.
    const safe = callback => (...args) => { try { callback(...args); } catch {} };
    const active = info => {
      if (stopped) return false;
      if (state.accountChanged || (typeof info?.uid === 'string' && info.uid && info.uid !== state.uid)) {
        stopped = true;
        record({ event: 'account_changed' });
        return false;
      }
      return true;
    };
    const profileListener = new Proxy({ onSelfStatusChanged: safe(info => {
      if (!active(info) || !Number.isSafeInteger(info?.status) || info.status === lastStatus) return;
      lastStatus = info.status;
      record({ event: 'status', status: info.status });
    }) }, { get: (target, name) => target[name] ?? (() => {}) });
    const messageListener = new Proxy({ onKickedOffLine: safe(info => {
      if (!active()) return;
      const event = { event: 'kicked', reason: reason(info) };
      for (const key of ['kickedType', 'securityKickedType']) {
        if (Number.isSafeInteger(info?.[key])) event[key] = info[key];
      }
      if (typeof info?.sameDevice === 'boolean') event.sameDevice = info.sameDevice;
      record(event);
    }) }, { get: (target, name) => target[name] ?? (() => {}) });
    diagnostics.ensure = () => {
      // Register directly on the original services, never on the business
      // guard and never forward a callback to NapCat's recovery handlers.
      if (!profileInstalled) {
        try { session.getProfileService().addKernelProfileListener(profileListener); profileInstalled = true; } catch {}
      }
      if (!messageInstalled) {
        try { session.getMsgService().addKernelMsgListener(messageListener); messageInstalled = true; } catch {}
      }
      const next = profileInstalled && messageInstalled ? 'ready' : 'partial';
      if (diagnostics.observerState !== next) { diagnostics.observerState = next; queue(); }
    };
    diagnostics.flush = async () => { while (running) await running; };
    safe(() => { if (active()) record({ event: 'attached' }); })();
    diagnostics.ensure();
    return diagnostics;
  };
}

module.exports = { installDiagnostics: createDiagnosticsInstaller(), createDiagnosticsInstaller };
