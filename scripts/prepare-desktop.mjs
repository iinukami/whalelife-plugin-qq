import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const lock = JSON.parse(await readFile('desktop-engine.lock.json', 'utf8'));
const archive = resolve('.artifacts/vendor/NapCat.Framework.zip');
await mkdir(resolve('.artifacts/vendor'), { recursive: true });
try { await access(archive); } catch {
  const response = await fetch(lock.archive); if (!response.ok) throw Error('Desktop engine download failed');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
}
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
if (await digest(archive) !== lock.sha256) throw Error('Desktop engine archive checksum mismatch');
const destination = resolve('vendor/napcat-framework');
// Always restore packaged files from the verified official archive before hashing.
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:WHALE_DESKTOP_ARCHIVE -DestinationPath $env:WHALE_DESKTOP_DEST -Force'],
  { windowsHide: true, env: { ...process.env, WHALE_DESKTOP_ARCHIVE: archive, WHALE_DESKTOP_DEST: destination }, stdio: 'pipe' });
const license = await fetch(`https://raw.githubusercontent.com/NapNeko/NapCatQQ/v${lock.version}/LICENSE`);
if (!license.ok) throw Error('License download failed');
await writeFile(join(destination, 'NAPCAT-LICENSE.txt'), await license.text());
await writeFile(join(destination, 'ATTRIBUTION.txt'), `NapCatQQ Framework ${lock.version}\nCopyright © 2024 Mlikiowa\n${lock.source}\nOfficial native desktop loader; runtime files remain unmodified.\nPrivate non-commercial use under the accompanying license.\n`);
const files = {};
async function visit(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error('Unexpected engine symlink');
    if (entry.isDirectory()) await visit(join(dir, entry.name), name + '/'); else files[name] = await digest(join(dir, entry.name));
  }
}
await visit(destination);
await writeFile('vendor/desktop-manifest.json', JSON.stringify({ ...lock, files }, null, 2));
console.log(`Verified desktop engine ready: ${lock.version}, ${Object.keys(files).length} files`);
