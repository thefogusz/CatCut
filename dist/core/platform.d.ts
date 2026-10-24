export type Env = Record<string, string | undefined>;
/** Executable file name on this OS: `ffmpeg` → `ffmpeg.exe` on Windows. */
export declare function exe(name: string, platform?: NodeJS.Platform): string;
/** PATH entries (`;` on Windows, `:` elsewhere). */
export declare function pathDirs(env?: Env, platform?: NodeJS.Platform): string[];
/** Per-user app data root: %LOCALAPPDATA% · ~/Library/Application Support · $XDG_DATA_HOME or ~/.local/share. */
export declare function localAppDataDir(env?: Env, platform?: NodeJS.Platform, home?: string): string;
/** Per-user Adobe settings root: %APPDATA%\Adobe · ~/Library/Preferences/Adobe (AE prefs live below it). */
export declare function adobePrefsDir(env?: Env, platform?: NodeJS.Platform, home?: string): string | undefined;
/** Folders that hold the Adobe app folders ("Adobe After Effects 2026", …). */
export declare function adobeAppRoots(env?: Env, platform?: NodeJS.Platform): string[];
/** `fontfile='…'` for ffmpeg drawtext labels, or undefined when no known font file exists (callers fall back). */
export declare function labelFontOpt(platform?: NodeJS.Platform): string | undefined;
export interface PosixProcess {
    pid: number;
    ppid: number;
    command: string;
}
type RunFn = (file: string, args: string[], opts: Record<string, unknown>) => PromiseLike<{
    stdout?: unknown;
}>;
/** Every process via `ps` (macOS/Linux): pid, parent pid and executable path. */
export declare function listPosixProcesses(run?: RunFn): Promise<PosixProcess[]>;
/**
 * pid and all its descendants, children first (so a parent cannot respawn them). Empty unless pid is a
 * child of `parent` (default: this process), so a stale or foreign pid never takes another tree down.
 */
export declare function ownTree(pid: number, procs: PosixProcess[], parent?: number): number[];
/** Executable inside a macOS app bundle: `/Applications/X/X.app` → `…/X.app/Contents/MacOS/` prefix match. */
export declare function isBundleProcess(command: string, appNamePattern: RegExp): boolean;
/** `vm_stat` output → bytes macOS can hand out now: free + inactive + speculative + purgeable pages. */
export declare function parseVmStat(out: string): number | undefined;
/**
 * Free RAM for the "enough memory to start AE / aerender" checks. macOS keeps memory busy as file cache,
 * so os.freemem() there is a fraction of what an app can actually get; read vm_stat instead.
 */
export declare function freeRamBytes(platform?: NodeJS.Platform): number;
export {};
