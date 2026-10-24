/**
 * Reels / TikTok / Shorts tools: speech transcripts (whisper.cpp), auto captions and text overlays burned
 * into deliverables, jump cuts on pauses, punch-in zooms, SFX on cuts. Timeline tools are dry runs by
 * default and back the timeline up before applying (undo: timeline_restore).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { framesToTc } from '../core/timecode.js';
import { captionAssets, captionSource, chunkWords, joinWords, placeWords, projectWords, transcriptsDir } from '../engine/captions.js';
import { applySplits, detectSilences, speechRanges, splitClip } from '../engine/jumpcut.js';
import { cachedTranscript, findWhisper, modelsDir } from '../engine/transcribe.js';
import { requireFfmpeg, requireProject } from './state.js';
import { tool, ToolError } from './tooldef.js';
const WAIT_MS = 20_000;
const frames = z.number().int();
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, '#RRGGBB');
/** history/timeline-<ISO-safe>-<n>.json, the format timeline_restore lists; exclusive create, never overwrites. */
async function backupTimeline(p, reason) {
    const dir = join(p.dir, 'history');
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const body = `${JSON.stringify({ savedAt: now, reason, timeline: p.timeline }, null, 2)}\n`;
    for (let n = 1;; n++) {
        const file = join(dir, `timeline-${now.replace(/[:.]/g, '-')}-${n}.json`);
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
/** Back up, set, validate (restoring on errors), save. */
async function applyTimeline(state, p, next, reason) {
    const backup = await backupTimeline(p, reason);
    const prev = p.timeline;
    state.api.project.setTimeline(p, next);
    const errors = state.api.project.validateTimeline(p);
    if (errors.length) {
        state.api.project.setTimeline(p, prev);
        throw new ToolError(`ไทม์ไลน์ใหม่ไม่ผ่านการตรวจสอบ ไม่ได้บันทึก / timeline invalid, not applied`, { errors, backup });
    }
    await state.api.project.saveProject(p);
    return backup;
}
function clipsById(p, ids) {
    if (!ids)
        return p.timeline.video;
    const unknown = ids.filter((id) => !p.timeline.video.some((c) => c.id === id));
    if (unknown.length)
        throw new ToolError(`ไม่พบคลิป / unknown clips: ${unknown.join(', ')}`, { unknown });
    return p.timeline.video.filter((c) => ids.includes(c.id));
}
const UNDO = 'ย้อนกลับได้ด้วย timeline_restore / undo with timeline_restore';
export const REELS_TOOLS = [
    tool({
        name: 'transcribe',
        description: 'ถอดเสียงพูดเป็นคำพร้อมเวลา (whisper.cpp ในเครื่อง ไม่ส่งไฟล์ออกนอกเครื่อง) เก็บ cache ไว้ใช้ทำซับ: ค่าเริ่มต้น = แหล่งเสียงที่ซับใช้ (VO ถ้ามี ไม่งั้นเสียงกล้องของคลิปบนไทม์ไลน์); งานยาวคืน jobId · Transcribe speech to timed words (local whisper.cpp), cached for captions',
        input: {
            assets: z.array(z.string()).optional().describe('asset ids; default: what the captions use'),
            lang: z.string().optional().describe("'th', 'en', … or 'auto'; default captions.lang or auto"),
            wait: z.boolean().optional().describe('false: return the job id at once'),
        },
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            requireFfmpeg(state);
            const w = findWhisper();
            if (!w.cli || !w.model) {
                throw new ToolError('ยังไม่มี whisper — ติดตั้ง whisper.cpp และโมเดลก่อน / whisper.cpp or its model is missing', {
                    cli: w.cli ?? null, model: w.model ?? null, modelsDir: modelsDir(),
                    hint: process.platform === 'darwin'
                        ? 'brew install ffmpeg-full (มี whisper-cli มาด้วย) แล้วโหลด ggml-large-v3-turbo-q5_0.bin ไว้ใน modelsDir'
                        : 'ติดตั้ง whisper.cpp (whisper-cli) แล้ววางโมเดล ggml-*.bin ใน modelsDir หรือกำหนด EDITMCP_WHISPER_CLI / EDITMCP_WHISPER_MODEL',
                });
            }
            const ids = a.assets ?? captionAssets(p);
            if (!ids.length)
                throw new ToolError('ไม่มีคลิปเสียงให้ถอด / nothing to transcribe (no clips or VO on the timeline)');
            const files = ids.map((id) => {
                const asset = p.assets[id];
                if (!asset)
                    throw new ToolError(`ไม่พบ asset / unknown asset: ${id}`);
                if (asset.kind === 'aecomp' || asset.kind === 'still')
                    throw new ToolError(`asset ไม่มีเสียงพูด / ${id} has no speech (${asset.kind})`);
                return { id, path: asset.path };
            });
            const lang = a.lang ?? p.captions?.lang;
            const job = state.jobs.start('transcribe', async (ctx) => {
                const out = [];
                for (const [i, f] of files.entries()) {
                    ctx.progress({ stage: 'transcribe', done: i, total: files.length, message: f.id });
                    const t = await cachedTranscript(state.env.tools, transcriptsDir(p), f.path, { ...(lang ? { lang } : {}), signal: ctx.signal, whisper: w });
                    out.push({ asset: f.id, cached: t.cached, lang: t.lang, model: t.model, words: t.words.length, text: t.text.length > 1500 ? `${t.text.slice(0, 1500)}…` : t.text });
                }
                ctx.progress({ stage: 'transcribe', done: files.length, total: files.length });
                return {
                    ok: true, transcripts: out,
                    hint: 'ตรวจคำผิด (ชื่อแบรนด์/ศัพท์อังกฤษ) แล้วแก้ด้วย captions_set {fixes:[{from,to}]}; ดูซับด้วย captions_plan / fix misheard words with captions_set {fixes}',
                };
            });
            if (a.wait === false)
                return { ok: true, jobId: job.id, pending: true };
            let timer;
            const info = await Promise.race([state.jobs.wait(job.id), new Promise((r) => { timer = setTimeout(() => r(undefined), WAIT_MS); })]);
            clearTimeout(timer);
            if (!info)
                return { ok: true, jobId: job.id, pending: true, hint: 'ยังถอดเสียงอยู่ — รอผลด้วย job_wait {id} / still running: job_wait {id}' };
            if (info.status === 'done')
                return { ...info.result, jobId: job.id };
            throw new ToolError(info.error ?? `transcribe ${info.status}`, { jobId: job.id });
        },
    }),
    tool({
        name: 'captions_set',
        description: 'ตั้งค่าซับอัตโนมัติ (สไตล์ Reels/TikTok) ที่เผาลงไฟล์ส่งงานตอน deliver (master ProRes ไม่มีซับ): enabled, style pop (ไฮไลต์ทีละคำ) | clean, position, font, สี, ขนาด, คำแก้ (fixes) และ targets · Configure burned-in auto captions (merged into the current settings)',
        input: {
            enabled: z.boolean().optional(),
            source: z.enum(['auto', 'clips', 'vo']).optional().describe('speech of the video clips or of the VO track; auto = VO when present'),
            lang: z.string().optional(),
            style: z.enum(['pop', 'clean']).optional(),
            position: z.enum(['bottom', 'middle', 'top']).optional().describe('default: middle on vertical video, bottom otherwise'),
            font: z.string().optional().describe('installed font family with Thai glyphs, e.g. "Kanit", "Prompt"'),
            fontScale: z.number().min(0.3).max(3).optional(),
            color: hex.optional(),
            highlight: hex.optional().describe('colour of the word being spoken (pop)'),
            uppercase: z.boolean().optional(),
            maxWords: z.number().int().min(1).max(12).optional(),
            maxChars: z.number().int().min(4).max(60).optional(),
            fixes: z.array(z.object({ from: z.string().min(1), to: z.string() })).optional().describe('replaces the whole fix list'),
            targets: z.array(z.string()).optional().describe('delivery targets that get captions; default all except th_tv, th_prores, m422hq'),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const next = { ...(p.captions ?? { enabled: false }) };
            for (const [k, v] of Object.entries(a))
                if (v !== undefined)
                    next[k] = v;
            if (a.enabled === undefined && !p.captions)
                next.enabled = true; // first call turns them on
            p.captions = next;
            await state.api.project.saveProject(p);
            return {
                ok: true, captions: p.captions, source: captionSource(p), assets: captionAssets(p),
                hint: 'ดูข้อความและเวลาด้วย captions_plan; ซับจะขึ้นเมื่อ deliver / preview with captions_plan; burned in on deliver',
            };
        },
    }),
    tool({
        name: 'captions_plan',
        description: 'ดูซับที่จะขึ้นจริงตามไทม์ไลน์ปัจจุบัน (ข้อความ + timecode) จาก transcript ใน cache ใช้ตรวจคำผิดก่อน deliver; ไม่ถอดเสียงเอง · List the captions as they will appear (from cached transcripts)',
        input: { limit: z.number().int().min(1).max(500).optional() },
        handler: async (a, state) => {
            const p = requireProject(state);
            const c = p.captions;
            const missing = [];
            const words = await projectWords(p, state.env.tools, transcriptsDir(p), { cacheOnly: true, missing });
            const fps = p.meta.fps;
            const caps = chunkWords(placeWords(p, words), fps, { ...(c?.maxWords ? { maxWords: c.maxWords } : {}), ...(c?.maxChars ? { maxChars: c.maxChars } : {}) });
            const limit = a.limit ?? 120;
            return {
                ok: true, enabled: !!c?.enabled, source: captionSource(p), count: caps.length,
                captions: caps.slice(0, limit).map((x) => ({ start: x.start, tc: framesToTc(x.start, fps), dur: x.end - x.start, text: joinWords(x.words.map((w) => w.text)) })),
                texts: c?.texts ?? [],
                ...(missing.length ? { missing, hint: `ยังไม่ได้ถอดเสียง: ${missing.join(', ')} — เรียก transcribe ก่อน / not transcribed yet: call transcribe` } : {}),
                ...(!c?.enabled ? { note: 'ซับยังปิดอยู่ เปิดด้วย captions_set {enabled:true} / captions are off' } : {}),
            };
        },
    }),
    tool({
        name: 'text_add',
        description: 'ใส่ข้อความบนภาพ (เผาลงไฟล์ส่งงาน): style hook = ข้อความใหญ่ด้านบนช่วงต้นคลิป (ฮุก 2-3 วิแรก), title = กลางจอ, lower = มุมล่าง; at/dur เป็นเฟรม · Add an on-screen text overlay (hook/title/lower)',
        input: {
            text: z.string().min(1).describe('\\n for a line break'),
            at: frames.min(0).optional().describe('default 0'),
            dur: frames.min(1).optional().describe('default 3 s'),
            style: z.enum(['hook', 'title', 'lower']).optional().describe('default hook'),
            id: z.string().optional(),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const c = p.captions ?? { enabled: false };
            const texts = [...(c.texts ?? [])];
            let id = a.id ?? `t${texts.length + 1}`;
            for (let n = texts.length + 2; !a.id && texts.some((t) => t.id === id); n++)
                id = `t${n}`;
            if (texts.some((t) => t.id === id))
                throw new ToolError(`id ซ้ำ / duplicate text id: ${id}`);
            texts.push({ id, text: a.text, at: a.at ?? 0, dur: a.dur ?? Math.round(p.meta.fps * 3), style: a.style ?? 'hook' });
            p.captions = { ...c, texts };
            await state.api.project.saveProject(p);
            return { ok: true, texts, hint: 'ขึ้นในไฟล์ deliver (ไม่ใช่ master) / burned into deliverables' };
        },
    }),
    tool({
        name: 'text_remove',
        description: 'ลบข้อความบนภาพตาม id · Remove a text overlay',
        input: { id: z.string() },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const texts = p.captions?.texts ?? [];
            if (!texts.some((t) => t.id === a.id))
                throw new ToolError(`ไม่พบข้อความ / unknown text id: ${a.id}`, { ids: texts.map((t) => t.id) });
            p.captions = { ...p.captions, texts: texts.filter((t) => t.id !== a.id) };
            await state.api.project.saveProject(p);
            return { ok: true, texts: p.captions.texts };
        },
    }),
    tool({
        name: 'jumpcut',
        description: 'ตัดช่วงเงียบ/หยุดพูดออก (jump cut สไตล์ Reels) จากเสียงของคลิปเอง: แบ่งคลิปเป็นท่อนที่มีเสียงพูด (<id>_j1, _j2…); ค่าเริ่มต้นทุกคลิปที่มีเสียงและไม่ได้เปลี่ยนความเร็ว; dry run ก่อน, apply: true เพื่อใช้ (สำรองไทม์ไลน์ก่อน) · Cut out pauses in talking-head clips',
        input: {
            clips: z.array(z.string()).optional(),
            noiseDb: z.number().min(-80).max(-10).optional().describe('silence threshold, default -35 (raise to -30 for noisy rooms)'),
            minSilenceMs: z.number().int().min(100).max(5000).optional().describe('shorter pauses stay; default 350'),
            padMs: z.number().int().min(0).max(1000).optional().describe('speech kept around each cut; default 80'),
            minPieceMs: z.number().int().min(0).max(5000).optional().describe('drop speech bits shorter than this; default 200'),
            apply: z.boolean().optional(),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            requireFfmpeg(state);
            const fps = p.meta.fps;
            const opts = {
                ...(a.noiseDb !== undefined ? { noiseDb: a.noiseDb } : {}), ...(a.minSilenceMs !== undefined ? { minSilenceMs: a.minSilenceMs } : {}),
                ...(a.padMs !== undefined ? { padMs: a.padMs } : {}), ...(a.minPieceMs !== undefined ? { minPieceMs: a.minPieceMs } : {}),
            };
            const taken = new Set(p.timeline.video.map((c) => c.id));
            const pieces = new Map();
            const report = [];
            const skipped = [];
            for (const clip of clipsById(p, a.clips)) {
                const asset = p.assets[clip.src];
                if (!asset || asset.kind === 'aecomp' || asset.kind === 'still') {
                    skipped.push({ clip: clip.id, reason: 'no audio (AE comp / still)' });
                    continue;
                }
                if (asset.probe && !asset.probe.hasAudio) {
                    skipped.push({ clip: clip.id, reason: 'source has no audio' });
                    continue;
                }
                if (clip.speed) {
                    skipped.push({ clip: clip.id, reason: 'speed-changed clip' });
                    continue;
                }
                const silences = await detectSilences(state.env.tools, asset.path, clip.in / fps, clip.dur / fps, opts);
                const ranges = speechRanges(silences, clip.dur, fps, opts);
                if (!ranges.length) {
                    skipped.push({ clip: clip.id, reason: 'no speech found (kept as is; lower noiseDb if it has quiet speech)' });
                    continue;
                }
                const parts = splitClip(clip, ranges, taken);
                if (parts.length === 1 && parts[0] === clip)
                    continue;
                pieces.set(clip.id, parts);
                const kept = parts.reduce((n, c) => n + c.dur, 0);
                report.push({ clip: clip.id, pieces: parts.length, before: clip.dur, after: kept, removed: clip.dur - kept, removedSec: Math.round(((clip.dur - kept) / fps) * 10) / 10 });
            }
            const removed = report.reduce((n, r) => n + r['removed'], 0);
            const base = { clips: report, skipped, removedFrames: removed, removedTc: framesToTc(removed, fps) };
            if (!a.apply || !pieces.size) {
                return { ok: true, applied: false, ...base, ...(pieces.size ? { next: 'ตรวจแล้วเรียกซ้ำด้วย apply: true / call again with apply: true' } : { note: 'ไม่มีช่วงเงียบให้ตัด / nothing to cut' }) };
            }
            const backup = await applyTimeline(state, p, applySplits(p.timeline, pieces), `before jumpcut (${pieces.size} clips)`);
            return { ok: true, applied: true, backup, ...base, hint: `ต่อด้วย punch_in ให้แต่ละท่อนสลับซูม; ${UNDO}` };
        },
    }),
    tool({
        name: 'punch_in',
        description: 'ซูมกระแทก (punch-in) สไตล์ Reels: ท่อนที่ต่อกันจากไฟล์เดียวกัน (เช่นหลัง jumpcut) สลับ 100% ↔ scale%; pattern all = ทุกคลิปที่เลือก; dry run ก่อน, apply: true เพื่อใช้ · Alternate zoom on consecutive pieces of the same source',
        input: {
            scale: z.number().min(101).max(200).optional().describe('zoomed size in percent; default 115'),
            pattern: z.enum(['alternate', 'all']).optional().describe('default alternate'),
            clips: z.array(z.string()).optional(),
            apply: z.boolean().optional(),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            const zoom = a.scale ?? 115;
            const pick = new Set(clipsById(p, a.clips).map((c) => c.id));
            const next = structuredClone(p.timeline);
            const changes = [];
            let run = 0;
            next.video.forEach((c, i) => {
                const prev = next.video[i - 1];
                run = prev && prev.src === c.src ? run + 1 : 0; // a new source restarts the pattern wide
                if (!pick.has(c.id))
                    return;
                const want = (a.pattern ?? 'alternate') === 'all' || run % 2 === 1 ? zoom : 100;
                const was = c.scale ?? 100;
                if (want === was)
                    return;
                if (want === 100)
                    delete c.scale;
                else
                    c.scale = want;
                changes.push({ clip: c.id, from: was, to: want });
            });
            if (!a.apply || !changes.length) {
                return { ok: true, applied: false, changes, ...(changes.length ? { next: 'apply: true เพื่อใช้ / call again with apply: true' } : { note: 'ไม่มีอะไรเปลี่ยน / nothing to change' }) };
            }
            const backup = await applyTimeline(state, p, next, `before punch_in ${zoom}%`);
            return { ok: true, applied: true, backup, changes, hint: UNDO };
        },
    }),
    tool({
        name: 'sfx_on_cuts',
        description: 'วางเสียงเอฟเฟกต์ (whoosh/pop) ที่รอยตัด: cuts source-change = เฉพาะตอนเปลี่ยนไฟล์ (ค่าเริ่มต้น), all = ทุกรอยตัดรวม jump cut; หลายไฟล์จะวนใช้; แทนที่ชุดเดิมที่เครื่องมือนี้วางไว้ (id sfx_auto_*); dry run ก่อน · Place SFX on cuts (replaces earlier auto SFX)',
        input: {
            srcs: z.array(z.string()).min(1).describe('audio asset ids (whoosh, pop, click…), used in turn'),
            cuts: z.enum(['source-change', 'all']).optional(),
            gainDb: z.number().min(-40).max(6).optional().describe('default -8'),
            offset: frames.optional().describe('frames relative to the cut; default -2 (the whoosh lands on the cut)'),
            apply: z.boolean().optional(),
        },
        mutating: true,
        writesProject: true,
        handler: async (a, state) => {
            const p = requireProject(state);
            for (const id of a.srcs)
                if (!p.assets[id])
                    throw new ToolError(`ไม่พบ asset / unknown asset: ${id} (เพิ่มไฟล์เสียงด้วย asset_add ก่อน)`);
            const starts = state.api.project.clipStartFrames(p);
            const v = p.timeline.video;
            const at = [];
            for (let i = 1; i < v.length; i++) {
                if ((a.cuts ?? 'source-change') === 'source-change' && v[i].src === v[i - 1].src)
                    continue;
                at.push(Math.max(0, (starts.get(v[i].id) ?? 0) + (a.offset ?? -2)));
            }
            const next = structuredClone(p.timeline);
            const removed = next.audio.sfx.filter((c) => c.id.startsWith('sfx_auto_')).length;
            next.audio.sfx = next.audio.sfx.filter((c) => !c.id.startsWith('sfx_auto_'));
            const added = at.map((f, i) => ({ id: `sfx_auto_${i + 1}`, src: a.srcs[i % a.srcs.length], at: f, gainDb: a.gainDb ?? -8 }));
            next.audio.sfx.push(...added);
            const fps = p.meta.fps;
            const base = { added: added.map((c) => ({ ...c, tc: framesToTc(c.at, fps) })), replaced: removed };
            if (!a.apply)
                return { ok: true, applied: false, ...base, next: 'apply: true เพื่อใช้ / call again with apply: true' };
            const backup = await applyTimeline(state, p, next, 'before sfx_on_cuts');
            return { ok: true, applied: true, backup, ...base, hint: UNDO };
        },
    }),
];
//# sourceMappingURL=tools-reels.js.map