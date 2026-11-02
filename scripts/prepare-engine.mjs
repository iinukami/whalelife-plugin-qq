import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, cp, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const lock = JSON.parse(await readFile('engine.lock.json', 'utf8'));
const archive = resolve('.artifacts/vendor/NapCat.Shell.Windows.Node.zip');
await mkdir(resolve('.artifacts/vendor'), { recursive: true });
try { await access(archive); } catch {
  const response = await fetch(lock.archive); if (!response.ok) throw Error('Engine download failed');
  const { Readable } = await import('node:stream'); const { pipeline } = await import('node:stream/promises'); const { createWriteStream } = await import('node:fs');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
}
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
if (await digest(archive) !== lock.sha256) throw Error('Engine archive checksum mismatch');
const destination = resolve('vendor/napcat');
try { await access(join(destination, 'index.js')); } catch {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:WHALE_ENGINE_ARCHIVE -DestinationPath $env:WHALE_ENGINE_DEST'],
    { windowsHide: true, env: { ...process.env, WHALE_ENGINE_ARCHIVE: archive, WHALE_ENGINE_DEST: destination }, stdio: 'pipe' });
}
const licenseURL = 'https://raw.githubusercontent.com/NapNeko/NapCatQQ/v4.18.41/LICENSE';
const license = await fetch(licenseURL); if (!license.ok) throw Error('License download failed');
await writeFile(join(destination, 'NAPCAT-LICENSE.txt'), await license.text());
await writeFile(join(destination, 'ATTRIBUTION.txt'), `NapCatQQ ${lock.version}\nCopyright © 2024 Mlikiowa\n${lock.source}\nOriginal official Windows Node release; private non-commercial use.\nRuntime files remain unmodified. WhaleLife's launcher is separate.\n`);
const files = {};
async function visit(dir, prefix='') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error('Unexpected engine symlink');
    if (entry.isDirectory()) await visit(join(dir, entry.name), relative + '/');
    else files[relative] = await digest(join(dir, entry.name));
  }
}
await visit(destination);
await writeFile('vendor/engine-manifest.json', JSON.stringify({ ...lock, files }, null, 2));
console.log(`Verified engine ready: ${lock.name} ${lock.version}, ${Object.keys(files).length} files`);
