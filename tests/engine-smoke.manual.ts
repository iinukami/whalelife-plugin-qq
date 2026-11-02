// Opt-in real engine startup, fresh isolated profile, NO QR scan/account login/messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ManagedEngine } from '../src/managed-engine.ts';
import { defaults } from '../src/config.ts';
import { temporaryDirectory } from '../../whalelife/tests/temporary-directory.ts';
import { until } from './fixture.ts';
test('official bundled engine reaches isolated QR login and stops cleanly', { skip: process.env.QQ_ENGINE_SMOKE !== '1', timeout: 90000 }, async t => {
  const root = await temporaryDirectory('whale-qq-plugin-engine-smoke-');
  const engine = new ManagedEngine({ ...defaults, accountId: '100001' }, new AbortController().signal, () => { throw Error('Unexpected real account login'); }, () => {}, root);
  t.after(() => engine.stop());
  await cp(resolve('managed'), join(root, 'managed'), { recursive: true });
  await cp(resolve('vendor'), join(root, 'vendor'), { recursive: true });
  // Test-only startup capture: fresh profile has no account, media or saved secrets.
  const diagnostic = join(root, 'startup.log'); await writeFile(diagnostic, '');
  const supervisor = join(root, 'managed/windows-job.cs');
  await writeFile(supervisor, (await readFile(supervisor, 'utf8')).replace('CreateFile("NUL",', `CreateFile(${JSON.stringify(diagnostic)},`));
  engine.start();
  try { await until(() => engine.status.state === 'failed' || (engine.status.state === 'waiting_login' && !!engine.status.qrCode), 60000); if (engine.status.state === 'failed') throw Error('failed'); }
  catch { throw Error(JSON.stringify({ status: { ...engine.status, qrCode: !!engine.status.qrCode }, files: await readdir(join(root, 'data/managed-napcat')).catch(() => []), diagnostic: (await readFile(diagnostic, 'utf8')).split('\n').filter(x => /error|failed|cannot|异常|失败|版本|at |Error|NODE_/i.test(x)).join('\n').slice(-4500) })); }
  assert.match(engine.status.qrCode!, /^data:image\/png;base64,/);
  assert.equal(engine.status.accountId, undefined);
  await engine.refreshQR();
  console.log('Official NapCat ready for QR login; no account signed in.');
  await engine.stop(); assert.equal(engine.status.state, 'stopped');
});
