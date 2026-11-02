/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Invoke only from an existing callback with a valid env and handle scope.
// QQ.exe exports forwarding stubs; QQNT.dll owns the running JS environment.
const host = Process.findModuleByName('QQNT.dll') || Process.enumerateModules().find(m => m.findExportByName('napi_get_cb_info'));
if (!host) throw Error('unsupported_runtime');
const fn = (name, args) => new NativeFunction(host.getExportByName(name), 'int', args);
const open = fn('napi_open_handle_scope', ['pointer','pointer']);
const close = fn('napi_close_handle_scope', ['pointer','pointer']);
const string = fn('napi_create_string_utf8', ['pointer','pointer','uint64','pointer']);
const run = fn('napi_run_script', ['pointer','pointer','pointer']);
const clear = fn('napi_get_and_clear_last_exception', ['pointer','pointer']);
const expression = /*EXPRESSION*/;
const source = Memory.allocUtf8String(expression);
const size = unescape(encodeURIComponent(expression)).length;
let done = false;
const hook = Interceptor.attach(host.getExportByName('napi_get_cb_info'), {
  onEnter(args) { this.env = args[0]; },
  onLeave(retval) {
    if (done || retval.toInt32() !== 0) return;
    done = true;
    const scope = Memory.alloc(Process.pointerSize), value = Memory.alloc(Process.pointerSize), result = Memory.alloc(Process.pointerSize);
    let opened = false;
    try {
      if (open(this.env, scope) !== 0) throw Error(); opened = true;
      if (string(this.env, source, size, value) !== 0) throw Error();
      if (run(this.env, value.readPointer(), result) !== 0) { clear(this.env, result); throw Error(); }
      send({complete:true,ok:true});
    } catch { send({complete:true,ok:false}); }
    finally { if (opened) close(this.env, scope.readPointer()); setImmediate(()=>hook.detach()); }
  }
});
