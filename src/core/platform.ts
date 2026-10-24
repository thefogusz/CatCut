/**
 * OS-specific locations and process helpers. Windows is the primary target; macOS is supported
 * (Adobe apps live in /Applications, per-user data in ~/Library, processes via `ps`).
 */
import { execa } from 'execa';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

/** Executable file name on this OS: `ffmpeg` → `ffmpeg.exe` on Windows. */
export function exe(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/** PATH entries (`;` on Windows, `:` elsewhere). */
export function pathDirs(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  return (env['PATH'] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Per-user app data root: %LOCALAPPDATA% · ~/Library/Application Support · $XDG_DATA_HOME or ~/.local/share. */
export function localAppDataDir(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (platform === 'win32') return env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  return env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
}

/** Per-user Adobe settings root: %APPDATA%\Adobe · ~/Library/Preferences/Adobe (AE prefs live below it). */
export function adobePrefsDir(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string | undefined {
  if (platform === 'win32') return env['APPDATA'] ? join(env['APPDATA'], 'Adobe') : undefined;
  if (platform === 'darwin') return join(home, 'Library', 'Preferences', 'Adobe');
  return undefined;
}

/** Folders that hold the Adobe app folders ("Adobe After Effects 2026", …). */
export function adobeAppRoots(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return [join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Adobe')];
  if (platform === 'darwin') return ['/Applications'];
  return [];
}

const LABEL_FONTS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: ['C:/Windows/Fonts/arial.ttf'],
  darwin: ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'],
  linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
};

/** `fontfile='…'` for ffmpeg drawtext labels, or undefined when no known font file exists (callers fall back). */
export function labelFontOpt(platform: NodeJS.Platform = process.platform): string | undefined {
  const file = (LABEL_FONTS[platform] ?? []).find((f) => existsSync(f));
  // drawtext option values need the drive colon escaped
  return file ? `fontfile='${file.replace(/:/g, '\\:')}'` : undefined;
}

export interface PosixProcess { pid: number; ppid: number; command: string }

type RunFn = (file: string, args: string[], opts: Record<string, unknown>) => PromiseLike<{ stdout?: unknown }>;

/** Every process via `ps` (macOS/Linux): pid, parent pid and executable path. */
export async function listPosixProcesses(run: RunFn = execa): Promise<PosixProcess[]> {
  const r = await run('ps', ['-axww', '-o', 'pid=,ppid=,comm='], { reject: false, timeout: 15_000 });
  const out: PosixProcess[] = [];
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return out;
}

/**
 * pid and all its descendants, children first (so a parent cannot respawn them). Empty unless pid is a
 * child of `parent` (default: this process), so a stale or foreign pid never takes another tree down.
 */
export function ownTree(pid: number, procs: PosixProcess[], parent: number = process.pid): number[] {
  if (!procs.some((p) => p.pid === pid && p.ppid === parent)) return [];
  return descendants(pid, procs);
}

function descendants(pid: number, procs: PosixProcess[]): number[] {
  const out: number[] = [];
  const visit = (p: number) => {
    for (const c of procs) if (c.ppid === p && c.pid !== p) visit(c.pid);
    out.push(p);
  };
  visit(pid);
  return out;
}

/** Executable inside a macOS app bundle: `/Applications/X/X.app` → `…/X.app/Contents/MacOS/` prefix match. */
export function isBundleProcess(command: string, appNamePattern: RegExp): boolean {
  const m = /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(command);
  return !!m && appNamePattern.test(m[1]!);
}

/** `vm_stat` output → bytes macOS can hand out now: free + inactive + speculative + purgeable pages. */
export function parseVmStat(out: string): number | undefined {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  if (!page) return undefined;
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(out)?.[1] ?? 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page;
}

/**
 * Free RAM for the "enough memory to start AE / aerender" checks. macOS keeps memory busy as file cache,
 * so os.freemem() there is a fraction of what an app can actually get; read vm_stat instead.
 */
export function freeRamBytes(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'darwin') {
    try {
      const n = parseVmStat(execFileSync('vm_stat', { encoding: 'utf8', timeout: 5000 }));
      if (n !== undefined) return n;
    } catch { /* fall back */ }
  }
  return os.freemem();
}
