import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { OwnedProcess, quoteWindows } from '../src/managed-engine.ts';
import { parseConfig } from '../src/config.ts';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { until } from './fixture.ts';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('desktop default and v1 migration preserve old connection and credentials', () => {
  assert.equal(parseConfig({}).connectionMode, 'desktop');
  const old = parseConfig({ schemaVersion: 1, enabled: true, wsUrl: 'ws://127.0.0.1:3001/', accessToken: 'secret', accountId: '100001', allowedUsers: ['200002'], personaId: 'a' });
  assert.equal(old.connectionMode, 'external'); assert.equal(old.accessToken, 'secret');
  assert.doesNotThrow(() => parseConfig({ enabled: true, connectionMode: 'managed', personaId: 'a', allowedUsers: ['200002'] }));
  assert.throws(() => parseConfig({ connectionMode: 'arbitrary' }));
  assert.equal(quoteWindows('a b\\'), '"a b\\\\"');
});

test('Windows owned job stops its entire process tree and leaves an unrelated process alive', { timeout: 20000 }, async t => {
  const root = await temporaryDirectory('whale-qq-plugin-job-');
  const owned = new OwnedProcess(resolve('.'));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { await owned.stop(); unrelated.kill(); await new Promise<void>(r => unrelated.once('close', () => r())); });
  const childScript = join(root, 'worker with spaces.cjs');
  await writeFile(childScript, `const fs=require('fs');const {spawn}=require('child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(root, 'pids.json'))},JSON.stringify([process.pid,p.pid]));setInterval(()=>{},1000);`);
  let exited = false;
  owned.start(process.execPath, [childScript], root, {}, () => { exited = true; });
  let pids: number[] = [];
  await until(async () => { try { pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')); return true; } catch { return false; } }, 10000);
  assert.ok(pids.every(alive)); assert.ok(!exited);
  await owned.stop(); await until(() => pids.every(pid => !alive(pid)));
  assert.ok(alive(unrelated.pid!));
});

test('abrupt owner death closes stdin lease and kills the owned engine without PID scans', { timeout: 20000 }, async t => {
  const root = await temporaryDirectory('whale-qq-plugin-orphan-');
  const script = join(root, 'owner.ts'), marker = join(root, 'engine.pid');
  await writeFile(script, `import {OwnedProcess} from ${JSON.stringify(new URL('../src/managed-engine.ts', import.meta.url).href)};const p=new OwnedProcess(${JSON.stringify(resolve('.'))});p.start(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)}],${JSON.stringify(root)},{},()=>{});setInterval(()=>{},1000);`);
  const owner = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let output = ''; owner.stderr.on('data', x => { output += x.toString(); });
  let pid = 0;
  t.after(async () => { owner.kill(); if (pid) await until(() => !alive(pid)); });
  try { await until(async () => { try { pid = Number(await readFile(marker, 'utf8')); return pid > 0; } catch { return false; } }, 10000); }
  catch { throw Error(output || 'Engine did not start'); }
  owner.kill(); await until(() => !alive(pid), 7000);
});
