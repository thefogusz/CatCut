/**
 * A/B compare between two built versions of the same project (DESIGN §13.2 row 9):
 * frame mapping between review plans, the list of versions that may be compared, and
 * a before/after contact sheet rendered with ffmpeg.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { labelFontOpt } from '../core/platform.js';
import { framesToTc } from '../core/timecode.js';
import type { Frames, Project, ReviewPlan, ToolPaths, Version } from '../core/types.js';
import { ReviewError, versionPlan } from './session.js';

/** A frame f in [start, start+dur) of the source plan maps to clamp(toStart + f - start, toMin, toMax). */
export interface MapSegment { start: Frames; dur: Frames; toStart: Frames; toMin: Frames; toMax: Frames }
export interface FrameMap {
  /** 'timecode': same length, same frame number. 'shot': lengths differ, matched by clip id. */
  method: 'timecode' | 'shot';
  warning?: string;
  segments: MapSegment[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** How frames of `from` land in `to`. Same length → by timecode; otherwise by shot id (source-aligned when the source is the same). */
export function mapFrames(from: ReviewPlan, to: ReviewPlan, labels: { from: string; to: string } = { from: 'A', to: 'B' }): FrameMap {
  const last = Math.max(0, to.frames - 1);
  if (from.frames === to.frames) return { method: 'timecode', segments: [{ start: 0, dur: from.frames, toStart: 0, toMin: 0, toMax: last }] };
  const unmatched: string[] = [];
  const segments = from.shots.map((s): MapSegment => {
    const t = to.shots.find(x => x.id === s.id);
    if (!t || t.dur <= 0) {
      unmatched.push(s.id);
      return { start: s.start, dur: s.dur, toStart: s.start, toMin: 0, toMax: last };
    }
    // Same source: keep the same source frame on screen; otherwise align shot starts.
    const toStart = t.src === s.src ? t.start + (s.in - t.in) : t.start;
    return { start: s.start, dur: s.dur, toStart, toMin: t.start, toMax: t.start + t.dur - 1 };
  });
  const warning = `ความยาวไม่เท่ากัน (${labels.from} ${from.frames} f · ${labels.to} ${to.frames} f) จับคู่เฟรมตามช็อต`
    + (unmatched.length ? ` · ไม่พบช็อต ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '…' : ''} ใช้ไทม์โค้ดเดิม` : '');
  return { method: 'shot', warning, segments };
}

export function mapFrame(map: FrameMap, f: Frames): Frames {
  const seg = map.segments.find(s => f >= s.start && f < s.start + s.dur) ?? map.segments[map.segments.length - 1];
  if (!seg) return 0;
  return clamp(seg.toStart + f - seg.start, seg.toMin, seg.toMax);
}

async function inside(dir: string, file: string): Promise<boolean> {
  try {
    const rel = relative(await realpath(dir), await realpath(file));
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  } catch { return false; }
}

export interface ComparableVersion { id: string; createdAt: string; frames: Frames; proxy: string; plan: ReviewPlan }

/**
 * Other versions of this project that can be shown next to `current`: valid id, a frozen shot plan,
 * the same fps, and a review proxy that exists inside the project folder.
 */
export async function comparableVersions(p: Project, current: Version): Promise<ComparableVersion[]> {
  const fps = versionPlan(p, current).fps;
  const out: ComparableVersion[] = [];
  for (const v of p.versions) {
    if (v.id === current.id || !/^v\d+$/.test(v.id) || !v.reviewProxy) continue;
    let plan: ReviewPlan;
    try { plan = versionPlan(p, v); } catch { continue; }
    if (plan.fps !== fps || !(await inside(p.dir, v.reviewProxy))) continue;
    out.push({ id: v.id, createdAt: v.createdAt, frames: plan.frames, proxy: v.reviewProxy, plan: structuredClone(plan) });
  }
  return out;
}

export async function findComparable(p: Project, current: Version, id: string): Promise<ComparableVersion> {
  if (!/^v\d+$/.test(id)) throw new ReviewError('Not found', 404);
  const found = (await comparableVersions(p, current)).find(v => v.id === id);
  if (!found) throw new ReviewError('Not found', 404);
  return found;
}

// ---------- before/after sheet ----------

export interface ComparePair { clipId?: string; a: Frames; b: Frames }

/** Pick frame pairs: explicit A frames, or the middle of each listed (or every) A shot; B frames come from the mapping. */
export function comparePairs(a: ReviewPlan, b: ReviewPlan, opts: { clipIds?: string[]; frames?: Frames[] } = {}, max = 24): { pairs: ComparePair[]; map: FrameMap } {
  const map = mapFrames(a, b);
  const shotAt = (f: Frames) => a.shots.find(s => f >= s.start && f < s.start + s.dur);
  let frames: Array<{ f: Frames; clipId?: string }>;
  if (opts.frames?.length) {
    frames = opts.frames.map(f => {
      if (!Number.isInteger(f) || f < 0 || f >= a.frames) throw new ReviewError(`frame ${f} is outside version A (0–${a.frames - 1})`);
      const s = shotAt(f);
      return { f, ...(s ? { clipId: s.id } : {}) };
    });
  } else {
    const shots = opts.clipIds?.length
      ? opts.clipIds.map(id => { const s = a.shots.find(x => x.id === id); if (!s) throw new ReviewError(`clip ${id} is not in version A`); return s; })
      : a.shots.filter(s => s.dur > 0);
    frames = shots.map(s => ({ f: s.start + Math.floor(s.dur / 2), clipId: s.id }));
  }
  if (!frames.length) throw new ReviewError('Nothing to compare');
  if (frames.length > max) throw new ReviewError(`At most ${max} pairs per sheet; pass clipIds or frames`);
  return { pairs: frames.map(({ f, clipId }) => ({ ...(clipId ? { clipId } : {}), a: f, b: mapFrame(map, f) })), map };
}

interface Side { id: string; media: string; plan: ReviewPlan }
export interface CompareSheetResult {
  path: string;
  sidecar: string;
  labelled: boolean;
  method: FrameMap['method'];
  warning?: string;
  pairs: Array<{ clipId?: string; a: { version: string; frame: Frames; tc: string }; b: { version: string; frame: Frames; tc: string } }>;
}

const THUMB_W = 480;

async function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; stderr: string }> {
  const r = await execa(file, args, { reject: false, windowsHide: true, stdin: 'ignore', timeout: timeoutMs, cancelSignal: signal, forceKillAfterDelay: 2000, maxBuffer: 16 * 2 ** 20 });
  if (r.isCanceled) throw new Error('compare sheet cancelled');
  if (r.timedOut) throw new Error(`compare sheet: ${basename(file)} timed out after ${timeoutMs} ms`);
  return { exitCode: r.exitCode ?? -1, stderr: String(r.stderr ?? '') };
}

function freePath(p: string): string {
  const ext = extname(p), stem = join(dirname(p), basename(p, ext));
  const free = (c: string) => !existsSync(c) && !existsSync(c.slice(0, -ext.length) + '.json');
  if (free(p)) return p;
  for (let i = 2; i < 10_000; i++) if (free(`${stem}_${i}${ext}`)) return `${stem}_${i}${ext}`;
  throw new Error(`cannot find a free name next to ${p}`);
}

/** Decode one master once and write the requested frames (sorted, unique) as PNGs into `dir`. */
async function grab(tools: ToolPaths, side: Side, frames: Frames[], dir: string, height: number, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  const select = frames.map(f => `eq(n\\,${f})`).join('+');
  const vf = `select='${select}',scale=${THUMB_W}:${height}:force_original_aspect_ratio=decrease,pad=${THUMB_W}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x101010,setsar=1`;
  const r = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-n', '-i', side.media, '-map', '0:v:0', '-vf', vf, '-fps_mode', 'passthrough', '-frames:v', String(frames.length), join(dir, 'f%04d.png')], timeoutMs, signal);
  const files = (await readdir(dir)).filter(f => /^f\d{4}\.png$/.test(f)).sort().map(f => join(dir, f));
  if (r.exitCode !== 0 || files.length !== frames.length) throw new Error(`could not read frames from ${side.id}: ${r.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`);
  return files;
}

const safeLabel = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24);

/** Render a two-column before/after sheet (A left, B right), one row per pair. Never overwrites. */
export async function renderCompareSheet(opts: {
  tools: ToolPaths; a: Side; b: Side; pairs: ComparePair[]; outPath: string; map: FrameMap; signal?: AbortSignal; timeoutMs?: number;
}): Promise<CompareSheetResult> {
  const { tools, a, b, pairs } = opts;
  if (!tools.ffmpeg) throw new Error('ffmpeg not found');
  if (!pairs.length) throw new Error('no frames to compare');
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const height = Math.max(2, Math.round((THUMB_W * a.plan.height) / a.plan.width / 2) * 2);
  const tmp = await mkdtemp(join(os.tmpdir(), 'editmcp-compare-'));
  try {
    const files = new Map<string, string>();
    for (const [key, side, list] of [['a', a, pairs.map(x => x.a)], ['b', b, pairs.map(x => x.b)]] as const) {
      const unique = [...new Set(list)].sort((x, y) => x - y);
      const dir = join(tmp, key);
      await mkdir(dir);
      const grabbed = await grab(tools, side, unique, dir, height, timeoutMs, opts.signal);
      unique.forEach((f, i) => files.set(`${key}${f}`, grabbed[i]!));
    }
    const target = freePath(opts.outPath);
    await mkdir(dirname(target), { recursive: true });
    const inputs = pairs.flatMap(x => ['-i', files.get(`a${x.a}`)!, '-i', files.get(`b${x.b}`)!]);
    const tc = (f: Frames) => framesToTc(f, a.plan.fps).replace(/:/g, '\\:');
    const label = (font: string, text: string) => `,drawtext=${font}:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4:x=8:y=8:text='${text}'`;
    const fonts: Array<string | undefined> = [];
    const labelFont = labelFontOpt();
    if (labelFont) fonts.push(labelFont);
    fonts.push('font=Sans', undefined);
    let lastErr = '';
    for (const font of fonts) {
      const graph = pairs.map((x, i) => {
        const clip = x.clipId ? ` ${safeLabel(x.clipId)}` : '';
        const la = font ? label(font, `A ${safeLabel(a.id)} ${tc(x.a)}${clip}`) : '';
        const lb = font ? label(font, `B ${safeLabel(b.id)} ${tc(x.b)}`) : '';
        return `[${2 * i}:v]pad=iw+4:ih+4:2:2:color=0x202020${la}[a${i}];[${2 * i + 1}:v]pad=iw+4:ih+4:2:2:color=0x202020${lb}[b${i}];[a${i}][b${i}]hstack=inputs=2[r${i}]`;
      });
      const rows = pairs.map((_, i) => `[r${i}]`).join('');
      graph.push(pairs.length > 1 ? `${rows}vstack=inputs=${pairs.length}[out]` : `${rows}null[out]`);
      const r = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-n', ...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', '-frames:v', '1', '-update', '1', target], timeoutMs, opts.signal);
      if (r.exitCode === 0 && existsSync(target)) {
        const result: CompareSheetResult = {
          path: target, sidecar: target.slice(0, -extname(target).length) + '.json', labelled: !!font, method: opts.map.method,
          ...(opts.map.warning ? { warning: opts.map.warning } : {}),
          pairs: pairs.map(x => ({ ...(x.clipId ? { clipId: x.clipId } : {}), a: { version: a.id, frame: x.a, tc: framesToTc(x.a, a.plan.fps) }, b: { version: b.id, frame: x.b, tc: framesToTc(x.b, b.plan.fps) } })),
        };
        await writeFile(result.sidecar, JSON.stringify({ versionA: a.id, versionB: b.id, ...result }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        return result;
      }
      lastErr = r.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
    }
    throw new Error(`compare sheet failed: ${lastErr}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Media used for the sheet: the ProRes master when present, else the review proxy. */
export function sheetMedia(v: Version): string {
  if (v.master && existsSync(v.master)) return v.master;
  if (v.reviewProxy && existsSync(v.reviewProxy)) return v.reviewProxy;
  throw new ReviewError(`${v.id} has no master or review proxy on disk`);
}
