import { execa } from 'execa';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import os from 'node:os';
import { adobeAppRoots, exe, freeRamBytes, pathDirs } from './platform.js';
import type { Encoders, Environment, ToolPaths } from './types.js';

const WINGET_FFMPEG_GLOB = join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
/** Homebrew prefixes (Apple silicon, Intel): apps started from the Dock do not get the shell's PATH. */
const BREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin'];
const BREW_FULL = ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin'];

function firstExisting(cands: string[]): string | undefined {
  return cands.find((p) => p && existsSync(p));
}

/** Find ffmpeg/ffprobe: env EDITMCP_FFMPEG, PATH, then the winget (Windows) or Homebrew (macOS) folders. */
export function findFfmpeg(): { ffmpeg: string; ffprobe: string } | undefined {
  const name = exe('ffmpeg');
  const envDir = process.env['EDITMCP_FFMPEG'];
  const cands: string[] = [];
  if (envDir) cands.push(join(envDir, name));
  // macOS: Homebrew's ffmpeg-full (keg-only) has libass for captions; prefer it over a slimmer ffmpeg on PATH
  if (process.platform === 'darwin') cands.push(...BREW_FULL.map((d) => join(d, name)));
  for (const dir of pathDirs()) cands.push(join(dir, name));
  if (process.platform === 'win32') {
    try {
      for (const pkg of readdirSync(WINGET_FFMPEG_GLOB)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        const pkgDir = join(WINGET_FFMPEG_GLOB, pkg);
        for (const sub of readdirSync(pkgDir)) {
          cands.push(join(pkgDir, sub, 'bin', name));
        }
      }
    } catch { /* winget folder absent */ }
  } else {
    for (const dir of BREW_BINS) cands.push(join(dir, name));
  }
  const ffmpeg = firstExisting(cands);
  if (!ffmpeg) return undefined;
  const ffprobe = join(dirname(ffmpeg), exe('ffprobe'));
  return existsSync(ffprobe) ? { ffmpeg, ffprobe } : undefined;
}

/** Newest "Adobe <app> 20xx" folder under the Adobe app roots (Program Files\Adobe or /Applications). */
function adobeAppDirs(app: string): string[] {
  const re = new RegExp(`^Adobe ${app} \\d{4}$`, 'i');
  const dirs: string[] = [];
  for (const root of adobeAppRoots()) {
    try {
      for (const d of readdirSync(root)) if (re.test(d)) dirs.push(join(root, d));
    } catch { /* no Adobe */ }
  }
  return dirs.sort().reverse();
}

/** macOS app bundle inside a version folder: "/Applications/Adobe X 2026/Adobe X 2026.app". */
function bundleIn(dir: string): string | undefined {
  return firstExisting([join(dir, `${basename(dir)}.app`)]);
}

/**
 * Newest After Effects (or EDITMCP_AE_DIR = its version folder). Windows: AfterFX.com/.exe and aerender.exe
 * under "Support Files". macOS: `afterfx` is the .app bundle (scripts run through AppleScript) and aerender
 * sits next to it.
 */
export function findAfterEffects(): Pick<ToolPaths, 'afterfx' | 'aerender' | 'aeVersionDir'> {
  const envDir = process.env['EDITMCP_AE_DIR'];
  const dirs = envDir ? [envDir] : adobeAppDirs('After Effects');
  for (const dir of dirs) {
    if (process.platform === 'darwin') {
      const app = bundleIn(dir);
      const aerender = join(dir, 'aerender');
      if (app) return { afterfx: app, aerender: existsSync(aerender) ? aerender : undefined, aeVersionDir: dir };
      continue;
    }
    const sf = join(dir, 'Support Files');
    const com = join(sf, 'AfterFX.com');
    const exePath = join(sf, 'AfterFX.exe');
    const aerender = join(sf, 'aerender.exe');
    const afterfx = firstExisting([com, exePath]);
    if (afterfx) return { afterfx, aerender: existsSync(aerender) ? aerender : undefined, aeVersionDir: dir };
  }
  return {};
}

/** Premiere / Media Encoder: the .exe on Windows, the .app bundle on macOS. */
export function findPremiere(): Pick<ToolPaths, 'premiereExe' | 'mediaEncoderExe'> {
  const out: Pick<ToolPaths, 'premiereExe' | 'mediaEncoderExe'> = {};
  const find = (app: string): string | undefined => {
    const dir = adobeAppDirs(app)[0];
    if (!dir) return undefined;
    return process.platform === 'darwin' ? bundleIn(dir) : firstExisting([join(dir, `Adobe ${app}.exe`)]);
  };
  const pr = find('Premiere Pro');
  const ame = find('Media Encoder');
  if (pr) out.premiereExe = pr;
  if (ame) out.mediaEncoderExe = ame;
  return out;
}

/**
 * ArtCraft headless CLIs (optional): EDITMCP_FILMCRAFT_DIR / EDITMCP_EFFECTCRAFT_DIR (e.g. a portable
 * zip), else the MSI install folders under Program Files.
 */
export function findArtCraft(): Pick<ToolPaths, 'filmcraftCli' | 'effectcraftCli'> {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const find = (envKey: string, app: string, cli: string): string | undefined => {
    const envDir = process.env[envKey];
    return firstExisting([envDir ? join(envDir, exe(cli)) : '', process.platform === 'win32' ? join(pf, app, exe(cli)) : '']);
  };
  const out: Pick<ToolPaths, 'filmcraftCli' | 'effectcraftCli'> = {};
  const fc = find('EDITMCP_FILMCRAFT_DIR', 'FilmCraft', 'filmcraft-cli');
  const ec = find('EDITMCP_EFFECTCRAFT_DIR', 'EffectCraft', 'effectcraft-cli');
  if (fc) out.filmcraftCli = fc;
  if (ec) out.effectcraftCli = ec;
  return out;
}

export function discoverTools(): ToolPaths {
  const ff = findFfmpeg();
  if (!ff) throw new Error(`ffmpeg/ffprobe not found. Install via ${process.platform === 'darwin' ? 'Homebrew (brew install ffmpeg)' : 'winget (Gyan.FFmpeg)'} or set EDITMCP_FFMPEG to its bin folder.`);
  return { ...ff, ...findAfterEffects(), ...findPremiere(), ...findArtCraft() };
}

export async function probeEncoders(ffmpeg: string): Promise<Encoders & { version?: string }> {
  const { stdout } = await execa(ffmpeg, ['-hide_banner', '-encoders'], { reject: false, windowsHide: true, timeout: 30_000 });
  const has = (name: string) => new RegExp(`^\\s*[A-Z.]{6}\\s+${name}\\s`, 'm').test(stdout);
  let version: string | undefined;
  try {
    const v = await execa(ffmpeg, ['-version'], { reject: false, windowsHide: true, timeout: 30_000 });
    version = v.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s+/, '');
  } catch { /* ignore */ }
  return {
    h264_nvenc: has('h264_nvenc'),
    h264_qsv: has('h264_qsv'),
    hevc_nvenc: has('hevc_nvenc'),
    libx264: has('libx264'),
    prores_ks: has('prores_ks'),
    dnxhd: has('dnxhd'),
    mpeg2video: has('mpeg2video'),
    version,
  };
}

export async function getEnvironment(): Promise<Environment> {
  const tools = discoverTools();
  const enc = await probeEncoders(tools.ffmpeg);
  const { version, ...encoders } = enc;
  return {
    tools,
    encoders,
    ffmpegVersion: version,
    totalRamGb: os.totalmem() / 2 ** 30,
    freeRamGb: freeRamBytes() / 2 ** 30,
    cpuThreads: os.cpus().length,
  };
}
