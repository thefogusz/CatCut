import type { AeBackend, AeEditRequest, AeEditResult, CompDetail, CompInfo, CompLint, Frames, LayerInfo, RenderRequest, RenderResult, StyleRules, TemplateComp, TemplateScan, ToolPaths } from '../core/types.js';
import { type AeScriptingPref } from './housekeeping.js';
import { type PurgeOutcome, type PurgePolicy, type SpawnFn, type StatfsFn } from './aerender.js';
export interface AeProcess {
    name: string;
    pid: number;
    title: string;
}
/** Fonts used by text layers (`fonts` = PostScript names) plus what AE itself reports missing (AE 24+, else null). */
export interface FontUsage {
    fonts: string[];
    families: string[];
    aeMissing: string[] | null;
}
interface AeOptions {
    /** Disk preflight / startup-crash retry settings passed to every aerender call. */
    statfs?: StatfsFn;
    cacheDir?: string;
    minFreeDiskGb?: number;
    retryDelayMs?: number;
    /** Policy for afterRenderBatch() (default: purge when the cache drive has < 20 GB free). */
    purge?: PurgePolicy;
    spawn?: SpawnFn;
    /** Per-call AfterFX timeout for list/version (default 2 min). */
    timeoutMs?: number;
    /** Timeout for jobs that snapshot whole comps: fingerprint, inspect, edit (default 10 min; big projects are slow). */
    fingerprintTimeoutMs?: number;
    minFreeRamGb?: number;
    /** macOS: how long to wait for AE to quit after a job before killing it (default 60 s). */
    macQuitWaitMs?: number;
    /** Running After Effects processes (injectable for tests; default: tasklist on Windows, ps on macOS). */
    listProcesses?: () => Promise<AeProcess[]>;
    /** AE's "Allow Scripts to Write Files" pref (injectable for tests; default: read from AE prefs). */
    scriptingPref?: () => Promise<AeScriptingPref>;
}
export interface FingerprintDetail {
    hash: string;
    /** The comp contains values scripting cannot read (Curves/Levels custom data, per-character text styles). */
    opaque: boolean;
}
export interface AeEditOutcome extends AeEditResult {
    /** An After Effects GUI was running during an in-place edit; its next save may revert this edit. */
    aeGuiRunning: boolean;
    warning?: string;
}
export interface HeadlessAeBackend extends AeBackend {
    edit(req: AeEditRequest): Promise<AeEditOutcome>;
    /** Like fingerprint, plus which comps contain values that cannot be fingerprinted. */
    fingerprintDetailed(aep: string, comps?: string[]): Promise<Record<string, FingerprintDetail>>;
    scanTemplate(aep: string): Promise<TemplateScan>;
    /** `rules` (project StyleRules) enables the threshold checks: thai-size, safe margin, corner radius. */
    lintComp(aep: string, comp: string, rules?: StyleRules): Promise<CompLint>;
    listFonts(aep: string): Promise<string[]>;
    listFontsDetailed(aep: string): Promise<FontUsage>;
    purgeCaches(): Promise<void>;
    /** Call after a batch of renders: purges AE caches when the disk-cache drive is low (see AeOptions.purge). */
    afterRenderBatch(policy?: PurgePolicy): Promise<PurgeOutcome>;
}
/**
 * AfterFX.exe processes via `tasklist /V` (window title separates a GUI from -noui instances). On macOS
 * every After Effects process is a GUI (there is no -noui), so each gets its app name as title.
 */
export declare function listAfterFxProcesses(spawn?: SpawnFn): Promise<AeProcess[]>;
/** AppleScript that runs a JSX file in After Effects and waits for it (AE's own DoScriptFile command). */
export declare function doScriptFile(app: string, jsx: string, timeoutMs: number): string;
export declare function createAeBackend(tools: ToolPaths, opts?: AeOptions): HeadlessAeBackend;
/** A layer as the mock sees it: just the facts the runner's analysis commands read from AE. */
export interface MockLayer {
    name: string;
    kind: LayerInfo['kind'];
    inFrame?: Frames;
    outFrame?: Frames;
    enabled?: boolean;
    text?: string;
    font?: string;
    fontFamily?: string;
    fontSize?: number;
    scalePct?: number;
    source?: string;
    still?: boolean;
    matted?: boolean;
    isMatte?: boolean;
    transformAnimated?: boolean;
    lastKeyFrame?: Frames;
    continuous?: boolean;
    animators?: Array<{
        name?: string;
        basedOn: TemplateComp['textAnimators'][number]['basedOn'];
    }>;
    expressions?: string[];
    controls?: string[];
    bounds?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    cornerRadiusPct?: number;
}
export interface MockComp {
    name: string;
    width?: number;
    height?: number;
    fps?: number;
    durationFrames: Frames;
    layers: MockLayer[];
}
/** Same rules as runner.jsx `lint()`, over a MockComp. */
export declare function lintMockComp(c: MockComp, rules?: StyleRules): CompLint;
/** Same rules as runner.jsx `scanComp()`, over a MockComp. */
export declare function scanMockComp(c: MockComp, warnings?: string[]): TemplateComp;
/**
 * In-memory AeBackend. Every .aep path sees the same comps. previewFrame/render write small placeholder
 * files (never overwriting); calls are recorded in `calls`.
 */
export declare class MockAeBackend implements AeBackend {
    readonly kind: "mock";
    readonly calls: string[];
    purged: number;
    comps: MockComp[];
    aeMissingFonts: string[] | null;
    constructor(opts?: {
        comps?: MockComp[];
        aeMissingFonts?: string[] | null;
        version?: string;
    });
    private readonly ver;
    private comp;
    private info;
    listComps(): Promise<CompInfo[]>;
    inspectComp(_aep: string, comp: string): Promise<CompDetail>;
    fingerprint(_aep: string, comps?: string[]): Promise<Record<string, string>>;
    edit(req: AeEditRequest): Promise<AeEditResult>;
    render(req: RenderRequest): Promise<RenderResult>;
    previewFrame(_aep: string, comp: string, frame: Frames, outPng: string): Promise<string>;
    version(): Promise<string>;
    scanTemplate(aep: string): Promise<TemplateScan>;
    lintComp(_aep: string, comp: string, rules?: StyleRules): Promise<CompLint>;
    listFontsDetailed(): Promise<FontUsage>;
    listFonts(): Promise<string[]>;
    purgeCaches(): Promise<void>;
}
export {};
