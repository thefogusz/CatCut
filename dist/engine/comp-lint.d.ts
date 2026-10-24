import type { AeBackend, CompLint, Project, QcIssue, StyleRules } from '../core/types.js';
export interface CompLintTarget {
    aep: string;
    comp: string;
}
export interface CompLintOptions {
    /** Default: the project's styleRules. */
    rules?: StyleRules;
    /** Kinds (lint kind or QcIssue kind) reported as 'error' in addition to project.styleRules.severity. */
    errorKinds?: string[];
    onProgress?: (p: {
        stage: string;
        done: number;
        total: number;
        message?: string;
    }) => void;
    signal?: AbortSignal;
}
export interface CompLintReport {
    issues: QcIssue[];
    comps: Array<CompLint & {
        aep: string;
    }>;
    failed: Array<{
        aep: string;
        comp: string;
        error: string;
    }>;
    notes: string[];
}
/** aecomp assets to lint: the given ids, else every aecomp the timeline uses (deduped by aep+comp). */
export declare function compTargets(p: Project, assetIds?: string[]): CompLintTarget[];
/** Map one comp's lint result onto the clips that use the comp (timeline frames), applying project rules. */
export declare function compLintToQcIssues(lint: CompLint, aep: string, project?: Project, opts?: Pick<CompLintOptions, 'rules' | 'errorKinds'>): QcIssue[];
/** Lint each target with the backend and map the results to QcIssues. Failures per comp are collected, not thrown. */
export declare function lintComps(backend: AeBackend, targets: CompLintTarget[], project?: Project, opts?: CompLintOptions): Promise<CompLintReport>;
export interface InstalledFonts {
    /** registry display names ("Kanit Bold (TrueType)") and font file stems */
    names: string[];
    sources: string[];
}
export interface FontSources {
    /** stdout of `reg query <key>` (default: reg.exe; '' off Windows) */
    regQuery?: (key: string) => Promise<string>;
    /** file names in a directory ([] when missing) */
    readDir?: (dir: string) => Promise<string[]>;
    env?: Record<string, string | undefined>;
    /** which OS's font folders to scan (default: this one) */
    platform?: NodeJS.Platform;
}
/** `reg query` value lines: "    Arial Bold (TrueType)    REG_SZ    arialbd.ttf". */
export declare function parseRegFonts(out: string): Array<{
    name: string;
    file: string;
}>;
/** Fonts the OS (and AE's own Adobe Fonts folder) can see: HKLM/HKCU registry + font folders on Windows, font folders on macOS. */
export declare function listInstalledFonts(src?: FontSources): Promise<InstalledFonts>;
/** Lowercase letters+digits only, without "(TrueType)"-style tags. */
export declare function normalizeFontName(s: string): string;
export interface FontAudit {
    used: string[];
    /** not found under any installed name or file */
    missing: string[];
    /** family installed, this exact style not found (AE may substitute) */
    familyOnly: Array<{
        font: string;
        family: string;
    }>;
    /** AE's own missing/substituted list (AE 24+), null when unavailable */
    aeReportedMissing: string[] | null;
    installedCount: number;
    sources: string[];
    note: string;
}
/** Loose match of used font names (PostScript or family) against installed names. */
export declare function auditFonts(used: {
    fonts: string[];
    families?: string[];
    aeMissing?: string[] | null;
}, installed: InstalledFonts): FontAudit;
