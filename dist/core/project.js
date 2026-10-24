import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashFile, hashJson, hashString } from './hash.js';
import { splitDissolve } from './timecode.js';
const PROJECT_FILE = 'project.json';
// ---------- create / load / save ----------
export async function createProject(dir, meta) {
    const abs = path.resolve(dir);
    assertNotProtected(abs);
    const file = path.join(abs, PROJECT_FILE);
    const name = meta.name?.trim();
    if (!name)
        throw new Error('project name is required');
    const fps = meta.fps ?? 25;
    const width = meta.width ?? 1920;
    const height = meta.height ?? 1080;
    if (!(Number.isFinite(fps) && fps > 0))
        throw new Error(`bad fps: ${meta.fps}`);
    for (const [k, v] of [['width', width], ['height', height]]) {
        if (!(Number.isInteger(v) && v > 0))
            throw new Error(`bad ${k}: ${v}`);
    }
    await mkdir(abs, { recursive: true });
    if (existsSync(file))
        throw new Error(`project already exists: ${file}`);
    const p = {
        meta: { name, fps, width, height, createdAt: new Date().toISOString(), schema: 1 },
        dir: abs,
        assets: {},
        timeline: normalizeTimeline(undefined),
        delivery: { targets: [] },
        versions: [],
    };
    projectPaths(p);
    await saveProject(p);
    return p;
}
/** `dir` may be the project directory or the project.json path itself. */
export async function loadProject(dir) {
    let abs = path.resolve(dir);
    const st = await stat(abs).catch(() => undefined);
    if (st?.isFile())
        abs = path.dirname(abs);
    const file = path.join(abs, PROJECT_FILE);
    let raw;
    try {
        raw = await readFile(file, 'utf8');
    }
    catch {
        throw new Error(`no ${PROJECT_FILE} in ${abs}`);
    }
    const p = parseProject(raw, abs, file);
    remember(p, raw);
    return p;
}
function parseProject(raw, abs, file) {
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`${file} is not valid JSON: ${e.message}`);
    }
    if (!data.meta || data.meta.schema !== 1)
        throw new Error(`unsupported project schema in ${file}`);
    return {
        meta: data.meta,
        dir: abs,
        assets: data.assets ?? {},
        timeline: normalizeTimeline(data.timeline),
        delivery: data.delivery ?? { targets: [] },
        versions: data.versions ?? [],
        ...(data.board !== undefined ? { board: data.board } : {}),
        ...(data.constraints !== undefined ? { constraints: data.constraints } : {}),
        ...(data.styleRules !== undefined ? { styleRules: data.styleRules } : {}),
        ...(data.captions !== undefined ? { captions: data.captions } : {}),
    };
}
// ---------- optimistic concurrency ----------
// Every loaded/saved Project remembers the exact project.json text it was based on. A save that finds
// different text on disk (another process — CLI build, a second MCP server — saved in between) does a
// three-way merge: non-conflicting changes from both sides are kept, real conflicts throw.
export class ProjectConflictError extends Error {
    conflicts;
    file;
    constructor(conflicts, file) {
        super(`โปรเจกต์ถูกแก้จากที่อื่น — โหลดใหม่แล้วลองอีกครั้ง / ${PROJECT_FILE} was changed by another process; conflicting: ${conflicts.join(', ')}`);
        this.conflicts = conflicts;
        this.file = file;
        this.name = 'ProjectConflictError';
    }
}
export class ProjectLockedError extends Error {
    lockFile;
    constructor(lockFile, holder) {
        super(`โปรเจกต์ถูกล็อกโดยโปรเซสอื่น (${holder}) — ลองใหม่อีกครั้ง / ${lockFile} is held by another process`);
        this.lockFile = lockFile;
        this.name = 'ProjectLockedError';
    }
}
const bases = new WeakMap();
function persistedOf(p) {
    const { meta, assets, timeline, delivery, versions, board, constraints, styleRules, captions } = p;
    return JSON.parse(JSON.stringify({ meta, assets, timeline, delivery, versions, board, constraints, styleRules, captions }));
}
function revisionOf(raw) {
    try {
        const r = JSON.parse(raw).revision;
        return typeof r === 'number' && Number.isInteger(r) ? r : 0;
    }
    catch {
        return 0;
    }
}
function remember(p, raw) {
    bases.set(p, { raw, snapshot: persistedOf(parseProject(raw, p.dir, PROJECT_FILE)), revision: revisionOf(raw) });
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => hashJson(a) === hashJson(b);
/** Whole values: a change on both sides is a conflict even if it touches different sub-fields. */
function isAtomic(at) {
    if (at.length === 1)
        return at[0] === 'meta' || at[0] === 'timeline' || at[0] === 'delivery';
    if (at[0] === 'assets' && at.length === 3)
        return at[2] === 'render' || at[2] === 'probe';
    if (at[0] === 'versions' && at.length === 3)
        return at[2] === 'reviewPlan' || at[2] === 'qc' || at[2] === 'stats';
    return false;
}
/** Derived caches and build artifacts: when both sides changed them, ours (the newer work) wins. */
function oursWins(at) {
    if (at[0] === 'assets' && at.length >= 3)
        return ['render', 'probe', 'fingerprint', 'hash'].includes(at[2]);
    return at[0] === 'versions' && at.length >= 3;
}
function assign(live, k, v) {
    if (v === undefined)
        delete live[k];
    else
        live[k] = structuredClone(v);
}
/** Merge `theirs` into the live object in place (keeps object identity for code holding references). */
function merge3(live, base, ours, theirs, at, conflicts) {
    const b = isObj(base) ? base : {};
    const o = isObj(ours) ? ours : {};
    const t = isObj(theirs) ? theirs : {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
        const here = [...at, k];
        if (here.length === 1 && k === 'versions') {
            mergeVersions(live, b[k], o[k], t[k], conflicts);
            continue;
        }
        const bv = b[k];
        const ov = o[k];
        const tv = t[k];
        if (same(ov, tv) || same(bv, tv))
            continue;
        const lv = live[k];
        if (!isAtomic(here) && isObj(ov) && isObj(tv) && isObj(lv)) {
            merge3(lv, bv, ov, tv, here, conflicts);
            continue;
        }
        if (same(bv, ov))
            assign(live, k, tv);
        else if (!oursWins(here))
            conflicts.push(here.join('.'));
    }
}
function versionNo(id) {
    const m = /^v(\d+)$/.exec(String(id));
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}
/** Versions are keyed by id: versions appended by either side are all kept. */
function mergeVersions(live, base, ours, theirs, conflicts) {
    const byId = (v) => new Map((Array.isArray(v) ? v : []).filter(isObj).filter((x) => typeof x['id'] === 'string').map((x) => [x['id'], x]));
    const bm = byId(base);
    const om = byId(ours);
    const tm = byId(theirs);
    if (!Array.isArray(live['versions']))
        live['versions'] = [];
    const arr = live['versions'];
    let inserted = false;
    for (const id of new Set([...bm.keys(), ...om.keys(), ...tm.keys()])) {
        const b = bm.get(id);
        const o = om.get(id);
        const t = tm.get(id);
        if (same(o, t) || same(b, t))
            continue;
        if (!o && t) {
            if (b)
                conflicts.push(`versions.${id}`); // we removed it, they changed it
            else {
                arr.push(structuredClone(t));
                inserted = true;
            }
            continue;
        }
        if (o && !t) {
            if (b && same(b, o))
                arr.splice(arr.findIndex((v) => v['id'] === id), 1);
            else if (b)
                conflicts.push(`versions.${id}`);
            continue;
        }
        const lv = arr.find((v) => v['id'] === id);
        if (!b || !lv) {
            conflicts.push(`versions.${id}`);
            continue;
        } // both created a different version with this id
        merge3(lv, b, o, t, ['versions', id], conflicts);
    }
    if (inserted)
        arr.sort((x, y) => versionNo(x['id']) - versionNo(y['id']));
}
// ---------- protected paths ----------
/**
 * EDITMCP_PROTECTED_PATHS (';'-separated): folders nothing may be written inside. None are built in:
 * a job folder locked during development once blocked the user's own edits (DESIGN §15).
 */
function protectedPaths() {
    return (process.env['EDITMCP_PROTECTED_PATHS'] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
}
/** Windows absolute path ("D:\\job", "\\\\server\\share"): compared the Windows way on every OS, never resolved against cwd. */
const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
function pathKey(p) {
    if (process.platform === 'win32' || WIN_ABS.test(p))
        return path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    return path.resolve(p).replace(/\/+$/, '');
}
function under(target, root) {
    const t = pathKey(target);
    const r = pathKey(root);
    // a backslash is an ordinary file name character in POSIX keys
    const seps = r.startsWith('/') ? ['/'] : ['\\', '/'];
    return t === r || seps.some((s) => t.startsWith(r + s));
}
/** Real path of the nearest existing ancestor + the rest (defeats junctions/symlinks into a protected tree). */
function realish(p) {
    let cur = path.resolve(p);
    const rest = [];
    for (;;) {
        if (existsSync(cur)) {
            try {
                return path.join(realpathSync.native(cur), ...rest.reverse());
            }
            catch {
                return path.resolve(p);
            }
        }
        const parent = path.dirname(cur);
        if (parent === cur)
            return path.resolve(p);
        rest.push(path.basename(cur));
        cur = parent;
    }
}
/** True when `target` is (inside) a protected path. Lexical check first, so a protected tree is never even stat'ed. */
export function isProtected(target) {
    const roots = protectedPaths();
    if (roots.some((r) => under(target, r)))
        return true;
    const real = realish(target);
    return roots.some((r) => under(real, r));
}
function assertNotProtected(target) {
    if (isProtected(target))
        throw new Error(`ห้ามเขียนในโฟลเดอร์ที่ป้องกันไว้ / refusing to write inside a protected path: ${target}`);
}
// ---------- cross-process lock ----------
const LOCK_FILE = 'project.lock';
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 2 * 60_000;
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
async function acquireLock(dir, opts) {
    const file = path.join(dir, LOCK_FILE);
    const token = randomBytes(8).toString('hex');
    const staleMs = opts.staleLockMs ?? LOCK_STALE_MS;
    const deadline = Date.now() + (opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
    const mine = { pid: process.pid, host: os.hostname(), at: '', token };
    for (let attempt = 0;; attempt++) {
        try {
            await writeFile(file, JSON.stringify({ ...mine, at: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
            break;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
        }
        const raw = await readFile(file, 'utf8').catch(() => undefined);
        if (raw === undefined)
            continue; // released between our attempts
        let holder;
        try {
            holder = JSON.parse(raw);
        }
        catch {
            holder = undefined;
        }
        const ageMs = holder ? Date.now() - Date.parse(holder.at) : Date.now() - ((await stat(file).catch(() => undefined))?.mtimeMs ?? Date.now());
        const stale = holder
            ? !(ageMs <= staleMs) || (holder.host === os.hostname() && !pidAlive(holder.pid))
            : ageMs > 5_000; // half-written lock left by a crash
        if (stale) {
            // Re-read right before removing so we never delete a lock someone else just took.
            if ((await readFile(file, 'utf8').catch(() => undefined)) === raw)
                await rm(file, { force: true });
            continue;
        }
        if (Date.now() >= deadline)
            throw new ProjectLockedError(file, holder ? `pid ${holder.pid}@${holder.host}` : 'unknown');
        await new Promise((r) => setTimeout(r, Math.min(25 * (attempt + 1), 250)));
    }
    return async () => {
        const raw = await readFile(file, 'utf8').catch(() => undefined);
        try {
            if (raw !== undefined && JSON.parse(raw).token === token)
                await rm(file, { force: true });
        }
        catch { /* not ours / unreadable: leave it */ }
    };
}
/** One save at a time per project folder inside this process (the lockfile serializes across processes). */
const saveQueues = new Map();
/**
 * Atomic (temp file + rename) and concurrency-safe: under project.lock, re-reads project.json; if another
 * process saved since this object was loaded/saved, merges both (see merge3) and adopts their changes in
 * place, or throws ProjectConflictError without writing. `dir` is not persisted.
 */
export async function saveProject(p, opts = {}) {
    assertNotProtected(p.dir);
    const key = pathKey(p.dir);
    const prev = saveQueues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => saveLocked(p, opts));
    saveQueues.set(key, run);
    try {
        await run;
    }
    finally {
        if (saveQueues.get(key) === run)
            saveQueues.delete(key);
    }
}
async function saveLocked(p, opts) {
    const file = path.join(p.dir, PROJECT_FILE);
    await mkdir(p.dir, { recursive: true });
    const release = await acquireLock(p.dir, opts);
    try {
        const disk = await readFile(file, 'utf8').catch(() => undefined);
        const base = bases.get(p);
        let revision = (base?.revision ?? 0) + 1;
        if (disk !== undefined && base && disk !== base.raw) {
            const theirs = persistedOf(parseProject(disk, p.dir, file));
            const ours = persistedOf(p);
            const conflicts = [];
            merge3(structuredClone(ours), base.snapshot, ours, theirs, [], conflicts); // dry run
            if (conflicts.length)
                throw new ProjectConflictError(conflicts, file);
            merge3(p, base.snapshot, ours, theirs, [], conflicts);
            revision = Math.max(revision, revisionOf(disk) + 1);
        }
        else if (disk !== undefined && !base) {
            revision = revisionOf(disk) + 1; // object not from loadProject: plain overwrite (legacy behaviour)
        }
        const text = `${JSON.stringify({ ...persistedOf(p), revision }, null, 2)}\n`;
        const tmp = path.join(p.dir, `.${PROJECT_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(tmp, text, 'utf8');
        try {
            await renameWithRetry(tmp, file);
        }
        catch (e) {
            await rm(tmp, { force: true });
            throw e;
        }
        remember(p, text);
    }
    finally {
        await release();
    }
}
/** Windows can refuse a rename for a moment while an editor/AV scanner holds the target. */
async function renameWithRetry(from, to) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await rename(from, to);
            return;
        }
        catch (e) {
            lastErr = e;
            const code = e.code;
            if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')
                throw e;
            await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
        }
    }
    throw lastErr;
}
export function projectPaths(p) {
    const paths = {
        cacheSegments: path.join(p.dir, 'cache', 'segments'),
        cacheRenders: path.join(p.dir, 'cache', 'renders'),
        cacheAudio: path.join(p.dir, 'cache', 'audio'),
        out: path.join(p.dir, 'out'),
        review: path.join(p.dir, 'review'),
        tmp: path.join(p.dir, 'cache', 'tmp'),
    };
    for (const d of Object.values(paths))
        mkdirSync(d, { recursive: true });
    return paths;
}
// ---------- assets ----------
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.wma', '.ac3']);
const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.psd', '.exr', '.dpx', '.heic', '.heif', '.tga']);
function inferKind(file) {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXT.has(ext))
        return 'audio';
    if (STILL_EXT.has(ext))
        return 'still';
    return 'camera';
}
function samePath(a, b) {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
/** Ids end up in file names: no path separators or characters Windows refuses. */
function assertValidId(id) {
    if (!id || id === '.' || id === '..' || /[\\/:*?"<>|\p{Cc}]/u.test(id) || /^\s|\s$/.test(id)) {
        throw new Error(`invalid asset id: ${JSON.stringify(id)}`);
    }
}
/** Keep letters/digits/combining marks (Thai vowels and tone marks are marks), collapse the rest to '_'. */
function sanitizeId(s, fallbackPrefix) {
    const cleaned = s.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
    return cleaned || `${fallbackPrefix}_${hashString(s).slice(0, 8)}`;
}
function uniqueId(p, base) {
    if (!(base in p.assets))
        return base;
    for (let n = 2;; n++) {
        const id = `${base}_${n}`;
        if (!(id in p.assets))
            return id;
    }
}
export async function addFileAsset(p, filePath, opts = {}) {
    const abs = path.resolve(filePath);
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile())
        throw new Error(`file not found: ${abs}`);
    const kind = opts.kind ?? inferKind(abs);
    let id = opts.id;
    if (id !== undefined) {
        assertValidId(id);
        const existing = p.assets[id];
        if (existing && !(existing.kind !== 'aecomp' && samePath(existing.path, abs))) {
            throw new Error(`asset id already in use: ${id}`);
        }
    }
    else {
        // Re-adding the same file is idempotent.
        const existing = Object.values(p.assets).find((a) => a.kind !== 'aecomp' && samePath(a.path, abs));
        id = existing?.id ?? uniqueId(p, sanitizeId(path.basename(abs, path.extname(abs)), kind));
    }
    const asset = { id, kind, path: abs, hash: await hashFile(abs) };
    if (opts.probe)
        asset.probe = await opts.probe(abs);
    p.assets[id] = asset;
    return asset;
}
export function addAeComp(p, aep, comp, id) {
    const abs = path.resolve(aep);
    const compName = comp.trim();
    if (!compName)
        throw new Error('comp name is required');
    const matches = (a) => a.kind === 'aecomp' && samePath(a.aep, abs) && a.comp === compName;
    if (id !== undefined) {
        assertValidId(id);
        const existing = p.assets[id];
        if (existing) {
            if (matches(existing))
                return existing;
            throw new Error(`asset id already in use: ${id}`);
        }
    }
    else {
        const existing = Object.values(p.assets).find(matches);
        if (existing)
            return existing;
        id = uniqueId(p, `C_${sanitizeId(compName, 'comp')}`);
    }
    const asset = { id, kind: 'aecomp', aep: abs, comp: compName };
    p.assets[id] = asset;
    return asset;
}
// ---------- timeline ----------
function normalizeTimeline(t) {
    const audio = t?.audio;
    const out = {
        video: Array.isArray(t?.video) ? t.video.map((c) => ({ ...c })) : [],
        cuts: Array.isArray(t?.cuts) ? t.cuts.map((c) => ({ ...c })) : [],
        audio: {
            vo: Array.isArray(audio?.vo) ? audio.vo.map((c) => ({ ...c })) : [],
            music: Array.isArray(audio?.music) ? audio.music.map((c) => ({ ...c })) : [],
            sfx: Array.isArray(audio?.sfx) ? audio.sfx.map((c) => ({ ...c })) : [],
        },
    };
    if (audio?.duck !== undefined)
        out.audio.duck = { ...audio.duck };
    if (audio?.useClipAudio !== undefined)
        out.audio.useClipAudio = audio.useClipAudio;
    return out;
}
export function setTimeline(p, t) {
    if (!t || typeof t !== 'object')
        throw new TypeError('timeline must be an object');
    p.timeline = normalizeTimeline(t);
}
/** Source length in frames when known (probe, or the AE render record). Stills loop, so they report undefined. */
function sourceFrames(a) {
    if (a.kind === 'still')
        return undefined;
    if (a.kind === 'aecomp')
        return a.probe?.durationFrames ?? a.render?.frames;
    return a.probe?.durationFrames;
}
function hasAudio(a) {
    if (a.kind === 'still')
        return false;
    if (a.kind === 'audio')
        return a.probe ? a.probe.hasAudio : true;
    return a.probe?.hasAudio;
}
const isFrames = (v) => Number.isInteger(v);
const SLOT_EPS = 1e-7;
/** The clip's retime curve, or undefined for realtime (no speed, rate 1, no ramp). */
export function speedCurve(c) {
    const s = c.speed;
    if (!s)
        return undefined;
    const R = s.rampFrom !== undefined && (s.rampFrames ?? 0) > 0 ? s.rampFrames : 0;
    const r0 = R > 0 ? s.rampFrom : s.rate;
    if (s.rate === 1 && (R === 0 || r0 === 1))
        return undefined;
    return { r0, r1: s.rate, R };
}
/** Effective interpolation: the clip's choice, else blend when any part of the curve is slow motion, else nearest. */
export function clipInterpolation(c) {
    if (c.speed?.interpolation)
        return c.speed.interpolation;
    const curve = speedCurve(c);
    return curve && Math.min(curve.r0, curve.r1) < 1 ? 'blend' : 'nearest';
}
/** Average rate of the clip over its duration (constant rate, or source span / dur for ramps); 1 when realtime. */
export function averageRate(c) {
    const curve = speedCurve(c);
    if (!curve)
        return 1;
    return curve.R > 0 && c.dur > 0 ? curvePos(curve, c.dur) / c.dur : curve.r1;
}
/** Source position (relative to `in`, fractional frames) at clip-local timeline time t. */
export function curvePos(c, t) {
    if (t <= 0)
        return c.r0 * t;
    if (c.R > 0 && t < c.R) {
        const x = t / c.R;
        return c.r0 * t + (c.r1 - c.r0) * c.R * (x ** 3 - x ** 4 / 2); // integral of the smoothstep-eased rate
    }
    return (c.R * (c.r0 + c.r1)) / 2 + c.r1 * (t - c.R);
}
/** Inverse of curvePos: timeline time at which the source position reaches m. */
export function curveTime(c, m) {
    if (m <= 0)
        return m / c.r0;
    const pR = curvePos(c, c.R);
    if (m >= pR)
        return c.R + (m - pR) / c.r1;
    let lo = 0;
    let hi = c.R;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (curvePos(c, mid) < m)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}
/** First clip-local slot that shows source frame `in + m` (nearest sampling). */
export function curveSlot(c, m) {
    return Math.ceil(curveTime(c, m) - SLOT_EPS);
}
/** Source frame (relative to `in`) shown at clip-local slot k with nearest sampling. */
export function shownFrame(c, k) {
    if (!c)
        return k;
    let m = Math.floor(curvePos(c, k) + 1e-6);
    while (curveSlot(c, m + 1) <= k)
        m++;
    while (m > -1e9 && curveSlot(c, m) > k)
        m--;
    return m;
}
/** Source frames the clip covers: round(dur * rate) for constant speed (the contract), the curve's span for ramps. */
export function clipSourceSpan(c) {
    const curve = speedCurve(c);
    return curve ? Math.round(curvePos(curve, c.dur)) : c.dur;
}
/**
 * Source range (relative to `in`, [first, end)) a clip needs when it also shows `before` timeline
 * frames of handle ahead of its in-point and `after` frames past its out-point (dissolves). The body
 * needs max(span, last shown frame + 1); handles need every frame they show (nearest sampling; a blend
 * or motion lookahead past the source end holds the last frame instead).
 */
export function clipSourceNeeds(c, before = 0, after = 0) {
    const curve = speedCurve(c);
    if (!curve)
        return { first: -before, end: c.dur + after };
    const first = before > 0 ? shownFrame(curve, -before) : 0;
    const last = shownFrame(curve, c.dur + after - 1) + 1;
    return { first, end: after > 0 ? last : Math.max(clipSourceSpan(c), last) };
}
function speedLabel(c) {
    const s = c.speed;
    if (!s)
        return '100%';
    const pct = (r) => `${Math.round(r * 1000) / 10}%`;
    return s.rampFrom !== undefined && s.rampFrames ? `${pct(s.rampFrom)}→${pct(s.rate)}/${s.rampFrames}f` : pct(s.rate);
}
function speedErrors(c, tag) {
    const errors = [];
    const s = c.speed;
    if (s !== undefined) {
        if (!s || typeof s !== 'object')
            return [`${tag}: speed must be an object`];
        const okRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.05 && v <= 20;
        if (!okRate(s.rate))
            errors.push(`${tag}: speed.rate must be between 0.05 and 20 (got ${s.rate})`);
        if (s.rampFrom !== undefined && !okRate(s.rampFrom))
            errors.push(`${tag}: speed.rampFrom must be between 0.05 and 20 (got ${s.rampFrom})`);
        if (s.rampFrames !== undefined && (!isFrames(s.rampFrames) || s.rampFrames < 0))
            errors.push(`${tag}: speed.rampFrames must be an integer >= 0 (got ${s.rampFrames})`);
        if ((s.rampFrom === undefined) !== (s.rampFrames === undefined))
            errors.push(`${tag}: speed ramp needs both rampFrom and rampFrames`);
        if (s.interpolation !== undefined && !['nearest', 'blend', 'motion'].includes(s.interpolation))
            errors.push(`${tag}: speed.interpolation must be nearest | blend | motion (got ${s.interpolation})`);
    }
    if (c.pushIn !== undefined && !(typeof c.pushIn === 'number' && Number.isFinite(c.pushIn) && c.pushIn >= 0 && c.pushIn <= 100)) {
        errors.push(`${tag}: pushIn must be a percent between 0 and 100 (got ${c.pushIn})`);
    }
    return errors;
}
export function validateTimeline(p) {
    const errors = [];
    const t = p.timeline ?? normalizeTimeline(undefined);
    const video = t.video ?? [];
    const cuts = t.cuts ?? [];
    const assetOf = (id) => p.assets[id];
    if (video.length === 0)
        errors.push('timeline.video is empty');
    // --- video clips ---
    const clipById = new Map();
    const clipIndex = new Map();
    const retimable = new Set(); // clips whose speed fields are valid (safe to map through the curve)
    video.forEach((c, i) => {
        const tag = `clip[${c?.id ?? `#${i}`}]`;
        if (!c || typeof c !== 'object') {
            errors.push(`${tag}: not an object`);
            return;
        }
        if (!c.id || typeof c.id !== 'string')
            errors.push(`${tag}: missing id`);
        else if (clipById.has(c.id))
            errors.push(`${tag}: duplicate clip id`);
        else {
            clipById.set(c.id, c);
            clipIndex.set(c.id, i);
        }
        if (!isFrames(c.dur))
            errors.push(`${tag}: dur must be an integer frame count (got ${c.dur})`);
        else if (c.dur <= 0)
            errors.push(`${tag}: dur must be > 0 (got ${c.dur})`);
        if (!isFrames(c.in))
            errors.push(`${tag}: in must be an integer frame count (got ${c.in})`);
        else if (c.in < 0)
            errors.push(`${tag}: in must be >= 0 (got ${c.in})`);
        if (c.scale !== undefined && !(Number.isFinite(c.scale) && c.scale > 0))
            errors.push(`${tag}: scale must be > 0 (got ${c.scale})`);
        const speedErrs = speedErrors(c, tag);
        errors.push(...speedErrs);
        if (speedErrs.length === 0)
            retimable.add(c);
        const a = c.src ? assetOf(c.src) : undefined;
        if (!a) {
            errors.push(`${tag}: unknown asset '${c.src}'`);
            return;
        }
        if (a.kind === 'audio')
            errors.push(`${tag}: asset '${c.src}' is audio-only, cannot be used as video`);
        const len = sourceFrames(a);
        if (len !== undefined && isFrames(c.in) && isFrames(c.dur) && c.dur > 0) {
            if (!speedCurve(c)) {
                if (c.in + c.dur > len)
                    errors.push(`${tag}: in+dur (${c.in + c.dur}) exceeds source length ${len} of '${c.src}'`);
            }
            else if (speedErrs.length === 0) {
                const need = clipSourceNeeds(c).end;
                if (c.in + need > len)
                    errors.push(`${tag}: in + source span (${c.in}+${need} = ${c.in + need} source frames for ${c.dur} frames at speed ${speedLabel(c)}) exceeds source length ${len} of '${c.src}'`);
            }
        }
    });
    // --- cuts / dissolves ---
    const seenCut = new Set();
    const reserved = new Map(); // frames of each clip consumed by dissolves on either side
    for (const cut of cuts) {
        const tag = `cut[after=${cut?.after}]`;
        if (!cut || typeof cut !== 'object') {
            errors.push('cut: not an object');
            continue;
        }
        const idx = clipIndex.get(cut.after);
        if (idx === undefined) {
            errors.push(`${tag}: unknown clip`);
            continue;
        }
        if (idx === video.length - 1) {
            errors.push(`${tag}: refers to the last clip, there is nothing after it`);
            continue;
        }
        if (seenCut.has(cut.after)) {
            errors.push(`${tag}: duplicate cut`);
            continue;
        }
        seenCut.add(cut.after);
        if (!isFrames(cut.dissolve) || cut.dissolve < 0) {
            errors.push(`${tag}: dissolve must be an integer >= 0 (got ${cut.dissolve})`);
            continue;
        }
        if (cut.dissolve === 0)
            continue;
        const A = video[idx];
        const B = video[idx + 1];
        const { a, b } = splitDissolve(cut.dissolve);
        reserved.set(A.id, (reserved.get(A.id) ?? 0) + a);
        reserved.set(B.id, (reserved.get(B.id) ?? 0) + b);
        // A needs b frames of handle after its out point, B needs a frames before its in point.
        // Only checked when the clips' own in/dur are valid; those errors are already reported above.
        const assetA = assetOf(A.src);
        const assetB = assetOf(B.src);
        const lenA = assetA ? sourceFrames(assetA) : undefined;
        if (lenA !== undefined && isFrames(A.in) && A.in >= 0 && isFrames(A.dur) && A.dur > 0) {
            if (!speedCurve(A)) {
                const avail = lenA - (A.in + A.dur);
                if (avail < b)
                    errors.push(`${tag}: dissolve ${cut.dissolve} needs ${b} handle frame(s) after '${A.id}' out, source '${A.src}' has ${Math.max(0, avail)}`);
            }
            else if (retimable.has(A)) {
                // the handle plays at the clip's end rate: b timeline frames show source frames up to `end`
                const end = A.in + clipSourceNeeds(A, 0, b).end;
                if (end > lenA)
                    errors.push(`${tag}: dissolve ${cut.dissolve} needs ${b} handle frame(s) after '${A.id}' out = source frames up to ${end} at speed ${speedLabel(A)}, source '${A.src}' has ${lenA}`);
            }
        }
        if (assetB && assetB.kind !== 'still' && isFrames(B.in) && B.in >= 0) {
            if (!speedCurve(B)) {
                if (B.in < a)
                    errors.push(`${tag}: dissolve ${cut.dissolve} needs ${a} handle frame(s) before '${B.id}' in, clip has ${B.in}`);
            }
            else if (retimable.has(B)) {
                const need = -clipSourceNeeds(B, a, 0).first;
                if (B.in < need)
                    errors.push(`${tag}: dissolve ${cut.dissolve} needs ${a} handle frame(s) before '${B.id}' in = ${need} source frame(s) at speed ${speedLabel(B)}, clip has ${B.in}`);
            }
        }
    }
    for (const [id, n] of reserved) {
        const c = clipById.get(id);
        if (c && isFrames(c.dur) && c.dur > 0 && n >= c.dur) {
            errors.push(`clip[${id}]: dissolves consume ${n} frame(s) but the clip is only ${c.dur}; at least 1 frame of body must remain`);
        }
    }
    // --- audio ---
    const audioIds = new Set();
    const tracks = [['vo', t.audio?.vo ?? []], ['music', t.audio?.music ?? []], ['sfx', t.audio?.sfx ?? []]];
    for (const [track, clips] of tracks) {
        clips.forEach((c, i) => {
            const tag = `audio.${track}[${c?.id ?? `#${i}`}]`;
            if (!c || typeof c !== 'object') {
                errors.push(`${tag}: not an object`);
                return;
            }
            if (!c.id || typeof c.id !== 'string')
                errors.push(`${tag}: missing id`);
            else if (audioIds.has(c.id))
                errors.push(`${tag}: duplicate audio clip id`);
            else
                audioIds.add(c.id);
            if (!isFrames(c.at) || c.at < 0)
                errors.push(`${tag}: at must be an integer >= 0 (got ${c.at})`);
            if (c.in !== undefined && (!isFrames(c.in) || c.in < 0))
                errors.push(`${tag}: in must be an integer >= 0 (got ${c.in})`);
            if (c.dur !== undefined && (!isFrames(c.dur) || c.dur <= 0))
                errors.push(`${tag}: dur must be an integer > 0 (got ${c.dur})`);
            if (c.gainDb !== undefined && !Number.isFinite(c.gainDb))
                errors.push(`${tag}: gainDb must be a number`);
            for (const k of ['fadeIn', 'fadeOut']) {
                const v = c[k];
                if (v !== undefined && (!isFrames(v) || v < 0))
                    errors.push(`${tag}: ${k} must be an integer >= 0 (got ${v})`);
            }
            const a = c.src ? assetOf(c.src) : undefined;
            if (!a) {
                errors.push(`${tag}: unknown asset '${c.src}'`);
                return;
            }
            if (hasAudio(a) === false)
                errors.push(`${tag}: asset '${c.src}' has no audio`);
            const len = sourceFrames(a);
            const inF = c.in ?? 0;
            if (len !== undefined && isFrames(inF)) {
                if (c.dur !== undefined && isFrames(c.dur) && inF + c.dur > len) {
                    errors.push(`${tag}: in+dur (${inF + c.dur}) exceeds source length ${len} of '${c.src}'`);
                }
                else if (c.dur === undefined && inF >= len) {
                    errors.push(`${tag}: in (${inF}) is at or past the end of source '${c.src}' (${len})`);
                }
            }
        });
    }
    const duck = t.audio?.duck;
    if (duck !== undefined) {
        if (!Number.isFinite(duck.underDb))
            errors.push('audio.duck.underDb must be a number');
        if (!(Number.isFinite(duck.attackMs) && duck.attackMs >= 0))
            errors.push('audio.duck.attackMs must be >= 0');
        if (!(Number.isFinite(duck.releaseMs) && duck.releaseMs >= 0))
            errors.push('audio.duck.releaseMs must be >= 0');
    }
    return errors;
}
export function timelineFrames(p) {
    return (p.timeline?.video ?? []).reduce((sum, c) => sum + (isFrames(c.dur) && c.dur > 0 ? c.dur : 0), 0);
}
export function captureReviewPlan(p) {
    const starts = clipStartFrames(p);
    return {
        fps: p.meta.fps, width: p.meta.width, height: p.meta.height, frames: timelineFrames(p),
        cuts: structuredClone(p.timeline.cuts),
        shots: p.timeline.video.map(c => {
            const asset = p.assets[c.src];
            return { ...c, start: starts.get(c.id) ?? 0, ...(asset?.kind === 'aecomp' ? { comp: asset.comp } : {}) };
        }),
    };
}
export function clipStartFrames(p) {
    const starts = new Map();
    let pos = 0;
    for (const c of p.timeline?.video ?? []) {
        starts.set(c.id, pos);
        pos += isFrames(c.dur) && c.dur > 0 ? c.dur : 0;
    }
    return starts;
}
/**
 * Identity of what a build would produce: timeline + the content identity of every referenced
 * asset (file hash / comp fingerprint, falling back to the path when not yet known) + picture format.
 * Unreferenced assets, project name and delivery settings do not affect it.
 */
export function planHash(p) {
    const t = p.timeline ?? normalizeTimeline(undefined);
    const used = new Set();
    for (const c of t.video ?? [])
        used.add(c.src);
    for (const c of [...(t.audio?.vo ?? []), ...(t.audio?.music ?? []), ...(t.audio?.sfx ?? [])])
        used.add(c.src);
    const assets = [...used].sort().map((id) => {
        const a = p.assets[id];
        if (!a)
            return { id, missing: true };
        if (a.kind === 'aecomp')
            return { id, kind: a.kind, comp: a.comp, src: a.fingerprint ?? `aep:${a.aep}` };
        return { id, kind: a.kind, src: a.hash ?? `path:${a.path}` };
    });
    return hashJson({
        meta: { fps: p.meta.fps, width: p.meta.width, height: p.meta.height },
        timeline: t,
        assets,
    });
}
/** 'v001', 'v002', ...: one past the highest existing id, skipping any id whose out/ folder already exists. */
export function nextVersionId(p) {
    let n = 0;
    for (const v of p.versions) {
        const m = /^v(\d+)$/.exec(v.id);
        if (m)
            n = Math.max(n, parseInt(m[1], 10));
    }
    for (;;) {
        n++;
        const id = `v${String(n).padStart(3, '0')}`;
        if (!p.versions.some((v) => v.id === id) && !existsSync(path.join(p.dir, 'out', id)))
            return id;
    }
}
//# sourceMappingURL=project.js.map