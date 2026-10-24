import { execa, type Options as ExecaOptions } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type {
  AeBackend,
  AeCompAsset,
  Asset,
  AudioClip,
  BuildOptions,
  BuildResult,
  BuildStats,
  Clip,
  DeliveryPreset,
  DeliveryTargetId,
  Environment,
  Frames,
  ProbeInfo,
  Progress,
  Project,
  QcReport,
  ToolPaths,
  Version,
} from '../core/types.js';
import { hashFile, hashJson, hashString } from '../core/hash.js';
import {
  captureReviewPlan,
  clipInterpolation,
  clipSourceNeeds,
  clipStartFrames,
  curvePos,
  curveSlot,
  curveTime,
  nextVersionId,
  planHash,
  projectPaths,
  saveProject,
  shownFrame,
  speedCurve,
  timelineFrames,
  validateTimeline,
  type SpeedCurve,
} from '../core/project.js';
import { splitDissolve } from '../core/timecode.js';
import { MASTER_PRESET_ID, presetToFfmpegArgs, resolvePreset } from './presets.js';
import { assFor, captionTargets, projectWords, subtitlesFilter, transcriptsDir } from './captions.js';
import type { Word } from './transcribe.js';

// ---------- types owned by this module ----------

/** Mirrors `runQc` from qc.ts; injected so this module does not import it. */
export interface QcArgs {
  tools: ToolPaths;
  path: string;
  expectedFrames: Frames;
  fps: number;
  loudness?: { integratedLufs: number; truePeakDb: number; toleranceLu?: number };
  contactSheetPath?: string;
  clipStarts?: Array<{ clipId: string; start: Frames; dur: Frames }>;
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
export type PinnableComp = AeCompAsset & { revertPin?: RevertPin };

export interface PreviewRangeOptions {
  from: Frames;
  to: Frames; // exclusive
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

interface CacheEntry {
  file: string; // basename inside cacheSegments
  frames: Frames;
  kind: 'segment' | 'dissolve';
  mode: 'copy' | 'encode';
  clipId?: string;
  createdAt: string;
  /** size + mtime when `frames` was last verified; an unchanged file is trusted without re-counting */
  size?: number;
  mtimeMs?: number;
}
interface CacheManifest {
  schema: 1;
  entries: Record<string, CacheEntry>;
}

interface Source {
  assetId: string;
  kind: Asset['kind'];
  path: string;
  probe: ProbeInfo;
  identity: string; // file hash or comp fingerprint
  timing: SourceTiming;
}

/** Stream origins. `*Sec` are absolute container timestamps (what `-copyts` keeps). */
interface SourceTiming {
  fmtStartSec: number; // container start; ffmpeg subtracts this from every stream without -copyts
  videoStartSec: number; // the project-frame origin of a moving source: frame 0 of the clip's `in`
  videoStartExpr: string; // videoStartSec as an exact ffmpeg expression (start_pts * time_base)
  audioStartSec: number;
  cfr: boolean; // r_frame_rate == avg_frame_rate
  tbSec?: number; // video stream time base (seconds per tick)
}

interface SegmentPlan {
  clip: Clip;
  index: number;
  src: Source;
  key: string;
  srcIn: Frames; // first source frame of the segment body (realtime clips; the copy path)
  k0: Frames; // first clip-local timeline frame of the body (== trimStart)
  frames: Frames; // body length (dissolve halves excluded)
  trimStart: Frames; // frames given to the dissolve before this clip
  trimEnd: Frames; // frames given to the dissolve after this clip
}

interface DissolvePlan {
  a: SegmentPlan;
  b: SegmentPlan;
  n: Frames;
  half: { a: Frames; b: Frames };
  key: string;
  aK0: Frames; // clip-local timeline frame of A where the dissolve starts (A.dur - a)
  bK0: Frames; // same for B (-a: B's handle before its in-point)
}

type ConcatItem = { kind: 'segment'; plan: SegmentPlan } | { kind: 'dissolve'; plan: DissolvePlan };

// ---------- process helpers ----------

const FF_BASE = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
const PRORES_HQ_ARGS = ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
const ALL_INTRA = new Set(['prores', 'dnxhd', 'mjpeg', 'png', 'tiff', 'bmp', 'rawvideo', 'v210', 'huffyuv', 'ffvhuff', 'cfhd', 'qtrle', 'ffv1', 'utvideo', 'magicyuv', 'dpx', 'exr']);
const MIN_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60_000;

class AbortError extends Error {
  constructor(message = 'build aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

function tail(s: string, lines = 12): string {
  const arr = s.trim().split(/\r?\n/);
  return arr.slice(-lines).join('\n');
}

async function run(bin: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(o.signal);
  const opts: ExecaOptions = {
    windowsHide: true,
    timeout: Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.round(o.timeoutMs))),
    forceKillAfterDelay: 3000,
    reject: false,
    stdin: 'ignore',
    maxBuffer: 64 * 1024 * 1024,
    cancelSignal: o.signal,
  };
  const r = await execa(bin, args, opts);
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  if (r.isCanceled || o.signal?.aborted) throw new AbortError();
  const name = path.basename(bin);
  if (r.timedOut) throw new Error(`${name} timed out after ${opts.timeout} ms\n  args: ${args.join(' ')}`);
  if (r.exitCode !== 0) throw new Error(`${name} failed (exit ${r.exitCode}): ${tail(stderr)}\n  args: ${args.join(' ')}`);
  return { stdout, stderr };
}

/** Budget for an encode of `frames` at `fps`: 30x realtime, floored at 2 min. */
function encodeTimeout(frames: Frames, fps: number): number {
  return budgetMs(frames / fps);
}

/** 30x realtime of `mediaSec` decoded media, floored at 2 min. */
function budgetMs(mediaSec: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.ceil(mediaSec * 1000 * 30));
}

const SEEK_PREROLL_SEC = 2;
const GOP_SLACK_SEC = 10; // worst-case distance from the seek point back to the previous keyframe
/** Dissolve curve id (part of the dissolve cache key): frame k of n mixes B at (k + 0.5) / n. */
const DISSOLVE_CURVE = 'linear-mid';

interface MovingInput {
  args: string[]; // input options + -i
  filters: string[]; // frames [srcIn, srcIn+frames) restamped from 0, before fitting
  decodeSec: number; // media seconds decoded (preroll + output + keyframe slack)
}

/**
 * Input + filters for project frames [srcIn, srcIn+frames) of a moving source. Seeks with -ss
 * before -i to `SEEK_PREROLL_SEC` before the first needed frame and keeps container timestamps
 * (-copyts, a global option the caller must add) so the project-frame grid stays anchored at the
 * video stream start: identical frames to decoding from frame 0 through `fps`, without the decode.
 */
function movingInput(src: Source, srcIn: Frames, frames: Frames, fps: number): MovingInput {
  const t = src.timing;
  const pre = Math.min(srcIn, Math.round(SEEK_PREROLL_SEC * fps));
  const k0 = srcIn - pre; // grid frame the decode starts at
  const args: string[] = [];
  // -ss is relative to the container start; ffmpeg adds fmtStartSec back.
  if (k0 > 0) args.push('-ss', (t.videoStartSec - t.fmtStartSec + k0 / fps).toFixed(6));
  args.push('-i', src.path);
  const filters = [`setpts=PTS-round(${t.videoStartExpr}/TB)`];
  if (!sameRate(src, fps)) filters.push(`fps=${fpsExpr(fps)}:start_time=${gridSec(k0, fps)}`);
  // Frame k sits at k/fps; half-frame margins make the cut immune to timestamp jitter. trim rounds its
  // bounds to the stream time base, so on a 1/fps base (AVI, fps filter) the margins vanish: trim in AVTB.
  const [num, den = '1'] = fpsExpr(fps).split('/');
  filters.push('settb=AVTB', `trim=start=${gridSec(srcIn - 0.5, fps)}:end=${gridSec(srcIn + frames - 0.5, fps)}`, 'setpts=PTS-STARTPTS', `settb=${den}/${num}`);
  return { args, filters, decodeSec: (pre + frames) / fps + (k0 > 0 ? GOP_SLACK_SEC : 0) };
}

function sameRate(src: Source, fps: number): boolean {
  return src.timing.cfr && src.probe.fps !== undefined && Math.abs(src.probe.fps - fps) < 1e-3;
}

/**
 * Before trim ran in AVTB, a time base under 2 ticks per frame rounded the half-frame margins away
 * unless half a frame is a whole number of microseconds (25/50 fps): such segments may be off by a frame.
 */
function coarseTrimKey(src: Source, fps: number): { trim?: 2 } {
  const tb = sameRate(src, fps) ? src.timing.tbSec : 1 / fps;
  if (tb === undefined || tb * fps <= 0.5 || Number.isInteger(5e5 / fps)) return {};
  return { trim: 2 };
}

// ---------- clip video (speed, push-in) ----------

/** Number for an ffmpeg expression: shortest round-trip form, so ffmpeg parses the same double. */
function xnum(v: number): string {
  return String(v);
}

/** `(V+k)` / `(V-k)` without a "+-" ffmpeg's parser may not accept. */
function plus(v: string, k: number): string {
  return k === 0 ? v : `(${v}${k > 0 ? '+' : '-'}${xnum(Math.abs(k))})`;
}

/** Balanced if-tree over integer M in [lo, hi] (keeps the parser's nesting depth at log2). */
function tableExpr(M: string, lo: number, hi: number, value: (m: number) => string): string {
  if (lo === hi) return value(lo);
  const mid = (lo + hi) >> 1;
  return `if(lt(${M},${mid + 1}),${tableExpr(M, lo, mid, value)},${tableExpr(M, mid + 1, hi, value)})`;
}

const MAX_RAMP_TABLE = 2000;

/**
 * ffmpeg expression of the curve inverse at source frame M (relative to `in`): closed forms before the
 * clip and after the ramp, a table inside the ramp (no closed-form inverse). `slots`: the integer first
 * slot (curveSlot), otherwise the exact time (curveTime). JS and ffmpeg evaluate the same doubles.
 */
function curveInverseExpr(c: SpeedCurve, M: string, slots: boolean): string {
  const wrap = (e: string) => (slots ? `ceil(${e}-1e-7)` : e);
  const before = wrap(`${M}/${xnum(c.r0)}`);
  const pR = curvePos(c, c.R);
  const after = wrap(`${xnum(c.R)}+(${M}-${xnum(pR)})/${xnum(c.r1)}`);
  if (c.R <= 0) return before; // constant: r0 == r1
  const hi = Math.ceil(pR) - 1; // integer m with 0 < m < pR
  if (hi - 1 > MAX_RAMP_TABLE) throw new Error(`speed ramp too long to encode (${hi} source frames)`);
  const inner = hi >= 1
    ? tableExpr(M, 1, hi, (m) => (slots ? String(curveSlot(c, m)) : xnum(Math.round(curveTime(c, m) * 1e6) / 1e6)))
    : after;
  return `if(lte(${M},0),${before},if(lt(${M},${xnum(pR)}),${inner},${after}))`;
}

/**
 * Slow push-in: zoom 100% -> 100+pushIn% linearly over the clip (clip-local frame k0 + in), centred,
 * applied to the fitted picture (so it multiplies Clip.scale). `perspective` maps the shrinking centre
 * rectangle onto the frame with sub-pixel accuracy: no integer crop steps, so no jitter.
 */
function pushFilters(clip: Clip, k0: Frames): string[] {
  if (!clip.pushIn) return [];
  const z = `(1+${xnum(clip.pushIn / 100)}*min(1,max(0,${plus('in', k0)}/${Math.max(1, clip.dur - 1)})))`;
  const x = `W/2*(1-1/${z})`;
  const y = `H/2*(1-1/${z})`;
  return [`perspective=x0='${x}':y0='${y}':x1='W-${x}':y1='${y}':x2='${x}':y2='H-${y}':x3='W-${x}':y3='H-${y}':interpolation=cubic:eval=frame`];
}

interface VideoChain {
  args: string[]; // input options + -i
  chains: string[]; // filter_complex chains ending in [label]
  decodeSec: number;
}

/**
 * Input + filter_complex chains for clip-local timeline frames [k0, k0+n) of `clip` (k0 < 0 / k0+n > dur
 * reach into the dissolve handles), fitted to the project size. Realtime clips decode source frames
 * in+k0.. directly. Retimed clips decode the source frames the curve shows and re-time them:
 *  - nearest: each source frame is stamped with the first slot that shows it (integer), fps= repeats /
 *    drops so slot k gets the latest frame stamped <= k (== in + floor(pos(k)));
 *  - blend / motion: frames are stamped with their exact curve time and the `framerate` filter
 *    (linear blend of the two neighbours) / `minterpolate` (motion compensated) samples the slots.
 * A cloned last frame (tpad) holds the picture when a lookahead runs past the source end.
 */
function clipVideo(src: Source, clip: Clip, k0: Frames, n: Frames, meta: { fps: number; width: number; height: number }, idx: number, label: string, post: string[] = []): VideoChain {
  const { fps, width: W, height: H } = meta;
  const fit = fitFilters(src.probe.width ?? W, src.probe.height ?? H, W, H, clip.scale ?? 100);
  const look = [...fit, ...pushFilters(clip, k0), 'format=yuv422p10le'];
  if (src.kind === 'still') {
    return {
      args: ['-loop', '1', '-framerate', String(fps), '-i', src.path],
      chains: [`[${idx}:v:0]${[...look, `trim=end_frame=${n}`, 'setpts=PTS-STARTPTS', ...post].join(',')}[${label}]`],
      decodeSec: n / fps,
    };
  }
  const curve = speedCurve(clip);
  if (!curve) {
    const m = movingInput(src, clip.in + k0, n, fps);
    return { args: m.args, chains: [`[${idx}:v:0]${[...m.filters, ...look, ...post].join(',')}[${label}]`], decodeSec: m.decodeSec };
  }
  const mode = clipInterpolation(clip);
  const relFirst = shownFrame(curve, k0);
  const relLast = shownFrame(curve, k0 + n - 1) + (mode === 'nearest' ? 0 : 1);
  const len = src.probe.durationFrames;
  const s0 = Math.max(0, clip.in + relFirst);
  const s1 = len > 0 ? Math.min(len - 1, clip.in + relLast) : clip.in + relLast;
  if (s1 < s0) throw new Error(`clip '${clip.id}': no source frames for frames ${k0}..${k0 + n - 1} at its speed`);
  const m = movingInput(src, s0, s1 - s0 + 1, fps);
  const off = s0 - clip.in; // relative source index of decoded frame N=0
  const [num, den = '1'] = fpsExpr(fps).split('/');
  const fr = fpsExpr(fps);
  let retime: string[];
  if (mode === 'nearest') {
    retime = [
      'tpad=stop_mode=clone:stop=2',
      `settb=${den}/${num}`,
      `setpts='max(0,${curveInverseExpr(curve, plus('N', off), true)}-(${k0}))'`,
      `fps=${fr}`,
    ];
  } else {
    // Stamps in 1/1000 frame; the grid starts at O = floor(time of the first frame), a clone of that frame
    // sits at O so the interpolator's output grid lands on whole slots; slot k0 is output index k0 - O.
    const t0 = curveTime(curve, off);
    const O = Math.floor(t0 + 1e-9);
    const clone = t0 - O > 1e-6;
    const T = (N: string) => `round((${curveInverseExpr(curve, N, false)}-(${O}))*1000)`;
    const interp = mode === 'blend'
      ? `framerate=fps=${fr}:interp_start=0:interp_end=255:scene=100`
      : `minterpolate=fps=${fr}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
    retime = [
      clone ? 'tpad=start=1:start_mode=clone:stop=2:stop_mode=clone' : 'tpad=stop_mode=clone:stop=2',
      `settb=${den}/${Number(num) * 1000}`,
      `setpts='${clone ? `if(eq(N,0),0,${T(plus('N', off - 1))})` : T(plus('N', off))}'`,
      interp,
      `trim=start_frame=${k0 - O}`,
      'setpts=PTS-STARTPTS',
    ];
  }
  const decodeSec = m.decodeSec * (mode === 'motion' ? 20 : 1); // minterpolate is far slower than realtime decode
  return { args: m.args, chains: [`[${idx}:v:0]${[...m.filters, ...retime, ...look, ...post].join(',')}[${label}]`], decodeSec };
}

/** Seconds of grid position `frames` using the exact rational rate (29.97 -> 30000/1001), as fps= does. */
function gridSec(frames: number, fps: number): string {
  const [num, den] = fpsExpr(fps).split('/');
  return ((frames * Number(den ?? 1)) / Number(num)).toFixed(9);
}

function sec(frames: Frames, fps: number): string {
  return (frames / fps).toFixed(6);
}

/** mov timescale: 25 -> 25000, 29.97 -> 30000 (frame duration 1001). */
export function movTimescale(fps: number): number {
  return Number.isInteger(fps) ? fps * 1000 : Math.round(fps) * 1000;
}

function sanitizeName(s: string, fallback: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_').trim();
  return cleaned || fallback;
}

/** ASCII-only cache file stem; non-ASCII ids keep a short hash so distinct ids never collide. */
function asciiStem(id: string): string {
  const ascii = id.replace(/[^A-Za-z0-9_-]+/g, '_');
  return ascii === id ? id : `${ascii.replace(/^_+|_+$/g, '') || 'x'}_${hashString(id).slice(0, 6)}`;
}

/** `base` if free, else `base_2`, `base_3`, ... Outputs are never overwritten. */
function uniquePath(base: string): string {
  if (!existsSync(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 2; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!existsSync(cand)) return cand;
  }
}

function tmpFile(dir: string, ext: string): string {
  return path.join(dir, `${process.pid}_${randomBytes(4).toString('hex')}${ext}`);
}

async function moveInto(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  try { await link(from, to); }
  catch (e) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  await rm(from);
}

// ---------- probe ----------

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  start_pts?: number | string;
  start_time?: string;
  time_base?: string;
  disposition?: { attached_pic?: number };
}
interface FfprobeOut {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; start_time?: string };
}

function parseRate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (!den || !num) return undefined;
    const v = num / den;
    return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
  }
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function ffprobeJson(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<FfprobeOut> {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 120_000, signal });
  return JSON.parse(stdout) as FfprobeOut;
}

/** fps as an ffmpeg rational where that is exact: 25 -> "25", 29.97 -> "30000/1001". */
function fpsExpr(fps: number): string {
  if (Number.isInteger(fps)) return String(fps);
  const n = Math.round((fps * 1001) / 1000);
  return Math.abs((n * 1000) / 1001 - fps) < 1e-3 ? `${n * 1000}/1001` : String(fps);
}

/**
 * ffprobe -> ProbeInfo. Duration uses project frames (`opts.fps`, default 25);
 * `fps` remains the source frame rate. Stills return 1 and are looped by the assembler.
 */
export async function probe(tools: ToolPaths, file: string, opts: { fps?: number; signal?: AbortSignal } = {}): Promise<ProbeInfo> {
  return (await probeDetailed(tools, file, opts)).info;
}

async function probeDetailed(tools: ToolPaths, file: string, opts: { fps?: number; signal?: AbortSignal } = {}): Promise<{ info: ProbeInfo; timing: SourceTiming }> {
  const data = await ffprobeJson(tools, file, opts.signal);
  return { info: await probeInfoOf(tools, file, data, opts), timing: timingOf(data) };
}

async function probeTiming(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<SourceTiming> {
  return timingOf(await ffprobeJson(tools, file, signal));
}

function timingOf(data: FfprobeOut): SourceTiming {
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const num = (x: string | number | undefined): number | undefined => {
    const n = x === undefined || x === '' ? Number.NaN : Number(x);
    return Number.isFinite(n) ? n : undefined;
  };
  const fmtStartSec = num(data.format?.start_time) ?? 0;
  const videoStartSec = num(v?.start_time) ?? fmtStartSec;
  const tb = /^(\d+)\/(\d+)$/.exec(v?.time_base ?? '');
  const pts = num(v?.start_pts);
  const videoStartExpr = tb && pts !== undefined && Number.isInteger(pts) ? `${pts}*${tb[1]}/${tb[2]}` : videoStartSec.toFixed(6);
  return {
    fmtStartSec,
    videoStartSec,
    videoStartExpr,
    audioStartSec: num(a?.start_time) ?? fmtStartSec,
    cfr: !!v?.r_frame_rate && v.r_frame_rate === v.avg_frame_rate,
    ...(tb && Number(tb[2]) > 0 ? { tbSec: Number(tb[1]) / Number(tb[2]) } : {}),
  };
}

async function probeInfoOf(tools: ToolPaths, file: string, data: FfprobeOut, opts: { fps?: number; signal?: AbortSignal }): Promise<ProbeInfo> {
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const formatName = data.format?.format_name ?? '';
  const isStill = !!v && (/image2|_pipe/.test(formatName) || v.nb_frames === '1');
  const info: ProbeInfo = { durationFrames: 0, hasVideo: !!v, hasAudio: !!a };
  if (a) {
    info.audioCodec = a.codec_name;
    if (a.sample_rate) info.sampleRate = Number(a.sample_rate);
    if (a.channels) info.channels = a.channels;
  }
  if (v) {
    info.videoCodec = v.codec_name;
    info.pixFmt = v.pix_fmt;
    if (v.width) info.width = v.width;
    if (v.height) info.height = v.height;
    if (isStill) {
      info.durationFrames = 1;
      info.allIntra = true;
      return info;
    }
    const fps = parseRate(v.r_frame_rate) ?? parseRate(v.avg_frame_rate);
    if (fps) info.fps = fps;
    info.allIntra = !!v.codec_name && ALL_INTRA.has(v.codec_name);
    let frames = Number(v.nb_frames);
    if (!(Number.isInteger(frames) && frames > 0)) {
      const dur = Number(v.duration ?? data.format?.duration);
      if (fps && Number.isFinite(dur) && dur > 0) frames = Math.round(dur * fps);
    }
    if (!(Number.isInteger(frames) && frames > 0)) frames = await countVideoPackets(tools, file, opts.signal);
    const duration = Number(v.duration ?? data.format?.duration);
    info.durationFrames = Number.isFinite(duration) && duration > 0
      ? Math.round(duration * (opts.fps ?? 25))
      : Math.round(frames * (opts.fps ?? 25) / (fps ?? opts.fps ?? 25));
    return info;
  }
  const dur = Number(a?.duration ?? data.format?.duration);
  info.durationFrames = Number.isFinite(dur) && dur > 0 ? Math.round(dur * (opts.fps ?? 25)) : 0;
  return info;
}

/** Number of video packets (== frames for every container/codec we write). Fast: no decode. */
export async function countVideoPackets(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file],
    { timeoutMs: 10 * 60_000, signal },
  );
  const n = parseInt(stdout.trim(), 10);
  if (!Number.isInteger(n)) throw new Error(`could not count frames of ${file}: ${stdout}`);
  return n;
}

async function firstVideoPtsSec(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', file],
    { timeoutMs: 60_000, signal },
  );
  const v = Number(stdout.trim().split(/\r?\n/)[0]);
  return Number.isFinite(v) ? v : Number.NaN;
}

async function codecTag(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_tag_string', '-of', 'csv=p=0', file],
    { timeoutMs: 60_000, signal },
  );
  return stdout.trim();
}

// ---------- loudness ----------

/** loudnorm first pass. Returns undefined for digital silence. */
export async function measureLoudnorm(
  tools: ToolPaths,
  file: string,
  target: { integratedLufs: number; truePeakDb: number; lra: number },
  signal?: AbortSignal,
): Promise<LoudnessMeasure | undefined> {
  const { stderr } = await run(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'info', '-i', file, '-vn', '-af', `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDb}:LRA=${target.lra}:print_format=json`, '-f', 'null', '-'],
    { timeoutMs: 20 * 60_000, signal },
  );
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) throw new Error(`loudnorm measurement produced no JSON:\n${tail(stderr)}`);
  const j = JSON.parse(m[0]) as Record<string, string>;
  const num = (k: string): number => Number(j[k]);
  const inputI = num('input_i');
  if (!Number.isFinite(inputI) || inputI < -70) return undefined;
  return { inputI, inputTp: num('input_tp'), inputLra: num('input_lra'), inputThresh: num('input_thresh'), targetOffset: num('target_offset') };
}

function loudnormPass2(m: LoudnessMeasure, target: { integratedLufs: number; truePeakDb: number; lra: number }): string {
  // Linear mode needs LRA target >= measured; raise it so loudnorm does not fall back to dynamic.
  const lra = Math.min(50, Math.max(target.lra, Math.ceil(m.inputLra)));
  // loudnorm rejects measured_I / measured_thresh above 0: a hot float mix is turned down first
  // (float, so lossless) and the measurements shifted by the same gain.
  const pre = Math.min(0, -10 - m.inputI);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '0');
  const ln = `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDb}:LRA=${lra}:measured_I=${f(m.inputI + pre)}:measured_TP=${f(m.inputTp + pre)}:measured_LRA=${f(m.inputLra)}:measured_thresh=${f(m.inputThresh + pre)}:offset=${f(m.targetOffset)}:linear=true:print_format=summary,aresample=48000`;
  return pre < 0 ? `volume=${pre.toFixed(2)}dB,${ln}` : ln;
}

/**
 * blend expression for an n-frame dissolve: frame k mixes B at (k + 0.5) / n, so no frame is pure A
 * or pure B (a 1-frame dissolve is a 50/50 frame, not a hard cut). k comes from the timestamp (both
 * sides start at 0), rounded so the weight is exact whatever the time base: blend's N counter is not
 * reliably 0-based across ffmpeg versions. The final +0.5 rounds instead of truncating.
 */
function dissolveExpr(n: Frames, fps: number): string {
  return `A+(B-A)*clip((round(T*${fpsExpr(fps)})+0.5)/${n},0,1)+0.5`;
}

function sameLoudness(a: DeliveryPreset['loudness'], b: DeliveryPreset['loudness']): boolean {
  if (!a || !b) return !a && !b;
  return Math.abs(a.integratedLufs - b.integratedLufs) < 0.05 && Math.abs(a.truePeakDb - b.truePeakDb) < 0.05;
}

// ---------- picture fitting ----------

/** scale-to-fit x scale% then centre crop/pad to W x H. */
function fitFilters(srcW: number, srcH: number, W: number, H: number, scalePct: number): string[] {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const s = Math.min(W / srcW, H / srcH) * (scalePct / 100);
  const sw = even(srcW * s);
  const sh = even(srcH * s);
  const cw = Math.min(sw, W);
  const ch = Math.min(sh, H);
  const out: string[] = [];
  if (sw !== srcW || sh !== srcH) out.push(`scale=${sw}:${sh}:flags=lanczos`);
  if (cw !== sw || ch !== sh) out.push(`crop=${cw}:${ch}`);
  if (cw !== W || ch !== H) out.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);
  out.push('setsar=1');
  return out;
}

// ---------- audio graph ----------

interface AudioPiece {
  input: number;
  /** trim points on ffmpeg's input timeline (container start = 0) */
  startSec: number;
  endSec?: number;
  /** where the audio stream begins on that timeline; a later start is padded with silence */
  streamStartSec?: number;
  atSec: number;
  gainDb: number;
  fadeIn?: { sec: number };
  fadeOut?: { startSec: number; sec: number };
  /** retimed clip audio: playback speed factor (atempo) and the exact length after it */
  tempo?: number;
  exactSec?: number;
}

/** atempo factors whose product is `f`, each within atempo's clean 0.5..2 range. */
function atempoChain(f: number): string[] {
  const out: string[] = [];
  let r = f;
  while (r > 2) { out.push('atempo=2'); r /= 2; }
  while (r < 0.5) { out.push('atempo=0.5'); r /= 0.5; }
  if (Math.abs(r - 1) > 1e-9) out.push(`atempo=${r.toFixed(9)}`);
  return out;
}

class FilterGraph {
  private readonly parts: string[] = [];
  private n = 0;
  readonly inputs: string[] = [];
  private readonly inputIndex = new Map<string, number>();

  input(file: string): number {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    const idx = this.inputIndex.get(key);
    if (idx !== undefined) return idx;
    const i = this.inputs.length;
    this.inputs.push(file);
    this.inputIndex.set(key, i);
    return i;
  }

  label(): string {
    return `n${this.n++}`;
  }

  add(chain: string): void {
    this.parts.push(chain);
  }

  piece(p: AudioPiece): string {
    const out = this.label();
    const f: string[] = [];
    const trim = [`start=${p.startSec.toFixed(6)}`];
    if (p.endSec !== undefined) trim.push(`end=${p.endSec.toFixed(6)}`);
    f.push(`atrim=${trim.join(':')}`, 'asetpts=PTS-STARTPTS', 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    // asetpts drops any gap before the first sample; put it back so the piece keeps its origin.
    const lead = Math.round(Math.max(0, (p.streamStartSec ?? 0) - p.startSec) * 48000);
    if (lead > 0) f.push(`adelay=delays=${lead}S:all=1`);
    if (p.tempo !== undefined) f.push(...atempoChain(p.tempo));
    if (p.exactSec !== undefined) f.push(`apad=whole_dur=${p.exactSec.toFixed(6)}`, `atrim=end=${p.exactSec.toFixed(6)}`);
    if (p.gainDb) f.push(`volume=${p.gainDb.toFixed(3)}dB`);
    if (p.fadeIn && p.fadeIn.sec > 0) f.push(`afade=t=in:st=0:d=${p.fadeIn.sec.toFixed(6)}`);
    if (p.fadeOut && p.fadeOut.sec > 0) f.push(`afade=t=out:st=${Math.max(0, p.fadeOut.startSec).toFixed(6)}:d=${p.fadeOut.sec.toFixed(6)}`);
    const at = Math.round(p.atSec * 48000);
    if (at > 0) f.push(`adelay=delays=${at}S:all=1`);
    this.add(`[${p.input}:a:0]${f.join(',')}[${out}]`);
    return out;
  }

  /** Sum (no normalisation) of labels; returns undefined for none. */
  mix(labels: string[]): string | undefined {
    if (labels.length === 0) return undefined;
    if (labels.length === 1) return labels[0];
    const out = this.label();
    this.add(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${out}]`);
    return out;
  }

  toString(): string {
    return this.parts.join(';');
  }
}

// ---------- the assembler ----------

export class Assembler {
  private readonly tools: ToolPaths;
  private readonly env: Environment;
  private readonly ae: AeBackend;
  private readonly qc?: QcRunner;
  private readonly concurrency: number;
  private readonly encoderId: string;
  private readonly loudnessCache = new Map<string, LoudnessMeasure | undefined>();

  constructor(deps: AssemblerDeps) {
    this.tools = deps.tools;
    this.env = deps.env;
    this.ae = deps.ae;
    this.qc = deps.qc;
    this.concurrency = Math.max(1, deps.concurrency ?? (deps.env.freeRamGb >= 3 ? 2 : 1));
    // Part of every segment/dissolve key: a different ffmpeg or encoder setting yields different pixels.
    this.encoderId = hashJson({ ffmpeg: deps.env.ffmpegVersion ?? 'unknown', prores: PRORES_HQ_ARGS });
  }

  private async encode(args: string[], videoArgs: string[], cpuArgs: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    try { await run(this.tools.ffmpeg, args, { timeoutMs, signal }); }
    catch (error) {
      throwIfAborted(signal);
      if (!videoArgs.includes('h264_nvenc') && !videoArgs.includes('hevc_nvenc')) throw error;
      // An encoder in ffmpeg's inventory may have no working GPU/driver on this host.
      const start = args.indexOf('-c:v');
      const retry = [...args.slice(0, start), ...cpuArgs, ...args.slice(start + videoArgs.length)];
      await run(this.tools.ffmpeg, retry, { timeoutMs, signal });
    }
  }

  // ----- build -----

  async build(p: Project, opts: BuildOptions = {}): Promise<BuildResult> {
    const t0 = performance.now();
    const signal = opts.signal;
    const fps = p.meta.fps;
    const paths = projectPaths(p);
    const report = (stage: string, done: number, total: number, message?: string) =>
      opts.onProgress?.({ stage, done, total, ...(message ? { message } : {}) });
    const stats: BuildStats = {
      segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {},
    };
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      try {
        return await fn();
      } finally {
        stats.timingsMs[name] = Math.round(performance.now() - t);
      }
    };

    if (p.timeline.video.length === 0) throw new Error('timeline.video is empty: nothing to build');

    // 0. structural validation first, so a broken timeline fails before minutes of aerender.
    // Probe-dependent checks (source lengths, audio presence) wait for fresh probes below.
    const structural = validateTimeline(withoutProbes(p));
    for (const id of usedAssetIds(p)) {
      const a = p.assets[id];
      if (a && a.kind !== 'aecomp' && !existsSync(a.path)) structural.push(`asset '${id}' file missing: ${a.path}`);
    }
    if (structural.length) throw new Error(`timeline invalid:\n - ${structural.join('\n - ')}`);
    retimeWarnings(p).forEach((w, i, all) => report('warning', i + 1, all.length, w));

    // 1. AE comps
    await timed('comps', () => this.ensureCompRenders(p, paths.cacheRenders, stats, report, signal, opts.force));
    // After a batch of AE renders, let the backend purge AE caches when the cache drive runs low.
    if (stats.compsRendered > 0) {
      const after = (this.ae as { afterRenderBatch?: () => Promise<unknown> }).afterRenderBatch;
      if (after) await after.call(this.ae).catch((e: unknown) => report('warning', 0, 0, `AE cache purge skipped: ${e instanceof Error ? e.message : String(e)}`));
    }

    // 2. probe + hash file assets, then validate
    const sources = await timed('probe', () => this.resolveSources(p, report, signal));
    await saveProject(p);
    const errors = validateTimeline(p);
    if (errors.length) throw new Error(`timeline invalid:\n - ${errors.join('\n - ')}`);

    const totalFrames = timelineFrames(p);
    const { segments, dissolves, order } = planTimeline(p, sources, this.encoderId);
    stats.segmentsTotal = segments.length;

    const manifest = await loadManifest(paths.cacheSegments);
    const saveManifest = () => writeManifest(paths.cacheSegments, manifest);

    // 3. segments
    await timed('segments', async () => {
      let done = 0;
      report('segments', 0, segments.length);
      await parallel(segments, this.concurrency, async (seg) => {
        const hit = !opts.force && (await this.cacheHit(manifest, paths.cacheSegments, seg.key, seg.frames, 'segment', signal));
        if (hit) stats.segmentsReused++;
        else {
          await this.renderSegment(p, seg, paths, manifest, signal);
          stats.segmentsRendered++;
        }
        report('segments', ++done, segments.length, `${seg.clip.id}: ${hit ? 'cache' : 'rendered'}`);
      });
      await saveManifest();
    });

    // 4. dissolves
    await timed('dissolves', async () => {
      let done = 0;
      report('dissolves', 0, dissolves.length);
      await parallel(dissolves, this.concurrency, async (d) => {
        const hit = !opts.force && (await this.cacheHit(manifest, paths.cacheSegments, d.key, d.n, 'dissolve', signal));
        if (!hit) {
          await this.renderDissolve(p, d, paths, manifest, signal);
          stats.dissolvesRendered++;
        }
        report('dissolves', ++done, dissolves.length, `${d.a.clip.id}->${d.b.clip.id} (${d.n}f): ${hit ? 'cache' : 'rendered'}`);
      });
      await saveManifest();
    });

    // 5. audio (rendered whole every build: cheap)
    const masterLoud = resolvePreset(MASTER_PRESET_ID, p.delivery.overrides?.[MASTER_PRESET_ID]).loudness;
    const audio = await timed('audio', async () => {
      report('audio', 0, 1);
      const wav = await this.renderAudio(p, sources, totalFrames, paths.tmp, masterLoud, signal);
      report('audio', 1, 1);
      return wav;
    });

    // version paths (decided late so a failed build leaves no empty version folder behind)
    const versionId = nextVersionId(p);
    const versionDir = path.join(paths.out, versionId);
    const baseName = `${sanitizeName(p.meta.name, 'master')}_${versionId}`;
    const master = uniquePath(path.join(versionDir, `${baseName}.mov`));

    // 6. one pass: stitch cached segments (-c:v copy, never re-encoded) + mux the audio
    await timed('mux', async () => {
      report('mux', 0, 1);
      const list = tmpFile(paths.tmp, '.txt');
      const lines = ['ffconcat version 1.0'];
      for (const item of order) {
        const entry = manifest.entries[item.plan.key];
        if (!entry) throw new Error(`internal: no cache entry for ${item.plan.key}`);
        lines.push(`file ${concatQuote(path.join(paths.cacheSegments, entry.file))}`);
      }
      await writeFile(list, `${lines.join('\n')}\n`, 'utf8');
      const out = tmpFile(paths.tmp, '.mov');
      try {
        await run(
          this.tools.ffmpeg,
          [
            ...FF_BASE, '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio,
            '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2',
            '-t', sec(totalFrames, fps), '-video_track_timescale', String(movTimescale(fps)), out,
          ],
          { timeoutMs: Math.max(5 * 60_000, encodeTimeout(totalFrames, fps)), signal },
        );
        const got = await countVideoPackets(this.tools, out, signal);
        if (got !== totalFrames) {
          throw new Error(`stitched master has ${got} frames, timeline is ${totalFrames} (segments: ${order.map((i) => `${i.kind}:${manifest.entries[i.plan.key]?.frames}`).join(' ')})`);
        }
        await mkdir(versionDir, { recursive: true });
        await moveInto(out, master);
        report('mux', 1, 1, `${got} frames: ${master}`);
      } finally {
        await rm(list, { force: true });
        await rm(out, { force: true });
        await rm(audio, { force: true });
      }
    });

    const version: Version = {
      id: versionId,
      createdAt: new Date().toISOString(),
      planHash: planHash(p),
      master,
      reviewPlan: captureReviewPlan(p),
      clipSnapshots: snapshotClips(p),
      deliverables: {},
      stats,
    };
    p.versions.push(version);
    await saveProject(p);

    // 8. qc
    if (this.qc && !opts.skipQc) {
      const qc = this.qc;
      await timed('qc', async () => {
        report('qc', 0, 1);
        const starts = clipStartFrames(p);
        version.qc = await qc({
          tools: this.tools,
          signal,
          path: master,
          expectedFrames: totalFrames,
          fps,
          ...(masterLoud ? { loudness: { integratedLufs: masterLoud.integratedLufs, truePeakDb: masterLoud.truePeakDb } } : {}),
          contactSheetPath: uniquePath(path.join(versionDir, `${baseName}_contact.png`)),
          clipStarts: p.timeline.video.map((c) => ({ clipId: c.id, start: starts.get(c.id) ?? 0, dur: c.dur })),
        });
        await saveProject(p);
        report('qc', 1, 1, version.qc.ok ? 'ok' : `${version.qc.issues.length} issue(s)`);
      });
    }

    // 9. deliverables
    if (!opts.skipDeliver && p.delivery.targets.length) {
      await timed('deliver', () => this.deliver(p, versionId, p.delivery.targets, { ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(signal ? { signal } : {}) }));
    }

    stats.timingsMs['total'] = Math.round(performance.now() - t0);
    await saveProject(p);
    return { version, stats };
  }

  // ----- AE comps -----

  private async ensureCompRenders(
    p: Project,
    cacheRenders: string,
    stats: BuildStats,
    report: (stage: string, done: number, total: number, message?: string) => void,
    signal?: AbortSignal,
    force?: boolean,
    only?: Set<string>,
  ): Promise<void> {
    const used = only ?? usedAssetIds(p);
    const comps = Object.values(p.assets).filter((a): a is PinnableComp => a.kind === 'aecomp' && used.has(a.id));
    report('comps', 0, comps.length);
    const fingerprints = new Map<string, Record<string, string>>();
    for (const aep of new Set(comps.map((asset) => asset.aep))) {
      throwIfAborted(signal);
      fingerprints.set(aep, await this.ae.fingerprint(aep, [...new Set(comps.filter((asset) => asset.aep === aep).map((asset) => asset.comp))]));
    }
    let done = 0;
    for (const asset of comps) {
      throwIfAborted(signal);
      const fps = fingerprints.get(asset.aep)?.[asset.comp];
      if (!fps) throw new Error(`comp '${asset.comp}' not found in ${asset.aep}`);
      const pin = asset.revertPin;
      if (pin && !force && asset.render && existsSync(asset.render.path) && (fps === pin.compFingerprint || fps === asset.render.fingerprint)) {
        // reverted shot: keep the restored render (and its fingerprint, so its segments stay cached)
        asset.fingerprint = asset.render.fingerprint;
        asset.probe = await probe(this.tools, asset.render.path, { fps: p.meta.fps, signal });
        stats.compsReused++;
        report('comps', ++done, comps.length, `${asset.id}: kept reverted render from ${pin.version}`);
        continue;
      }
      if (pin) delete asset.revertPin; // the comp changed after the revert (or force): render it normally
      asset.fingerprint = fps;
      const cached = asset.render && asset.render.fingerprint === fps && existsSync(asset.render.path) && asset.probe;
      if (cached && !force) {
        stats.compsReused++;
        report('comps', ++done, comps.length, `${asset.id}: up to date`);
        continue;
      }
      const target = path.join(cacheRenders, `${asciiStem(asset.id)}_${fps.slice(0, 8)}.mov`);
      let rendered: { path: string; frames: Frames } | undefined;
      if (!force && existsSync(target)) {
        // Same fingerprint already rendered (e.g. project.json was rolled back): adopt it.
        const info = await probe(this.tools, target, { fps: p.meta.fps, signal });
        if (info.hasVideo && info.durationFrames > 0) rendered = { path: target, frames: info.durationFrames };
      }
      if (!rendered) {
        const res = await this.ae.render({ aep: asset.aep, comp: asset.comp, outPath: target, ...(signal ? { signal } : {}) });
        rendered = { path: res.path, frames: res.frames };
        stats.compsRendered++;
      } else {
        stats.compsReused++;
      }
      asset.probe = await probe(this.tools, rendered.path, { fps: p.meta.fps, signal });
      asset.render = { path: rendered.path, frames: asset.probe.durationFrames || rendered.frames, fingerprint: fps, renderedAt: new Date().toISOString() };
      report('comps', ++done, comps.length, `${asset.id}: rendered`);
    }
    if (comps.length) await saveProject(p);
  }

  // ----- sources -----

  private async resolveSources(
    p: Project,
    report: (stage: string, done: number, total: number, message?: string) => void,
    signal?: AbortSignal,
    /** preview: aecomps outside this set may lack a render and get a placeholder (never encoded) */
    needed?: Set<string>,
  ): Promise<Map<string, Source>> {
    const used = usedAssetIds(p);
    const out = new Map<string, Source>();
    const ids = [...used];
    report('probe', 0, ids.length);
    let done = 0;
    for (const id of ids) {
      throwIfAborted(signal);
      const a = p.assets[id];
      if (!a) throw new Error(`timeline refers to unknown asset '${id}'`);
      if (a.kind === 'aecomp') {
        if (needed && !needed.has(id) && (!a.render || !a.probe || !existsSync(a.render.path))) {
          const frames = a.render?.frames ?? a.probe?.durationFrames ?? 1e9;
          out.set(id, { assetId: id, kind: a.kind, path: '', probe: { durationFrames: frames, hasVideo: true, hasAudio: false }, identity: 'unrendered', timing: { fmtStartSec: 0, videoStartSec: 0, videoStartExpr: '0', audioStartSec: 0, cfr: true } });
          report('probe', ++done, ids.length, `${id} (not needed)`);
          continue;
        }
        if (!a.render || !a.probe) throw new Error(`internal: comp '${id}' has no render`);
        const timing = await probeTiming(this.tools, a.render.path, signal);
        // renderedAt is part of the identity so a forced re-render with an unchanged fingerprint invalidates its segments.
        out.set(id, { assetId: id, kind: a.kind, path: a.render.path, probe: a.probe, identity: `${a.render.fingerprint}@${a.render.renderedAt}`, timing });
      } else {
        if (!existsSync(a.path)) throw new Error(`asset '${id}' file missing: ${a.path}`);
        a.hash = await hashFile(a.path);
        const { info, timing } = await probeDetailed(this.tools, a.path, { fps: p.meta.fps, signal });
        a.probe = info;
        out.set(id, { assetId: id, kind: a.kind, path: a.path, probe: info, identity: a.hash, timing });
      }
      report('probe', ++done, ids.length, id);
    }
    return out;
  }

  // ----- cache -----

  /**
   * A cache file is trusted when its size + mtime match what the manifest recorded when its frame
   * count was last verified; otherwise the packets are re-counted (no decode) and the record refreshed.
   */
  private async cacheHit(manifest: CacheManifest, dir: string, key: string, frames: Frames, kind: CacheEntry['kind'], signal?: AbortSignal): Promise<boolean> {
    const entry = manifest.entries[key];
    if (entry && entry.frames !== frames) {
      delete manifest.entries[key];
      return false;
    }
    // Without an entry, a file present under the key name (manifest lost) is adopted when the frame count is right.
    const file = path.join(dir, entry?.file ?? `${key}.mov`);
    const st = await stat(file).catch(() => undefined);
    if (!st?.isFile()) {
      if (entry) delete manifest.entries[key];
      return false;
    }
    if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return true;
    const n = await countVideoPackets(this.tools, file, signal).catch(() => { throwIfAborted(signal); return -1; });
    if (n !== frames) {
      if (entry) delete manifest.entries[key];
      return false;
    }
    manifest.entries[key] = {
      ...(entry ?? { file: path.basename(file), frames, kind, mode: 'encode', createdAt: new Date().toISOString() }),
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
    return true;
  }

  private async recordCache(manifest: CacheManifest, key: string, final: string, entry: Omit<CacheEntry, 'file' | 'createdAt' | 'size' | 'mtimeMs'>): Promise<void> {
    const st = await stat(final);
    manifest.entries[key] = { ...entry, file: path.basename(final), createdAt: new Date().toISOString(), size: st.size, mtimeMs: st.mtimeMs };
  }

  // ----- segments -----

  private async renderSegment(p: Project, seg: SegmentPlan, paths: ReturnType<typeof projectPaths>, manifest: CacheManifest, signal?: AbortSignal): Promise<void> {
    const fps = p.meta.fps;
    const final = path.join(paths.cacheSegments, `${seg.key}.mov`);
    await rm(final, { force: true }); // stale/forced cache entry; cache files are regenerable
    const out = tmpFile(paths.tmp, '.mov');
    let mode: CacheEntry['mode'] = 'encode';

    if (await this.canStreamCopy(p, seg.src, seg.clip, signal)) {
      // Same origin as the encode path and clip audio: the video stream start, not the container start.
      const ss = seg.src.timing.videoStartSec - seg.src.timing.fmtStartSec + seg.srcIn / fps;
      await run(
        this.tools.ffmpeg,
        [...FF_BASE, '-y', '-ss', ss.toFixed(6), '-i', seg.src.path, '-map', '0:v:0', '-c:v', 'copy', '-an', '-frames:v', String(seg.frames), '-video_track_timescale', String(movTimescale(fps)), out],
        { timeoutMs: encodeTimeout(seg.frames, fps), signal },
      );
      const n = await countVideoPackets(this.tools, out, signal);
      const pts = await firstVideoPtsSec(this.tools, out, signal);
      if (n === seg.frames && Number.isFinite(pts) && Math.abs(pts) < 0.25 / fps) mode = 'copy';
      else await rm(out, { force: true }); // not frame-accurate on this file: re-encode instead
    }
    if (mode === 'encode') {
      const enc = this.encodeArgs(p, seg.src, seg.clip, seg.k0, seg.frames, out);
      await run(this.tools.ffmpeg, enc.args, { timeoutMs: budgetMs(enc.decodeSec), signal });
      const n = await countVideoPackets(this.tools, out, signal);
      if (n !== seg.frames) {
        await rm(out, { force: true });
        throw new Error(`segment ${seg.clip.id}: encoded ${n} frames, expected ${seg.frames} (source ${seg.src.path} may be shorter than the clip + handles)`);
      }
    }
    await moveInto(out, final);
    await this.recordCache(manifest, seg.key, final, { frames: seg.frames, kind: 'segment', mode, clipId: seg.clip.id });
  }

  /** Stream copy is frame-accurate only on all-intra ProRes 422 HQ at project size/fps (integer fps). */
  private async canStreamCopy(p: Project, src: Source, clip: Clip, signal?: AbortSignal): Promise<boolean> {
    const pr = src.probe;
    if (src.kind === 'still' || !pr.allIntra || pr.videoCodec !== 'prores') return false;
    if (pr.width !== p.meta.width || pr.height !== p.meta.height) return false;
    if (!Number.isInteger(p.meta.fps) || pr.fps === undefined || Math.abs(pr.fps - p.meta.fps) > 1e-3) return false;
    if ((clip.scale ?? 100) !== 100) return false;
    if (speedCurve(clip) || clip.pushIn) return false; // retime / zoom: encode
    if (pr.pixFmt && pr.pixFmt !== 'yuv422p10le') return false;
    return (await codecTag(this.tools, src.path, signal)) === 'apch';
  }

  /** ffmpeg args for a ProRes 422 HQ video-only piece of `frames` frames from clip-local timeline frame `k0`. */
  private encodeArgs(p: Project, src: Source, clip: Clip, k0: Frames, frames: Frames, out: string): { args: string[]; decodeSec: number } {
    const fps = p.meta.fps;
    const v = clipVideo(src, clip, k0, frames, p.meta, 0, 'v');
    const args = [...FF_BASE, '-y', ...(src.kind === 'still' ? [] : ['-copyts']), ...v.args, '-filter_complex', v.chains.join(';')];
    args.push('-map', '[v]', '-an', '-frames:v', String(frames), ...PRORES_HQ_ARGS, '-video_track_timescale', String(movTimescale(fps)), out);
    return { args, decodeSec: v.decodeSec };
  }

  // ----- dissolves -----

  private async renderDissolve(p: Project, d: DissolvePlan, paths: ReturnType<typeof projectPaths>, manifest: CacheManifest, signal?: AbortSignal): Promise<void> {
    const fps = p.meta.fps;
    const W = p.meta.width;
    const H = p.meta.height;
    const final = path.join(paths.cacheSegments, `${d.key}.mov`);
    await rm(final, { force: true });
    const out = tmpFile(paths.tmp, '.mov');

    const args = [...FF_BASE, '-y', '-copyts'];
    const chains: string[] = [];
    let inputs = 0;
    let decodeSec = 0;
    // One time base on both sides: blend evaluates T in its first input's time base, which is only
    // right when framesync does not have to pick a common one.
    const r = fpsExpr(fps).split('/');
    const tb = `settb=${r[1] ?? '1'}/${r[0]}`;
    const side = (src: Source, clip: Clip, k0: Frames, label: string) => {
      const v = clipVideo(src, clip, k0, d.n, { fps, width: W, height: H }, inputs++, label, [tb]);
      args.push(...v.args);
      chains.push(...v.chains);
      decodeSec += v.decodeSec;
    };
    side(d.a.src, d.a.clip, d.aK0, 'va');
    side(d.b.src, d.b.clip, d.bK0, 'vb');
    chains.push(`[va][vb]blend=all_expr='${dissolveExpr(d.n, fps)}'[v]`);
    args.push('-filter_complex', chains.join(';'), '-map', '[v]', '-an', '-frames:v', String(d.n), ...PRORES_HQ_ARGS, '-video_track_timescale', String(movTimescale(fps)), out);
    await run(this.tools.ffmpeg, args, { timeoutMs: budgetMs(decodeSec), signal });
    const n = await countVideoPackets(this.tools, out, signal);
    if (n !== d.n) {
      await rm(out, { force: true });
      throw new Error(`dissolve ${d.a.clip.id}->${d.b.clip.id}: got ${n} frames, expected ${d.n} (not enough handle in a source?)`);
    }
    await moveInto(out, final);
    await this.recordCache(manifest, d.key, final, { frames: d.n, kind: 'dissolve', mode: 'encode' });
  }

  // ----- audio -----

  private async renderAudio(
    p: Project,
    sources: Map<string, Source>,
    totalFrames: Frames,
    tmpDir: string,
    loud: DeliveryPreset['loudness'],
    signal?: AbortSignal,
  ): Promise<string> {
    const fps = p.meta.fps;
    const D = totalFrames / fps;
    const t = p.timeline;

    // clip audio (camera sound), extended into the handles and cross-faded under dissolves
    const clipPieces = (g: FilterGraph): string[] => {
      if (t.audio.useClipAudio === false) return [];
      const starts = clipStartFrames(p);
      const cutAfter = new Map(t.cuts.map((c) => [c.after, c.dissolve]));
      const labels: string[] = [];
      t.video.forEach((clip, i) => {
        const src = sources.get(clip.src);
        if (!src || !src.probe.hasAudio) return;
        const prev = i > 0 ? t.video[i - 1] : undefined;
        const nPrev = prev ? cutAfter.get(prev.id) ?? 0 : 0;
        const nNext = i < t.video.length - 1 ? cutAfter.get(clip.id) ?? 0 : 0;
        const before = splitDissolve(nPrev); // this clip supplies `a` frames before its in-point
        const after = splitDissolve(nNext); // and `b` frames after its out-point
        const curve = speedCurve(clip);
        if (curve) {
          labels.push(...retimedAudio(g, src, clip, curve, starts.get(clip.id) ?? 0, before.a, after, nPrev, nNext, fps));
          return;
        }
        const srcStart = Math.max(0, clip.in - before.a);
        const lead = clip.in - srcStart;
        const o = audioOrigin(src);
        const piece: AudioPiece = {
          input: g.input(src.path),
          startSec: o.originSec + srcStart / fps,
          endSec: o.originSec + (clip.in + clip.dur + after.b) / fps,
          streamStartSec: o.streamStartSec,
          atSec: ((starts.get(clip.id) ?? 0) - lead) / fps,
          gainDb: 0,
        };
        if (nPrev > 0) piece.fadeIn = { sec: nPrev / fps };
        if (nNext > 0) piece.fadeOut = { startSec: (lead + clip.dur - after.a) / fps, sec: nNext / fps };
        labels.push(g.piece(piece));
      });
      return labels;
    };

    const track = (g: FilterGraph, clips: AudioClip[]): string[] =>
      clips.map((c) => {
        const src = sources.get(c.src);
        if (!src) throw new Error(`audio clip '${c.id}' refers to unknown asset '${c.src}'`);
        const inF = c.in ?? 0;
        const srcLen = src.probe.durationFrames > 0 ? src.probe.durationFrames : undefined;
        let dur = c.dur ?? (srcLen !== undefined ? srcLen - inF : totalFrames - c.at);
        dur = Math.min(dur, totalFrames - c.at);
        const o = audioOrigin(src);
        const piece: AudioPiece = {
          input: g.input(src.path),
          startSec: o.originSec + inF / fps,
          endSec: o.originSec + (inF + dur) / fps,
          streamStartSec: o.streamStartSec,
          atSec: c.at / fps,
          gainDb: c.gainDb ?? 0,
        };
        if (c.fadeIn) piece.fadeIn = { sec: c.fadeIn / fps };
        if (c.fadeOut) piece.fadeOut = { startSec: (dur - c.fadeOut) / fps, sec: c.fadeOut / fps };
        return g.piece(piece);
      });

    const duck = t.audio.duck && t.audio.vo.length && t.audio.music.length ? t.audio.duck : undefined;
    let voLevelDb = -20;
    if (duck) {
      // Measure the VO premix on its own graph so the threshold lands `underDb` below the speech level.
      const gm = new FilterGraph();
      const voOnly = gm.mix(track(gm, t.audio.vo));
      if (voOnly) voLevelDb = await this.measureRms(gm, voOnly, signal);
    }

    const g = new FilterGraph();
    const clipMix = g.mix(clipPieces(g));
    const vo = g.mix(track(g, t.audio.vo));
    const music = g.mix(track(g, t.audio.music));
    const sfx = g.mix(track(g, t.audio.sfx));

    const finalInputs: string[] = [];
    if (clipMix) finalInputs.push(clipMix);
    if (sfx) finalInputs.push(sfx);
    if (duck && vo && music) {
      // Compressor: reduction ~= (level - threshold) * (1 - 1/ratio); solve threshold for the wanted dip.
      const ratio = 20;
      const thresholdDb = Math.max(-60, Math.min(-6, voLevelDb - Math.abs(duck.underDb) / (1 - 1 / ratio)));
      const threshold = Math.pow(10, thresholdDb / 20).toFixed(6);
      const voMain = g.label();
      const voSc = g.label();
      const voScPad = g.label();
      const musicPad = g.label();
      const ducked = g.label();
      const pad = `apad=whole_dur=${D.toFixed(6)},atrim=end=${D.toFixed(6)}`;
      g.add(`[${vo}]asplit=2[${voMain}][${voSc}]`);
      g.add(`[${voSc}]${pad}[${voScPad}]`);
      g.add(`[${music}]${pad}[${musicPad}]`);
      g.add(`[${musicPad}][${voScPad}]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=${Math.max(0.01, duck.attackMs)}:release=${Math.max(0.01, duck.releaseMs)}:makeup=1:detection=rms[${ducked}]`);
      finalInputs.push(voMain, ducked);
    } else {
      if (vo) finalInputs.push(vo);
      if (music) finalInputs.push(music);
    }

    const raw = tmpFile(tmpDir, '.wav');
    const args = [...FF_BASE, '-y'];
    const mixed = g.mix(finalInputs);
    if (!mixed) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', D.toFixed(6));
    } else {
      for (const f of g.inputs) args.push('-i', f);
      g.add(`[${mixed}]apad=whole_dur=${D.toFixed(6)},atrim=end=${D.toFixed(6)}[out]`);
      args.push('-filter_complex', g.toString(), '-map', '[out]');
    }
    // Float intermediate: a mix summing past 0 dBFS must reach loudnorm unclipped.
    args.push('-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', raw);
    await run(this.tools.ffmpeg, args, { timeoutMs: 20 * 60_000, signal });

    if (!loud) return raw; // muxed to pcm_s24le by the caller
    const target = { integratedLufs: loud.integratedLufs, truePeakDb: loud.truePeakDb, lra: loud.lra ?? 7 };
    const m = await measureLoudnorm(this.tools, raw, target, signal);
    if (!m) return raw; // silence: nothing to normalise
    const normalized = tmpFile(tmpDir, '.wav');
    await run(this.tools.ffmpeg, [...FF_BASE, '-y', '-i', raw, '-af', loudnormPass2(m, target), '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', normalized], { timeoutMs: 20 * 60_000, signal });
    await rm(raw, { force: true });
    return normalized;
  }

  /** Speech level estimate (dBFS) of one graph label: overall RMS, floored at RMS peak - 6 dB. */
  private async measureRms(g: FilterGraph, label: string, signal?: AbortSignal): Promise<number> {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
    for (const f of g.inputs) args.push('-i', f);
    g.add(`[${label}]astats=measure_perchannel=none:measure_overall=RMS_level+RMS_peak[m]`);
    args.push('-filter_complex', g.toString(), '-map', '[m]', '-f', 'null', '-');
    const { stderr } = await run(this.tools.ffmpeg, args, { timeoutMs: 10 * 60_000, signal });
    const grab = (k: string): number => {
      const m = new RegExp(`${k}:\\s*(-?[\\d.]+|-inf)`).exec(stderr);
      return m && m[1] !== '-inf' ? Number(m[1]) : Number.NEGATIVE_INFINITY;
    };
    const v = Math.max(grab('RMS level dB'), grab('RMS peak dB') - 6);
    return Number.isFinite(v) ? v : -20;
  }

  // ----- deliver -----

  async deliver(
    p: Project,
    versionId: string,
    targets: DeliveryTargetId[],
    opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {},
  ): Promise<Record<string, string>> {
    const version = p.versions.find((v) => v.id === versionId);
    if (!version) throw new Error(`unknown version ${versionId}`);
    if (!existsSync(version.master)) throw new Error(`master missing: ${version.master}`);
    const paths = projectPaths(p);
    const fps = p.meta.fps;
    const masterLoud = resolvePreset(MASTER_PRESET_ID, p.delivery.overrides?.[MASTER_PRESET_ID]).loudness;
    const masterProbe = await probe(this.tools, version.master, { fps, signal: opts.signal });
    const mw = masterProbe.width ?? p.meta.width;
    const mh = masterProbe.height ?? p.meta.height;
    const out: Record<string, string> = {};
    const baseName = `${sanitizeName(p.meta.name, 'master')}_${versionId}`;
    let done = 0;
    opts.onProgress?.({ stage: 'deliver', done: 0, total: targets.length });

    // captions / text overlays: burned into the targets that take them (never into the master)
    const burnTargets = new Set(captionTargets(p.captions, targets));
    const burning = targets.some((t) => burnTargets.has(t)) && !!p.captions && (p.captions.enabled || !!p.captions.texts?.length);
    let words = new Map<string, Word[]>();
    let subDir: string | undefined;
    if (burning) {
      if (!(await hasFilter(this.tools.ffmpeg, 'subtitles'))) {
        throw new Error('this ffmpeg cannot burn captions (no libass): install an ffmpeg with libass, e.g. `brew install ffmpeg-full` on macOS, or set EDITMCP_FFMPEG');
      }
      if (p.captions!.enabled) {
        words = await projectWords(p, this.tools, transcriptsDir(p), {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onTranscribe: (id) => opts.onProgress?.({ stage: 'deliver', done, total: targets.length, message: `transcribing ${id} (whisper)` }),
        });
      }
      if (!isAsciiPath(os.tmpdir())) throw new Error('captions need an ASCII TEMP directory; set TEMP/TMP to an ASCII path');
      subDir = await mkdtemp(path.join(os.tmpdir(), 'catcut-subs-'));
    }

    try {
    for (const target of targets) {
      throwIfAborted(opts.signal);
      const preset = resolvePreset(target, p.delivery.overrides?.[target]);
      const tfps = preset.video.fps ?? fps;
      const W = preset.video.width;
      const H = preset.video.height;
      const enc = presetToFfmpegArgs(preset, this.env, { width: W, height: H, fps: tfps });

      const vf: string[] = [];
      const sameAspect = Math.abs(W / H - mw / mh) < 0.01;
      const scale = W === mw && H === mh ? []
        : [sameAspect ? `scale=${W}:${H}:flags=lanczos` : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`];
      if (preset.video.interlaced && Math.abs(fps - tfps * 2) < 0.01) {
        // 50p master -> 25i: scale the progressive frames, then weave field pairs (scaling woven
        // frames would blend the two fields together).
        vf.push(...scale, 'tinterlace=interleave_top');
      } else {
        if (Math.abs(tfps - fps) > 1e-3) vf.push(`fps=${fpsExpr(tfps)}`);
        vf.push(...scale);
        // 25p master -> 25i: PsF (flag fields, keep every frame).
        if (preset.video.interlaced) vf.push('setfield=tff');
      }
      const ass = subDir && burnTargets.has(target) ? assFor(p, words, { width: W, height: H }) : undefined;
      if (ass) {
        const file = path.join(subDir!, `${preset.id}.ass`);
        await writeFile(file, ass, 'utf8');
        vf.push(subtitlesFilter(file));
      }
      vf.push('setsar=1');

      const args = [...FF_BASE, '-y', '-i', version.master, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','), ...enc.videoArgs];
      if (preset.loudness && !sameLoudness(preset.loudness, masterLoud)) {
        const t = { integratedLufs: preset.loudness.integratedLufs, truePeakDb: preset.loudness.truePeakDb, lra: preset.loudness.lra ?? 7 };
        const key = hashJson({ master: version.master, target: t });
        if (!this.loudnessCache.has(key)) this.loudnessCache.set(key, await measureLoudnorm(this.tools, version.master, t, opts.signal));
        const m = this.loudnessCache.get(key);
        if (m) args.push('-af', loudnormPass2(m, t));
      }
      args.push(...enc.audioArgs);
      const versionDir = path.join(paths.out, versionId);
      await mkdir(versionDir, { recursive: true });
      const final = uniquePath(path.join(versionDir, `${baseName}_${preset.id}.${enc.ext}`));
      const tmp = tmpFile(paths.tmp, `.${enc.ext}`);
      args.push(tmp);
      const cpu = presetToFfmpegArgs({ ...preset, video: { ...preset.video, useGpu: false } }, this.env, { width: W, height: H, fps: tfps });
      await this.encode(args, enc.videoArgs, cpu.videoArgs, encodeTimeout(masterProbe.durationFrames, fps), opts.signal);
      await moveInto(tmp, final);
      out[target] = final;
      version.deliverables[target] = final;
      await saveProject(p);
      opts.onProgress?.({ stage: 'deliver', done: ++done, total: targets.length, message: `${target}: ${final}` });
    }
    } finally {
      if (subDir) await rm(subDir, { recursive: true, force: true });
    }
    return out;
  }

  // ----- review proxy -----

  async reviewProxy(p: Project, versionId: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const version = p.versions.find((v) => v.id === versionId);
    if (!version) throw new Error(`unknown version ${versionId}`);
    const paths = projectPaths(p);
    const dir = path.join(paths.review, versionId);
    await mkdir(dir, { recursive: true });
    const final = uniquePath(path.join(dir, `${sanitizeName(p.meta.name, 'master')}_${versionId}_review.mp4`));
    const tmp = tmpFile(paths.tmp, '.mp4');
    const gpu = this.env.encoders.h264_nvenc;
    const vcodec = gpu ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
    const fps = version.reviewPlan?.fps ?? p.meta.fps;
    const frames = version.reviewPlan?.frames ?? timelineFrames(p);
    const h = Math.max(2, Math.floor(Math.min(540, version.reviewPlan?.height ?? p.meta.height) / 2) * 2);
    await this.encode(
      [...FF_BASE, '-y', '-i', version.master, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:${h}:flags=bicubic,setsar=1`, ...vcodec, '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps) * 2), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', tmp],
      vcodec, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'], encodeTimeout(frames, fps), opts.signal,
    );
    await moveInto(tmp, final);
    version.reviewProxy = final;
    await saveProject(p);
    return final;
  }

  // ----- quick range preview -----

  /**
   * Low-res H.264 preview of timeline frames [from, to) for quick A/B/C tryouts, written to
   * review/previews/ (never overwriting). From the current timeline only the segments and dissolves
   * that touch the range are encoded, into the normal segment cache (a later build reuses them), and
   * only the comps they use are rendered; audio is the whole mix (not loudness-normalised), trimmed.
   * With `version`, that version's master is trimmed instead.
   */
  async previewRange(p: Project, opts: PreviewRangeOptions): Promise<PreviewRangeResult> {
    const t0 = performance.now();
    const { signal } = opts;
    const fps = p.meta.fps;
    const paths = projectPaths(p);
    const report = (stage: string, done: number, total: number, message?: string) =>
      opts.onProgress?.({ stage, done, total, ...(message ? { message } : {}) });
    const scale = Math.min(1, Math.max(0.1, opts.scale ?? 0.5));
    const { from, to } = opts;
    if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from)) throw new Error(`bad preview range [${from}, ${to})`);
    const n = to - from;
    const dir = path.join(paths.review, 'previews');
    await mkdir(dir, { recursive: true });
    const label = opts.version ?? 'timeline';
    const final = uniquePath(path.join(dir, `${sanitizeName(p.meta.name, 'preview')}_${label}_${from}-${to}.mp4`));
    const tmp = tmpFile(paths.tmp, '.mp4');
    const gpu = this.env.encoders.h264_nvenc;
    const cpuArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
    const vcodec = gpu ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0'] : cpuArgs;
    const outArgs = [
      ...vcodec, '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps) * 2), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', tmp,
    ];
    const h = Math.max(2, Math.round((p.meta.height * scale) / 2) * 2);
    const counts = { segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0 };
    let warnings: string[] = [];

    if (opts.version) {
      const v = p.versions.find((x) => x.id === opts.version);
      if (!v) throw new Error(`unknown version ${opts.version}`);
      if (!existsSync(v.master)) throw new Error(`master missing: ${v.master}`);
      const total = v.reviewPlan?.frames ?? (await countVideoPackets(this.tools, v.master, signal));
      if (to > total) throw new Error(`preview range [${from}, ${to}) is past the end of ${v.id} (${total} frames)`);
      report('preview', 0, 1, `${v.id} ${from}-${to}`);
      await this.encode(
        [...FF_BASE, '-y', '-ss', sec(from, fps), '-i', v.master, '-map', '0:v:0', '-map', '0:a:0?', '-frames:v', String(n), '-t', sec(n, fps), '-vf', `scale=-2:${h}:flags=bicubic,setsar=1`, ...outArgs],
        vcodec, cpuArgs, encodeTimeout(n, fps), signal,
      );
    } else {
      if (p.timeline.video.length === 0) throw new Error('timeline.video is empty: nothing to preview');
      const total = timelineFrames(p);
      if (to > total) throw new Error(`preview range [${from}, ${to}) is past the end of the timeline (${total} frames)`);
      const structural = validateTimeline(withoutProbes(p));
      if (structural.length) throw new Error(`timeline invalid:\n - ${structural.join('\n - ')}`);
      warnings = retimeWarnings(p);
      warnings.forEach((w, i, all) => report('warning', i + 1, all.length, w));

      const needed = rangeClips(p, from, to);
      const neededAssets = new Set<string>([...needed].map((id) => p.timeline.video.find((c) => c.id === id)!.src));
      for (const c of [...p.timeline.audio.vo, ...p.timeline.audio.music, ...p.timeline.audio.sfx]) neededAssets.add(c.src);
      const stats: BuildStats = { segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} };
      await this.ensureCompRenders(p, paths.cacheRenders, stats, report, signal, false, neededAssets);
      const sources = await this.resolveSources(p, report, signal, neededAssets);
      await saveProject(p);
      const errors = validateTimeline(p);
      if (errors.length) throw new Error(`timeline invalid:\n - ${errors.join('\n - ')}`);

      const { order } = planTimeline(p, sources, this.encoderId);
      const starts = clipStartFrames(p);
      const picked: Array<{ item: ConcatItem; start: Frames }> = [];
      for (const item of order) {
        const start = item.kind === 'segment'
          ? (starts.get(item.plan.clip.id) ?? 0) + item.plan.trimStart
          : (starts.get(item.plan.a.clip.id) ?? 0) + item.plan.a.clip.dur - item.plan.half.a;
        const len = item.kind === 'segment' ? item.plan.frames : item.plan.n;
        if (start < to && start + len > from) picked.push({ item, start });
      }
      const manifest = await loadManifest(paths.cacheSegments);
      let done = 0;
      report('segments', 0, picked.length);
      await parallel(picked, this.concurrency, async ({ item }) => {
        if (item.kind === 'segment') {
          const seg = item.plan;
          if (await this.cacheHit(manifest, paths.cacheSegments, seg.key, seg.frames, 'segment', signal)) counts.segmentsReused++;
          else { await this.renderSegment(p, seg, paths, manifest, signal); counts.segmentsRendered++; }
        } else {
          const d = item.plan;
          if (!(await this.cacheHit(manifest, paths.cacheSegments, d.key, d.n, 'dissolve', signal))) { await this.renderDissolve(p, d, paths, manifest, signal); counts.dissolvesRendered++; }
        }
        report('segments', ++done, picked.length);
      });
      await writeManifest(paths.cacheSegments, manifest);

      const audio = await this.renderAudio(p, sources, total, paths.tmp, undefined, signal);
      const list = tmpFile(paths.tmp, '.txt');
      const lines = ['ffconcat version 1.0'];
      for (const { item } of picked) {
        const entry = manifest.entries[item.plan.key];
        if (!entry) throw new Error(`internal: no cache entry for ${item.plan.key}`);
        lines.push(`file ${concatQuote(path.join(paths.cacheSegments, entry.file))}`);
      }
      await writeFile(list, `${lines.join('\n')}\n`, 'utf8');
      const off = from - (picked[0]?.start ?? 0);
      try {
        report('preview', 0, 1, `${from}-${to}`);
        const graph = `[0:v:0]trim=start_frame=${off}:end_frame=${off + n},setpts=PTS-STARTPTS,scale=-2:${h}:flags=bicubic,setsar=1[v];`
          + `[1:a:0]atrim=start=${sec(from, fps)}:end=${sec(to, fps)},asetpts=PTS-STARTPTS[a]`;
        await this.encode(
          [...FF_BASE, '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-frames:v', String(n), ...outArgs],
          vcodec, cpuArgs, encodeTimeout(n + off, fps), signal,
        );
      } finally {
        await rm(list, { force: true });
        await rm(audio, { force: true });
      }
    }
    const got = await countVideoPackets(this.tools, tmp, signal);
    if (got !== n) {
      await rm(tmp, { force: true });
      throw new Error(`preview has ${got} frames, expected ${n}`);
    }
    await moveInto(tmp, final);
    report('preview', 1, 1, final);
    return {
      path: final, from, to, frames: n, source: opts.version ? 'version' : 'timeline', ...(opts.version ? { version: opts.version } : {}),
      ...counts, warnings, elapsedMs: Math.round(performance.now() - t0),
    };
  }
}

// ---------- speed helpers (audio, warnings, snapshots) ----------

/** Audio of a retimed clip is muted when motion interpolation slows it below 50% (atempo artefacts). */
function muteRetimedAudio(clip: Clip, curve: SpeedCurve): boolean {
  return clipInterpolation(clip) === 'motion' && Math.min(curve.r0, curve.r1) < 0.5;
}

/**
 * Clip audio of a retimed clip: atempo per constant-rate stretch (the ramp is one stretch at its average
 * tempo), each padded/trimmed to its exact timeline length so picture and sound meet at every boundary.
 * `lead` timeline frames before the in-point (dissolve handle) run at the start rate.
 */
function retimedAudio(
  g: FilterGraph, src: Source, clip: Clip, curve: SpeedCurve, start: Frames, leadWanted: Frames,
  after: { a: Frames; b: Frames }, nPrev: Frames, nNext: Frames, fps: number,
): string[] {
  if (muteRetimedAudio(clip, curve)) return [];
  const lead = Math.min(leadWanted, Math.floor(clip.in / curve.r0));
  const t0 = -lead;
  const t1 = clip.dur + after.b;
  const cuts = [t0, ...(curve.R > t0 && curve.R < t1 ? [curve.R] : []), t1];
  const o = audioOrigin(src);
  const labels: string[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    const s0 = clip.in + curvePos(curve, a);
    const s1 = clip.in + curvePos(curve, b);
    const piece: AudioPiece = {
      input: g.input(src.path),
      startSec: o.originSec + s0 / fps,
      endSec: o.originSec + s1 / fps,
      streamStartSec: o.streamStartSec,
      atSec: (start + a) / fps,
      gainDb: 0,
      tempo: (s1 - s0) / (b - a),
      exactSec: (b - a) / fps,
    };
    if (i === 0 && nPrev > 0) piece.fadeIn = { sec: nPrev / fps };
    if (i + 2 === cuts.length && nNext > 0) piece.fadeOut = { startSec: (clip.dur - after.a - a) / fps, sec: nNext / fps };
    labels.push(g.piece(piece));
  }
  return labels;
}

/** Advisory notes about speed / push-in choices (reported as 'warning' progress before a build or preview). */
function retimeWarnings(p: Project): string[] {
  const out: string[] = [];
  const clipAudio = p.timeline.audio.useClipAudio !== false;
  for (const clip of p.timeline.video) {
    const a = p.assets[clip.src];
    const curve = speedCurve(clip);
    if (!curve) continue;
    if (a?.kind === 'still') { out.push(`clip '${clip.id}': speed has no effect on a still`); continue; }
    const mode = clipInterpolation(clip);
    const audio = clipAudio && a?.probe?.hasAudio !== false && a?.kind !== 'graphic';
    if (mode === 'motion') out.push(`clip '${clip.id}': motion interpolation (minterpolate) is slow, roughly 10-50x slower than a normal encode; use blend for drafts`);
    if (audio && muteRetimedAudio(clip, curve)) out.push(`clip '${clip.id}': clip audio muted (motion slow-mo below 50%)`);
    else if (audio && curve.R > 0) out.push(`clip '${clip.id}': clip audio follows the ramp at its average tempo; picture and sound meet again at the ramp end`);
    if (Math.max(curve.r0, curve.r1) > 1 && mode !== 'nearest') out.push(`clip '${clip.id}': ${mode} interpolation on a speed-up mixes neighbouring frames (motion blur look)`);
  }
  return out;
}

/** Per-clip state of a build (shot_revert): the clip, and for comps the render + fingerprint it used. */
function snapshotClips(p: Project): NonNullable<Version['clipSnapshots']> {
  const out: NonNullable<Version['clipSnapshots']> = {};
  for (const clip of p.timeline.video) {
    const a = p.assets[clip.src];
    out[clip.id] = {
      clip: structuredClone(clip),
      ...(a?.kind === 'aecomp' && a.render ? { render: structuredClone(a.render), fingerprint: a.render.fingerprint } : {}),
    };
  }
  return out;
}

// ---------- planning (pure) ----------

/** The project with probe/render data hidden: validateTimeline then checks structure only. */
function withoutProbes(p: Project): Project {
  const assets: Project['assets'] = {};
  for (const [id, a] of Object.entries(p.assets)) {
    const copy = { ...a };
    delete copy.probe;
    if (copy.kind === 'aecomp') delete copy.render;
    assets[id] = copy;
  }
  return { ...p, assets };
}

/** Where clip frame 0 / an audio clip's `in` 0 sits on ffmpeg's input timeline, and where its audio starts. */
function audioOrigin(src: Source): { originSec: number; streamStartSec: number } {
  const t = src.timing;
  const origin = src.probe.hasVideo && src.kind !== 'still' ? t.videoStartSec : t.audioStartSec;
  return { originSec: origin - t.fmtStartSec, streamStartSec: t.audioStartSec - t.fmtStartSec };
}

/** Clips a preview of [from, to) needs: every clip whose span or dissolve touches the range. */
function rangeClips(p: Project, from: Frames, to: Frames): Set<string> {
  const out = new Set<string>();
  const video = p.timeline.video;
  const cutAfter = new Map(p.timeline.cuts.map((c) => [c.after, c.dissolve]));
  let pos = 0;
  video.forEach((clip, i) => {
    const start = pos;
    pos += clip.dur;
    if (start < to && pos > from) out.add(clip.id);
    const next = video[i + 1];
    const n = next ? cutAfter.get(clip.id) ?? 0 : 0;
    if (next && n > 0) {
      const { a, b } = splitDissolve(n);
      if (pos - a < to && pos + b > from) { out.add(clip.id); out.add(next.id); }
    }
  });
  return out;
}

function usedAssetIds(p: Project): Set<string> {
  const used = new Set<string>();
  for (const c of p.timeline.video) used.add(c.src);
  for (const c of [...p.timeline.audio.vo, ...p.timeline.audio.music, ...p.timeline.audio.sfx]) used.add(c.src);
  return used;
}

/** Segment / dissolve plans + concat order. Exported for tests; pure. */
export function planTimeline(p: Project, sources: Map<string, Source>, encoderId = ''): { segments: SegmentPlan[]; dissolves: DissolvePlan[]; order: ConcatItem[] } {
  const t = p.timeline;
  const fps = p.meta.fps;
  const cutAfter = new Map(t.cuts.map((c) => [c.after, c.dissolve]));
  const segments: SegmentPlan[] = t.video.map((clip, i) => {
    const src = sources.get(clip.src);
    if (!src) throw new Error(`clip '${clip.id}': unknown asset '${clip.src}'`);
    if (!src.probe.hasVideo) throw new Error(`clip '${clip.id}': asset '${clip.src}' has no video`);
    const prev = i > 0 ? t.video[i - 1] : undefined;
    const nPrev = prev ? cutAfter.get(prev.id) ?? 0 : 0;
    const nNext = i < t.video.length - 1 ? cutAfter.get(clip.id) ?? 0 : 0;
    const trimStart = splitDissolve(nPrev).b; // the dissolve before us owns our first b frames
    const trimEnd = splitDissolve(nNext).a; // the dissolve after us owns our last a frames
    const frames = clip.dur - trimStart - trimEnd;
    if (frames <= 0) throw new Error(`clip '${clip.id}': dissolves (${trimStart}+${trimEnd}) leave no body in ${clip.dur} frames`);
    const key = hashJson({
      schema: 3, // 3: seeking input + video-start origin + ffmpeg/encoder id
      enc: encoderId,
      src: src.identity, in: clip.in, dur: clip.dur, scale: clip.scale ?? 100,
      w: p.meta.width, h: p.meta.height, fps, handlesBefore: trimStart, handlesAfter: trimEnd,
      // only when set, so realtime clips keep their existing cache keys
      ...retimeKey(clip, src),
      ...(src.kind === 'still' ? {} : coarseTrimKey(src, fps)),
    });
    return { clip, index: i, src, key, srcIn: clip.in + trimStart, k0: trimStart, frames, trimStart, trimEnd };
  });

  const dissolves: DissolvePlan[] = [];
  const order: ConcatItem[] = [];
  segments.forEach((seg, i) => {
    order.push({ kind: 'segment', plan: seg });
    const next = segments[i + 1];
    if (!next) return;
    const n = cutAfter.get(seg.clip.id) ?? 0;
    if (n <= 0) return;
    const half = splitDissolve(n);
    const d: DissolvePlan = {
      a: seg, b: next, n, half,
      key: hashJson({ schema: 3, a: seg.key, b: next.key, n, curve: DISSOLVE_CURVE, enc: encoderId }),
      aK0: seg.clip.dur - half.a,
      bK0: -half.a,
    };
    const bNeed = -clipSourceNeeds(next.clip, half.a, 0).first;
    if (next.clip.in < bNeed && next.src.kind !== 'still') throw new Error(`cut ${seg.clip.id}->${next.clip.id}: dissolve ${n} needs ${bNeed} source frame(s) before '${next.clip.id}' in`);
    dissolves.push(d);
    order.push({ kind: 'dissolve', plan: d });
  });
  return { segments, dissolves, order };
}

/** Speed / push-in part of a segment key (empty for realtime clips; speed is a no-op on stills). */
function retimeKey(clip: Clip, src: Source): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const curve = src.kind === 'still' ? undefined : speedCurve(clip);
  if (curve) out['speed'] = { ...curve, interp: clipInterpolation(clip) };
  if (clip.pushIn) out['pushIn'] = clip.pushIn;
  return out;
}

/** concat demuxer path: forward slashes, single-quoted, embedded quotes escaped. */
function concatQuote(file: string): string {
  return `'${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

// ---------- manifest ----------

async function loadManifest(dir: string): Promise<CacheManifest> {
  try {
    const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as Partial<CacheManifest>;
    if (m.schema === 1 && m.entries && typeof m.entries === 'object') return { schema: 1, entries: m.entries };
  } catch { /* missing or corrupt: start fresh; files are re-adopted by frame count */ }
  return { schema: 1, entries: {} };
}

async function writeManifest(dir: string, m: CacheManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.manifest.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  await rename(tmp, path.join(dir, 'manifest.json'));
}

// ---------- small async pool ----------

async function parallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (next < items.length && failed === undefined) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (e) {
        failed = e ?? new Error('unknown failure');
        throw e;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  const results = await Promise.allSettled(workers);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}

const filterCache = new Map<string, Promise<Set<string>>>();

/** Whether this ffmpeg build has a filter (e.g. `subtitles` needs libass). */
export async function hasFilter(ffmpeg: string, name: string): Promise<boolean> {
  if (!filterCache.has(ffmpeg)) {
    filterCache.set(ffmpeg, execa(ffmpeg, ['-hide_banner', '-filters'], { reject: false, windowsHide: true, timeout: 30_000 })
      .then((r) => new Set(String(r.stdout ?? '').split(/\r?\n/).map((l) => /^\s*[A-Z.|]{2,3}\s+(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x))));
  }
  return (await filterCache.get(ffmpeg)!).has(name);
}

function isAsciiPath(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}
