/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Runs in QQ's existing main JS loop. Never initializes or closes a QQ session.
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const key = Symbol.for('whalelife.qq.desktop-attach.v1');

async function identity(wrapper, session) {
  const profile = session.getProfileService();
  let id, timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('identity_timeout')), 5000); });
    const result = new Promise(resolve => {
      id = profile.addKernelProfileListener(new Proxy({ onSelfStatusChanged: resolve }, { get: (t, k) => t[k] ?? (() => {}) }));
    });
    // Attach rejection handling before invoking the native request.
    const requested = Promise.resolve().then(() => profile.getSelfStatus());
    const info = await Promise.race([Promise.all([result, requested]).then(([info]) => info), deadline]);
    const uin = profile.getUinByUid('whalelife-desktop-attach', [info.uid]).get(info.uid);
    if (!/^\d{5,20}$/.test(String(uin)) || !info.uid || info.status === 20) throw Error('not_logged_in');
    const list = await Promise.race([wrapper.NodeIKernelLoginService.get().getLoginList(), deadline]);
    return { accountId: String(uin), uid: info.uid, nickname: list.LocalLoginInfoList.find(v => String(v.uin) === String(uin))?.nickName || '', online: true };
  } finally { clearTimeout(timer); if (id !== undefined) profile.removeKernelProfileListener(id); }
}

function createAgent(runtime = process, globals = globalThis, loadNapCat = url => import(url)) {
async function run(input) {
  if (Date.now() > input.deadline || runtime.type !== 'browser') throw Error('expired_or_wrong_process');
  const wrapperPath = path.join(runtime.mainModule.filename.split('application.asar')[0], 'wrapper.node');
  const native = { exports: {} }; runtime.dlopen(native, wrapperPath);
  const wrapper = native.exports;
  const session = wrapper.NodeIQQNTWrapperSession.getNTWrapperSession?.('nt_1');
  if (!session) throw Error('unsupported_session');
  const self = await identity(wrapper, session);
  const owned = globals[key];
  const legacy = runtime.env.NAPCAT_WORKDIR && path.resolve(runtime.env.NAPCAT_WORKDIR).toLowerCase() === path.resolve(input.legacyWorkdir).toLowerCase();
  if (input.operation === 'inspect') return { ...self, bridge: owned ? 'attached' : legacy ? 'legacy' : 'none' };
  if (self.accountId !== input.accountId || self.uid !== input.uid || Date.now() > input.deadline) throw Error('account_changed');
  if (owned) {
    if (owned.accountId !== self.accountId || owned.uid !== self.uid || owned.failed || !owned.valid) throw Error('bridge_changed');
    await owned.ready; return { ...self, bridge: 'attached' };
  }
  if (legacy) return { ...self, bridge: 'legacy' };
  // Avoid competing with a different already loaded protocol component.
  if (runtime.env.NAPCAT_WORKDIR || runtime.env.NAPCAT_WRAPPER_PATH) throw Error('foreign_bridge');
  const state = { accountId: self.accountId, uid: self.uid, valid: true, failed: false };
  globals[key] = state;
  runtime.env.NAPCAT_WORKDIR = input.workdir;
  runtime.env.NAPCAT_WRAPPER_PATH = wrapperPath;
  runtime.env.NAPCAT_DISABLE_BYPASS = '1';
  // Each lookup stays on the selected session. Once identity changes, no further
  // native calls or message callbacks may use this connection.
  const profile = session.getProfileService();
  profile.addKernelProfileListener(new Proxy({ onSelfStatusChanged(info) {
    if (info.uid !== self.uid || info.status === 20) state.valid = false;
  } }, { get: (t,k) => t[k] ?? (() => {}) }));
  const guard = object => new Proxy(object, { get(target, name) {
    const value = Reflect.get(target, name);
    if (typeof value !== 'function') return value;
    return (...args) => {
      if (!state.valid) throw Error('selected_account_offline');
      if (String(name).startsWith('addKernel') && args[0]) {
        const listener = args[0]; args[0] = new Proxy(listener, { get(t,k) { const f=t[k]; return typeof f==='function' ? (...a) => { if(state.valid) return f.apply(t,a); } : f; } });
      }
      const result = value.apply(target, args);
      return /^get.*Service$/.test(String(name)) && result ? guard(result) : result;
    };
  } });
  const login = wrapper.NodeIKernelLoginService.get();
  const facade = new Proxy(login, { get(target, name) {
    if (name === 'addKernelLoginListener') return listener => {
      queueMicrotask(() => { Promise.resolve(listener.onQRCodeLoginSucceed({ uin: self.accountId, uid: self.uid })).catch(() => { state.failed = true; }); });
      return 0;
    };
    if (/login|logout|QRCode|destroy|cancel|connect|Polling/i.test(String(name)) && name !== 'getLoginList') return () => { throw Error('desktop_login_owned_by_user'); };
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
  } });
  state.ready = loadNapCat(pathToFileURL(path.join(input.framework, 'napcat.mjs')).href)
    .then(m => m.NCoreInitFramework(guard(session), facade, callback => queueMicrotask(callback)))
    .catch(error => { state.failed = true; state.valid = false; throw error; });
  await state.ready;
  return { ...self, bridge: 'attached' };
}
return { run };
}
module.exports = { ...createAgent(), createAgent };
