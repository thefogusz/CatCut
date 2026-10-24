import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { adobeAppRoots, adobePrefsDir, exe, isBundleProcess, listPosixProcesses, localAppDataDir, ownTree, parseVmStat, pathDirs } from '../../src/core/platform.js';

describe('platform', () => {
  it('names executables and splits PATH per OS', () => {
    expect(exe('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(exe('ffmpeg', 'darwin')).toBe('ffmpeg');
    expect(pathDirs({ PATH: 'C:\\a;;C:\\b' }, 'win32')).toEqual(['C:\\a', 'C:\\b']);
    expect(pathDirs({ PATH: '/opt/homebrew/bin::/usr/bin' }, 'darwin')).toEqual(['/opt/homebrew/bin', '/usr/bin']);
  });

  it('per-user and Adobe folders: %LOCALAPPDATA% / %APPDATA% on Windows, ~/Library on macOS', () => {
    expect(localAppDataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x')).toBe('C:\\Users\\x\\AppData\\Local');
    expect(localAppDataDir({}, 'darwin', '/Users/x')).toBe(join('/Users/x', 'Library', 'Application Support'));
    expect(adobePrefsDir({}, 'darwin', '/Users/x')).toBe(join('/Users/x', 'Library', 'Preferences', 'Adobe'));
    expect(adobePrefsDir({}, 'win32')).toBeUndefined();
    expect(adobeAppRoots({}, 'darwin')).toEqual(['/Applications']);
    expect(adobeAppRoots({ ProgramFiles: 'D:\\PF' }, 'win32')).toEqual([join('D:\\PF', 'Adobe')]);
  });

  it('parses ps output and kills only a tree that belongs to the given parent', async () => {
    const run = async () => ({ stdout: [
      '  100     1 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects',
      '  200   100 /Applications/Adobe After Effects 2026/aerendercore.app/Contents/MacOS/aerendercore',
      '  300   200 /bin/helper with spaces',
      '  400     1 /usr/sbin/other',
    ].join('\n') });
    const procs = await listPosixProcesses(run);
    expect(procs.map((p) => [p.pid, p.ppid])).toEqual([[100, 1], [200, 100], [300, 200], [400, 1]]);
    expect(procs[2]!.command).toBe('/bin/helper with spaces');
    expect(ownTree(100, procs, 1)).toEqual([300, 200, 100]);
    expect(ownTree(100, procs, 999)).toEqual([]); // not our child: never touched
    expect(ownTree(12345, procs, 1)).toEqual([]);
  });

  it('recognises an app bundle process by its app name', () => {
    const ae = '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects';
    expect(isBundleProcess(ae, /^Adobe After Effects\b/)).toBe(true);
    expect(isBundleProcess(ae, /^Adobe Premiere Pro\b/)).toBe(false);
    expect(isBundleProcess('/usr/bin/After Effects', /^Adobe After Effects\b/)).toBe(false);
  });

  it('counts reclaimable macOS memory from vm_stat, not only free pages', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                     3823.',
      'Pages active:                                 228479.',
      'Pages inactive:                               226958.',
      'Pages speculative:                               634.',
      'Pages wired down:                             192780.',
      'Pages purgeable:                                   4.',
    ].join('\n');
    expect(parseVmStat(out)).toBe((3823 + 226958 + 634 + 4) * 16384);
    expect(parseVmStat('garbage')).toBeUndefined();
  });
});
