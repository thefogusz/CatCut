import type { AeBackend, AeCompAsset, Asset, BuildOptions, BuildResult, Clip, DeliveryTargetId, Environment, Frames, ProbeInfo, Progress, Project, QcReport, ToolPaths } from '../core/types.js';
/** Mirrors `runQc` from qc.ts; injected so this module does not import it. */
export interface QcArgs {
    tools: ToolPaths;
    path: string;
    expectedFrames: Frames;
    fps: number;
    loudness?: {
        integratedLufs: number;
        truePeakDb: number;
        toleranceLu?: number;
    };
    contactSheetPath?: string;
    clipStarts?: Array<{
        clipId: string;
        start: Frames;
        dur: Frames;
    }>;
    signal?: AbortSignal;
}
export type QcRunner = (args: QcArgs) => Promise<QcReport>;
export interface AssemblerDeps {
    tools: ToolPaths;
    env: Environment;
    ae: AeBackend;
    qc?: QcRunner;
    /** parallel segment encodes; default 2 when >= 3 GB RAM is free, else 1 */
    concurrency?: number;
}
export interface LoudnessMeasure {
    inputI: number;
    inputTp: number;
    inputLra: number;
    inputThresh: number;
    targetOffset: number;
}
/**
 * shot_revert pin on an aecomp asset: its `render` is an older render restored from a version. Builds
 * keep it while the comp's live fingerprint is still `compFingerprint` (the comp state the revert
 * replaced) or the render's own; the first edit of the comp after that drops the pin and renders again.
 */
export interface RevertPin {
    compFingerprint?: string;
    version: string;
    clipId: string;
    at: string;
}
export type PinnableComp = AeCompAsset & {
    revertPin?: RevertPin;
};
export interface PreviewRangeOptions {
    from: Frames;
    to: Frames;
    /** trim this version's master instead of assembling the current timeline */
    version?: string;
    /** picture scale of the preview (default 0.5) */
    scale?: number;
    onProgress?: (p: Progress) => void;
    signal?: AbortSignal;
}
export interface PreviewRangeResult {
    path: string;
    from: Frames;
    to: Frames;
    frames: Frames;
    source: 'timeline' | 'version';
    version?: string;
    segmentsRendered: number;
    segmentsReused: number;
    dissolvesRendered: number;
    warnings: string[];
    elapsedMs: number;
}
interface Source {
    assetId: string;
    kind: Asset['kind'];
    path: string;
    probe: ProbeInfo;
    identity: string;
    timing: SourceTiming;
}
/** Stream origins. `*Sec` are absolute container timestamps (what `-copyts` keeps). */
interface SourceTiming {
    fmtStartSec: number;
    videoStartSec: number;
    videoStartExpr: string;
    audioStartSec: number;
    cfr: boolean;
    tbSec?: number;
}
interface SegmentPlan {
    clip: Clip;
    index: number;
    src: Source;
    key: string;
    srcIn: Frames;
    k0: Frames;
    frames: Frames;
    trimStart: Frames;
    trimEnd: Frames;
}
interface DissolvePlan {
    a: SegmentPlan;
    b: SegmentPlan;
    n: Frames;
    half: {
        a: Frames;
        b: Frames;
    };
    key: string;
    aK0: Frames;
    bK0: Frames;
}
type ConcatItem = {
    kind: 'segment';
    plan: SegmentPlan;
} | {
    kind: 'dissolve';
    plan: DissolvePlan;
};
/** mov timescale: 25 -> 25000, 29.97 -> 30000 (frame duration 1001). */
export declare function movTimescale(fps: number): number;
/**
 * ffprobe -> ProbeInfo. Duration uses project frames (`opts.fps`, default 25);
 * `fps` remains the source frame rate. Stills return 1 and are looped by the assembler.
 */
export declare function probe(tools: ToolPaths, file: string, opts?: {
    fps?: number;
    signal?: AbortSignal;
}): Promise<ProbeInfo>;
/** Number of video packets (== frames for every container/codec we write). Fast: no decode. */
export declare function countVideoPackets(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number>;
/** loudnorm first pass. Returns undefined for digital silence. */
export declare function measureLoudnorm(tools: ToolPaths, file: string, target: {
    integratedLufs: number;
    truePeakDb: number;
    lra: number;
}, signal?: AbortSignal): Promise<LoudnessMeasure | undefined>;
export declare class Assembler {
    private readonly tools;
    private readonly env;
    private readonly ae;
    private readonly qc?;
    private readonly concurrency;
    private readonly encoderId;
    private readonly loudnessCache;
    constructor(deps: AssemblerDeps);
    private encode;
    build(p: Project, opts?: BuildOptions): Promise<BuildResult>;
    private ensureCompRenders;
    private resolveSources;
    /**
     * A cache file is trusted when its size + mtime match what the manifest recorded when its frame
     * count was last verified; otherwise the packets are re-counted (no decode) and the record refreshed.
     */
    private cacheHit;
    private recordCache;
    private renderSegment;
    /** Stream copy is frame-accurate only on all-intra ProRes 422 HQ at project size/fps (integer fps). */
    private canStreamCopy;
    /** ffmpeg args for a ProRes 422 HQ video-only piece of `frames` frames from clip-local timeline frame `k0`. */
    private encodeArgs;
    private renderDissolve;
    private renderAudio;
    /** Speech level estimate (dBFS) of one graph label: overall RMS, floored at RMS peak - 6 dB. */
    private measureRms;
    deliver(p: Project, versionId: string, targets: DeliveryTargetId[], opts?: {
        onProgress?: (p: Progress) => void;
        signal?: AbortSignal;
    }): Promise<Record<string, string>>;
    reviewProxy(p: Project, versionId: string, opts?: {
        signal?: AbortSignal;
    }): Promise<string>;
    /**
     * Low-res H.264 preview of timeline frames [from, to) for quick A/B/C tryouts, written to
     * review/previews/ (never overwriting). From the current timeline only the segments and dissolves
     * that touch the range are encoded, into the normal segment cache (a later build reuses them), and
     * only the comps they use are rendered; audio is the whole mix (not loudness-normalised), trimmed.
     * With `version`, that version's master is trimmed instead.
     */
    previewRange(p: Project, opts: PreviewRangeOptions): Promise<PreviewRangeResult>;
}
/** Segment / dissolve plans + concat order. Exported for tests; pure. */
export declare function planTimeline(p: Project, sources: Map<string, Source>, encoderId?: string): {
    segments: SegmentPlan[];
    dissolves: DissolvePlan[];
    order: ConcatItem[];
};
/** Whether this ffmpeg build has a filter (e.g. `subtitles` needs libass). */
export declare function hasFilter(ffmpeg: string, name: string): Promise<boolean>;
export {};
