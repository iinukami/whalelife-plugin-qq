import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { remoteDesktop } from '../src/desktop-attach.ts';

for (const cancel of [false, true]) test(`native helper ${cancel ? 'cancellation' : 'failed probe'} leaves its owned test target alive`, async t => {
  const root = await temporaryDirectory('whale-qq-native-');
  let child: ReturnType<typeof spawn> | undefined;
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  t.after(async () => {
    clearTimeout(timer); controller.abort();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  const fixture = join(root, 'native.cjs');
  await writeFile(fixture, `const sharp=require(${JSON.stringify(resolve('node_modules/sharp'))});process.send('ready');setInterval(()=>sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer().catch(()=>{}),100);`);
  child = spawn(process.execPath, [fixture], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  if (cancel) timer = setTimeout(() => controller.abort(), 250);
  await assert.rejects(remoteDesktop(resolve('.'), { pid: child.pid!, startedAt: 'owned-test', path: process.execPath }, { operation: 'inspect' }, controller.signal), cancel ? /取消/ : /读取或接入/);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  assert.deepEqual(await readdir(resolve('data/desktop-attach/tmp')), []);
});
