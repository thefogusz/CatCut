/**
 * aerender wrapper. Renders a comp (or a single frame) through Adobe's aerender.exe
 * WITHOUT ever touching a running After Effects GUI.
 *
 * - Output goes to an ASCII temp name first (AE 25.2–26.x mangles non-ASCII output
 *   file names set from scripts/CLI), then is renamed to the requested path.
 * - Never overwrites: an existing target gets a `_2`, `_3`… suffix.
 * - Every process spawn goes through an injectable `spawn` (default: execa) so tests
 *   can fake aerender while still running real ffmpeg/ffprobe.
 * - Timeout / abort → the whole process tree is killed (taskkill /T /F on Windows, ps + SIGKILL elsewhere).
 * - Refuses to start when the output or AE-cache drive is nearly full; retries once when aerender
 *   crashes before rendering its first frame (never after a timeout or abort).
 */
import { execa } from 'execa';
import type { AeBackend, Frames, Progress, RenderRequest, RenderResult, ToolPaths } from '../core/types.js';
export type SpawnFn = typeof execa;
export interface AerenderRequest extends RenderRequest {
    omTemplate: string;
    rsTemplate: string;
    /**
     * Comp displayStartFrame. startFrame/endFrame are 0-based comp frames; aerender's -s/-e are
     * numbered from the comp's display start, so the offset is added when building args.
     */
    frameOffset?: Frames;
    /** omTemplate is a non-ProRes fallback ('Lossless'): transcode the result to ProRes 422 HQ with ffmpeg. */
    fallback?: boolean;
    timeoutMs?: number;
    /** Warn (default) or refuse (`strictRam`) when free RAM is below this many GB. */
    minFreeRamGb?: number;
    strictRam?: boolean;
    /** Comp size, for the disk-space estimate (default 1920×1080). */
    width?: number;
    height?: number;
    /** Overrides the estimated output size used by the disk-space check. */
    estimatedBytes?: number;
}
export interface AerenderOptions {
    spawn?: SpawnFn;
    /** Max parallel aerender processes (default 1, or EDITMCP_AE_PARALLEL). */
    maxParallel?: number;
    /** Disk-space preflight on the output and AE-cache drives (default on). */
    checkDisk?: boolean;
    /** Minimum free GB on each checked drive (default 5; the requirement is max(this, 2 × estimate)). */
    minFreeGb?: number;
    /** Folder on the AE disk-cache drive (default defaultAeCacheDir()). */
    cacheDir?: string;
    /** Injectable for tests (default fs.promises.statfs). */
    statfs?: StatfsFn;
    /** Retry once when aerender crashes during startup (default true). */
    retryStartupCrash?: boolean;
    /** Pause before that retry (default 3000 ms). */
    retryDelayMs?: number;
}
export type AerenderFailure = 'exit' | 'timeout' | 'abort' | 'output' | 'frames';
/** Structured aerender failure: callers decide on fallbacks from `reason` + aerender's own error lines. */
export declare class AerenderError extends Error {
    readonly reason: AerenderFailure;
    readonly errors: string[];
    readonly startupCrash: boolean;
    /** startupCrash: non-zero exit before any frame was rendered that looks like a crash, not a usage error. */
    constructor(message: string, reason: AerenderFailure, errors: string[], startupCrash?: boolean);
}
/**
 * Exit before the first frame that looks like a crash: a Windows exception exit code, no aerender ERROR
 * line at all (process died silently), or a crash-like message. Plain ERROR lines (comp not found,
 * bad template...) are deterministic and are not retried.
 */
export declare function isStartupCrashOutput(exitCode: number | undefined, errors: string[], log: string[], userStrings?: string[]): boolean;
export interface DiskStat {
    bavail: number | bigint;
    bsize: number | bigint;
}
export type StatfsFn = (path: string) => Promise<DiskStat>;
/** Free bytes on the volume holding `path` (or its nearest existing ancestor). */
export declare function freeDiskBytes(path: string, statfs?: StatfsFn): Promise<number>;
/** Folder on the drive AE's disk cache uses: EDITMCP_AE_CACHE_DIR, else %LOCALAPPDATA% / ~/Library/Caches (AE's default lives under it). */
export declare function defaultAeCacheDir(): string;
/** ProRes 422 HQ ≈ 0.45 byte/pixel/frame; the Lossless fallback writes ~4 bytes/pixel before the transcode. */
export declare function estimateOutputBytes(frames: Frames, width?: number, height?: number, fallback?: boolean): number;
export declare class DiskSpaceError extends Error {
    readonly path: string;
    readonly freeBytes: number;
    readonly needBytes: number;
    constructor(message: string, path: string, freeBytes: number, needBytes: number);
}
export interface PurgePolicy {
    /** default true */
    enabled?: boolean;
    /** purge only when the cache drive has less than this many GB free (default 20) */
    belowGb?: number;
    cacheDir?: string;
    statfs?: StatfsFn;
}
export interface PurgeOutcome {
    purged: boolean;
    reason: string;
    freeGbBefore?: number;
    freeGbAfter?: number;
}
/** Call after a batch of renders: purges AE caches when the disk-cache drive runs low. Never throws. */
export declare function purgeIfLowCacheSpace(backend: Pick<AeBackend, 'purgeCaches'>, policy?: PurgePolicy): Promise<PurgeOutcome>;
/**
 * True only when aerender exited reporting that the requested output-module template does not exist.
 * Matches aerender's ERROR lines (never the echoed command line), with quoted text and the given
 * user strings (comp name, project path, template name) removed first so names cannot trigger it.
 */
export declare function isMissingOmTemplate(error: unknown, userStrings?: string[]): boolean;
/** -mfr percentage for builds: 90 per the design, scaled down when free RAM is low. */
export declare function defaultMfrPercent(freeGb?: number): number;
export declare function isAscii(s: string): boolean;
/** `path` if it does not exist, else `base_2.ext`, `base_3.ext`… — never overwrite. */
export declare function uniqueOutputPath(path: string): string;
/**
 * ASCII temp path for an AE render. Same directory when that directory is ASCII,
 * otherwise the OS temp dir. For image outputs the name carries the `[#####]` sequence token.
 */
export declare function asciiTempPath(outPath: string): {
    tmp: string;
    sequence: boolean;
    prefix: string;
    dir: string;
};
/** rename, falling back to copy+unlink across volumes. Target must not exist. */
export declare function moveFile(from: string, to: string): Promise<void>;
/** Kill a process and all its children. */
export declare function killTree(pid: number | undefined, spawn: SpawnFn, child?: {
    kill?: (s?: 'SIGKILL') => unknown;
}): Promise<void>;
/** Video frame count via ffprobe (packets; for all-intra codecs packets == frames). */
export declare function probeFrameCount(tools: ToolPaths, path: string, spawn?: SpawnFn, signal?: AbortSignal): Promise<Frames>;
/**
 * Full comp render: ProRes 422 HQ with optional PCM audio; segment assembly strips audio later.
 * AE's Lossless output is RGB: convert with the BT.709 matrix into limited range and tag the stream,
 * otherwise swscale defaults to BT.601 and players shift every hue.
 */
export declare function transcodeToProres(tools: ToolPaths, src: string, dst: string, spawn?: SpawnFn, signal?: AbortSignal): Promise<void>;
export interface ProgressParser {
    feed(line: string): Progress | undefined;
    readonly total: number | undefined;
    readonly done: number;
    readonly errors: string[];
}
export declare function createProgressParser(knownTotal?: number): ProgressParser;
/**
 * Render with aerender. Resolves to the final (renamed) path; rejects loudly when the exit code,
 * the output file or the frame count is not what was asked for.
 * startFrame/endFrame (0-based, inclusive) are required: the expected frame count comes from the
 * caller's comp duration, never from aerender's own "Duration" line.
 */
export declare function aerender(tools: ToolPaths, req: AerenderRequest, opts?: AerenderOptions): Promise<RenderResult>;
