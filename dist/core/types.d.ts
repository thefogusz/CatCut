/**
 * The shared contract. Every module codes against these types.
 * All times are integer FRAMES at `ProjectMeta.fps` unless a name ends in `Ms`, `Sec` or `Tc`.
 */
export type Frames = number;
export interface ProjectMeta {
    name: string;
    fps: number;
    width: number;
    height: number;
    createdAt: string;
    schema: 1;
}
export type AssetKind = 'camera' | 'graphic' | 'still' | 'audio' | 'aecomp';
export interface ProbeInfo {
    durationFrames: Frames;
    width?: number;
    height?: number;
    fps?: number;
    videoCodec?: string;
    pixFmt?: string;
    audioCodec?: string;
    sampleRate?: number;
    channels?: number;
    hasVideo: boolean;
    hasAudio: boolean;
    allIntra?: boolean;
}
export interface FileAsset {
    id: string;
    kind: Exclude<AssetKind, 'aecomp'>;
    path: string;
    hash?: string;
    probe?: ProbeInfo;
}
export interface AeRenderRecord {
    path: string;
    frames: Frames;
    fingerprint: string;
    renderedAt: string;
}
export interface AeCompAsset {
    id: string;
    kind: 'aecomp';
    aep: string;
    comp: string;
    fingerprint?: string;
    render?: AeRenderRecord;
    probe?: ProbeInfo;
}
export type Asset = FileAsset | AeCompAsset;
export interface Clip {
    id: string;
    src: string;
    in: Frames;
    dur: Frames;
    scale?: number;
    marker?: string;
    slot?: string;
    speed?: ClipSpeed;
    pushIn?: number;
}
/** Retime. Source frames consumed = round(dur * rate) for constant speed; ramps ease between rates. */
export interface ClipSpeed {
    rate: number;
    /** optional ramp: start at `from` rate and ease to `rate` over `rampFrames` timeline frames at the clip start */
    rampFrom?: number;
    rampFrames?: Frames;
    interpolation?: 'nearest' | 'blend' | 'motion';
}
export interface BoardSlot {
    id: string;
    order: number;
    chapter?: string;
    boardStartFrame?: Frames;
    boardDurFrames?: Frames;
    sourceHint?: string;
    sourceTc?: string;
    onScreenText?: string;
    notes?: string;
    thumb?: string;
    status?: 'ok' | 'mockup' | 'substitute' | 'missing';
}
export interface Board {
    source: string;
    importedAt: string;
    targetFrames?: Frames;
    chapters?: Array<{
        name: string;
        startFrame?: Frames;
        durFrames?: Frames;
    }>;
    slots: BoardSlot[];
    warnings?: string[];
}
/** Things the user said once that must hold on every build (checked by lint, shown to agents). */
export interface Constraint {
    id: string;
    text: string;
    scope?: string;
    check?: 'board-only' | 'no-cover-photo' | 'logo-static' | 'no-repeat-gimmick' | 'manual';
    createdAt: string;
}
export interface StyleRules {
    cornerRadiusPct?: number;
    safeMarginPct?: number;
    palette?: string[];
    joins?: Array<{
        from: string;
        to: string;
        dissolve: Frames;
    }>;
    thai?: {
        minCapHeightPct?: number;
        minWeight?: number;
        lowerVowelClearancePx?: number;
        animateBy?: 'line' | 'word' | 'char';
    };
    maxStaticSec?: number;
}
export interface Cut {
    after: string;
    dissolve: Frames;
}
export interface AudioClip {
    id: string;
    src: string;
    at: Frames;
    in?: Frames;
    dur?: Frames;
    gainDb?: number;
    fadeIn?: Frames;
    fadeOut?: Frames;
}
export interface DuckSettings {
    underDb: number;
    attackMs: number;
    releaseMs: number;
}
export interface AudioTracks {
    vo: AudioClip[];
    music: AudioClip[];
    sfx: AudioClip[];
    duck?: DuckSettings;
    useClipAudio?: boolean;
}
export interface Timeline {
    video: Clip[];
    cuts: Cut[];
    audio: AudioTracks;
}
export type DeliveryTargetId = 'yt' | 'fb' | 'vert' | 'th_tv' | 'th_prores' | 'led' | 'm422hq' | (string & {});
export interface DeliverySettings {
    targets: DeliveryTargetId[];
    overrides?: Partial<Record<DeliveryTargetId, Partial<DeliveryPreset>>>;
    note?: string;
}
export interface QcIssue {
    kind: 'black' | 'freeze' | 'silence' | 'loudness' | 'truepeak' | 'frames' | 'spec' | 'gap' | 'flash' | 'cutcross' | 'repeat' | 'duplicate' | 'lowmotion' | 'slowmo' | 'board' | 'style' | 'thai' | 'comp' | 'disk';
    severity: 'error' | 'warn';
    startFrame?: Frames;
    endFrame?: Frames;
    clipId?: string;
    message: string;
}
export interface QcReport {
    ok: boolean;
    frames: Frames;
    expectedFrames: Frames;
    integratedLufs?: number;
    truePeakDb?: number;
    lra?: number;
    issues: QcIssue[];
    contactSheet?: string;
}
export interface Version {
    id: string;
    createdAt: string;
    planHash: string;
    master: string;
    reviewProxy?: string;
    reviewPlan?: ReviewPlan;
    deliverables: Record<string, string>;
    qc?: QcReport;
    stats: BuildStats;
    clipSnapshots?: Record<string, {
        clip: Clip;
        render?: AeRenderRecord;
        fingerprint?: string;
    }>;
}
export interface ReviewShot {
    id: string;
    src: string;
    start: Frames;
    in: Frames;
    dur: Frames;
    marker?: string;
    comp?: string;
}
export interface ReviewPlan {
    fps: number;
    width: number;
    height: number;
    frames: Frames;
    shots: ReviewShot[];
    cuts?: Cut[];
}
/** Text burned into deliverables over the picture, e.g. a hook in the first seconds. */
export interface TextOverlay {
    id: string;
    text: string;
    at: Frames;
    dur: Frames;
    style?: 'hook' | 'title' | 'lower';
}
/**
 * Auto captions from speech (whisper.cpp) and text overlays. Burned into deliverables only; the ProRes
 * master stays clean. Word timings come from cached transcripts of the sources (cache/transcripts/).
 */
export interface CaptionSettings {
    enabled: boolean;
    source?: 'auto' | 'clips' | 'vo';
    lang?: string;
    style?: 'pop' | 'clean';
    position?: 'bottom' | 'middle' | 'top';
    font?: string;
    fontScale?: number;
    color?: string;
    highlight?: string;
    uppercase?: boolean;
    maxWords?: number;
    maxChars?: number;
    fixes?: Array<{
        from: string;
        to: string;
    }>;
    targets?: DeliveryTargetId[];
    texts?: TextOverlay[];
}
export interface Project {
    meta: ProjectMeta;
    dir: string;
    assets: Record<string, Asset>;
    timeline: Timeline;
    delivery: DeliverySettings;
    versions: Version[];
    board?: Board;
    constraints?: Constraint[];
    styleRules?: StyleRules;
    captions?: CaptionSettings;
}
export interface DeliveryPreset {
    id: DeliveryTargetId;
    label: string;
    container: 'mp4' | 'mov' | 'mxf';
    video: {
        codec: 'h264' | 'hevc' | 'prores_422hq' | 'prores_4444' | 'xdcam_hd422' | 'dnxhr_hqx';
        width: number;
        height: number;
        fps?: number;
        interlaced?: boolean;
        bitrateMbps?: number;
        cbr?: boolean;
        useGpu?: boolean;
    };
    audio: {
        codec: 'aac' | 'pcm_s24le' | 'pcm_s16le';
        bitrateKbps?: number;
        sampleRate: 48000;
        channels: 2;
    };
    loudness?: {
        integratedLufs: number;
        truePeakDb: number;
        lra?: number;
    };
    textless?: boolean;
}
export interface BuildStats {
    segmentsTotal: number;
    segmentsRendered: number;
    segmentsReused: number;
    dissolvesRendered: number;
    compsRendered: number;
    compsReused: number;
    timingsMs: Record<string, number>;
}
export interface Progress {
    stage: string;
    done: number;
    total: number;
    message?: string;
}
export interface BuildOptions {
    force?: boolean;
    skipQc?: boolean;
    skipDeliver?: boolean;
    onProgress?: (p: Progress) => void;
    signal?: AbortSignal;
}
export interface BuildResult {
    version: Version;
    stats: BuildStats;
}
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface JobInfo {
    id: string;
    name: string;
    status: JobStatus;
    progress?: Progress;
    startedAt?: string;
    endedAt?: string;
    log: string[];
    error?: string;
    result?: unknown;
}
export interface ToolPaths {
    ffmpeg: string;
    ffprobe: string;
    afterfx?: string;
    aerender?: string;
    aeVersionDir?: string;
    premiereExe?: string;
    mediaEncoderExe?: string;
    filmcraftCli?: string;
    effectcraftCli?: string;
}
export interface Encoders {
    h264_nvenc: boolean;
    h264_qsv: boolean;
    hevc_nvenc: boolean;
    libx264: boolean;
    prores_ks: boolean;
    dnxhd: boolean;
    mpeg2video: boolean;
}
export interface Environment {
    tools: ToolPaths;
    encoders: Encoders;
    ffmpegVersion?: string;
    aeVersion?: string;
    totalRamGb: number;
    freeRamGb: number;
    cpuThreads: number;
}
export interface CompInfo {
    id: number;
    name: string;
    width: number;
    height: number;
    fps: number;
    durationFrames: Frames;
    numLayers: number;
}
export interface LayerInfo {
    index: number;
    name: string;
    kind: 'text' | 'footage' | 'solid' | 'shape' | 'precomp' | 'null' | 'camera' | 'light' | 'adjustment' | 'other';
    inFrame: Frames;
    outFrame: Frames;
    enabled: boolean;
    text?: string;
    source?: string;
    effects: string[];
    bounds?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}
export interface CompDetail extends CompInfo {
    layers: LayerInfo[];
    fingerprint: string;
}
export type AeOp = {
    op: 'setText';
    layer: string | number;
    text: string;
    fontSize?: number;
    font?: string;
    color?: [number, number, number];
} | {
    op: 'replaceFootage';
    layer: string | number;
    path: string;
} | {
    op: 'shiftLayer';
    layer: string | number;
    frames: Frames;
} | {
    op: 'setProperty';
    layer: string | number;
    property: string;
    value: unknown;
    atFrame?: Frames;
} | {
    op: 'addEffect';
    layer: string | number;
    matchName: string;
    properties?: Record<string, unknown>;
} | {
    op: 'applyPreset';
    layer: string | number;
    ffxPath: string;
} | {
    op: 'setLayerEnabled';
    layer: string | number;
    enabled: boolean;
} | {
    op: 'duplicateComp';
    newName: string;
} | {
    op: 'script';
    jsx: string;
};
export interface AeEditRequest {
    aep: string;
    comp: string;
    ops: AeOp[];
    saveAs?: string;
}
export interface AeEditResult {
    ok: boolean;
    savedTo: string;
    fingerprint: string;
    log: string[];
}
export interface AeCreateRequest {
    jsx: string;
    saveAs: string;
    scriptDir?: string;
}
export interface AeCreateResult {
    savedTo: string;
    comps: CompInfo[];
    log: string[];
}
export interface RenderRequest {
    aep: string;
    comp: string;
    outPath: string;
    startFrame?: Frames;
    endFrame?: Frames;
    outputModule?: string;
    renderSettings?: string;
    mfrPercent?: number;
    signal?: AbortSignal;
    onProgress?: (p: Progress) => void;
}
export interface RenderResult {
    path: string;
    frames: Frames;
    elapsedMs: number;
    usedFallback: boolean;
    log: string;
}
export interface AeBackend {
    readonly kind: 'extendscript-headless' | 'effectcraft' | 'mock';
    listComps(aep: string): Promise<CompInfo[]>;
    inspectComp(aep: string, comp: string, atFrame?: Frames): Promise<CompDetail>;
    fingerprint(aep: string, comps?: string[]): Promise<Record<string, string>>;
    edit(req: AeEditRequest): Promise<AeEditResult>;
    create?(req: AeCreateRequest): Promise<AeCreateResult>;
    render(req: RenderRequest): Promise<RenderResult>;
    previewFrame(aep: string, comp: string, frame: Frames, outPng: string): Promise<string>;
    version(): Promise<string>;
    scanTemplate?(aep: string): Promise<TemplateScan>;
    lintComp?(aep: string, comp: string): Promise<CompLint>;
    listFonts?(aep: string): Promise<string[]>;
    purgeCaches?(): Promise<void>;
}
export interface TemplateComp {
    name: string;
    durationFrames: Frames;
    width: number;
    height: number;
    placeholders: Array<{
        layer: string;
        kind: 'footage' | 'image' | 'text' | 'precomp';
        source?: string;
        moving: boolean;
    }>;
    expressionLocked: string[];
    fonts: string[];
    textAnimators: Array<{
        layer: string;
        basedOn: 'characters' | 'words' | 'lines' | 'other';
    }>;
}
export interface TemplateScan {
    aep: string;
    comps: TemplateComp[];
    warnings: string[];
}
export interface CompLint {
    comp: string;
    issues: Array<{
        kind: 'animation-ends-early' | 'layer-ends-early' | 'background-ends-early' | 'thai-animator' | 'thai-size' | 'style';
        layer?: string;
        frame?: Frames;
        message: string;
    }>;
}
export interface XmemlWriteOptions {
    sequenceName: string;
    /** asset id -> file path to reference (full comp render or original camera file) */
    resolvePath?: (asset: Asset) => string | undefined;
    /**
     * 'premiere' (default): edges touching a transition are -1 and in/out include the dissolve halves.
     * 'filmcraft': every clip edge is explicit at its cut and in/out cover the body only (FilmCraft
     * misreads the -1 form: it drops or re-tracks clips next to dissolves).
     */
    flavor?: 'premiere' | 'filmcraft';
}
export interface XmemlReadResult {
    fps: number;
    width: number;
    height: number;
    timeline: Timeline;
    /** pathurl (decoded, absolute) -> asset id guess, resolved by caller */
    unresolvedPaths: string[];
}
/**
 * Something only the person at the computer can do (sign in, tick a preference, close a dialog).
 * Every tool that needs one returns this card so the agent relays the same steps every time
 * instead of improvising (DESIGN.md §14).
 */
export interface UserAction {
    /** stable id, e.g. 'ae-allow-scripts' */
    code: string;
    app: 'after-effects' | 'premiere' | 'ffmpeg' | 'disk' | 'catcut';
    title: string;
    steps: string[];
    why: string;
    /** once = never again on this computer; after-update = once per app/CatCut update; each-time = whenever it happens */
    frequency: 'once' | 'after-update' | 'each-time';
    /** must the app stay open after the steps */
    keepOpen: boolean;
    /** when the app may be closed */
    closeAfter: string;
    /** must the person open or create a project in that app (almost always false) */
    needsProject: boolean;
}
