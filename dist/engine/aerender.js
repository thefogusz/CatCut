/**
 * aerender wrapper. Renders a comp (or a single frame) through Adobe's aerender.exe
 * WITHOUT ever touching a running After Effects GUI.
 *
 * - Output goes to an ASCII temp name first (AE 25.2–26.x mangles non-ASCII output
 *   file names set from scripts/CLI), then is renamed to the requested path.
 * - Never overwrites: an existing target gets a `_2`, `_3`… suffix.
 * - Every process spawn goes through an injectable `spawn` (default: execa) so tests
 *   can fake aerender while still running real ffmpeg/ffprobe.
 * - Timeout / abort → the whole process tree is killed (taskkill /T /F on Windows, ps + SIGKILL elsewhere).
 * - Refuses to start when the output or AE-cache drive is nearly full; retries once when aerender
 *   crashes before rendering its first frame (never after a timeout or abort).
 */
import { execa } from 'execa';
import { constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile, link, statfs as fsStatfs, unlink } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { freeRamBytes, listPosixProcesses, ownTree } from '../core/platform.js';
import { tcToFrames } from '../core/timecode.js';
/** Structured aerender failure: callers decide on fallbacks from `reason` + aerender's own error lines. */
export class AerenderError extends Error {
    reason;
    errors;
    startupCrash;
    /** startupCrash: non-zero exit before any frame was rendered that looks like a crash, not a usage error. */
    constructor(message, reason, errors, startupCrash = false) {
        super(message);
        this.reason = reason;
        this.errors = errors;
        this.startupCrash = startupCrash;
        this.name = 'AerenderError';
    }
}
const STARTUP_CRASH = /crash|unexpected(?:ly)?\s+(?:quit|exit|terminat)|access violation|0xc0000005|unhandled exception|failed to (?:start|launch|initiali[sz]e)|unable to (?:start|launch|initiali[sz]e)|could not (?:start|launch|initiali[sz]e|connect)|after effects (?:has )?(?:stopped|quit|crashed)/i;
/**
 * Exit before the first frame that looks like a crash: a Windows exception exit code, no aerender ERROR
 * line at all (process died silently), or a crash-like message. Plain ERROR lines (comp not found,
 * bad template...) are deterministic and are not retried.
 */
export function isStartupCrashOutput(exitCode, errors, log, userStrings = []) {
    if (exitCode === undefined || exitCode < 0 || exitCode >= 0xc0000000)
        return true;
    const clean = (l) => { let s = l; for (const u of userStrings)
        if (u)
            s = s.split(u).join(' '); return s; };
    if (log.some((l) => !l.startsWith('$ ') && STARTUP_CRASH.test(clean(l))))
        return true;
    return errors.length === 0;
}
const GB = 2 ** 30;
/** Free bytes on the volume holding `path` (or its nearest existing ancestor). */
export async function freeDiskBytes(path, statfs = (p) => fsStatfs(p)) {
    let cur = resolve(path);
    while (!existsSync(cur)) {
        const up = dirname(cur);
        if (up === cur)
            break;
        cur = up;
    }
    const s = await statfs(cur);
    return Number(s.bavail) * Number(s.bsize);
}
/** Folder on the drive AE's disk cache uses: EDITMCP_AE_CACHE_DIR, else %LOCALAPPDATA% / ~/Library/Caches (AE's default lives under it). */
export function defaultAeCacheDir() {
    if (process.env['EDITMCP_AE_CACHE_DIR'])
        return process.env['EDITMCP_AE_CACHE_DIR'];
    if (process.platform === 'darwin')
        return join(os.homedir(), 'Library', 'Caches');
    return process.env['LOCALAPPDATA'] || os.tmpdir();
}
/** ProRes 422 HQ ≈ 0.45 byte/pixel/frame; the Lossless fallback writes ~4 bytes/pixel before the transcode. */
export function estimateOutputBytes(frames, width = 1920, height = 1080, fallback = false) {
    return frames * width * height * (fallback ? 4.5 : 0.45);
}
export class DiskSpaceError extends Error {
    path;
    freeBytes;
    needBytes;
    constructor(message, path, freeBytes, needBytes) {
        super(message);
        this.path = path;
        this.freeBytes = freeBytes;
        this.needBytes = needBytes;
        this.name = 'DiskSpaceError';
    }
}
function driveOf(p) {
    const root = parse(resolve(p)).root;
    return process.platform === 'win32' ? root.toLowerCase() : root;
}
/**
 * Refuse a render when the output drive or the AE disk-cache drive has less than
 * max(minFreeGb (5), 2 × estimated output) free. Returns a log note; a failing statfs only warns.
 */
async function checkRenderDiskSpace(req, frames, opts) {
    const est = req.estimatedBytes ?? estimateOutputBytes(frames, req.width, req.height, req.fallback);
    const need = Math.max((opts.minFreeGb ?? 5) * GB, 2 * est);
    const checks = [{ path: dirname(resolve(req.outPath)), what: 'output' }, { path: opts.cacheDir ?? defaultAeCacheDir(), what: 'AE disk cache' }];
    const seen = new Set();
    const notes = [];
    for (const c of checks) {
        const drive = driveOf(c.path);
        if (seen.has(drive))
            continue;
        seen.add(drive);
        let free;
        try {
            free = await freeDiskBytes(c.path, opts.statfs);
        }
        catch (e) {
            notes.push(`WARN disk space check skipped for ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
        }
        if (free < need) {
            const f = (free / GB).toFixed(1), n = (need / GB).toFixed(1);
            throw new DiskSpaceError(`พื้นที่ดิสก์ไม่พอสำหรับ render: ไดรฟ์ ${drive} (${c.what}) เหลือ ${f} GB ต้องมีอย่างน้อย ${n} GB — ลบไฟล์เก่าหรือล้าง cache ของ AE (ae_purge_cache) ก่อน / `
                + `not enough disk space to render: ${drive} (${c.what}) has ${f} GB free, need ${n} GB (max(${opts.minFreeGb ?? 5} GB, 2 × estimated output ${(est / GB).toFixed(2)} GB)); free space or purge the AE cache first`, c.path, free, need);
        }
    }
    return notes.length ? notes.join('\n') : undefined;
}
/** Call after a batch of renders: purges AE caches when the disk-cache drive runs low. Never throws. */
export async function purgeIfLowCacheSpace(backend, policy = {}) {
    if (policy.enabled === false)
        return { purged: false, reason: 'disabled' };
    if (!backend.purgeCaches)
        return { purged: false, reason: 'backend cannot purge caches' };
    const dir = policy.cacheDir ?? defaultAeCacheDir();
    const below = policy.belowGb ?? 20;
    let before;
    try {
        before = (await freeDiskBytes(dir, policy.statfs)) / GB;
    }
    catch { /* unknown: purge only when forced */ }
    if (before === undefined ? below !== Infinity : before >= below) {
        return { purged: false, reason: before === undefined ? 'free space unknown' : `cache drive has ${before.toFixed(1)} GB free (>= ${below} GB)`, ...(before !== undefined ? { freeGbBefore: before } : {}) };
    }
    try {
        await backend.purgeCaches();
    }
    catch (e) {
        return { purged: false, reason: `purge failed: ${e instanceof Error ? e.message : String(e)}`, ...(before !== undefined ? { freeGbBefore: before } : {}) };
    }
    let after;
    try {
        after = (await freeDiskBytes(dir, policy.statfs)) / GB;
    }
    catch { /* ignore */ }
    return { purged: true, reason: before === undefined ? 'forced' : `cache drive had ${before.toFixed(1)} GB free (< ${below} GB)`, ...(before !== undefined ? { freeGbBefore: before } : {}), ...(after !== undefined ? { freeGbAfter: after } : {}) };
}
/**
 * True only when aerender exited reporting that the requested output-module template does not exist.
 * Matches aerender's ERROR lines (never the echoed command line), with quoted text and the given
 * user strings (comp name, project path, template name) removed first so names cannot trigger it.
 */
export function isMissingOmTemplate(error, userStrings = []) {
    // AE 2026 reports the missing template but exits 0 without writing a file ('output'), older versions exit non-zero.
    if (!(error instanceof AerenderError) || (error.reason !== 'exit' && error.reason !== 'output'))
        return false;
    return error.errors.some((line) => {
        let l = line;
        for (const s of userStrings)
            if (s)
                l = l.split(s).join(' ');
        l = l.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, ' ');
        return /output[- ]module template/i.test(l)
            && /\bno output[- ]module template\b|\b(?:not|never) (?:been )?found\b|could not be found|does not exist|unable to find/i.test(l);
    });
}
/** -mfr percentage for builds: 90 per the design, scaled down when free RAM is low. */
export function defaultMfrPercent(freeGb = freeRamBytes() / 2 ** 30) {
    if (freeGb >= 16)
        return 90;
    if (freeGb >= 8)
        return 70;
    if (freeGb >= 4)
        return 50;
    return 25;
}
const IMAGE_EXT = new Set(['.png', '.tif', '.tiff', '.jpg', '.jpeg', '.psd', '.exr', '.dpx', '.tga', '.bmp']);
const MAX_LOG_LINES = 4000;
// ---------- small helpers (exported for ae.ts and tests) ----------
export function isAscii(s) {
    // eslint-disable-next-line no-control-regex
    return /^[\x00-\x7f]*$/.test(s);
}
/** `path` if it does not exist, else `base_2.ext`, `base_3.ext`… — never overwrite. */
export function uniqueOutputPath(path) {
    if (!existsSync(path))
        return path;
    const dir = dirname(path);
    const ext = extname(path);
    const stem = basename(path, ext);
    for (let n = 2; n < 10_000; n++) {
        const cand = join(dir, `${stem}_${n}${ext}`);
        if (!existsSync(cand))
            return cand;
    }
    throw new Error(`cannot find a free output name for ${path}`);
}
/**
 * ASCII temp path for an AE render. Same directory when that directory is ASCII,
 * otherwise the OS temp dir. For image outputs the name carries the `[#####]` sequence token.
 */
export function asciiTempPath(outPath) {
    const ext = extname(outPath).toLowerCase() || '.mov';
    const dir = isAscii(dirname(outPath)) ? dirname(outPath) : join(os.tmpdir(), 'editmcp-ae');
    if (!isAscii(dir))
        throw new Error('After Effects requires an ASCII TEMP directory');
    mkdirSync(dir, { recursive: true });
    const safeStem = basename(outPath, extname(outPath)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'render';
    const prefix = `aer_${randomBytes(4).toString('hex')}_${safeStem}`;
    const sequence = IMAGE_EXT.has(ext);
    const tmp = sequence ? join(dir, `${prefix}_[#####]${ext}`) : join(dir, `${prefix}${ext}`);
    return { tmp, sequence, prefix, dir };
}
/** rename, falling back to copy+unlink across volumes. Target must not exist. */
export async function moveFile(from, to) {
    if (existsSync(to))
        throw new Error(`refusing to overwrite ${to}`);
    mkdirSync(dirname(to), { recursive: true });
    try {
        await link(from, to);
        await unlink(from);
    }
    catch (e) {
        if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(e.code ?? ''))
            throw e;
        await copyFile(from, to, constants.COPYFILE_EXCL);
        await unlink(from);
    }
}
/** Kill a process and all its children. */
export async function killTree(pid, spawn, child) {
    if (pid && process.platform === 'win32') {
        try {
            await spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { reject: false, windowsHide: true, timeout: 10_000 });
        }
        catch { /* already gone */ }
    }
    else if (pid) {
        // aerender on macOS starts its own render process: kill every descendant, not only the child
        try {
            for (const p of ownTree(pid, await listPosixProcesses())) {
                try {
                    process.kill(p, 'SIGKILL');
                }
                catch { /* already gone */ }
            }
        }
        catch { /* ps unavailable */ }
    }
    try {
        child?.kill?.('SIGKILL');
    }
    catch { /* ignore */ }
}
/** Video frame count via ffprobe (packets; for all-intra codecs packets == frames). */
export async function probeFrameCount(tools, path, spawn = execa, signal) {
    const r = await spawn(tools.ffprobe, [
        '-v', 'error', '-select_streams', 'v:0', '-count_packets',
        '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path,
    ], { reject: false, windowsHide: true, timeout: 120_000, cancelSignal: signal });
    const n = parseInt(String(r.stdout).trim(), 10);
    if (r.exitCode !== 0 || !Number.isFinite(n))
        throw new Error(`ffprobe could not count frames of ${path}: ${r.stderr}`);
    return n;
}
/**
 * Full comp render: ProRes 422 HQ with optional PCM audio; segment assembly strips audio later.
 * AE's Lossless output is RGB: convert with the BT.709 matrix into limited range and tag the stream,
 * otherwise swscale defaults to BT.601 and players shift every hue.
 */
export async function transcodeToProres(tools, src, dst, spawn = execa, signal) {
    const r = await spawn(tools.ffmpeg, [
        '-hide_banner', '-nostdin', '-n', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2',
        // setparams tags the frames themselves; newer ffmpeg takes stream color info from frames over -color_* flags.
        '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
        '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        dst,
    ], { reject: false, windowsHide: true, timeout: 4 * 60 * 60_000, cancelSignal: signal });
    if (r.exitCode !== 0 || !existsSync(dst))
        throw new Error(`ffmpeg ProRes transcode failed: ${r.stderr}`);
}
// ---------- concurrency gate ----------
class Semaphore {
    max;
    queue = [];
    active = 0;
    constructor(max) {
        this.max = max;
    }
    async acquire() {
        if (this.active < this.max) {
            this.active++;
            return () => this.release();
        }
        await new Promise((res) => this.queue.push(res));
        return () => this.release();
    }
    release() {
        const next = this.queue.shift();
        if (next)
            next();
        else
            this.active--;
    }
}
const gates = new Map();
function gate(max) {
    let g = gates.get(max);
    if (!g) {
        g = new Semaphore(max);
        gates.set(max, g);
    }
    return g;
}
// ---------- progress parsing ----------
const RE_FRAME = /^PROGRESS:\s+(-?\d+:\d+:\d+:\d+)\s+\((\d+)\)/;
const RE_DURATION = /^PROGRESS:\s+Duration:\s+(\d+:\d+:\d+:\d+)/;
const RE_FPS = /^PROGRESS:\s+Frame Rate:\s+([\d.]+)/;
export function createProgressParser(knownTotal) {
    let fps;
    let durationTc;
    let total = knownTotal;
    let done = 0;
    const errors = [];
    return {
        get total() { return total; },
        get done() { return done; },
        errors,
        feed(line) {
            const l = line.trim();
            if (!l)
                return undefined;
            if (/aerender ERROR/i.test(l) || /^ERROR:/i.test(l))
                errors.push(l);
            let m = RE_FPS.exec(l);
            if (m) {
                fps = parseFloat(m[1]);
                if (durationTc && total === undefined)
                    total = tcToFrames(durationTc, fps);
                return undefined;
            }
            m = RE_DURATION.exec(l);
            if (m) {
                durationTc = m[1];
                if (fps && total === undefined)
                    total = tcToFrames(durationTc, fps);
                return undefined;
            }
            m = RE_FRAME.exec(l);
            if (m) {
                done = parseInt(m[2], 10);
                return { stage: 'aerender', done, total: total ?? Math.max(done, 1), message: m[1] };
            }
            return undefined;
        },
    };
}
// ---------- main ----------
function buildArgs(req, tmpOut) {
    // Always an explicit range: otherwise the RS template's time span (often "Work Area Only") decides.
    const offset = req.frameOffset ?? 0;
    const args = ['-project', req.aep, '-comp', req.comp, '-RStemplate', req.rsTemplate, '-OMtemplate', req.omTemplate, '-output', tmpOut,
        '-s', String(offset + req.startFrame), '-e', String(offset + req.endFrame)];
    if (req.mfrPercent !== undefined)
        args.push('-mfr', 'ON', String(Math.max(1, Math.min(100, Math.round(req.mfrPercent)))));
    args.push('-close', 'DO_NOT_SAVE_CHANGES', '-sound', 'OFF');
    return args;
}
function findSequenceFiles(dir, prefix) {
    try {
        return readdirSync(dir).filter((f) => f.startsWith(prefix) && !f.includes('[')).map((f) => join(dir, f)).sort();
    }
    catch {
        return [];
    }
}
/** AE may change the extension to match the OM format (e.g. Lossless → .avi). Find what it wrote. */
function findRenderedFile(tmp, prefix, dir) {
    if (existsSync(tmp))
        return tmp;
    const cands = findSequenceFiles(dir, prefix);
    return cands[0];
}
/** Delete every partial aer_<random>_* file of a failed render (AE may still hold it briefly). */
async function removeTempOutputs(dir, prefix) {
    let names;
    try {
        names = readdirSync(dir).filter((f) => f.startsWith(prefix));
    }
    catch {
        return;
    }
    for (const name of names) {
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await unlink(join(dir, name));
                break;
            }
            catch (e) {
                const code = e.code;
                if (code === 'ENOENT' || attempt === 4)
                    break;
                await new Promise((r) => setTimeout(r, 200));
            }
        }
    }
}
/**
 * Render with aerender. Resolves to the final (renamed) path; rejects loudly when the exit code,
 * the output file or the frame count is not what was asked for.
 * startFrame/endFrame (0-based, inclusive) are required: the expected frame count comes from the
 * caller's comp duration, never from aerender's own "Duration" line.
 */
export async function aerender(tools, req, opts = {}) {
    const spawn = opts.spawn ?? execa;
    if (!tools.aerender)
        throw new Error('aerender not found (ToolPaths.aerender). Install After Effects or set EDITMCP_AE_DIR.');
    if (!existsSync(req.aep))
        throw new Error(`project not found: ${req.aep}`);
    const { startFrame, endFrame } = req;
    if (startFrame === undefined || endFrame === undefined || !Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0) {
        throw new Error('aerender needs an explicit non-negative integer startFrame/endFrame (0-based comp frames)');
    }
    if (endFrame < startFrame)
        throw new Error(`endFrame ${endFrame} < startFrame ${startFrame}`);
    const maxParallel = opts.maxParallel ?? Math.max(1, parseInt(process.env['EDITMCP_AE_PARALLEL'] ?? '1', 10) || 1);
    const release = await gate(maxParallel).acquire();
    try {
        req.signal?.throwIfAborted();
        const diskNote = opts.checkDisk === false ? undefined : await checkRenderDiskSpace(req, endFrame - startFrame + 1, opts);
        let r;
        try {
            r = await renderOnce(tools, req, spawn, startFrame, endFrame);
        }
        catch (error) {
            // aerender sometimes dies while starting up (license/GPU/plugin init); one retry, never on timeout/abort.
            if (opts.retryStartupCrash === false || !(error instanceof AerenderError) || !error.startupCrash || req.signal?.aborted)
                throw error;
            const delay = opts.retryDelayMs ?? 3000;
            if (delay > 0)
                await new Promise((res) => setTimeout(res, delay));
            req.signal?.throwIfAborted();
            r = await renderOnce(tools, req, spawn, startFrame, endFrame);
            r = { ...r, log: `retry: first attempt crashed during startup (${error.message.split('\n')[0]})\n${r.log}` };
        }
        return diskNote ? { ...r, log: `${diskNote}\n${r.log}` } : r;
    }
    finally {
        release();
    }
}
async function renderOnce(tools, req, spawn, startFrame, endFrame) {
    const t0 = Date.now();
    const log = [];
    const pushLog = (l) => { if (log.length < MAX_LOG_LINES)
        log.push(l); };
    let temp;
    try {
        req.signal?.throwIfAborted();
        const freeGb = freeRamBytes() / 2 ** 30;
        const minFree = req.minFreeRamGb ?? 0.75;
        if (freeGb < minFree) {
            const msg = `low free RAM: ${freeGb.toFixed(2)} GB (< ${minFree} GB)`;
            if (req.strictRam)
                throw new Error(msg);
            pushLog(`WARN ${msg}`);
        }
        const { tmp, sequence, prefix, dir } = asciiTempPath(req.outPath);
        temp = { dir, prefix };
        const args = buildArgs(req, tmp);
        pushLog(`$ aerender ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
        const expected = endFrame - startFrame + 1;
        const parser = createProgressParser(expected);
        const onLine = (line) => {
            pushLog(line);
            const p = parser.feed(line);
            if (p)
                req.onProgress?.(p);
        };
        // Arguments are an array and no shell is used, so Thai comp names / project paths pass through verbatim.
        const child = spawn(tools.aerender, args, {
            reject: false, windowsHide: true, timeout: 0, stripFinalNewline: false,
        });
        // Stream stdout lines when the spawn gives us a stream (execa does; fakes may not).
        let streamed = false;
        for (const s of [child.stdout, child.stderr]) {
            if (s && typeof s.on === 'function') {
                streamed = true;
                let buf = '';
                s.on('data', (chunk) => {
                    buf += chunk.toString();
                    let i;
                    while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
                        onLine(buf.slice(0, i));
                        buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
                    }
                });
                s.on('end', () => { if (buf)
                    onLine(buf); });
            }
        }
        let killed;
        const timeoutMs = req.timeoutMs ?? 4 * 60 * 60 * 1000;
        const timer = timeoutMs > 0 ? setTimeout(() => { killed = 'timeout'; void killTree(child.pid, spawn, child); }, timeoutMs) : undefined;
        const onAbort = () => { killed = 'abort'; void killTree(child.pid, spawn, child); };
        req.signal?.addEventListener('abort', onAbort, { once: true });
        let res;
        try {
            res = await child;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            req.signal?.removeEventListener('abort', onAbort);
        }
        if (!streamed) {
            for (const text of [res.stdout, res.stderr]) {
                if (typeof text === 'string')
                    for (const line of text.split(/\r?\n/))
                        onLine(line);
            }
        }
        if (killed) {
            throw new AerenderError(`aerender ${killed === 'timeout' ? `timed out after ${timeoutMs} ms` : 'aborted'} (process tree killed)\n${tail(log)}`, killed, parser.errors);
        }
        if (res.exitCode !== 0) {
            const err = new AerenderError(`aerender exited with code ${res.exitCode}${parser.errors.length ? ': ' + parser.errors.join(' | ') : ''}\n${tail(log)}`, 'exit', parser.errors);
            throw new AerenderError(err.message, 'exit', parser.errors, parser.done === 0 && isStartupCrashOutput(res.exitCode, parser.errors, log, [req.comp, req.aep, req.omTemplate]) && !isMissingOmTemplate(err, [req.comp, req.aep, req.omTemplate]));
        }
        // Locate what AE wrote.
        let produced;
        let frames;
        if (sequence) {
            const files = findSequenceFiles(dir, prefix);
            if (files.length === 0)
                throw new AerenderError(`aerender produced no frames in ${dir}\n${tail(log)}`, 'output', parser.errors);
            if (files.length !== expected)
                throw new AerenderError(`aerender frame count mismatch: got ${files.length} images, expected ${expected} (${req.comp})\n${tail(log)}`, 'frames', parser.errors);
            if (files.length > 1)
                throw new AerenderError('image-sequence output supports a single frame only', 'output', parser.errors);
            produced = files[0];
            frames = 1;
        }
        else {
            produced = findRenderedFile(tmp, prefix, dir);
            if (!produced)
                throw new AerenderError(`aerender produced no output file (${tmp})${parser.errors.length ? ': ' + parser.errors.join(' | ') : ''}\n${tail(log)}`, 'output', parser.errors);
            if (req.fallback) {
                const prores = join(dir, `${prefix}_prores.mov`);
                pushLog(`fallback: transcoding ${basename(produced)} → ProRes 422 HQ (BT.709)`);
                await transcodeToProres(tools, produced, prores, spawn, req.signal);
                await unlink(produced).catch(() => undefined);
                produced = prores;
            }
            frames = await probeFrameCount(tools, produced, spawn, req.signal);
            if (frames !== expected) {
                throw new AerenderError(`aerender frame count mismatch: got ${frames}, expected ${expected} (${req.comp})\n${tail(log)}`, 'frames', parser.errors);
            }
        }
        // Final name: requested path (may be Thai), never overwriting.
        const finalPath = uniqueOutputPath(req.outPath);
        if (sequence && extname(produced).toLowerCase() !== extname(finalPath).toLowerCase()) {
            // Format differs (e.g. TIFF template asked to produce .png): caller converts; keep AE's extension.
            const alt = uniqueOutputPath(finalPath.slice(0, -extname(finalPath).length) + extname(produced));
            await moveFile(produced, alt);
            return { path: alt, frames, elapsedMs: Date.now() - t0, usedFallback: !!req.fallback, log: log.join('\n') };
        }
        await moveFile(produced, finalPath);
        pushLog(`→ ${finalPath} (${frames} frames, ${statSync(finalPath).size} bytes)`);
        return { path: finalPath, frames, elapsedMs: Date.now() - t0, usedFallback: !!req.fallback, log: log.join('\n') };
    }
    catch (error) {
        if (temp)
            await removeTempOutputs(temp.dir, temp.prefix);
        throw error;
    }
}
function tail(log, n = 15) {
    return log.slice(-n).join('\n');
}
//# sourceMappingURL=aerender.js.map