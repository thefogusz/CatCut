import type { Project, QcIssue, Version } from '../core/types.js';
/** Version + housekeeping flags (persisted with the version in project.json). */
export type KeptVersion = Version & {
    keep?: boolean;
    purgedAt?: string;
};
export interface StatFsLike {
    bavail: number | bigint;
    bsize: number | bigint;
    blocks: number | bigint;
}
export type StatFsFn = (p: string) => Promise<StatFsLike>;
export interface HousekeepingOptions {
    /** warn when the project folder grows past this (default 50 GB) */
    budgetGb?: number;
    statfs?: StatFsFn;
    env?: Record<string, string | undefined>;
    now?: () => Date;
}
export interface DriveSpace {
    root: string;
    for: string[];
    freeBytes?: number;
    totalBytes?: number;
    error?: string;
}
export interface AeCacheInfo {
    folder?: string;
    source: 'prefs' | 'default' | 'unknown';
    prefsFile?: string;
    aeVersion?: string;
    maxSizeGb?: number;
    dirs: string[];
    bytes?: number;
    partial?: boolean;
}
/** Parse an AE "Prefs*.txt": sections `["Name"]`, entries `"Key" = "value"`, long strings continued with `"\`. */
export declare function parseAePrefs(text: string): Map<string, Map<string, string>>;
export interface AeScriptingPref {
    /** undefined: no prefs file yet (AE never started on this account) or the key is missing */
    allowed?: boolean;
    prefsFile?: string;
    aeVersion?: string;
}
/** "Allow Scripts to Write Files and Access Network" from the newest AE main prefs, read without starting AE. */
export declare function aeScriptingPref(env?: Record<string, string | undefined>): Promise<AeScriptingPref>;
/** AE disk cache folder from the newest AE prefs; default %LOCALAPPDATA%\Temp (~/Library/Caches on macOS); else unknown. */
export declare function findAeDiskCache(env?: Record<string, string | undefined>): Promise<Omit<AeCacheInfo, 'bytes' | 'partial' | 'dirs'>>;
export interface DiskReport {
    drives: DriveSpace[];
    aeCache: AeCacheInfo;
    project: {
        dir: string;
        cache: {
            segments: number;
            renders: number;
            audio: number;
            tmp: number;
            other: number;
            total: number;
        };
        out: {
            byVersion: Record<string, number>;
            orphans: Record<string, number>;
            total: number;
        };
        review: number;
        /** everything else in the project folder by top-level name (agent scripts, evidence frames, AE files ...) */
        other: Record<string, number>;
        total: number;
    };
    keptVersions: string[];
    warnings: string[];
}
/** AE disk cache folder and its size, without starting AE (the reshoot job grew it ~20 GB in 3 h). */
export declare function aeDiskCache(env?: Record<string, string | undefined>): Promise<AeCacheInfo>;
export declare function diskReport(p: Project, opts?: HousekeepingOptions): Promise<DiskReport>;
/**
 * Free-space gate for a build: error when the project drive would have < 5 GB left after writing
 * `estimatedBytes`, warn below 20 GB. `extraPaths` (e.g. the AE disk cache folder) are checked the same way
 * without the estimate.
 */
export declare function preflight(p: Project, estimatedBytes: number, opts?: {
    statfs?: StatFsFn;
    extraPaths?: string[];
}): Promise<QcIssue[]>;
export declare function setVersionKeep(p: Project, versionId: string, keep: boolean): KeptVersion;
export type GcReason = 'old-version' | 'orphan-version-folder' | 'unused-segment' | 'orphan-segment' | 'superseded-render' | 'stale-temp';
export interface GcItem {
    path: string;
    rel: string;
    bytes: number;
    mtimeMs: number;
    reason: GcReason;
    version?: string;
}
export interface GcPlan {
    schema: 1;
    planId: string;
    projectDir: string;
    createdAt: string;
    keepLatest: number;
    retainedVersions: string[];
    items: GcItem[];
    totalBytes: number;
    /** cache entries kept because their use cannot be proven either way (dissolves without clip ids) */
    keptUnknown: number;
    hash: string;
}
export interface GcPlanOptions extends HousekeepingOptions {
    keepLatest?: number;
    /** exact segment cache keys still used (e.g. from planTimeline of the retained versions); overrides the clip-id heuristic */
    referencedSegmentKeys?: ReadonlySet<string>;
}
/**
 * What could be deleted: versions older than the latest `keepLatest` (and not `keep`), out/ folders with no
 * version, segment cache files for clips none of the retained versions (or the current timeline) use, comp
 * renders no asset points to, and stale temp files. Writes the plan (with its hash) to cache/gc/; deletes nothing.
 */
export declare function gcPlan(p: Project, opts?: GcPlanOptions): Promise<GcPlan>;
export interface GcApplyResult {
    planId: string;
    deleted: Array<{
        path: string;
        bytes: number;
    }>;
    skipped: Array<{
        path: string;
        reason: string;
    }>;
    freedBytes: number;
    purgedVersions: string[];
    log: string;
}
/**
 * Delete what a recent plan listed. Refuses without the confirm token ('ลบ' | 'delete'), for a plan older than
 * 10 minutes or tampered with, and per file for anything outside <project>/cache or <project>/out, links, or files
 * changed since the plan. Marks versions whose master is gone with `purgedAt` (caller saves the project).
 */
export declare function gcApply(p: Project, planId: string, confirm: string, opts?: HousekeepingOptions): Promise<GcApplyResult>;
