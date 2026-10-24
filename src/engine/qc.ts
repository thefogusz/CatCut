/**
 * Automated QC for a rendered master / deliverable (DESIGN.md §5.4).
 *
 * One ffprobe (packet count, no decode) + at most three parallel ffmpeg passes:
 *   - analysis: blackdetect + freezedetect + silencedetect + ebur128 in a single decode
 *     (+ optional mpdecimate duplicate-frame cadence on a split of the same decoded video)
 *   - frame count via -count_frames, only when the container's nb_frames is not trustworthy
 *   - contact sheet (select/tile) with a timecode label when a font is available
 *
 * Detector events are read from BOTH the lavfi frame metadata printed to stdout
 * (`metadata=print:file=-`, ffmpeg >= 7 formats) and the classic stderr log lines,
 * then de-duplicated, so a change in either log format cannot blind the QC.
 * All frame positions are integer frames at `fps`; `endFrame` is exclusive.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Frames, QcIssue, QcReport, ToolPaths } from '../core/types.js';
import { labelFontOpt } from '../core/platform.js';
import { framesToTc } from '../core/timecode.js';

export interface QcLoudnessTarget {
  integratedLufs: number;
  truePeakDb: number; // ceiling
  toleranceLu?: number; // default 1.0 LU either side of integratedLufs
}

export interface QcClipStart {
  clipId: string;
  start: Frames;
  dur: Frames;
}

export interface QcArgs {
  tools: ToolPaths;
  path: string;
  expectedFrames: Frames;
  fps: number;
  loudness?: QcLoudnessTarget;
  contactSheetPath?: string; // png; an existing file is never overwritten (suffix _2, _3 ...)
  clipStarts?: QcClipStart[]; // timeline positions used to label issues with a clipId
  /** duplicate-frame cadence (stutter, e.g. slow motion made by repeating frames); off by default */
  duplicates?: boolean | QcDuplicateOptions;
  /** timeline-lint issues (flash / lowmotion ...) to carry into the report unchanged */
  lintIssues?: QcIssue[];
  signal?: AbortSignal;
  timeoutMs?: number; // per ffmpeg/ffprobe process; default scales with media duration
}

export interface QcDuplicateOptions {
  ranges?: Array<{ start: Frames; end: Frames }>; // only report inside these timeline ranges (end exclusive)
  minRatio?: number; // duplicated share of a window to count as cadence (default 0.3)
  minSec?: number; // window length (default 0.5 s)
  /** mpdecimate thresholds (8×8 block SAD); strict defaults so only near-identical frames count */
  hi?: number;
  lo?: number;
  frac?: number;
}

export interface LoudnessStats {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

// Detector thresholds (DESIGN.md §5.4 / module contract).
const BLACK_MIN_SEC = 0.2;
const BLACK_PIX_TH = 0.1;
const FREEZE_NOISE = '-50dB';
const FREEZE_MIN_SEC = 0.5;
const SILENCE_NOISE = '-50dB';
const SILENCE_MIN_SEC = 1.0;
const DEFAULT_TOLERANCE_LU = 1.0;
const DUP_MIN_RATIO = 0.3;
const DUP_MIN_SEC = 0.5;
const DUP_MAX_RATIO = 0.85; // above this the window is a freeze/still, which freezedetect reports
const DUP_MAX_RUN = 4; // cadence repeats a frame at most a few times in a row (20% slow motion = 4)
const DUP_HI = 64 * 4;
const DUP_LO = 64 * 2;
const DUP_FRAC = 0.33;

// Contact sheet layout.
const SHEET_COLUMNS = 6;
const SHEET_THUMB_WIDTH = 320;
const SHEET_TARGET_THUMBS = 36;


// ---------- process helper ----------

interface RunCtx {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Spawn with a timeout; a timeout or abort kills the child (ffmpeg has no grandchildren) and throws. */
async function run(file: string, args: string[], ctx: RunCtx): Promise<RunResult> {
  const r = await execa(file, args, {
    reject: false,
    windowsHide: true,
    stdin: 'ignore',
    timeout: ctx.timeoutMs,
    cancelSignal: ctx.signal,
    forceKillAfterDelay: 2000,
    maxBuffer: 256 * 2 ** 20, // showinfo lines (duplicates analysis) can be large on long masters
    stripFinalNewline: false,
  });
  if (r.isCanceled) throw new Error('QC cancelled');
  if (r.timedOut) throw new Error(`QC: ${basename(file)} timed out after ${ctx.timeoutMs} ms`);
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tail(s: string, lines = 6): string {
  return s.trim().split(/\r?\n/).slice(-lines).join('\n');
}

// ---------- probe ----------

interface StreamProbe {
  hasVideo: boolean;
  hasAudio: boolean;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  nbFrames?: number; // container-declared
  nbPackets?: number; // demuxed video packets
  durationSec?: number;
}

function parseRate(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const [n, d] = s.split('/').map(Number);
  if (!n || !d || !Number.isFinite(n / d)) return undefined;
  return n / d;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function probeStreams(tools: ToolPaths, path: string, ctx: RunCtx): Promise<StreamProbe> {
  const r = await run(
    tools.ffprobe,
    [
      '-v', 'error', '-count_packets',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_packets,duration:format=duration',
      '-of', 'json', path,
    ],
    ctx,
  );
  if (r.exitCode !== 0) throw new Error(`ffprobe failed on ${path}: ${tail(r.stderr)}`);
  let json: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    json = JSON.parse(r.stdout) as typeof json;
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${path}`);
  }
  const streams = json.streams ?? [];
  const v = streams.find((s) => s['codec_type'] === 'video');
  const a = streams.find((s) => s['codec_type'] === 'audio');
  const out: StreamProbe = { hasVideo: !!v, hasAudio: !!a };
  if (v) {
    out.codec = typeof v['codec_name'] === 'string' ? v['codec_name'] : undefined;
    out.width = num(v['width']);
    out.height = num(v['height']);
    out.fps = parseRate(v['avg_frame_rate']) ?? parseRate(v['r_frame_rate']);
    out.nbFrames = num(v['nb_frames']);
    out.nbPackets = num(v['nb_read_packets']);
    out.durationSec = num(v['duration']);
  }
  out.durationSec ??= num(json.format?.['duration']);
  return out;
}

/** Trust the container's frame count only when it agrees with the demuxed packet count; otherwise decode and count. */
async function countFrames(tools: ToolPaths, path: string, p: StreamProbe, ctx: RunCtx): Promise<Frames> {
  if (p.nbFrames && p.nbFrames > 0 && p.nbFrames === p.nbPackets) return p.nbFrames;
  const r = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', path],
    ctx,
  );
  if (r.exitCode !== 0) throw new Error(`ffprobe -count_frames failed on ${path}: ${tail(r.stderr)}`);
  try {
    const json = JSON.parse(r.stdout) as { streams?: Array<Record<string, unknown>> };
    const n = num(json.streams?.[0]?.['nb_read_frames']);
    if (n !== undefined) return n;
  } catch { /* fall through */ }
  throw new Error(`ffprobe -count_frames gave no frame count for ${path}`);
}

// ---------- detector output parsing ----------

interface SecRange {
  start: number;
  end?: number; // undefined = ran until EOF
}

/** Every `<key>=<n>` / `<key>: <n>` occurrence (lavfi metadata on stdout, filter log on stderr). */
function collectValues(text: string, key: string): number[] {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${key}\\s*[=:]\\s*(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)`, 'g');
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function dedupeSorted(values: number[]): number[] {
  const sorted = [...values].sort((x, y) => x - y);
  const out: number[] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || Math.abs(v - last) > 1e-4) out.push(v);
  }
  return out;
}

/** Pair `<prefix>_start` with the next `<prefix>_end`; the same event seen on stdout and stderr collapses to one. */
function parseRanges(text: string, prefix: string): SecRange[] {
  const starts = dedupeSorted(collectValues(text, `${prefix}_start`));
  const ends = dedupeSorted(collectValues(text, `${prefix}_end`));
  const ranges: SecRange[] = [];
  let ei = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const nextStart = starts[i + 1];
    while (ei < ends.length && ends[ei]! <= start) ei++;
    const end = ends[ei];
    if (end !== undefined && (nextStart === undefined || end <= nextStart + 1e-4)) {
      ranges.push({ start, end });
      ei++;
    } else {
      ranges.push({ start });
    }
  }
  return ranges;
}

function finiteDb(v: number): number {
  return Number.isFinite(v) ? v : -120; // ebur128 prints "-inf" for digital silence; keep JSON-safe
}

function parseDb(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  if (/^-?inf$/i.test(s)) return -Infinity;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

/** The ebur128 "Summary:" block on stderr. */
function parseEbur128Summary(stderr: string): LoudnessStats | undefined {
  const idx = stderr.lastIndexOf('Summary:');
  if (idx < 0) return undefined;
  const block = stderr.slice(idx);
  const i = parseDb(/\bI:\s*(-?[\d.]+|-?inf)\s*LUFS/i.exec(block)?.[1]);
  const lra = parseDb(/\bLRA:\s*(-?[\d.]+|-?inf)\s*LU\b/i.exec(block)?.[1]);
  const tp = parseDb(/\bPeak:\s*(-?[\d.]+|-?inf)\s*dBFS/i.exec(block)?.[1]);
  if (i === undefined || tp === undefined) return undefined;
  return { integratedLufs: finiteDb(i), truePeakDb: finiteDb(tp), lra: finiteDb(lra ?? 0) };
}

/** loudnorm first-pass JSON (fallback measurement). */
function parseLoudnormJson(stderr: string): LoudnessStats | undefined {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as Record<string, string>;
    const i = parseDb(j['input_i']);
    const tp = parseDb(j['input_tp']);
    const lra = parseDb(j['input_lra']);
    if (i === undefined || tp === undefined) return undefined;
    return { integratedLufs: finiteDb(i), truePeakDb: finiteDb(tp), lra: finiteDb(lra ?? 0) };
  } catch {
    return undefined;
  }
}

// ---------- analysis pass ----------

interface Analysis {
  black: SecRange[];
  freeze: SecRange[];
  silence: SecRange[];
  loudness?: LoudnessStats;
  kept?: number[]; // pts_time of frames mpdecimate kept (duplicates analysis only)
}

const VIDEO_CHAIN = `blackdetect=d=${BLACK_MIN_SEC}:pix_th=${BLACK_PIX_TH},freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_SEC},metadata=mode=print:file=-`;
const AUDIO_CHAIN = `silencedetect=n=${SILENCE_NOISE}:d=${SILENCE_MIN_SEC},ametadata=mode=print:file=-,ebur128=peak=true:framelog=quiet`;

function dupChain(o: QcDuplicateOptions): string {
  return `mpdecimate=hi=${o.hi ?? DUP_HI}:lo=${o.lo ?? DUP_LO}:frac=${o.frac ?? DUP_FRAC},showinfo=checksum=0,nullsink`;
}

/** pts_time of every frame showinfo printed (stderr log lines are atomic, unlike two stdout printers). */
function parseShowinfo(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/Parsed_showinfo_\d+[^\r\n]*?\bpts_time:\s*(-?\d+(?:\.\d+)?)/g)) out.push(Number(m[1]));
  return out;
}

async function analyze(tools: ToolPaths, path: string, p: StreamProbe, ctx: RunCtx, dup?: QcDuplicateOptions): Promise<Analysis> {
  const graph: string[] = [];
  const maps: string[] = [];
  if (p.hasVideo && dup) {
    graph.push(`[0:v:0]split=2[qv][qd]`, `[qv]${VIDEO_CHAIN}[v]`, `[qd]${dupChain(dup)}`);
    maps.push('-map', '[v]');
  } else if (p.hasVideo) { graph.push(`[0:v:0]${VIDEO_CHAIN}[v]`); maps.push('-map', '[v]'); }
  if (p.hasAudio) { graph.push(`[0:a:0]${AUDIO_CHAIN}[a]`); maps.push('-map', '[a]'); }
  if (graph.length === 0) return { black: [], freeze: [], silence: [] };
  const r = await run(
    tools.ffmpeg,
    ['-hide_banner', '-nostats', '-nostdin', '-v', 'info', '-i', path, '-filter_complex', graph.join(';'), ...maps, '-f', 'null', '-'],
    ctx,
  );
  if (r.exitCode !== 0) throw new Error(`ffmpeg QC analysis failed on ${path}: ${tail(r.stderr)}`);
  const text = `${r.stdout}\n${r.stderr}`;
  const out: Analysis = {
    black: parseRanges(text, 'black'),
    freeze: parseRanges(text, 'freeze'),
    silence: parseRanges(text, 'silence'),
  };
  if (p.hasAudio) out.loudness = parseEbur128Summary(r.stderr);
  if (p.hasVideo && dup) out.kept = parseShowinfo(r.stderr);
  return out;
}

/**
 * Cadence ranges (frames, end exclusive): windows of `minSec` where the duplicated share is between
 * minRatio and DUP_MAX_RATIO. Repeats longer than DUP_MAX_RUN frames are holds (freeze/black/still,
 * reported by freezedetect), not cadence, so they never count. Ranges are trimmed to the first
 * repeated pair and the last repeat.
 */
function duplicateRanges(kept: number[], frames: Frames, fps: number, o: QcDuplicateOptions): Array<{ start: Frames; end: Frames; ratio: number }> {
  if (!kept.length || frames <= 0) return [];
  const t0 = Math.min(...kept.slice(0, 4));
  const dup = new Uint8Array(frames).fill(1);
  for (const t of kept) {
    const f = Math.round((t - t0) * fps);
    if (f >= 0 && f < frames) dup[f] = 0;
  }
  for (let f = 0; f < frames;) {
    if (!dup[f]) { f++; continue; }
    let e = f;
    while (e < frames && dup[e]) e++;
    if (e - f > DUP_MAX_RUN) dup.fill(0, f, e); // a hold, not a cadence
    f = e;
  }
  const w = Math.max(2, Math.round((o.minSec ?? DUP_MIN_SEC) * fps));
  const minRatio = o.minRatio ?? DUP_MIN_RATIO;
  const mark = new Uint8Array(frames);
  let dups = 0;
  for (let f = 0; f < frames; f++) {
    dups += dup[f]!;
    if (f >= w) dups -= dup[f - w]!;
    if (f >= w - 1) {
      const ratio = dups / w;
      if (ratio >= minRatio && ratio <= DUP_MAX_RATIO) mark.fill(1, f - w + 1, f + 1);
    }
  }
  const out: Array<{ start: Frames; end: Frames; ratio: number }> = [];
  for (let f = 0; f < frames;) {
    if (!mark[f]) { f++; continue; }
    let e = f;
    while (e < frames && mark[e]) e++;
    let first = -1;
    let last = -1;
    let n = 0;
    for (let g = f; g < e; g++) if (dup[g]) { if (first < 0) first = g; last = g; n++; }
    if (first >= 0) {
      const start = Math.max(0, first - 1); // the frame being repeated starts the stutter
      const end = last + 1;
      out.push({ start, end, ratio: n / (end - start) });
    }
    f = e;
  }
  return out;
}

function clampToRanges(r: { start: Frames; end: Frames }, ranges: Array<{ start: Frames; end: Frames }> | undefined, minLen: Frames): Array<{ start: Frames; end: Frames }> {
  if (!ranges) return [r];
  return ranges
    .map((x) => ({ start: Math.max(r.start, x.start), end: Math.min(r.end, x.end) }))
    .filter((x) => x.end - x.start >= minLen);
}

/** Integrated loudness, true peak and LRA of the first audio stream (ebur128; loudnorm JSON as fallback). */
export async function measureLoudness(tools: ToolPaths, path: string): Promise<LoudnessStats> {
  const ctx: RunCtx = { timeoutMs: 10 * 60_000 };
  const common = ['-hide_banner', '-nostats', '-nostdin', '-v', 'info', '-i', path, '-map', '0:a:0', '-vn'];
  const a = await run(tools.ffmpeg, [...common, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], ctx);
  const fromEbur = a.exitCode === 0 ? parseEbur128Summary(a.stderr) : undefined;
  if (fromEbur) return fromEbur;
  const b = await run(tools.ffmpeg, [...common, '-af', 'loudnorm=I=-23:TP=-1:LRA=7:print_format=json', '-f', 'null', '-'], ctx);
  const fromLoudnorm = b.exitCode === 0 ? parseLoudnormJson(b.stderr) : undefined;
  if (fromLoudnorm) return fromLoudnorm;
  throw new Error(`loudness measurement failed on ${path}: ${tail(a.exitCode === 0 ? b.stderr : a.stderr)}`);
}

// ---------- contact sheet ----------

async function uniquePath(p: string): Promise<string> {
  if (!existsSync(p)) return p;
  const dir = dirname(p);
  const ext = extname(p);
  const stem = basename(p, ext);
  for (let i = 2; i < 10_000; i++) {
    const cand = join(dir, `${stem}_${i}${ext}`);
    if (!existsSync(cand)) return cand;
  }
  throw new Error(`cannot find a free name next to ${p}`);
}

function labelFilter(fontOpt: string, fps: number): string {
  // `%{pts\:hms}` = source time of the thumbnail, `f<n>` = source frame number.
  return `drawtext=${fontOpt}:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=3:x=6:y=6:text='%{pts\\:hms} f%{eif\\:round(t*${fps})\\:d}'`;
}

/**
 * fps=1/N style sampling, expressed in frames (select every `step`th frame) so the thumb count is exact,
 * tiled SHEET_COLUMNS wide. Label attempts: Windows Arial by file path (no fontconfig cache build), fontconfig
 * default sans, then no label at all. Returns the written path, or undefined with the reason.
 */
async function contactSheet(
  tools: ToolPaths, path: string, outPath: string, frames: Frames, fps: number, ctx: RunCtx,
): Promise<{ path?: string; error?: string }> {
  if (frames <= 0) return { error: 'no frames to sample' };
  const target = await uniquePath(outPath);
  await mkdir(dirname(target), { recursive: true });
  const step = Math.max(1, Math.ceil(frames / SHEET_TARGET_THUMBS));
  const thumbs = Math.ceil(frames / step);
  const rows = Math.max(1, Math.ceil(thumbs / SHEET_COLUMNS));
  const fontOpts: Array<string | undefined> = [];
  const labelFont = labelFontOpt();
  if (labelFont) fontOpts.push(labelFont);
  fontOpts.push('font=Sans', undefined);
  let lastErr = '';
  for (const fontOpt of fontOpts) {
    const chain = [
      `select='not(mod(n,${step}))'`,
      ...(fontOpt ? [labelFilter(fontOpt, fps)] : []),
      `scale=${SHEET_THUMB_WIDTH}:-2`,
      `tile=layout=${SHEET_COLUMNS}x${rows}:padding=2:margin=2:color=0x202020`,
    ].join(',');
    const r = await run(
      tools.ffmpeg,
      ['-hide_banner', '-nostats', '-nostdin', '-n', '-i', path, '-map', '0:v:0', '-vf', chain, '-frames:v', '1', '-update', '1', target],
      ctx,
    );
    if (r.exitCode === 0 && existsSync(target)) return { path: target };
    lastErr = tail(r.stderr, 3);
  }
  return { error: lastErr };
}

// ---------- report assembly ----------

interface IssueCtx {
  fps: number;
  totalFrames: Frames;
  clipStarts?: QcClipStart[];
}

function clipAt(frame: Frames, clips: QcClipStart[] | undefined): string | undefined {
  return clips?.find((c) => frame >= c.start && frame < c.start + c.dur)?.clipId;
}

function rangeIssue(kind: QcIssue['kind'], label: string, r: SecRange, c: IssueCtx): QcIssue {
  const startFrame = Math.max(0, Math.round(r.start * c.fps));
  const endFrame = r.end === undefined ? c.totalFrames : Math.round(r.end * c.fps);
  const tc = (f: Frames) => framesToTc(f, c.fps);
  const len = Math.max(0, endFrame - startFrame);
  const where = r.end === undefined ? `${tc(startFrame)} → ท้ายไฟล์` : `${tc(startFrame)} → ${tc(endFrame)}`;
  const clipId = clipAt(startFrame, c.clipStarts);
  const issue: QcIssue = {
    kind,
    severity: 'warn',
    startFrame,
    endFrame,
    message: `${label} ${where} (${len} เฟรม)${clipId ? ` [clip ${clipId}]` : ''}`,
  };
  if (clipId) issue.clipId = clipId;
  return issue;
}

/** A frozen picture inside a black interval is just the black interval; report it once. */
function withoutBlackFreezes(freeze: SecRange[], black: SecRange[], durationSec: number): SecRange[] {
  const end = (r: SecRange) => r.end ?? durationSec;
  return freeze.filter((f) => {
    const flen = end(f) - f.start;
    if (flen <= 0) return true;
    const covered = black.reduce((acc, b) => acc + Math.max(0, Math.min(end(f), end(b)) - Math.max(f.start, b.start)), 0);
    return covered / flen < 0.8;
  });
}

export async function runQc(args: QcArgs): Promise<QcReport> {
  const { tools, path, expectedFrames, fps } = args;
  const probeCtx: RunCtx = { timeoutMs: args.timeoutMs ?? 120_000, signal: args.signal };
  const p = await probeStreams(tools, path, probeCtx);
  const durationSec = p.durationSec ?? (p.nbPackets ?? expectedFrames) / fps;
  const ctx: RunCtx = { timeoutMs: args.timeoutMs ?? Math.max(120_000, Math.ceil(durationSec * 6) * 1000), signal: args.signal };

  const dupOpts: QcDuplicateOptions | undefined = args.duplicates === true ? {} : args.duplicates || undefined;
  const issues: QcIssue[] = [];
  if (!p.hasVideo) issues.push({ kind: 'spec', severity: 'error', message: `ไม่มี video stream: ${path}` });
  if (p.fps !== undefined && Math.abs(p.fps - fps) > 0.01) {
    issues.push({ kind: 'spec', severity: 'warn', message: `fps ของไฟล์ ${p.fps.toFixed(3)} ≠ ${fps} ที่คาด` });
  }

  const [frames, analysis, sheet] = await Promise.all([
    p.hasVideo ? countFrames(tools, path, p, ctx) : Promise.resolve(0),
    analyze(tools, path, p, ctx, dupOpts),
    args.contactSheetPath && p.hasVideo
      ? contactSheet(tools, path, args.contactSheetPath, p.nbPackets ?? expectedFrames, fps, ctx)
      : Promise.resolve<{ path?: string; error?: string }>({}),
  ]);

  if (frames !== expectedFrames) {
    issues.push({
      kind: 'frames',
      severity: 'error',
      startFrame: Math.min(frames, expectedFrames),
      endFrame: Math.max(frames, expectedFrames),
      message: `จำนวนเฟรม ${frames} ≠ ${expectedFrames} ที่วางแผน (${frames > expectedFrames ? 'เกิน' : 'ขาด'} ${Math.abs(frames - expectedFrames)} เฟรม)`,
    });
  }

  const ictx: IssueCtx = { fps, totalFrames: frames, clipStarts: args.clipStarts };
  for (const r of analysis.black) issues.push(rangeIssue('black', 'ภาพดำ (black)', r, ictx));
  for (const r of withoutBlackFreezes(analysis.freeze, analysis.black, durationSec)) {
    issues.push(rangeIssue('freeze', 'ภาพค้าง (freeze)', r, ictx));
  }
  for (const r of analysis.silence) issues.push(rangeIssue('silence', 'เสียงเงียบ (silence)', r, ictx));
  if (dupOpts && analysis.kept) {
    const minLen = Math.max(2, Math.round((dupOpts.minSec ?? DUP_MIN_SEC) * fps));
    for (const d of duplicateRanges(analysis.kept, frames, fps, dupOpts)) {
      for (const r of clampToRanges(d, dupOpts.ranges, minLen)) {
        const issue = rangeIssue('duplicate', `เฟรมซ้ำเป็นจังหวะ ~${Math.round(d.ratio * 100)}% (กระตุก/slow-mo แบบซ้ำเฟรม — ลอง interpolation blend/motion)`, { start: r.start / fps, end: r.end / fps }, ictx);
        issues.push(issue);
      }
    }
  }
  if (args.lintIssues) issues.push(...args.lintIssues);

  let loud = analysis.loudness;
  if (!loud && p.hasAudio) {
    try { loud = await measureLoudness(tools, path); } catch { /* reported below when a target was requested */ }
  }
  if (args.loudness) {
    const t = args.loudness;
    if (!loud) {
      issues.push({ kind: 'loudness', severity: 'error', message: p.hasAudio ? 'วัดความดังไม่ได้' : 'ไม่มี audio stream ให้วัดความดัง' });
    } else {
      const tol = t.toleranceLu ?? DEFAULT_TOLERANCE_LU;
      const diff = loud.integratedLufs - t.integratedLufs;
      if (Math.abs(diff) > tol) {
        issues.push({
          kind: 'loudness',
          severity: 'error',
          message: `ความดังรวม ${loud.integratedLufs.toFixed(1)} LUFS ${diff > 0 ? 'ดังกว่า' : 'เบากว่า'}เป้า ${t.integratedLufs} LUFS ${Math.abs(diff).toFixed(1)} LU (เกณฑ์ ±${tol} LU)`,
        });
      }
      if (loud.truePeakDb > t.truePeakDb) {
        issues.push({
          kind: 'truepeak',
          severity: 'error',
          message: `true peak ${loud.truePeakDb.toFixed(1)} dBTP เกินเพดาน ${t.truePeakDb} dBTP`,
        });
      }
    }
  }
  if (sheet.error) issues.push({ kind: 'spec', severity: 'warn', message: `สร้าง contact sheet ไม่สำเร็จ: ${sheet.error}` });

  issues.sort((x, y) => (x.kind === 'frames' ? -1 : y.kind === 'frames' ? 1 : (x.startFrame ?? -1) - (y.startFrame ?? -1)));

  const report: QcReport = {
    ok: !issues.some((i) => i.severity === 'error'),
    frames,
    expectedFrames,
    issues,
  };
  if (loud) {
    report.integratedLufs = loud.integratedLufs;
    report.truePeakDb = loud.truePeakDb;
    report.lra = loud.lra;
  }
  if (sheet.path) report.contactSheet = sheet.path;
  return report;
}
