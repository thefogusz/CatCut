// macOS/Linux: per-user folders (~/Library/…, CatCut backups, AE prefs) resolve under a throwaway HOME,
// so no test ever writes into the real one. Windows keeps its env (tests set LOCALAPPDATA themselves).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

if (process.platform !== 'win32') {
  const home = mkdtempSync(join(os.tmpdir(), 'catcut-home-'));
  process.env['HOME'] = home;
  afterAll(() => rmSync(home, { recursive: true, force: true }));
}
