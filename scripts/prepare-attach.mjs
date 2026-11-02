import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const lock = JSON.parse(await readFile('attach-engine.lock.json', 'utf8'));
const installed = await readFile('node_modules/frida/build/frida_binding.node').catch(() => null);
if (installed && createHash('sha256').update(installed).digest('hex') === lock.bindingSha256) {
  console.log('Verified native attach component already installed: ' + lock.version);
  process.exit(0);
}
const dir = resolve('.artifacts/vendor'), archive = resolve(dir, 'frida-17.24.0-win32-x64.tar.gz');
await mkdir(dir, { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch (e) {
  if (e.code !== 'ENOENT') throw e;
  const response = await fetch(lock.archive, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Frida archive download failed');
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw Error('Frida archive checksum mismatch');
await writeFile(archive, bytes);
execFileSync('tar.exe', ['-xzf', archive, '-C', resolve('node_modules/frida')], { windowsHide: true, stdio: 'inherit' });
if (createHash('sha256').update(await readFile('node_modules/frida/build/frida_binding.node')).digest('hex') !== lock.bindingSha256) throw Error('Frida binding checksum mismatch');
console.log('Verified native attach component ready: ' + lock.version);
