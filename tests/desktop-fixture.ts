import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Use the test fixture's OneBot server as the independently running desktop.
export async function desktopConnection(root: string) {
  const cfg = JSON.parse(await readFile(join(root, 'data/config.json'), 'utf8'));
  const wsPort = Number(new URL(cfg.wsUrl).port);
  await mkdir(join(root, 'data/desktop-bridge'), { recursive: true });
  await writeFile(join(root, 'data/desktop-bridge/connection.json'), JSON.stringify({
    version: 1, wsPort, webPort: wsPort === 65000 ? 64999 : 65000,
    accessToken: 'a'.repeat(64), webToken: 'b'.repeat(64),
  }));
}
