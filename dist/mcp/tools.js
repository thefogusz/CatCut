/**
 * MCP tool definitions. Each tool: zod input shape + handler(args, state) → JSON-able data.
 * Errors thrown by a handler become `isError` results with a JSON body ({ ok: false, error, ...data }).
 * All times are frames at project fps (CLAUDE.md).
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isProtected, ProjectConflictError } from '../core/project.js';
import { framesToTc } from '../core/timecode.js';
import { openReview } from '../review/server.js';
import { agentReview, readReviewSession, submitReview, versionPlan } from '../review/session.js';
import { findAeDiskCache, preflight } from '../engine/housekeeping.js';
import { xmemlExportWarnings } from '../io/xmeml.js';
import { PRESETS } from '../engine/presets.js';
import { compsNeedingRender, isAeComp, requireFfmpeg, requireProject } from './state.js';
// ---------- result plumbing (shared: tooldef.ts) ----------
import { fail, ok, tool, ToolError } from './tooldef.js';
import { EXTRA_TOOLS } from './tools-extra.js';
import { createPremiereClient } from '../engine/premiere.js';
import { hasFilter } from '../engine/ffmpeg.js';
import { findWhisper, modelsDir } from '../engine/transcribe.js';
import { freeRamBytes } from '../core/platform.js';
/** Tools that change the project while a build/deliver/review job may be using it. */
const MUTATING = new Set(['project_new', 'project_open', 'asset_add', 'timeline_set', 'timeline_edit', 'audio_add', 'ae_edit', 'import_premiere_xml', 'timeline_restore']);
/** Tools that write into the open project's folder. */
const WRITES_PROJECT = new Set([
    'asset_add', 'timeline_set', 'timeline_edit', 'audio_add', 'ae_edit', 'import_premiere_xml', 'timeline_restore',
    'build', 'deliver', 'preview', 'review_open', 'review_submit', 'export_premiere_xml',
]);
export async function runTool(t, args, state) {
    try {
        if (MUTATING.has(t.name) || t.mutating) {
            const running = activeJob(state, PROJECT_JOBS);
            if (running)
                throw new ToolError(`wait for ${running.name} before editing the project`, { jobId: running.id });
        }
        if ((WRITES_PROJECT.has(t.name) || t.writesProject) && state.project)
            assertWritable(state.project.dir, 'project folder');
        return ok(await t.handler(args, state));
    }
    catch (err) {
        if (err instanceof ProjectConflictError || (err instanceof Error && err.name === 'ProjectConflictError'))
            return fail(await onConflict(state, err));
        return fail(err);
    }
}
/** Another process saved project.json in a conflicting way: reload so the agent's retry starts from disk. */
async function onConflict(state, err) {
    const data = { conflicts: err.conflicts ?? [] };
    const p = state.project;
    if (p && !activeJob(state, PROJECT_JOBS)) {
        try {
            state.project = await state.api.project.loadProject(p.dir);
            data['reloaded'] = true;
        }
        catch (e) {
            data['reloaded'] = false;
            data['reloadError'] = e instanceof Error ? e.message : String(e);
        }
    }
    return new ToolError('โปรเจกต์ถูกแก้จากที่อื่น — โหลดใหม่แล้วลองอีกครั้ง / project.json was changed elsewhere: reloaded, retry the edit', data);
}
/** Validate args with the tool's schema and run it (used by the CLI and tests). */
export async function callTool(state, name, args = {}) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t)
        throw new Error(`unknown tool: ${name}`);
    const parsed = z.object(t.input).safeParse(args);
    if (!parsed.success)
        return fail(new ToolError('invalid arguments', { issues: parsed.error.issues }));
    return runTool(t, parsed.data, state);
}
/** Parse the JSON body of a ToolResult. */
export function toolResultData(r) {
    const text = r.content[0]?.text ?? '{}';
    return JSON.parse(text);
}
// ---------- schemas ----------
const frames = z.number().int();
const layerRef = z.union([z.string(), z.number()]);
const ClipSchema = z.object({
    id: z.string().min(1),
    src: z.string().min(1).describe('asset id'),
    in: frames.min(0).describe('source in-point (frames)'),
    dur: frames.describe('timeline duration (frames)'),
    scale: z.number().optional().describe('percent, default 100'),
    marker: z.string().optional().describe('marker name at clip start'),
    slot: z.string().optional().describe('board slot id this clip realises'),
    speed: z.object({
        rate: z.number().min(0.05).max(20).describe('0.5 = 50% slow motion, 2 = 200%; source frames used = round(dur * rate)'),
        rampFrom: z.number().min(0.05).max(20).optional().describe('ramp: start rate, eased (smoothstep) to `rate` over rampFrames'),
        rampFrames: frames.min(0).optional().describe('ramp length in timeline frames at the clip start (needs rampFrom)'),
        interpolation: z.enum(['nearest', 'blend', 'motion']).optional().describe('nearest = repeat/drop frames; blend = mix neighbours (default for slow motion); motion = optical flow (minterpolate, very slow)'),
    }).optional().describe('retime; omit for realtime'),
    pushIn: z.number().min(0).max(100).optional().describe('slow centred zoom over the clip in percent (8 = 100%→108%), on top of scale'),
});
const CutSchema = z.object({
    after: z.string().describe('clip id; the cut between it and the next clip'),
    dissolve: frames.min(0).describe('frames; 0 = hard cut'),
});
const AudioClipSchema = z.object({
    id: z.string().min(1),
    src: z.string().min(1).describe('asset id'),
    at: frames.min(0).describe('timeline position (frames)'),
    in: frames.min(0).optional(),
    dur: frames.optional(),
    gainDb: z.number().optional(),
    fadeIn: frames.min(0).optional(),
    fadeOut: frames.min(0).optional(),
});
const DuckSchema = z.object({ underDb: z.number(), attackMs: z.number(), releaseMs: z.number() });
const AudioTracksSchema = z.object({
    vo: z.array(AudioClipSchema).default([]),
    music: z.array(AudioClipSchema).default([]),
    sfx: z.array(AudioClipSchema).default([]),
    duck: DuckSchema.optional(),
    useClipAudio: z.boolean().optional(),
});
const TimelineSchema = z.object({
    video: z.array(ClipSchema),
    cuts: z.array(CutSchema).default([]),
    audio: AudioTracksSchema.default({ vo: [], music: [], sfx: [] }),
});
const AeOpSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('setText'), layer: layerRef, text: z.string(), fontSize: z.number().optional(), font: z.string().optional(), color: z.tuple([z.number(), z.number(), z.number()]).optional() }),
    z.object({ op: z.literal('replaceFootage'), layer: layerRef, path: z.string() }),
    z.object({ op: z.literal('shiftLayer'), layer: layerRef, frames }),
    z.object({ op: z.literal('setProperty'), layer: layerRef, property: z.string(), value: z.unknown(), atFrame: frames.optional() }),
    z.object({ op: z.literal('addEffect'), layer: layerRef, matchName: z.string(), properties: z.record(z.unknown()).optional() }),
    z.object({ op: z.literal('applyPreset'), layer: layerRef, ffxPath: z.string() }),
    z.object({ op: z.literal('setLayerEnabled'), layer: layerRef, enabled: z.boolean() }),
    z.object({ op: z.literal('duplicateComp'), newName: z.string() }),
    z.object({ op: z.literal('script'), jsx: z.string() }),
]);
const EditOpSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('insert'), clip: ClipSchema, index: z.number().int().min(0).optional(), after: z.string().optional().describe('insert after this clip id (default: end)') }),
    z.object({ op: z.literal('move'), id: z.string(), index: z.number().int().min(0) }),
    z.object({ op: z.literal('remove'), id: z.string() }),
    z.object({ op: z.literal('trim'), id: z.string(), in: frames.min(0).optional(), dur: frames.optional() }),
    z.object({ op: z.literal('set_dissolve'), after: z.string(), frames: frames.min(0).describe('0 removes the dissolve') }),
    z.object({ op: z.literal('set_marker'), id: z.string(), name: z.string().optional().describe('omit to remove') }),
    z.object({ op: z.literal('set_scale'), id: z.string(), scale: z.number().positive() }),
    z.object({ op: z.literal('remove_audio'), id: z.string() }),
]);
// ---------- helpers ----------
const WIN = process.platform === 'win32';
function samePath(a, b) {
    const x = resolve(a);
    const y = resolve(b);
    return WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/** Never overwrite: returns p, or p_2, p_3 ... (before the extension). */
export function uniquePath(p) {
    if (!existsSync(p))
        return p;
    const ext = extname(p);
    const base = ext ? p.slice(0, -ext.length) : p;
    for (let i = 2;; i++) {
        const c = `${base}_${i}${ext}`;
        if (!existsSync(c))
            return c;
    }
}
function fileSafe(name) {
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'untitled';
}
function asciiSlug(s) {
    const slug = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (slug === s)
        return slug;
    // non-ASCII (e.g. Thai) names: keep a stable short hash so different comps never collide
    let h = 0;
    for (const ch of s)
        h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return `${slug || 'comp'}_${h.toString(16)}`;
}
// ---------- write confinement ----------
function isInside(child, parent) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** Refuse writes into protected trees (EDITMCP_PROTECTED_PATHS). */
function assertWritable(target, what) {
    if (isProtected(target))
        throw new ToolError(`ห้ามเขียนในโฟลเดอร์ที่ป้องกันไว้ / refusing to write ${what} inside a protected path`, { path: target });
}
/** A Windows path ("D:\\job") off Windows would become a folder literally named "D:\\job" in the current directory. */
function nativeDir(p) {
    if (!WIN && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p)) {
        throw new ToolError(`path ของ Windows ใช้บนเครื่องนี้ไม่ได้ / a Windows path cannot be used on ${process.platform}: ${p}`, { path: p });
    }
    return resolve(p);
}
/** AE outputs must land inside the open project or next to (below the folder of) the source .aep. */
function assertConfined(state, target, aep, what) {
    const roots = [dirname(aep), ...(state.project ? [state.project.dir] : [])];
    if (!roots.some((r) => isInside(target, r))) {
        throw new ToolError(`${what} ต้องอยู่ในโฟลเดอร์โปรเจกต์หรือโฟลเดอร์ของ .aep / ${what} must be inside the project folder or next to the .aep`, { path: target, allowed: roots });
    }
    assertWritable(target, what);
}
// ---------- AE jobs ----------
const AE_WAIT_MS = 20_000;
/**
 * AE calls run as jobs so they never block the MCP request behind a build's renders. When the job
 * queue is busy (or wait=false) the job id is returned immediately; otherwise we wait up to ~20 s.
 */
async function runAeJob(state, name, wait, fn) {
    const busy = state.jobs.list().some((j) => j.status === 'running' || j.status === 'queued');
    const job = state.jobs.start(name, fn);
    const pending = () => ({
        ok: true, jobId: job.id, status: state.jobs.get(job.id)?.status ?? job.status, pending: true,
        hint: 'After Effects กำลังทำงานหรือรอคิว — รอผลด้วย job_wait {id} / AE is busy or queued: call job_wait {id}',
    });
    if (!(wait ?? !busy))
        return pending();
    let timer;
    const info = await Promise.race([
        state.jobs.wait(job.id),
        new Promise((r) => { timer = setTimeout(() => r(undefined), AE_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (!info)
        return pending();
    if (info.status === 'done')
        return { ...info.result, jobId: job.id };
    throw new ToolError(info.error ?? `${name} ${info.status}`, { jobId: job.id, status: info.status });
}
/** Backends may flag comps whose effect values (Curves, Levels...) are not part of the fingerprint. */
function isOpaque(res, comp) {
    if (!res || typeof res !== 'object')
        return false;
    const r = res;
    return r.opaque === true || (Array.isArray(r.opaqueComps) && r.opaqueComps.includes(comp));
}
function opaqueHint(state, aep, comp) {
    const ids = state.project ? Object.values(state.project.assets).filter(isAeComp).filter((a) => a.comp === comp && samePath(a.aep, aep)).map((a) => a.id) : [];
    const forceArg = ids.length ? `build {forceAssets: ${JSON.stringify(ids)}}` : 'build {forceAssets: [<asset id>]}';
    return {
        opaque: true,
        opaqueAssets: ids,
        opaqueHint: `comp '${comp}' มีค่าเอฟเฟกต์ที่อ่านไม่ได้ (เช่น Curves/Levels) — ถ้าแก้แค่ในนั้น fingerprint จะไม่เปลี่ยน ต้องใช้ build {force: true} หรือ ${forceArg} / opaque effect values are not fingerprinted: force the re-render`,
    };
}
/**
 * build {forceAssets}: drop the render record and move the cached render aside (never deleted) so the
 * Assembler cannot adopt the same-fingerprint file and has to render the comp again.
 */
async function forgetRenders(state, p, ids, ctx) {
    const moved = {};
    if (!ids.length)
        return moved;
    for (const id of ids) {
        const a = p.assets[id];
        if (!a || !isAeComp(a))
            continue;
        const old = a.render?.path;
        if (old && existsSync(old)) {
            const ext = extname(old);
            const aside = uniquePath(`${old.slice(0, old.length - ext.length)}_forced${ext}`);
            await rename(old, aside);
            moved[id] = aside;
            ctx.log(`${id}: previous render kept as ${aside}`);
        }
        delete a.render;
    }
    await state.api.project.saveProject(p);
    return moved;
}
// ---------- timeline backups ----------
const BACKUP_RE = /^timeline-(.+)-(\d+)\.json$/;
/** history/timeline-<ISO-safe>-<n>.json; never overwrites. */
async function backupTimeline(p, reason) {
    const dir = join(p.dir, 'history');
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const stamp = now.replace(/[:.]/g, '-');
    const body = `${JSON.stringify({ savedAt: now, reason, timeline: p.timeline }, null, 2)}\n`;
    for (let n = 1;; n++) {
        const file = join(dir, `timeline-${stamp}-${n}.json`);
        try {
            await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
            return file;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
        }
    }
}
async function listBackups(p) {
    const dir = join(p.dir, 'history');
    const names = existsSync(dir) ? (await readdir(dir)).filter((n) => BACKUP_RE.test(n)) : [];
    const key = (n) => { const m = BACKUP_RE.exec(n); return [m[1], Number(m[2])]; };
    names.sort((x, y) => { const [a, i] = key(x); const [b, j] = key(y); return a < b ? -1 : a > b ? 1 : i - j; });
    return Promise.all(names.map(async (name) => {
        try {
            const d = JSON.parse(await readFile(join(dir, name), 'utf8'));
            const video = d.timeline?.video ?? [];
            return { name, savedAt: d.savedAt, reason: d.reason, clips: video.length, frames: video.reduce((s, c) => s + (c.dur > 0 ? c.dur : 0), 0) };
        }
        catch {
            return { name, error: 'unreadable' };
        }
    }));
}
/** Validate a candidate timeline against the project's assets without touching the project. */
function validateCandidate(state, p, t) {
    const probe = { ...p };
    state.api.project.setTimeline(probe, t);
    return { errors: state.api.project.validateTimeline(probe), timeline: probe.timeline };
}
function assetSummary(a) {
    const pr = a.probe;
    const base = {
        id: a.id,
        kind: a.kind,
        frames: pr?.durationFrames,
        size: pr?.width && pr.height ? `${pr.width}x${pr.height}` : undefined,
        fps: pr?.fps,
        hasAudio: pr?.hasAudio,
    };
    if (isAeComp(a)) {
        const stale = !!a.render && a.fingerprint !== undefined && a.render.fingerprint !== a.fingerprint;
        return { ...base, aep: a.aep, comp: a.comp, render: a.render ? { path: a.render.path, frames: a.render.frames, stale } : null, needsRender: !a.render || stale };
    }
    return { ...base, path: a.path };
}
function timelineSummary(state, p) {
    const fps = p.meta.fps;
    const total = state.api.project.timelineFrames(p);
    const starts = state.api.project.clipStartFrames(p);
    const t = p.timeline;
    return {
        frames: total,
        tc: framesToTc(total, fps),
        clips: t.video.map((c) => {
            const start = starts.get(c.id) ?? 0;
            return { id: c.id, src: c.src, start, startTc: framesToTc(start, fps), in: c.in, dur: c.dur, scale: c.scale, marker: c.marker };
        }),
        dissolves: t.cuts.filter((c) => c.dissolve > 0),
        audio: { vo: t.audio.vo.length, music: t.audio.music.length, sfx: t.audio.sfx.length, duck: t.audio.duck, useClipAudio: t.audio.useClipAudio ?? true },
    };
}
function jobSummary(j, logLines = 20) {
    return { ...j, log: j.log.slice(-logLines) };
}
function activeJob(state, names) {
    return state.jobs.list().find((j) => (j.status === 'running' || j.status === 'queued') && names.includes(j.name));
}
const PROJECT_JOBS = ['build', 'deliver', 'preview', 'review_open'];
function reviewVersion(p, id) {
    const v = id ? p.versions.find(x => x.id === id) : p.versions[p.versions.length - 1];
    if (!v)
        throw new ToolError('ไม่พบเวอร์ชัน ต้อง build ก่อน / unknown version: build first');
    return v;
}
function reviewKey(p, v) { return `${p.dir}/${v.id}`; }
function startReviewJob(state, id, open, wait = true) {
    const p = requireProject(state);
    const v = reviewVersion(p, id);
    const running = activeJob(state, PROJECT_JOBS);
    if (running)
        throw new ToolError(`wait for ${running.name} before creating a review`, { jobId: running.id });
    const snapshot = versionPlan(p, v);
    if (!open || !v.reviewProxy || !existsSync(v.reviewProxy))
        requireFfmpeg(state);
    const job = state.jobs.start(open ? 'review_open' : 'preview', async (ctx) => {
        v.reviewPlan ??= structuredClone(snapshot);
        if (!open || !v.reviewProxy || !existsSync(v.reviewProxy)) {
            ctx.log('creating review proxy');
            v.reviewProxy = await state.assembler.reviewProxy(p, v.id, { signal: ctx.signal });
        }
        ctx.signal.throwIfAborted();
        await state.api.project.saveProject(p);
        if (!open)
            return { version: v.id, reviewProxy: v.reviewProxy };
        state.reviews ??= new Map();
        const key = reviewKey(p, v);
        let review = state.reviews.get(key);
        if (!review) {
            review = await openReview(p, v);
            if (ctx.signal.aborted) {
                await review.close();
                ctx.signal.throwIfAborted();
            }
            state.reviews.set(key, review);
        }
        return { version: v.id, url: review.url, hint: 'เปิด URL เพื่อรีวิว แล้วอ่าน review_notes; เสนอแผนแก้ก่อนลงมือ / read review_notes after submission, propose edits before applying' };
    });
    return awaitJob(state, job.id, wait ? QUICK_WAIT_MS : 0, { version: v.id });
}
const QUICK_WAIT_MS = 20_000;
/** Wait up to `ms` for a job: its result when done, a pending stub (job_wait hint) when still running. */
async function awaitJob(state, id, ms, extra = {}) {
    const info = await waitJob(state, id, ms);
    if (!info) {
        return { ok: true, ...extra, jobId: id, status: state.jobs.get(id)?.status ?? 'running', pending: true, hint: 'ยังทำงานอยู่ — รอผลด้วย job_wait {id} / still running: call job_wait {id}' };
    }
    if (info.status === 'done')
        return { ok: true, ...extra, ...info.result, jobId: id };
    throw new ToolError(info.error ?? `${info.name} ${info.status}`, { jobId: id, status: info.status });
}
async function waitJob(state, id, ms) {
    let timer;
    try {
        return await Promise.race([
            state.jobs.wait(id),
            new Promise((r) => { timer = setTimeout(() => r(undefined), ms); }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Apply a new timeline; on validation errors the previous timeline is restored and the errors returned. */
function commitTimeline(state, p, next) {
    const prev = p.timeline;
    state.api.project.setTimeline(p, next);
    const errors = state.api.project.validateTimeline(p);
    if (errors.length)
        state.api.project.setTimeline(p, prev);
    return errors;
}
async function commitOrThrow(state, p, next, what) {
    const errors = commitTimeline(state, p, next);
    if (errors.length)
        throw new ToolError(`${what} ไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / ${what} invalid, not applied`, { errors });
    await state.api.project.saveProject(p);
}
export function applyEditOps(t, ops) {
    const tl = structuredClone(t);
    const idx = (id) => {
        const i = tl.video.findIndex((c) => c.id === id);
        if (i < 0)
            throw new Error(`ไม่พบคลิป / unknown clip: ${id}`);
        return i;
    };
    const clip = (id) => tl.video[idx(id)];
    for (const op of ops) {
        switch (op.op) {
            case 'insert': {
                if (tl.video.some((c) => c.id === op.clip.id))
                    throw new Error(`clip id ซ้ำ / duplicate clip id: ${op.clip.id}`);
                const at = op.after !== undefined ? idx(op.after) + 1 : Math.min(op.index ?? tl.video.length, tl.video.length);
                tl.video.splice(at, 0, op.clip);
                break;
            }
            case 'move': {
                const [c] = tl.video.splice(idx(op.id), 1);
                tl.video.splice(Math.min(op.index, tl.video.length), 0, c);
                break;
            }
            case 'remove':
                tl.video.splice(idx(op.id), 1);
                tl.cuts = tl.cuts.filter((c) => c.after !== op.id);
                break;
            case 'trim': {
                const c = clip(op.id);
                if (op.in !== undefined)
                    c.in = op.in;
                if (op.dur !== undefined)
                    c.dur = op.dur;
                break;
            }
            case 'set_dissolve': {
                if (idx(op.after) === tl.video.length - 1)
                    throw new Error(`ใส่ dissolve หลังคลิปสุดท้ายไม่ได้ / no cut after the last clip: ${op.after}`);
                tl.cuts = tl.cuts.filter((c) => c.after !== op.after);
                if (op.frames > 0)
                    tl.cuts.push({ after: op.after, dissolve: op.frames });
                break;
            }
            case 'set_marker': {
                const c = clip(op.id);
                if (op.name)
                    c.marker = op.name;
                else
                    delete c.marker;
                break;
            }
            case 'set_scale':
                clip(op.id).scale = op.scale;
                break;
            case 'remove_audio': {
                const a = tl.audio;
                const before = a.vo.length + a.music.length + a.sfx.length;
                a.vo = a.vo.filter((c) => c.id !== op.id);
                a.music = a.music.filter((c) => c.id !== op.id);
                a.sfx = a.sfx.filter((c) => c.id !== op.id);
                if (a.vo.length + a.music.length + a.sfx.length === before)
                    throw new Error(`ไม่พบ audio clip / unknown audio clip: ${op.id}`);
                break;
            }
        }
    }
    // cuts are keyed by the clip before them; after moves/removes drop the ones that no longer sit between two clips
    const last = tl.video[tl.video.length - 1]?.id;
    const ids = new Set(tl.video.map((c) => c.id));
    tl.cuts = tl.cuts.filter((c) => ids.has(c.after) && c.after !== last);
    return tl;
}
/** Positional diff of two timelines (Premiere does not preserve our clip ids reliably). */
export function diffTimelines(a, b) {
    const clips = [];
    const n = Math.max(a.video.length, b.video.length);
    for (let i = 0; i < n; i++) {
        const x = a.video[i];
        const y = b.video[i];
        if (!x) {
            clips.push({ index: i, id: y.id, field: 'added', to: y });
            continue;
        }
        if (!y) {
            clips.push({ index: i, id: x.id, field: 'removed', from: x });
            continue;
        }
        for (const f of ['src', 'in', 'dur', 'scale', 'marker']) {
            const from = f === 'scale' ? x[f] ?? 100 : x[f];
            const to = f === 'scale' ? y[f] ?? 100 : y[f];
            if (from !== to)
                clips.push({ index: i, id: x.id, field: f, from, to });
        }
    }
    const dis = (t) => new Map(t.cuts.filter((c) => c.dissolve > 0).map((c) => [c.after, c.dissolve]));
    const da = dis(a);
    const db = dis(b);
    const dissolves = [];
    for (const k of new Set([...da.keys(), ...db.keys()])) {
        const from = da.get(k) ?? 0;
        const to = db.get(k) ?? 0;
        if (from !== to)
            dissolves.push({ after: k, from, to });
    }
    const sum = (t) => t.video.reduce((s, c) => s + c.dur, 0);
    const counts = (t) => ({ vo: t.audio.vo.length, music: t.audio.music.length, sfx: t.audio.sfx.length });
    return {
        frames: { before: sum(a), after: sum(b) },
        clips: { before: a.video.length, after: b.video.length, changed: clips },
        dissolves,
        audio: { before: counts(a), after: counts(b) },
    };
}
/** One line per change, for a human to approve before `apply`. */
function summarizeDiff(d, fps) {
    const lines = [];
    const tc = (f) => framesToTc(f, fps);
    const { before, after } = d.frames;
    lines.push(before === after ? `ความยาวเท่าเดิม ${before} เฟรม (${tc(before)}) / length unchanged` : `ความยาว / length: ${before} → ${after} เฟรม (${tc(before)} → ${tc(after)})`);
    if (d.clips.before !== d.clips.after)
        lines.push(`จำนวนคลิป / clips: ${d.clips.before} → ${d.clips.after}`);
    const v = (x) => (x === undefined ? '-' : String(x));
    for (const c of d.clips.changed) {
        const at = `#${c.index + 1} '${c.id ?? '?'}'`;
        if (c.field === 'added') {
            const n = c.to;
            lines.push(`+ เพิ่มคลิป ${at}: src ${n.src}, in ${n.in}, dur ${n.dur}`);
        }
        else if (c.field === 'removed')
            lines.push(`- ลบคลิป ${at}`);
        else
            lines.push(`~ คลิป ${at}: ${c.field} ${v(c.from)} → ${v(c.to)}`);
    }
    for (const x of d.dissolves)
        lines.push(`~ dissolve หลัง '${x.after}': ${x.from} → ${x.to} เฟรม`);
    const a = d.audio;
    if (a.before.vo !== a.after.vo || a.before.music !== a.after.music || a.before.sfx !== a.after.sfx) {
        lines.push(`เสียง vo/music/sfx: ${a.before.vo}/${a.before.music}/${a.before.sfx} → ${a.after.vo}/${a.after.music}/${a.after.sfx}`);
    }
    if (lines.length === 1 && before === after)
        lines.push('ไม่มีความต่างในคลิป/dissolve / no clip or dissolve changes');
    return lines;
}
function projectStatus(state, p) {
    const assets = Object.values(p.assets);
    const byKind = {};
    for (const a of assets)
        byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    const latest = p.versions[p.versions.length - 1];
    return {
        name: p.meta.name,
        dir: p.dir,
        fps: p.meta.fps,
        size: `${p.meta.width}x${p.meta.height}`,
        assets: { total: assets.length, byKind, compsNeedingRender: compsNeedingRender(p) },
        timeline: timelineSummary(state, p),
        validation: state.api.project.validateTimeline(p),
        delivery: p.delivery,
        versions: {
            count: p.versions.length,
            latest: latest ? { id: latest.id, createdAt: latest.createdAt, master: latest.master, reviewProxy: latest.reviewProxy, deliverables: latest.deliverables, qcOk: latest.qc?.ok } : null,
        },
        jobs: state.jobs.list().filter((j) => j.status === 'running' || j.status === 'queued').map((j) => ({ id: j.id, name: j.name, progress: j.progress })),
    };
}
const COMPAT_NOTES = [
    process.platform === 'darwin'
        ? 'AE บน macOS ไม่มี -noui: CatCut สั่งผ่าน AppleScript (DoScriptFile) เปิด AE ของตัวเองแล้วปิดเมื่อเสร็จ — ต้องปิด AE ที่เปิดอยู่ก่อน และอนุญาต Automation ครั้งแรก'
        : 'AE headless = AfterFX.com -m -noui -r <jsx>: ต้องมี -m เสมอ ไม่งั้นสคริปต์จะไปรันใน AE ที่เปิดอยู่ (DESIGN §2.1)',
    'AE 25.2.2–26.3: ชื่อไฟล์ output ภาษาไทยจากสคริปต์กลายเป็นขีด → render ชื่อ ASCII แล้ว rename (DESIGN §2.1)',
    'saveFrameToPng ไม่เสถียร → preview frame ใช้ aerender -s N -e N (DESIGN §2.1)',
    'OutputModule.setSettings เปลี่ยน Format ไม่ได้ → ต้องมี OM template "EDITMCP ProRes 422 HQ" หรือ fallback Lossless + ffmpeg (DESIGN §2.1, §12)',
    'ไม่ใช้ nexrender patch (commandLineRenderer.jsx): ต้อง admin และพังเมื่ออัปเดต AE (DESIGN §2.1)',
    'Premiere ไม่มี headless: แลกเปลี่ยนด้วย FCP7 XML (xmeml) เท่านั้น; FCPXML เปิดไม่ได้, OTIO ยังเบต้าไม่มีทรานซิชัน (DESIGN §2.2)',
    'Premiere 2026: dissolve เลขคี่ / Motion scale / pathurl ไทย ยังต้องทดสอบจริง (DESIGN §5.3, §10)',
    'ffmpeg 9: ไม่อ่าน camera RAW (R3D/BRAW/ARRIRAW) (DESIGN §2.3)',
    'เครื่อง 16 GB: render AE ทีละตัว, เช็ค RAM ว่างก่อน aerender (CLAUDE.md)',
];
// ---------- tools ----------
const CORE_TOOLS = [
    tool({
        name: 'project_new',
        description: 'สร้างโปรเจกต์ใหม่ในโฟลเดอร์ (project.json) · Create a project: dir, name, fps=25, 1920x1080',
        input: {
            dir: z.string().describe('project folder (created if missing)'),
            name: z.string().min(1),
            fps: z.number().positive().optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            targets: z.array(z.string()).optional().describe('delivery target ids (see delivery_presets)'),
        },
        handler: async (a, state) => {
            assertWritable(a.dir, 'project_new.dir');
            const dir = nativeDir(a.dir);
            assertWritable(dir, 'project_new.dir');
            const unknown = (a.targets ?? []).filter((t) => !PRESETS[t]);
            if (unknown.length)
                throw new ToolError(`ไม่รู้จัก target / unknown delivery targets: ${unknown.join(', ')}`, { known: Object.keys(PRESETS) });
            if (existsSync(join(dir, 'project.json')))
                throw new ToolError('มีโปรเจกต์อยู่แล้ว ใช้ project_open / project already exists, use project_open', { dir });
            const p = await state.api.project.createProject(dir, { name: a.name, fps: a.fps, width: a.width, height: a.height });
            if (a.targets?.length) {
                p.delivery.targets = [...new Set(a.targets)];
                await state.api.project.saveProject(p);
            }
            state.project = p;
            return { ok: true, ...projectStatus(state, p) };
        },
    }),
    tool({
        name: 'delivery_presets',
        description: 'รายการปลายทางส่งงาน (id, ขนาด, codec, ความดัง) สำหรับให้ผู้ใช้เลือก · List delivery targets with their specs (for a setup/export picker)',
        input: {},
        handler: async (_a, state) => ({
            presets: Object.values(PRESETS).map((t) => ({
                id: t.id, label: t.label, container: t.container, codec: t.video.codec,
                size: `${t.video.width}x${t.video.height}`, ...(t.video.fps ? { fps: t.video.fps } : {}), ...(t.video.interlaced ? { interlaced: true } : {}),
                ...(t.loudness ? { lufs: t.loudness.integratedLufs } : {}),
            })),
            projectTargets: state.project?.delivery.targets ?? [],
        }),
    }),
    tool({
        name: 'project_open',
        description: 'เปิดโปรเจกต์ที่มีอยู่ · Open an existing project folder',
        input: { dir: z.string() },
        handler: async (a, state) => {
            assertWritable(resolve(a.dir), 'project (opened for editing)');
            const p = await state.api.project.loadProject(resolve(a.dir));
            state.project = p;
            return { ok: true, ...projectStatus(state, p) };
        },
    }),
    tool({
        name: 'project_status',
        description: 'สถานะโปรเจกต์: assets, timeline, comp ที่ต้อง render, เวอร์ชัน, jobs · Project status',
        input: {},
        handler: async (_a, state) => projectStatus(state, requireProject(state)),
    }),
    tool({
        name: 'asset_add',
        description: 'เพิ่มไฟล์สื่อ (path) หรือ comp (aep + comp) จาก After Effects (.aep) หรือ EffectCraft (.ecproj) · Add a media file or a motion comp (.aep or .ecproj)',
        input: {
            path: z.string().optional().describe('video / still / audio file'),
            aep: z.string().optional().describe('.aep (After Effects) or .ecproj (EffectCraft) path, with comp'),
            comp: z.string().optional().describe('comp name inside the .aep'),
            id: z.string().optional().describe('asset id (default: auto)'),
            kind: z.enum(['camera', 'graphic', 'still', 'audio']).optional().describe('for files; default from probe'),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            let asset;
            if (a.aep) {
                if (!a.comp)
                    throw new ToolError('ต้องระบุ comp คู่กับ aep / comp is required with aep');
                const aep = resolve(a.aep);
                if (!existsSync(aep))
                    throw new ToolError(`ไม่พบไฟล์ / file not found: ${aep}`);
                asset = state.api.project.addAeComp(p, aep, a.comp, a.id);
            }
            else if (a.path) {
                requireFfmpeg(state);
                const path = resolve(a.path);
                if (!existsSync(path))
                    throw new ToolError(`ไม่พบไฟล์ / file not found: ${path}`);
                asset = await state.api.project.addFileAsset(p, path, { id: a.id, kind: a.kind, probe: state.api.probe });
            }
            else {
                throw new ToolError('ต้องระบุ path หรือ aep+comp / give path, or aep + comp');
            }
            await state.api.project.saveProject(p);
            return { ok: true, asset: assetSummary(asset) };
        },
    }),
    tool({
        name: 'asset_list',
        description: 'รายการ assets ทั้งหมด · List assets',
        input: {},
        handler: async (_a, state) => {
            const p = requireProject(state);
            return { assets: Object.values(p.assets).map(assetSummary) };
        },
    }),
    tool({
        name: 'timeline_set',
        description: 'ตั้งไทม์ไลน์ทั้งหมด (หน่วยเฟรม) ตรวจสอบก่อน ถ้าผิดจะไม่บันทึก · Set the whole timeline (frames); validated, rejected if invalid',
        input: { timeline: TimelineSchema },
        handler: async (a, state) => {
            const p = requireProject(state);
            await commitOrThrow(state, p, a.timeline, 'timeline');
            return { ok: true, timeline: timelineSummary(state, p) };
        },
    }),
    tool({
        name: 'timeline_edit',
        description: 'แก้ไทม์ไลน์ทีละจุด: insert / move / remove / trim / set_dissolve / set_marker / set_scale / remove_audio · Small timeline edits (validated)',
        input: { ops: z.array(EditOpSchema).min(1) },
        handler: async (a, state) => {
            const p = requireProject(state);
            const next = applyEditOps(p.timeline, a.ops);
            await commitOrThrow(state, p, next, 'timeline');
            return { ok: true, applied: a.ops.length, timeline: timelineSummary(state, p) };
        },
    }),
    tool({
        name: 'audio_add',
        description: 'ใส่ VO / เพลง / SFX ที่ตำแหน่ง (เฟรม); ตั้ง ducking ได้ · Add an audio clip to vo / music / sfx',
        input: {
            track: z.enum(['vo', 'music', 'sfx']),
            src: z.string().describe('asset id'),
            at: frames.min(0).default(0),
            id: z.string().optional(),
            in: frames.min(0).optional(),
            dur: frames.optional(),
            gainDb: z.number().optional(),
            fadeIn: frames.min(0).optional(),
            fadeOut: frames.min(0).optional(),
            duck: DuckSchema.optional().describe('music under vo, e.g. {underDb:-12, attackMs:150, releaseMs:400}'),
            useClipAudio: z.boolean().optional(),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            const next = structuredClone(p.timeline);
            const all = [...next.audio.vo, ...next.audio.music, ...next.audio.sfx];
            let id = a.id;
            if (!id) {
                let n = next.audio[a.track].length + 1;
                while (all.some((c) => c.id === `${a.track}${n}`))
                    n++;
                id = `${a.track}${n}`;
            }
            else if (all.some((c) => c.id === id)) {
                throw new ToolError(`audio id ซ้ำ / duplicate audio id: ${id}`);
            }
            const clip = { id, src: a.src, at: a.at, in: a.in, dur: a.dur, gainDb: a.gainDb, fadeIn: a.fadeIn, fadeOut: a.fadeOut };
            next.audio[a.track].push(clip);
            if (a.duck)
                next.audio.duck = a.duck;
            if (a.useClipAudio !== undefined)
                next.audio.useClipAudio = a.useClipAudio;
            await commitOrThrow(state, p, next, 'audio');
            return { ok: true, clip, timeline: timelineSummary(state, p) };
        },
    }),
    tool({
        name: 'ae_list_comps',
        description: 'รายชื่อ comp ใน .aep หรือ .ecproj (job — ถ้าคิวว่างรอผลไม่เกิน ~20 วิ) · List comps in an .aep / .ecproj (job; waits up to ~20 s when idle)',
        input: { aep: z.string(), wait: z.boolean().optional().describe('wait up to ~20 s for the result (default: only when no other job is queued)') },
        handler: async (a, state) => {
            const aep = resolve(a.aep);
            return runAeJob(state, 'ae_list_comps', a.wait, async () => ({ comps: await state.ae.listComps(aep) }));
        },
    }),
    tool({
        name: 'ae_inspect_comp',
        description: 'ดู layer ของ comp (ชนิด, in/out, ข้อความ, effects, ขอบเขต; job) · Inspect a comp\'s layers (job)',
        input: { aep: z.string(), comp: z.string(), atFrame: frames.min(0).optional(), wait: z.boolean().optional() },
        handler: async (a, state) => {
            const aep = resolve(a.aep);
            return runAeJob(state, 'ae_inspect_comp', a.wait, async () => {
                const detail = await state.ae.inspectComp(aep, a.comp, a.atFrame);
                return { ...detail, ...(isOpaque(detail, a.comp) ? opaqueHint(state, aep, a.comp) : {}) };
            });
        },
    }),
    tool({
        name: 'ae_edit',
        description: 'แก้ comp (setText, replaceFootage, shiftLayer, setProperty, addEffect, applyPreset, setLayerEnabled, duplicateComp, script) แล้วบันทึก (job); render เดิมจะถูกนับว่าเก่า · Edit a comp (job)',
        input: {
            aep: z.string(), comp: z.string(), ops: z.array(AeOpSchema).min(1),
            saveAs: z.string().optional().describe('new project file (same type as the source: .aep or .ecproj) inside the project folder or next to the source'),
            wait: z.boolean().optional(),
        },
        handler: async (a, state) => {
            const aep = resolve(a.aep);
            const saveAs = a.saveAs ? resolve(a.saveAs) : undefined;
            if (saveAs && extname(saveAs).toLowerCase() !== extname(aep).toLowerCase())
                throw new ToolError(`saveAs ต้องเป็นไฟล์ชนิดเดียวกับต้นฉบับ (${extname(aep)}) / saveAs must have the source's extension`);
            if (saveAs)
                assertConfined(state, saveAs, aep, 'saveAs');
            else
                assertWritable(aep, 'the .aep (in-place edit)');
            return runAeJob(state, 'ae_edit', a.wait, async () => {
                const res = await state.ae.edit({ aep, comp: a.comp, ops: a.ops, saveAs });
                const stale = [];
                const p = state.project;
                if (p && res.ok) {
                    for (const asset of Object.values(p.assets)) {
                        if (isAeComp(asset) && asset.comp === a.comp && samePath(asset.aep, res.savedTo)) {
                            asset.fingerprint = res.fingerprint;
                            stale.push(asset.id);
                        }
                    }
                    if (stale.length)
                        await state.api.project.saveProject(p);
                }
                return {
                    ...res, staleAssets: stale, hint: stale.length ? 'build จะ render comp นี้ใหม่ / build re-renders these comps' : undefined,
                    ...(isOpaque(res, a.comp) ? opaqueHint(state, res.savedTo, a.comp) : {}),
                };
            });
        },
    }),
    tool({
        name: 'ae_create',
        description: 'สร้างโปรเจกต์ใหม่จากสคริปต์ JSX แบบ headless (job): saveAs .aep = After Effects, .ecproj = EffectCraft (ArtCraft) · Create a new .aep or .ecproj by running a JSX build script headlessly (job). '
            + 'The script runs in an empty project: build comps/layers only — no app.newProject() (kills headless AE), no save, no quit. '
            + 'Use match-name property paths (layer.property("ADBE Transform Group").property("ADBE Position")) and new TextDocument(...) so one script works in both hosts: EffectCraft does not resolve display names like property("Position"). '
            + 'L(msg) appends to the returned log; SCRIPT_DIR is the folder of jsxPath. Errors come back with the script line. '
            + 'asset: registers the comp for build; an existing aecomp id is repointed to the new .aep so the next build re-renders it.',
        input: {
            jsx: z.string().optional().describe('script text'),
            jsxPath: z.string().optional().describe('UTF-8 .jsx file (instead of jsx)'),
            saveAs: z.string().describe('new .aep (After Effects) or .ecproj (EffectCraft) inside the project folder (never overwritten; use a new name per revision)'),
            asset: z.object({ comp: z.string(), id: z.string().optional() }).optional(),
            wait: z.boolean().optional(),
        },
        handler: async (a, state) => {
            if (!state.ae.create)
                throw new ToolError('AE backend cannot create projects');
            if (!a.jsx === !a.jsxPath)
                throw new ToolError('ระบุ jsx หรือ jsxPath อย่างใดอย่างหนึ่ง / give exactly one of jsx or jsxPath');
            const jsxPath = a.jsxPath ? resolve(a.jsxPath) : undefined;
            if (jsxPath && !existsSync(jsxPath))
                throw new ToolError(`ไม่พบไฟล์ / file not found: ${jsxPath}`);
            if (!jsxPath || a.asset)
                requireProject(state);
            const saveAs = resolve(a.saveAs);
            const ext = extname(saveAs).toLowerCase();
            if (ext !== '.aep' && ext !== '.ecproj')
                throw new ToolError('saveAs ต้องเป็น .aep หรือ .ecproj / saveAs must end in .aep or .ecproj');
            if (ext === '.ecproj' && !state.env.tools.effectcraftCli)
                throw new ToolError('ไม่พบ EffectCraft / effectcraft-cli not found (install EffectCraft or set EDITMCP_EFFECTCRAFT_DIR)');
            if (existsSync(saveAs))
                throw new ToolError(`มีไฟล์นี้แล้ว ใช้ชื่อใหม่ / refusing to overwrite: ${saveAs}`);
            assertConfined(state, saveAs, jsxPath ?? join(state.project.dir, 'x'), 'saveAs');
            const existing = a.asset?.id ? state.project.assets[a.asset.id] : undefined;
            if (existing && existing.kind !== 'aecomp')
                throw new ToolError(`asset id already in use by a ${existing.kind} file: ${a.asset.id}`);
            const jsx = a.jsx ?? await readFile(jsxPath, 'utf8');
            return runAeJob(state, 'ae_create', a.wait, async () => {
                const res = await state.ae.create({ jsx, saveAs, ...(jsxPath ? { scriptDir: dirname(jsxPath) } : {}) });
                let asset;
                const p = state.project;
                if (p && a.asset) {
                    if (!res.comps.some((c) => c.name === a.asset.comp))
                        throw new ToolError(`ไม่มี comp '${a.asset.comp}' ในไฟล์ใหม่ / comp not found in ${res.savedTo}`, { comps: res.comps.map((c) => c.name) });
                    const cur = a.asset.id ? p.assets[a.asset.id] : undefined;
                    if (cur && isAeComp(cur)) {
                        // Repoint: drop the old render so the next build renders the new project.
                        Object.assign(cur, { aep: res.savedTo, comp: a.asset.comp });
                        delete cur.render;
                        delete cur.fingerprint;
                        delete cur.probe;
                        asset = cur;
                    }
                    else {
                        asset = state.api.project.addAeComp(p, res.savedTo, a.asset.comp, a.asset.id);
                    }
                    await state.api.project.saveProject(p);
                }
                return { ok: true, ...res, ...(asset ? { asset: assetSummary(asset), hint: 'ae_preview_frame เพื่อเช็ค แล้ว build / check with ae_preview_frame, then build' } : {}) };
            });
        },
    }),
    tool({
        name: 'ae_preview_frame',
        description: 'render เฟรมเดียวของ comp เป็น PNG (job) · Render one frame of a comp to PNG (job)',
        input: {
            aep: z.string(), comp: z.string(), frame: frames.min(0).default(0),
            out: z.string().optional().describe('png path inside the project folder or next to the .aep (default: project review folder)'),
            wait: z.boolean().optional(),
        },
        handler: async (a, state) => {
            const aep = resolve(a.aep);
            let out = a.out ? resolve(a.out) : '';
            if (out) {
                assertConfined(state, out, aep, 'out');
                await mkdir(dirname(out), { recursive: true });
            }
            else {
                const dir = state.project ? state.api.project.projectPaths(state.project).review : join(os.tmpdir(), 'editmcp');
                await mkdir(dir, { recursive: true });
                out = join(dir, `preview_${asciiSlug(a.comp)}_${a.frame}.png`);
            }
            return runAeJob(state, 'ae_preview_frame', a.wait, async () => {
                const png = await state.ae.previewFrame(aep, a.comp, a.frame, uniquePath(out));
                return { ok: true, png };
            });
        },
    }),
    tool({
        name: 'build',
        description: 'render เฉพาะที่เปลี่ยน → ต่อท่อน → เสียง → master ProRes → QC → deliverables; คืน job id ทันที · Incremental build (async job)',
        input: {
            force: z.boolean().optional().describe('ignore caches'),
            forceAssets: z.array(z.string()).optional().describe('aecomp asset ids to re-render even if their fingerprint did not change (e.g. edits only inside Curves/Levels)'),
            skipQc: z.boolean().optional(),
            skipDeliver: z.boolean().optional(),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            requireFfmpeg(state);
            const running = activeJob(state, PROJECT_JOBS);
            if (running)
                throw new ToolError(`มี ${running.name} กำลังทำงานอยู่ / a ${running.name} job is already running`, { jobId: running.id });
            const errors = state.api.project.validateTimeline(p);
            if (errors.length)
                throw new ToolError('timeline ไม่ผ่านการตรวจสอบ / timeline invalid', { errors });
            const forceAssets = [...new Set(a.forceAssets ?? [])];
            const notComps = forceAssets.filter((id) => !(p.assets[id] && isAeComp(p.assets[id])));
            if (notComps.length)
                throw new ToolError(`forceAssets ต้องเป็น aecomp asset / not aecomp assets: ${notComps.join(', ')}`, { notComps });
            // Disk preflight: ProRes 422 HQ ≈ 184 Mbps at 1080p25; budget master + worst-case new segments.
            const fps = p.meta.fps;
            const bytesPerFrame = (184e6 / 8 / 25) * ((p.meta.width * p.meta.height) / (1920 * 1080)) * (25 / fps);
            const estimate = Math.ceil(2 * state.api.project.timelineFrames(p) * bytesPerFrame);
            const aeCache = await findAeDiskCache().catch(() => ({ folder: undefined }));
            const diskIssues = await preflight(p, estimate, { extraPaths: aeCache.folder ? [aeCache.folder] : [] }).catch(() => []);
            if (diskIssues.some((i) => i.severity === 'error'))
                throw new ToolError('พื้นที่ดิสก์ไม่พอ / not enough disk space', { issues: diskIssues });
            const job = state.jobs.start('build', async (ctx) => {
                const moved = await forgetRenders(state, p, forceAssets, ctx);
                const opts = {
                    force: a.force, skipQc: a.skipQc, skipDeliver: a.skipDeliver, signal: ctx.signal,
                    ...(forceAssets.length ? { forceAssets } : {}),
                    onProgress: (pr) => {
                        ctx.progress(pr);
                        ctx.log(`${pr.stage} ${pr.done}/${pr.total}${pr.message ? ' ' + pr.message : ''}`);
                    },
                };
                const r = await state.assembler.build(p, opts);
                return {
                    version: r.version.id, master: r.version.master, reviewProxy: r.version.reviewProxy, deliverables: r.version.deliverables, qcOk: r.version.qc?.ok, qcIssues: r.version.qc?.issues.length ?? 0, stats: r.stats,
                    ...(forceAssets.length ? { forcedAssets: forceAssets, movedRenders: moved } : {}),
                    ...(diskIssues.length ? { diskWarnings: diskIssues } : {}),
                };
            });
            return { ok: true, jobId: job.id, status: job.status, hint: 'รอผลด้วย job_wait {id} (ไม่ต้อง sleep) / call job_wait {id} to block until done' };
        },
    }),
    tool({
        name: 'deliver',
        description: 'สร้าง deliverable จาก master ของเวอร์ชัน (job) · Encode deliverables (yt, fb, vert, th_tv, th_prores, led, m422hq) from a version',
        input: {
            version: z.string().optional().describe('default: latest'),
            targets: z.array(z.string()).optional().describe('default: project.delivery.targets'),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            requireFfmpeg(state);
            const running = activeJob(state, PROJECT_JOBS);
            if (running)
                throw new ToolError(`มี ${running.name} กำลังทำงานอยู่ / a ${running.name} job is already running`, { jobId: running.id });
            const version = a.version ?? p.versions[p.versions.length - 1]?.id;
            if (!version)
                throw new ToolError('ยังไม่มีเวอร์ชัน ต้อง build ก่อน / no version yet: run build first');
            if (!p.versions.some((v) => v.id === version))
                throw new ToolError(`ไม่พบเวอร์ชัน / unknown version: ${version}`, { versions: p.versions.map((v) => v.id) });
            const targets = a.targets ?? p.delivery.targets;
            if (!targets.length)
                throw new ToolError('ไม่มี target / no delivery targets given');
            const job = state.jobs.start('deliver', async (ctx) => {
                const deliverables = await state.assembler.deliver(p, version, targets, {
                    signal: ctx.signal,
                    onProgress: (pr) => { ctx.progress(pr); ctx.log(`${pr.stage} ${pr.done}/${pr.total}${pr.message ? ' ' + pr.message : ''}`); },
                });
                return { version, deliverables };
            });
            return { ok: true, jobId: job.id, status: job.status, version, targets };
        },
    }),
    tool({
        name: 'job_status',
        description: 'ความคืบหน้า / log / ผลลัพธ์ของ job · Job progress, log tail and result',
        input: { id: z.string() },
        handler: async (a, state) => {
            const j = state.jobs.get(a.id);
            if (!j)
                throw new ToolError(`ไม่พบ job / unknown job: ${a.id}`);
            return jobSummary(j, 200);
        },
    }),
    tool({
        name: 'job_wait',
        description: 'รอจน job เสร็จ (หรือครบเวลา) แล้วคืนผล — ใช้แทนการวนถาม job_status / sleep · Block until a job finishes (or timeoutSec passes) and return its result',
        input: {
            id: z.string(),
            timeoutSec: z.number().int().min(1).max(3600).optional().describe('default 600; on timeout returns done:false — call again'),
        },
        handler: async (a, state) => {
            if (!state.jobs.get(a.id))
                throw new ToolError(`ไม่พบ job / unknown job: ${a.id}`);
            const info = await waitJob(state, a.id, (a.timeoutSec ?? 600) * 1000);
            const j = info ?? state.jobs.get(a.id);
            return { ...jobSummary(j, 40), done: !!info, ...(info ? {} : { hint: 'ยังไม่เสร็จ — เรียก job_wait อีกครั้ง / still running: call job_wait again' }) };
        },
    }),
    tool({
        name: 'job_list',
        description: 'รายการ jobs · List jobs',
        input: {},
        handler: async (_a, state) => ({ jobs: state.jobs.list().map((j) => jobSummary(j, 3)) }),
    }),
    tool({
        name: 'job_cancel',
        description: 'ยกเลิก job ที่กำลังทำงาน · Cancel a running job',
        input: { id: z.string() },
        handler: async (a, state) => {
            const j = state.jobs.get(a.id);
            if (!j)
                throw new ToolError(`ไม่พบ job / unknown job: ${a.id}`);
            return { ok: true, cancelled: state.jobs.cancel(a.id), status: state.jobs.get(a.id)?.status };
        },
    }),
    tool({
        name: 'qc_report',
        description: 'รายงาน QC ของเวอร์ชัน (ล่าสุดถ้าไม่ระบุ) · QC report of a version',
        input: { version: z.string().optional() },
        handler: async (a, state) => {
            const p = requireProject(state);
            const v = a.version ? p.versions.find((x) => x.id === a.version) : p.versions[p.versions.length - 1];
            if (!v)
                throw new ToolError(a.version ? `ไม่พบเวอร์ชัน / unknown version: ${a.version}` : 'ยังไม่มีเวอร์ชัน / no version yet');
            return { version: v.id, master: v.master, qc: v.qc ?? null, note: v.qc ? undefined : 'ไม่มีรายงาน QC (build ด้วย skipQc?) / no QC report' };
        },
    }),
    tool({
        name: 'preview',
        description: 'สร้าง H.264 preview เวอร์ชันใหม่สำหรับรีวิว (job) · Create a small review proxy without launching Adobe',
        input: { version: z.string().optional(), wait: z.boolean().optional().describe('default true: wait up to ~20 s') },
        handler: async (a, state) => startReviewJob(state, a.version, false, a.wait ?? true),
    }),
    tool({
        name: 'review_open',
        description: 'เปิดหน้ารีวิวในเครื่อง: เลือกช็อต/ช่วง วงจุดแก้ และบันทึกโน้ต (job → URL) · Local version review',
        input: { version: z.string().optional(), wait: z.boolean().optional().describe('default true: wait up to ~20 s for the URL') },
        handler: async (a, state) => startReviewJob(state, a.version, true, a.wait ?? true),
    }),
    tool({
        name: 'review_notes',
        description: 'อ่านโน้ตและแผนช็อตของเวอร์ชัน ใช้เสนอแผนแก้ก่อนลงมือ · Read version review notes; do not apply edits automatically',
        input: { version: z.string().optional() },
        handler: async (a, state) => {
            const p = requireProject(state), v = reviewVersion(p, a.version);
            const session = await readReviewSession(p, v);
            // actionable vs parked split: agents act only on `actionable`; `parked` notes are informational.
            return { version: v.id, plan: versionPlan(p, v), ...agentReview(session), session };
        },
    }),
    tool({
        name: 'review_submit',
        description: 'ส่งสำเนาโน้ตที่บันทึกแล้วให้ agent อ่าน ไม่แก้ไทม์ไลน์ · Submit an immutable note snapshot',
        input: { version: z.string().optional(), revision: frames.min(0).optional() },
        handler: async (a, state) => {
            const p = requireProject(state), v = reviewVersion(p, a.version);
            return submitReview(p, v, a.revision);
        },
    }),
    tool({
        name: 'review_close',
        description: 'ปิด server หน้ารีวิวเวอร์ชันนี้ โน้ตยังอยู่บนดิสก์ · Close this local review server',
        input: { version: z.string().optional() },
        handler: async (a, state) => {
            const p = requireProject(state), v = reviewVersion(p, a.version), key = reviewKey(p, v);
            const review = state.reviews?.get(key);
            await review?.close();
            state.reviews?.delete(key);
            return { ok: true, version: v.id, closed: !!review };
        },
    }),
    tool({
        name: 'export_premiere_xml',
        description: 'ส่งออก FCP7 XML (xmeml) ไปเปิดใน Premiere หรือ FilmCraft (ArtCraft) → out/<version>/<name>.xml · Export the timeline as FCP7 XML for Premiere or FilmCraft',
        input: {
            version: z.string().optional().describe('default: latest, or "draft" before any build'),
            sequenceName: z.string().optional(),
            target: z.enum(['premiere', 'filmcraft']).optional().describe('editor that opens the file (default premiere); filmcraft writes explicit clip edges FilmCraft reads correctly around dissolves'),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            if (a.version && !p.versions.some((v) => v.id === a.version))
                throw new ToolError(`ไม่พบเวอร์ชัน / unknown version: ${a.version}`);
            const version = a.version ?? p.versions[p.versions.length - 1]?.id ?? 'draft';
            const sequenceName = a.sequenceName ?? `${p.meta.name}_${version}`;
            const target = a.target ?? 'premiere';
            const xml = state.api.xmeml.writeXmeml(p, { sequenceName, flavor: target });
            const dir = join(state.api.project.projectPaths(p).out, version);
            await mkdir(dir, { recursive: true });
            const path = uniquePath(join(dir, `${fileSafe(p.meta.name)}${target === 'premiere' ? '' : `_${target}`}.xml`));
            await writeFile(path, xml, { encoding: 'utf8', flag: 'wx' });
            const warnings = xmemlExportWarnings(p); // things FCP7 XML cannot carry (ramps, optical-flow, ...)
            return {
                ok: true, path, version, sequenceName, target, clips: p.timeline.video.length, unrendered: compsNeedingRender(p), ...(warnings.length ? { warnings } : {}),
                ...(target === 'filmcraft' ? { hint: 'FilmCraft: File > Import เลือกไฟล์นี้ · กลับมาด้วย File > Export > Final Cut Pro XML แล้ว import_premiere_xml' } : {}),
            };
        },
    }),
    tool({
        name: 'import_premiere_xml',
        description: 'นำ FCP7 XML ที่ export จาก Premiere หรือ FilmCraft กลับมา: ค่าเริ่มต้นแค่สรุปความต่าง + คำเตือน (dry run); apply: true เพื่อใช้ (สำรองไทม์ไลน์เดิมไว้ใน history/ ก่อน) · Import Premiere/FilmCraft XML: dry-run diff by default, apply: true to commit',
        input: {
            path: z.string(),
            apply: z.boolean().optional().describe('commit the imported timeline (default false = dry run: summary, diff, warnings only)'),
        },
        handler: async (a, state) => {
            const p = requireProject(state);
            const path = resolve(a.path);
            if (!existsSync(path))
                throw new ToolError(`ไม่พบไฟล์ / file not found: ${path}`);
            const r = state.api.xmeml.readXmeml(await readFile(path, 'utf8'), p);
            const warnings = [...(r.warnings ?? [])];
            if (r.fps !== p.meta.fps)
                warnings.push(`fps ใน XML = ${r.fps} แต่โปรเจกต์ = ${p.meta.fps}`);
            if (r.width !== p.meta.width || r.height !== p.meta.height)
                warnings.push(`ขนาดใน XML = ${r.width}x${r.height} แต่โปรเจกต์ = ${p.meta.width}x${p.meta.height}`);
            const diff = diffTimelines(p.timeline, r.timeline);
            const summary = summarizeDiff(diff, p.meta.fps);
            const { errors } = validateCandidate(state, p, r.timeline);
            const report = { file: basename(path), summary, diff, warnings, unresolvedPaths: r.unresolvedPaths };
            if (!a.apply) {
                return {
                    ok: true, dryRun: true, applied: false, valid: errors.length === 0, errors, ...report,
                    hint: errors.length
                        ? 'ไทม์ไลน์จาก XML ยังใช้ไม่ได้ (ดู errors / unresolvedPaths) / imported timeline is invalid'
                        : 'ตรวจสรุปแล้วเรียกซ้ำด้วย apply: true เพื่อใช้ (สำรองไทม์ไลน์เดิมไว้ใน history/) / review, then call again with apply: true',
                };
            }
            if (errors.length)
                throw new ToolError('ไทม์ไลน์จาก XML ไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / imported timeline invalid, not applied', { errors, ...report });
            const backup = await backupTimeline(p, `before import_premiere_xml ${basename(path)}`);
            await commitOrThrow(state, p, r.timeline, 'timeline');
            return { ok: true, applied: true, backup, ...report, timeline: timelineSummary(state, p), hint: 'ย้อนกลับได้ด้วย timeline_restore / undo with timeline_restore' };
        },
    }),
    tool({
        name: 'timeline_restore',
        description: 'ดูรายการสำรองไทม์ไลน์ใน history/ หรือย้อนกลับไปฉบับหนึ่ง (สำรองฉบับปัจจุบันก่อนเสมอ) · List timeline backups, or restore one (current timeline is backed up first)',
        input: { backup: z.string().optional().describe('backup file name from the list; omit to list') },
        handler: async (a, state) => {
            const p = requireProject(state);
            if (!a.backup)
                return { backups: await listBackups(p), hint: 'timeline_restore {backup: "<name>"} เพื่อย้อนกลับ / pass a name to restore' };
            if (basename(a.backup) !== a.backup || !BACKUP_RE.test(a.backup))
                throw new ToolError(`ชื่อไฟล์สำรองไม่ถูกต้อง / not a timeline backup name: ${a.backup}`);
            const file = join(p.dir, 'history', a.backup);
            if (!existsSync(file))
                throw new ToolError(`ไม่พบไฟล์สำรอง / backup not found: ${a.backup}`, { backups: (await listBackups(p)).map((b) => b.name) });
            let next;
            try {
                next = JSON.parse(await readFile(file, 'utf8')).timeline;
            }
            catch (e) {
                throw new ToolError(`อ่านไฟล์สำรองไม่ได้ / unreadable backup: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (!next || typeof next !== 'object')
                throw new ToolError(`ไฟล์สำรองไม่มี timeline / backup has no timeline: ${a.backup}`);
            const { errors, timeline: normalized } = validateCandidate(state, p, next);
            if (errors.length)
                throw new ToolError('ไทม์ไลน์ในไฟล์สำรองไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / backup timeline invalid, not applied', { errors });
            const diff = diffTimelines(p.timeline, normalized);
            const backup = await backupTimeline(p, `before timeline_restore ${a.backup}`);
            await commitOrThrow(state, p, next, 'timeline');
            return { ok: true, restored: a.backup, backup, summary: summarizeDiff(diff, p.meta.fps), timeline: timelineSummary(state, p) };
        },
    }),
    tool({
        name: 'doctor',
        description: 'ตรวจเครื่องมือ: ffmpeg, encoders (NVENC), AE, RAM + ข้อควรระวังตามเวอร์ชัน · Environment check and compat notes',
        input: {},
        handler: async (_a, state) => {
            const env = state.env;
            const freeRamGb = freeRamBytes() / 2 ** 30;
            let aeVersion = 'unknown (not launched)';
            if (process.env['EDITMCP_ALLOW_AE'] === '1' && env.tools.afterfx) {
                try {
                    aeVersion = await state.ae.version();
                }
                catch (err) {
                    aeVersion = `error: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
            else if (env.aeVersion) {
                aeVersion = env.aeVersion;
            }
            const r1 = (n) => Math.round(n * 10) / 10;
            return {
                ok: state.problems.length === 0,
                tools: env.tools,
                ffmpegVersion: env.ffmpegVersion,
                encoders: env.encoders,
                gpu: env.encoders.h264_nvenc ? 'NVENC encoder found; runtime failure falls back to libx264' : 'ไม่มี NVENC → libx264',
                ram: { totalGb: r1(env.totalRamGb), freeGb: r1(freeRamGb), low: freeRamGb < 3 },
                cpuThreads: env.cpuThreads,
                aeVersion,
                aeBackend: state.ae.kind,
                afterEffects: env.tools.afterfx ? 'found' : 'not found (ae_* tools unavailable)',
                premiere: env.tools.premiereExe ? 'found (optional; exchange via FCP7 XML)' : 'not found (optional)',
                filmcraft: env.tools.filmcraftCli ? 'found (optional; export_premiere_xml {target: "filmcraft"})' : 'not found (optional)',
                premiereBridge: await (async () => {
                    const st = await (state.premiere ?? createPremiereClient()).status();
                    if (st.connected)
                        return `connected (Premiere ${st.premiere ?? '?'}, project ${st.project?.name ?? 'none'}): premiere_push / premiere_pull`;
                    return st.installed ? 'installed, Premiere closed (fine: premiere_open starts it with the project)' : 'not installed (optional; `catcut premiere-bridge install` for premiere_* tools without computer use)';
                })(),
                effectcraft: env.tools.effectcraftCli ? 'found (optional; .ecproj comps: ae_create / build render them headless)' : 'not found (optional)',
                captions: await (async () => {
                    const w = findWhisper();
                    const libass = env.tools.ffmpeg ? await hasFilter(env.tools.ffmpeg, 'subtitles') : false;
                    const parts = [
                        libass ? 'burn-in ok (libass)' : 'no libass: captions/text cannot be burned (macOS: brew install ffmpeg-full)',
                        w.cli ? `whisper ${w.model ? basename(w.model) : `has no model (put ggml-*.bin in ${modelsDir()})`}` : 'whisper-cli not found (transcribe unavailable)',
                    ];
                    return parts.join(' · ');
                })(),
                problems: state.problems,
                compat: COMPAT_NOTES,
                project: state.project ? { name: state.project.meta.name, dir: state.project.dir } : null,
            };
        },
    }),
];
export const TOOLS = [...CORE_TOOLS, ...EXTRA_TOOLS];
//# sourceMappingURL=tools.js.map