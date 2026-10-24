/**
 * Speech → timed words with whisper.cpp (`whisper-cli`), for captions and transcript-based edits.
 *
 * ffmpeg extracts 16 kHz mono WAV into an ASCII temp folder; whisper-cli writes its "JSON full" output
 * (segments + per-token offsets). Words come from Intl.Segmenter (Thai has no spaces between words), each
 * timed by the tokens that cover its characters. Transcripts are cached per source content + model + language
 * under <project>/cache/transcripts/, so captions and re-delivers never transcribe twice.
 */
import { execa } from 'execa';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, join } from 'node:path';
import { hashFile, hashJson } from '../core/hash.js';
import { exe, localAppDataDir, pathDirs } from '../core/platform.js';
import { isAscii, killTree } from './aerender.js';
/** Model preference: better Thai first; the user can pin one with EDITMCP_WHISPER_MODEL. */
const MODEL_RANK = [/large-v3-turbo/, /large-v3/, /large/, /medium/, /small/, /base/, /tiny/];
/** whisper-cli: EDITMCP_WHISPER_CLI, PATH, Homebrew; model: EDITMCP_WHISPER_MODEL, else the best ggml-*.bin in <app data>/CatCut/models. */
export function findWhisper(env = process.env) {
    const name = exe('whisper-cli');
    const cli = [env['EDITMCP_WHISPER_CLI'] ?? '', ...pathDirs(env).map((d) => join(d, name)), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name]
        .find((p) => p && existsSync(p));
    let model = env['EDITMCP_WHISPER_MODEL'] && existsSync(env['EDITMCP_WHISPER_MODEL']) ? env['EDITMCP_WHISPER_MODEL'] : undefined;
    if (!model) {
        const dir = modelsDir();
        let files = [];
        try {
            files = readdirSync(dir).filter((f) => /^ggml-.*\.bin$/i.test(f) && statSync(join(dir, f)).size > 1e6);
        }
        catch { /* none yet */ }
        const rank = (f) => { const i = MODEL_RANK.findIndex((r) => r.test(f)); return i < 0 ? MODEL_RANK.length : i; };
        const best = files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
        if (best)
            model = join(dir, best);
    }
    return { ...(cli ? { cli } : {}), ...(model ? { model } : {}) };
}
export function modelsDir() {
    return join(localAppDataDir(), 'CatCut', 'models');
}
const wordSegmenter = (lang) => new Intl.Segmenter(lang === 'auto' ? undefined : lang, { granularity: 'word' });
/**
 * Words with times from whisper's JSON full. Token texts are concatenated per segment so every character
 * knows the token (and time) it came from; a word starts at its first character's token and ends at its
 * last one's. When tokens do not spell the segment text (rare), times are spread by character count.
 */
export function wordsFromWhisper(json, lang = 'auto', silences = []) {
    const seg = wordSegmenter(json.result?.language ?? lang);
    const words = [];
    for (const s of json.transcription ?? []) {
        const warp = speechWarp(s.offsets.from, s.offsets.to, silences);
        const segStart = words.length;
        const tokens = (s.tokens ?? []).filter((t) => !/^\[_.*\]$/.test(t.text.trim()) && t.text !== '');
        let text = tokens.map((t) => t.text).join('');
        const charTimes = [];
        for (const t of tokens)
            for (let i = 0; i < t.text.length; i++)
                charTimes.push(t.offsets);
        if (text.trim() !== s.text.trim() || !charTimes.length) {
            // fall back: spread the segment over its characters
            text = s.text;
            charTimes.length = 0;
            const span = Math.max(1, s.offsets.to - s.offsets.from);
            for (let i = 0; i < text.length; i++) {
                const a = s.offsets.from + (span * i) / text.length;
                charTimes.push({ from: a, to: a + span / text.length });
            }
        }
        let space = true; // a new whisper segment starts a phrase
        for (const part of seg.segment(text)) {
            if (!part.isWordLike) {
                if (/\s/.test(part.segment))
                    space = true;
                // punctuation sticks to the word before it ("world," "ครับ!")
                const last = words[words.length - 1];
                const p = part.segment.trim();
                if (p && last && part.index > 0)
                    last.text += p;
                continue;
            }
            const first = charTimes[part.index];
            const lastChar = charTimes[part.index + part.segment.length - 1];
            if (!first || !lastChar)
                continue;
            words.push({ text: part.segment, startMs: Math.round(first.from), endMs: Math.round(Math.max(lastChar.to, first.from)), ...(space ? { space: true } : {}) });
            space = false;
        }
        for (let i = segStart; i < words.length; i++) {
            const w = words[i];
            w.startMs = Math.round(warp(w.startMs));
            w.endMs = Math.round(Math.max(warp(w.endMs), w.startMs));
        }
    }
    // whisper sometimes gives zero-length tokens: end at least where the next word starts
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const next = words[i + 1];
        if (w.endMs <= w.startMs)
            w.endMs = next ? Math.max(w.startMs + 1, next.startMs) : w.startMs + 300;
    }
    return words;
}
/**
 * whisper's token times run on through pauses (words after a pause start inside the silence), which would
 * put captions early and let jump cuts drop words. Within one segment, map whisper time linearly onto the
 * parts of [from, to) that really have sound (silences from silencedetect on the same audio).
 */
export function speechWarp(from, to, silences) {
    const speech = [];
    let pos = from;
    for (const s of [...silences].sort((a, b) => a.startMs - b.startMs)) {
        if (s.endMs <= pos || s.startMs >= to)
            continue;
        if (s.startMs > pos)
            speech.push([pos, s.startMs]);
        pos = Math.max(pos, s.endMs);
    }
    if (pos < to)
        speech.push([pos, to]);
    const total = speech.reduce((n, [a, b]) => n + b - a, 0);
    const span = to - from;
    if (!speech.length || total <= 0 || span <= 0 || total >= span - 1)
        return (t) => t;
    return (t) => {
        let left = (Math.min(Math.max(t, from), to) - from) / span * total;
        for (const [a, b] of speech) {
            if (left <= b - a)
                return a + left;
            left -= b - a;
        }
        return speech[speech.length - 1][1];
    };
}
/** Spelling fixes (brand names, misheard words), applied word by word and across neighbouring words. */
export function applyFixes(words, fixes = []) {
    let out = words.map((w) => ({ ...w }));
    for (const f of fixes) {
        if (!f.from)
            continue;
        const next = [];
        for (let i = 0; i < out.length; i++) {
            // longest run of words starting at i whose joined text equals `from` (Thai: no spaces)
            let joined = '';
            let hit = -1;
            for (let j = i; j < out.length && joined.length < f.from.length + 4; j++) {
                joined += (joined && /[A-Za-z0-9]$/.test(joined) && /^[A-Za-z0-9]/.test(out[j].text) ? ' ' : '') + out[j].text;
                if (joined.replace(/[.,!?]+$/, '') === f.from) {
                    hit = j;
                    break;
                }
            }
            if (hit < 0) {
                next.push(out[i]);
                continue;
            }
            const tail = out[hit].text.match(/[.,!?]+$/)?.[0] ?? '';
            next.push({ text: f.to + tail, startMs: out[i].startMs, endMs: out[hit].endMs, ...(out[i].space ? { space: true } : {}) });
            i = hit;
        }
        out = next;
    }
    return out;
}
/** Transcribe one media file (its first audio stream). */
export async function transcribeFile(tools, file, opts = {}) {
    const run = opts.run ?? execa;
    const w = opts.whisper ?? findWhisper();
    if (!w.cli)
        throw new Error('whisper-cli not found: brew install whisper-cpp (or ffmpeg-full), or set EDITMCP_WHISPER_CLI');
    if (!w.model)
        throw new Error(`no whisper model: put a ggml-*.bin into ${modelsDir()} (e.g. ggml-large-v3-turbo-q5_0.bin) or set EDITMCP_WHISPER_MODEL`);
    const lang = opts.lang ?? 'auto';
    const tempRoot = os.tmpdir();
    if (!isAscii(tempRoot))
        throw new Error('whisper needs an ASCII TEMP directory; set TEMP/TMP to an ASCII path');
    const dir = await mkdtemp(join(tempRoot, 'catcut-whisper-'));
    try {
        const wav = join(dir, 'audio.wav');
        const ff = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { reject: false, windowsHide: true, timeout: 30 * 60_000, cancelSignal: opts.signal });
        if (ff.exitCode !== 0)
            throw new Error(`ffmpeg could not read the audio of ${file}: ${String(ff.stderr ?? '').trim().slice(-300)}`);
        const durSec = statSync(wav).size / 32000;
        const child = run(w.cli, ['-m', w.model, '-f', wav, '-l', lang, '-ojf', '-of', join(dir, 'out'), '-np'], { reject: false, windowsHide: true, timeout: 0, cancelSignal: opts.signal });
        const timeoutMs = Math.max(10 * 60_000, durSec * 3000);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; void killTree(child.pid, run, child); }, timeoutMs);
        let r;
        try {
            r = await child;
        }
        finally {
            clearTimeout(timer);
        }
        if (timedOut)
            throw new Error(`whisper timed out after ${Math.round(timeoutMs / 1000)} s`);
        const raw = await readFile(join(dir, 'out.json'), 'utf8').catch(() => undefined);
        if (r.exitCode !== 0 || raw === undefined)
            throw new Error(`whisper-cli failed (${r.exitCode}): ${String(r.stderr ?? '').trim().slice(-400)}`);
        const json = JSON.parse(raw);
        const silences = await pauses(tools, wav, run, opts.signal);
        const words = wordsFromWhisper(json, lang, silences);
        return {
            source: file, lang: json.result?.language ?? lang, model: basename(w.model),
            text: (json.transcription ?? []).map((s) => s.text.trim()).join(' '), words,
        };
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
/** Pauses in the 16 kHz WAV (ms), for speechWarp; none when silencedetect is unavailable. */
async function pauses(tools, wav, run, signal) {
    const r = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-i', wav, '-af', 'silencedetect=noise=-40dB:d=0.25', '-f', 'null', '-'], { reject: false, windowsHide: true, timeout: 10 * 60_000, cancelSignal: signal });
    if (r.exitCode !== 0)
        return [];
    const out = [];
    let open;
    for (const line of String(r.stderr ?? '').split(/\r?\n/)) {
        const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (a) {
            open = Math.max(0, Number(a[1]) * 1000);
            continue;
        }
        const b = /silence_end:\s*([\d.]+)/.exec(line);
        if (b && open !== undefined) {
            out.push({ startMs: open, endMs: Number(b[1]) * 1000 });
            open = undefined;
        }
    }
    return out;
}
/** Bump when word timing changes, so cached transcripts are redone. */
const TIMING_VERSION = 2;
/** Cache file name for a transcript: source content + model + language + timing method. */
export async function transcriptKey(file, model, lang = 'auto') {
    return hashJson({ file: await hashFile(file), model: model ? basename(model) : null, lang, timing: TIMING_VERSION }).slice(0, 16);
}
export async function cachedTranscript(tools, cacheDir, file, opts = {}) {
    const w = opts.whisper ?? findWhisper();
    const target = join(cacheDir, `${await transcriptKey(file, w.model, opts.lang)}.json`);
    const hit = await readFile(target, 'utf8').then((t) => JSON.parse(t)).catch(() => undefined);
    if (hit)
        return { ...hit, cached: true };
    if (opts.cacheOnly)
        return undefined;
    opts.onMiss?.();
    const t = await transcribeFile(tools, file, { ...opts, whisper: w });
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(t, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
    return { ...t, cached: false };
}
//# sourceMappingURL=transcribe.js.map