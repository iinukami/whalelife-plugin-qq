/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Runs separately so a native attachment failure cannot terminate the plugin.
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
process.once('message', async input => {
  let session, script;
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(new URL('../node_modules/frida/build/frida_binding.node', import.meta.url))) hash.update(chunk);
    if (hash.digest('hex') !== 'ee70a01fbdca968c23602cf662ce611a3cc99ce96df922361fb02baadabe73c3') throw Error('component_checksum');
    const frida = await import('frida');
    session = await frida.attach(input.pid);
    const template = await readFile(new URL('./napi.js', import.meta.url), 'utf8');
    script = await session.createScript(template.replace('/*EXPRESSION*/', JSON.stringify(input.expression)));
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('callback_timeout')), 30000);
      script.message.connect(message => {
        if (message.type === 'error' || message.payload?.complete) {
          clearTimeout(timer);
          if (message.type === 'error' || !message.payload.ok) reject(Error('evaluate_failed'));
          else resolve();
        }
      });
    });
    await script.load(); await completed;
    process.send?.({ ok: true });
  } catch { process.send?.({ ok: false }); }
  finally { await script?.unload().catch(() => {}); await session?.detach().catch(() => {}); process.disconnect?.(); }
});
