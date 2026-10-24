/**
 * The shared contract. Every module codes against these types.
 * All times are integer FRAMES at `ProjectMeta.fps` unless a name ends in `Ms`, `Sec` or `Tc`.
 */

export type Frames = number;

// ---------- project ----------

export interface ProjectMeta {
  name: string;
  fps: number; // 25 by default; 29.97 etc. allowed but drop-frame timecode is not handled yet
  width: number;
  height: number;
  createdAt: string; // ISO
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
  allIntra?: boolean; // ProRes / DNxHR / MJPEG / PNG seq: frame-accurate stream-copy trims are safe
}

export interface FileAsset {
  id: string;
  kind: Exclude<AssetKind, 'aecomp'>;
  path: string; // absolute; may contain Thai characters
  hash?: string; // content hash (size+mtime+head bytes), set by project.scanAssets
  probe?: ProbeInfo;
}

export interface AeRenderRecord {
  path: string; // ProRes MOV, full comp, ASCII filename inside the project cache
  frames: Frames;
  fingerprint: string; // comp fingerprint this render was made from
  renderedAt: string;
}

export interface AeCompAsset {
  id: string;
  kind: 'aecomp';
  aep: string; // absolute path to the project the comp lives in: .aep (After Effects) or .ecproj (EffectCraft)
  comp: string; // comp name
  fingerprint?: string; // last known comp fingerprint
  render?: AeRenderRecord; // last good render (undefined = needs render)
  probe?: ProbeInfo; // probe of `render.path`
}

export type Asset = FileAsset | AeCompAsset;

export interface Clip {
  id: string;
  src: string; // asset id
  in: Frames; // source in-point
  dur: Frames; // timeline duration
  scale?: number; // percent, default 100 (uniform, centered)
  marker?: string; // marker name placed at clip start
  slot?: string; // board slot id this clip realises (see Board)
  speed?: ClipSpeed; // retime; absent = 100% realtime
  pushIn?: number; // percent of slow zoom over the clip (e.g. 8 = 100%→108%), for near-static footage
}

/** Retime. Source frames consumed = round(dur * rate) for constant speed; ramps ease between rates. */
export interface ClipSpeed {
  rate: number; // 0.5 = 50% slow motion, 2 = 200%
  /** optional ramp: start at `from` rate and ease to `rate` over `rampFrames` timeline frames at the clip start */
  rampFrom?: number;
  rampFrames?: Frames;
  interpolation?: 'nearest' | 'blend' | 'motion'; // motion = optical-flow style (minterpolate); default blend for rate<1
}

// ---------- board (storyboard / brief) ----------

export interface BoardSlot {
  id: string; // "01", "28r" ...
  order: number;
  chapter?: string;
  boardStartFrame?: Frames; // where the board places this slot on the timeline
  boardDurFrames?: Frames;
  sourceHint?: string; // file / folder named on the board
  sourceTc?: string; // source timecode written on the board (e.g. "0.03")
  onScreenText?: string; // exact text the board shows
  notes?: string;
  thumb?: string; // path to the board thumbnail image for this slot
  status?: 'ok' | 'mockup' | 'substitute' | 'missing';
}

export interface Board {
  source: string; // path of the board file (PDF/CSV/JSON) it came from
  importedAt: string;
  targetFrames?: Frames; // total target duration (e.g. 3:00)
  chapters?: Array<{ name: string; startFrame?: Frames; durFrames?: Frames }>;
  slots: BoardSlot[];
  warnings?: string[]; // contradictions found during import
}

// ---------- user rules ----------

/** Things the user said once that must hold on every build (checked by lint, shown to agents). */
export interface Constraint {
  id: string;
  text: string; // the rule in the user's words, e.g. "ใช้เฉพาะ element ในบอร์ด"
  scope?: string; // optional: a slot id, asset id, effect match name or 'all'
  check?: 'board-only' | 'no-cover-photo' | 'logo-static' | 'no-repeat-gimmick' | 'manual';
  createdAt: string;
}

export interface StyleRules {
  cornerRadiusPct?: number; // radius as % of the shorter card side; "มนก็มนให้หมด"
  safeMarginPct?: number; // default 5
  palette?: string[]; // hex colours
  joins?: Array<{ from: string; to: string; dissolve: Frames }>; // edge-type join policy, e.g. {from:'card', to:'footage', dissolve:10}
  thai?: { minCapHeightPct?: number; minWeight?: number; lowerVowelClearancePx?: number; animateBy?: 'line' | 'word' | 'char' };
  maxStaticSec?: number; // advisory: footage nearly static longer than this gets a push-in suggestion
}

export interface Cut {
  after: string; // clip id; the cut between this clip and the next one in `video`
  dissolve: Frames; // 0 = hard cut
}

export interface AudioClip {
  id: string;
  src: string; // asset id (kind 'audio' or any asset with audio)
  at: Frames; // timeline position
  in?: Frames; // source in (default 0)
  dur?: Frames; // default: until source end or timeline end
  gainDb?: number; // default 0
  fadeIn?: Frames;
  fadeOut?: Frames;
}

export interface DuckSettings {
  underDb: number; // e.g. -12: music drops 12 dB while VO plays
  attackMs: number;
  releaseMs: number;
}

export interface AudioTracks {
  vo: AudioClip[];
  music: AudioClip[];
  sfx: AudioClip[];
  duck?: DuckSettings; // applies music under vo
  useClipAudio?: boolean; // default true: audio embedded in video clips is included (camera sound)
}

export interface Timeline {
  video: Clip[]; // in order; no gaps
  cuts: Cut[]; // one per adjacent pair at most; missing = hard cut
  audio: AudioTracks;
}

export type DeliveryTargetId = 'yt' | 'fb' | 'vert' | 'th_tv' | 'th_prores' | 'led' | 'm422hq' | (string & {});

export interface DeliverySettings {
  targets: DeliveryTargetId[];
  overrides?: Partial<Record<DeliveryTargetId, Partial<DeliveryPreset>>>;
  note?: string;
}

export interface QcIssue {
  kind:
    | 'black' | 'freeze' | 'silence' | 'loudness' | 'truepeak' | 'frames' | 'spec' | 'gap'
    | 'flash' // a shot shorter than N frames (neighbouring source shot leaking in)
    | 'cutcross' // a clip crosses a shot change in its source
    | 'repeat' // adjacent clips reuse overlapping source ranges
    | 'duplicate' // duplicated-frame cadence (stutter) inside a clip
    | 'lowmotion' // nearly static for long (advisory)
    | 'slowmo' // slow motion that repeats source frames without optical flow
    | 'board' // deviates from the board (missing slot, order, timing drift, extra element)
    | 'style' // violates StyleRules / Constraint
    | 'thai' // Thai typography lint
    | 'comp' // AE comp lint (animation ends early, layer ends before comp out ...)
    | 'disk';
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
  contactSheet?: string; // png path
}

export interface Version {
  id: string; // v001, v002 ...
  createdAt: string;
  planHash: string; // hash of timeline+assets used
  master: string; // ProRes MOV path
  reviewProxy?: string;
  reviewPlan?: ReviewPlan; // immutable shot map of this build, independent of later timeline edits
  deliverables: Record<string, string>; // target id -> path
  qc?: QcReport;
  stats: BuildStats;
  clipSnapshots?: Record<string, { clip: Clip; render?: AeRenderRecord; fingerprint?: string }>; // per-clip state of this build (shot_revert)
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
  cuts?: Cut[]; // transition context for annotations near a cut
}

// ---------- captions / on-screen text (Reels / TikTok style) ----------

/** Text burned into deliverables over the picture, e.g. a hook in the first seconds. */
export interface TextOverlay {
  id: string;
  text: string; // \n for a line break
  at: Frames;
  dur: Frames;
  style?: 'hook' | 'title' | 'lower'; // hook: big, top · title: big, centre · lower: small, lower third
}

/**
 * Auto captions from speech (whisper.cpp) and text overlays. Burned into deliverables only; the ProRes
 * master stays clean. Word timings come from cached transcripts of the sources (cache/transcripts/).
 */
export interface CaptionSettings {
  enabled: boolean; // speech captions on/off (overlays in `texts` burn either way)
  source?: 'auto' | 'clips' | 'vo'; // whose speech: camera audio of video clips or the VO track (auto: vo when present)
  lang?: string; // whisper language: 'th', 'en', … or 'auto' (default)
  style?: 'pop' | 'clean'; // pop: word-by-word highlight (TikTok); clean: whole phrase
  position?: 'bottom' | 'middle' | 'top';
  font?: string; // font family; default per OS with Thai glyphs
  fontScale?: number; // 1 = default size
  color?: string; // '#RRGGBB'
  highlight?: string; // active word colour (pop)
  uppercase?: boolean; // Latin letters only
  maxWords?: number; // Latin words per caption (default 3)
  maxChars?: number; // visible characters per caption (default 12; Thai vowel/tone marks do not count)
  fixes?: Array<{ from: string; to: string }>; // corrections applied to transcripts (brand names, misheard words)
  targets?: DeliveryTargetId[]; // default: every target except broadcast/master (th_tv, th_prores, m422hq)
  texts?: TextOverlay[];
}

export interface Project {
  meta: ProjectMeta;
  dir: string; // absolute project directory (holds project.json, cache/, out/)
  assets: Record<string, Asset>;
  timeline: Timeline;
  delivery: DeliverySettings;
  versions: Version[];
  board?: Board;
  constraints?: Constraint[];
  styleRules?: StyleRules;
  captions?: CaptionSettings;
}

// ---------- delivery presets ----------

export interface DeliveryPreset {
  id: DeliveryTargetId;
  label: string;
  container: 'mp4' | 'mov' | 'mxf';
  video: {
    codec: 'h264' | 'hevc' | 'prores_422hq' | 'prores_4444' | 'xdcam_hd422' | 'dnxhr_hqx';
    width: number;
    height: number;
    fps?: number; // default project fps
    interlaced?: boolean; // 1080i50 for broadcast
    bitrateMbps?: number; // for h264/hevc/xdcam
    cbr?: boolean;
    useGpu?: boolean; // try nvenc/qsv, fall back to libx264
  };
  audio: {
    codec: 'aac' | 'pcm_s24le' | 'pcm_s16le';
    bitrateKbps?: number;
    sampleRate: 48000;
    channels: 2;
  };
  loudness?: { integratedLufs: number; truePeakDb: number; lra?: number };
  textless?: boolean; // also produce textless (video track without title overlays) — needs comp support, optional
}

// ---------- build ----------

export interface BuildStats {
  segmentsTotal: number;
  segmentsRendered: number;
  segmentsReused: number;
  dissolvesRendered: number;
  compsRendered: number;
  compsReused: number;
  timingsMs: Record<string, number>; // 'probe' | 'segments' | 'dissolves' | 'audio' | 'mux' | 'qc' | 'deliver' | 'total'
}

export interface Progress {
  stage: string;
  done: number;
  total: number;
  message?: string;
}

export interface BuildOptions {
  force?: boolean; // ignore caches
  skipQc?: boolean;
  skipDeliver?: boolean;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export interface BuildResult {
  version: Version;
  stats: BuildStats;
}

// ---------- jobs ----------

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobInfo {
  id: string;
  name: string;
  status: JobStatus;
  progress?: Progress;
  startedAt?: string;
  endedAt?: string;
  log: string[]; // last N lines
  error?: string;
  result?: unknown;
}

// ---------- tools / environment ----------

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  afterfx?: string; // AfterFX.com (console variant) preferred, else AfterFX.exe
  aerender?: string;
  aeVersionDir?: string; // "C:\Program Files\Adobe\Adobe After Effects 2026"
  premiereExe?: string;
  mediaEncoderExe?: string;
  filmcraftCli?: string; // ArtCraft FilmCraft headless CLI (optional editor)
  effectcraftCli?: string; // ArtCraft EffectCraft headless CLI (optional motion host)
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
  aeVersion?: string; // read lazily via a headless job; may be unknown
  totalRamGb: number;
  freeRamGb: number;
  cpuThreads: number;
}

// ---------- After Effects backend ----------

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
  text?: string; // for text layers
  source?: string; // footage file or precomp name
  effects: string[]; // match names
  bounds?: { x: number; y: number; w: number; h: number }; // comp-space at the inspect frame, normalized 0..1 if available
}

export interface CompDetail extends CompInfo {
  layers: LayerInfo[];
  fingerprint: string;
}

export type AeOp =
  | { op: 'setText'; layer: string | number; text: string; fontSize?: number; font?: string; color?: [number, number, number] }
  | { op: 'replaceFootage'; layer: string | number; path: string }
  | { op: 'shiftLayer'; layer: string | number; frames: Frames } // move layer in time
  | { op: 'setProperty'; layer: string | number; property: string; value: unknown; atFrame?: Frames } // property = dotted match-name path
  | { op: 'addEffect'; layer: string | number; matchName: string; properties?: Record<string, unknown> }
  | { op: 'applyPreset'; layer: string | number; ffxPath: string }
  | { op: 'setLayerEnabled'; layer: string | number; enabled: boolean }
  | { op: 'duplicateComp'; newName: string }
  | { op: 'script'; jsx: string }; // escape hatch; runs inside the open project with `comp` in scope

export interface AeEditRequest {
  aep: string;
  comp: string;
  ops: AeOp[];
  saveAs?: string; // default: save in place (the MCP copies the .aep first; see docs)
}

export interface AeEditResult {
  ok: boolean;
  savedTo: string;
  fingerprint: string;
  log: string[];
}

export interface AeCreateRequest {
  jsx: string; // script run headlessly in an empty project; must not call newProject/save/quit
  saveAs: string; // new .aep, never overwritten
  scriptDir?: string; // exposed to the script as SCRIPT_DIR (for relative imports)
}

export interface AeCreateResult {
  savedTo: string;
  comps: CompInfo[];
  log: string[];
}

export interface RenderRequest {
  aep: string;
  comp: string;
  outPath: string; // final path (may be non-ASCII); backend renders to ASCII temp then renames
  startFrame?: Frames;
  endFrame?: Frames;
  outputModule?: string; // OM template name; default: the installed ProRes template, fallback 'Lossless' + transcode
  renderSettings?: string; // RS template; default 'Best Settings'
  mfrPercent?: number; // -mfr ON <percent>
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface RenderResult {
  path: string;
  frames: Frames;
  elapsedMs: number;
  usedFallback: boolean; // true when Lossless+transcode path was used
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
  // Optional analysis commands (headless runner + mock implement them).
  scanTemplate?(aep: string): Promise<TemplateScan>;
  lintComp?(aep: string, comp: string): Promise<CompLint>;
  listFonts?(aep: string): Promise<string[]>; // font PostScript/family names used by text layers
  purgeCaches?(): Promise<void>;
}

export interface TemplateComp {
  name: string;
  durationFrames: Frames;
  width: number;
  height: number;
  placeholders: Array<{ layer: string; kind: 'footage' | 'image' | 'text' | 'precomp'; source?: string; moving: boolean /* precomp follows its window; false = luma/track matte window, clip stays still */ }>;
  expressionLocked: string[]; // "Layer > property" paths driven by expressions (e.g. Controls layer)
  fonts: string[];
  textAnimators: Array<{ layer: string; basedOn: 'characters' | 'words' | 'lines' | 'other' }>;
}

export interface TemplateScan {
  aep: string;
  comps: TemplateComp[];
  warnings: string[];
}

export interface CompLint {
  comp: string;
  issues: Array<{ kind: 'animation-ends-early' | 'layer-ends-early' | 'background-ends-early' | 'thai-animator' | 'thai-size' | 'style'; layer?: string; frame?: Frames; message: string }>;
}

// ---------- xmeml (FCP7 XML) ----------

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

// ---------- user action cards ----------

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
