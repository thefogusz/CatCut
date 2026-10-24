/**
 * Disk housekeeping (DESIGN §13.2 row 8): free-space report, AE disk-cache size, project cache/out usage,
 * a garbage-collection plan for superseded renders/segments/versions, and a confirmed apply step.
 *
 * Safety: nothing is deleted without a plan made in the last 10 minutes + an explicit confirm token; only plain
 * files inside <project>/cache and <project>/out (checked through real paths, symlinks refused) are removed; every
 * deletion is logged to <project>/history/gc-<stamp>.log. AE preferences are read, never written.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, opendir, readdir, readFile, rename, rmdir, statfs as fsStatfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashJson } from '../core/hash.js';
import { adobePrefsDir } from '../core/platform.js';
import { isProtected } from '../core/project.js';
const GB = 1024 ** 3;
const DISK_ERROR_BYTES = 5 * GB;
const DISK_WARN_BYTES = 20 * GB;
const PLAN_MAX_AGE_MS = 10 * 60_000;
const MIN_AGE_MS = 60 * 60_000; // orphan/temp files younger than this may belong to a running build
const CONFIRM_TOKENS = new Set(['ลบ', 'delete']);
/** Project folder size that earns a warning in disk_report (the reshoot job reached ~100 GB unnoticed). */
const DEFAULT_BUDGET_GB = 50;
/** Windows absolute path ("D:\\job", "\\\\server\\share"). */
const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
async function freeSpace(target, statfs) {
    // a Windows-style path on another OS is passed as is (statfs reports it unreadable), never resolved against cwd
    const foreign = process.platform !== 'win32' && WIN_ABS.test(target);
    let p = foreign ? target : path.resolve(target);
    while (!foreign && !existsSync(p)) {
        const up = path.dirname(p);
        if (up === p)
            break;
        p = up;
    }
    const s = await statfs(p);
    const bsize = Number(s.bsize);
    return { free: Number(s.bavail) * bsize, total: Number(s.blocks) * bsize };
}
/** Drive a path lives on: "C:\\" for Windows-style paths (on any OS), the volume ("/Volumes/X/") or "/" on macOS. */
function driveRoot(p) {
    if (WIN_ABS.test(p) || process.platform === 'win32')
        return path.win32.parse(path.win32.resolve(p)).root.toUpperCase();
    const abs = path.resolve(p);
    return /^\/Volumes\/[^/]+/.exec(abs)?.[0].concat('/') ?? path.parse(abs).root;
}
/** Parse an AE "Prefs*.txt": sections `["Name"]`, entries `"Key" = "value"`, long strings continued with `"\`. */
export function parseAePrefs(text) {
    const out = new Map();
    let section = '';
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        while (/\\\s*$/.test(line) && i + 1 < lines.length) {
            // `..."\` + newline + `\t\t"...` joins the two quoted pieces
            line = line.replace(/"?\\\s*$/, '') + lines[++i].trim().replace(/^"/, '');
        }
        const sec = /^\s*\["(.*)"\]\s*$/.exec(line);
        if (sec) {
            section = sec[1];
            continue;
        }
        const kv = /^\s*"(.+?)"\s*=\s*"(.*)"\s*$/.exec(line);
        if (!kv)
            continue;
        if (!out.has(section))
            out.set(section, new Map());
        out.get(section).set(kv[1], kv[2]);
    }
    return out;
}
function versionKey(v) {
    return v.split('.').map((x) => parseInt(x, 10) || 0);
}
/** AE prefs version folders under %APPDATA% (or ~/Library/Preferences on macOS), newest first, with their "*Prefs*.txt" files. */
async function aePrefsDirs(env) {
    const appdata = env['APPDATA'];
    const adobe = appdata ? path.join(appdata, 'Adobe') : process.platform === 'darwin' && env['HOME'] ? adobePrefsDir(env, 'darwin', env['HOME']) : undefined;
    if (!adobe)
        return [];
    const root = path.join(adobe, 'After Effects');
    const versions = (await readdir(root).catch(() => [])).filter((v) => /^\d+(\.\d+)*$/.test(v))
        .sort((a, b) => { const x = versionKey(a); const y = versionKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (y[i] ?? 0) - (x[i] ?? 0);
        if (d)
            return d;
    } return 0; });
    const out = [];
    for (const ver of versions) {
        const dir = path.join(root, ver);
        out.push({ ver, dir, files: (await readdir(dir).catch(() => [])).filter((f) => /^Adobe After Effects .*Prefs.*\.txt$/i.test(f)).sort() });
    }
    return out;
}
/** "Allow Scripts to Write Files and Access Network" from the newest AE main prefs, read without starting AE. */
export async function aeScriptingPref(env = process.env) {
    for (const { ver, dir, files } of await aePrefsDirs(env)) {
        const main = files.find((f) => /^Adobe After Effects [\d.]+ Prefs\.txt$/i.test(f));
        if (!main)
            continue;
        const file = path.join(dir, main);
        // the value is written quoted ("1") or as raw hex (01) depending on the AE version
        const m = /"Pref_SCRIPTING_FILE_NETWORK_SECURITY"\s*=\s*"?([0-9A-Fa-f]+)"?/.exec(await readFile(file, 'utf8').catch(() => ''));
        return m ? { allowed: parseInt(m[1], 16) === 1, prefsFile: file, aeVersion: ver } : { prefsFile: file, aeVersion: ver };
    }
    return {};
}
/** AE disk cache folder from the newest AE prefs; default %LOCALAPPDATA%\Temp (~/Library/Caches on macOS); else unknown. */
export async function findAeDiskCache(env = process.env) {
    for (const { ver, dir, files } of await aePrefsDirs(env)) {
        for (const f of files) {
            const file = path.join(dir, f);
            const prefs = parseAePrefs(await readFile(file, 'utf8').catch(() => ''));
            let folder;
            let maxSizeGb;
            const dc = prefs.get('Disk Cache Controls');
            if (dc) {
                for (const [k, v] of dc) {
                    if (/^Folder( \d+)?$/i.test(k) && v)
                        folder = v;
                    if (/^Max Size( \d+)?$/i.test(k) && Number.isFinite(Number(v)))
                        maxSizeGb = Number(v);
                }
            }
            if (!folder) {
                for (const sec of prefs.values()) {
                    for (const [k, v] of sec)
                        if (/^(Disk Cache Folder|Conformed Media Cache)/i.test(k) && v)
                            folder = v;
                }
            }
            if (folder)
                return { folder, source: 'prefs', prefsFile: file, aeVersion: ver, ...(maxSizeGb !== undefined ? { maxSizeGb } : {}) };
        }
    }
    const local = env['LOCALAPPDATA'];
    if (local && existsSync(path.join(local, 'Temp')))
        return { folder: path.join(local, 'Temp'), source: 'default' };
    // macOS default: ~/Library/Caches/Adobe/After Effects/<ver>/Disk Cache…
    const caches = env['HOME'] ? path.join(env['HOME'], 'Library', 'Caches') : undefined;
    if (!local && caches && process.platform === 'darwin' && existsSync(caches))
        return { folder: caches, source: 'default' };
    return { source: 'unknown' };
}
/** The "Disk Cache - <host>.noindex" folders AE creates under the configured folder (never the whole Temp). */
async function aeCacheDirs(folder) {
    const found = [];
    const pick = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (e.isDirectory() && /^(Disk Cache|Ae Disk Cache)/i.test(e.name))
                found.push(path.join(dir, e.name));
        }
    };
    await pick(folder);
    const aeRoot = path.join(folder, 'Adobe', 'After Effects');
    for (const v of await readdir(aeRoot).catch(() => []))
        await pick(path.join(aeRoot, v));
    return found;
}
/** Recursive size without following links; stops (partial) after `maxEntries` or `budgetMs`. */
async function dirSize(root, opts = {}) {
    const maxEntries = opts.maxEntries ?? 500_000;
    const deadline = Date.now() + (opts.budgetMs ?? 20_000);
    let bytes = 0;
    let files = 0;
    let seen = 0;
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        const handle = await opendir(dir).catch(() => undefined);
        if (!handle)
            continue;
        for await (const e of handle) {
            if (++seen > maxEntries || Date.now() > deadline)
                return { bytes, files, partial: true };
            const full = path.join(dir, e.name);
            if (e.isDirectory())
                stack.push(full);
            else if (e.isFile()) {
                const st = await lstat(full).catch(() => undefined);
                if (st) {
                    bytes += st.size;
                    files++;
                }
            }
        }
    }
    return { bytes, files, partial: false };
}
/** AE disk cache folder and its size, without starting AE (the reshoot job grew it ~20 GB in 3 h). */
export async function aeDiskCache(env = process.env) {
    const found = await findAeDiskCache(env);
    const aeCache = { ...found, dirs: [] };
    if (!found.folder)
        return aeCache;
    aeCache.dirs = await aeCacheDirs(found.folder);
    if (aeCache.dirs.length) {
        let bytes = 0;
        for (const d of aeCache.dirs) {
            const s = await dirSize(d);
            bytes += s.bytes;
            if (s.partial)
                aeCache.partial = true;
        }
        aeCache.bytes = bytes;
    }
    return aeCache;
}
export async function diskReport(p, opts = {}) {
    const statfs = opts.statfs ?? fsStatfs;
    const warnings = [];
    const aeCache = await aeDiskCache(opts.env ?? process.env);
    const found = aeCache;
    if (!found.folder) {
        warnings.push('หาโฟลเดอร์ disk cache ของ AE ไม่พบ / AE disk cache folder unknown');
    }
    const roots = new Map();
    const add = (p0, label) => { const r = driveRoot(p0); roots.set(r, [...(roots.get(r) ?? []), label]); };
    add(p.dir, 'project');
    if (found.folder)
        add(found.folder, 'ae-disk-cache');
    const drives = [];
    for (const [root, labels] of roots) {
        try {
            const s = await freeSpace(labels.includes('project') ? p.dir : found.folder, statfs);
            drives.push({ root, for: labels, freeBytes: s.free, totalBytes: s.total });
        }
        catch (e) {
            drives.push({ root, for: labels, error: e instanceof Error ? e.message : String(e) });
        }
    }
    const cacheDir = path.join(p.dir, 'cache');
    const sizeOf = async (d) => (await dirSize(d)).bytes;
    const known = ['segments', 'renders', 'audio', 'tmp'];
    const cache = { segments: 0, renders: 0, audio: 0, tmp: 0, other: 0, total: 0 };
    for (const k of known)
        cache[k] = await sizeOf(path.join(cacheDir, k));
    cache.total = await sizeOf(cacheDir);
    cache.other = Math.max(0, cache.total - known.reduce((s, k) => s + cache[k], 0));
    const outDir = path.join(p.dir, 'out');
    const versionIds = new Set(p.versions.map((v) => v.id));
    const byVersion = {};
    const orphans = {};
    let outTotal = 0;
    for (const e of await readdir(outDir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(outDir, e.name);
        const size = e.isDirectory() ? await sizeOf(full) : ((await lstat(full).catch(() => undefined))?.size ?? 0);
        outTotal += size;
        if (e.isDirectory() && versionIds.has(e.name))
            byVersion[e.name] = size;
        else
            orphans[e.name] = size;
    }
    const review = await sizeOf(path.join(p.dir, 'review'));
    const other = {};
    for (const e of await readdir(p.dir, { withFileTypes: true }).catch(() => [])) {
        if (['cache', 'out', 'review'].includes(e.name))
            continue;
        const full = path.join(p.dir, e.name);
        other[e.name] = e.isDirectory() ? await sizeOf(full) : ((await lstat(full).catch(() => undefined))?.size ?? 0);
    }
    const total = cache.total + outTotal + review + Object.values(other).reduce((a, b) => a + b, 0);
    const budget = (opts.budgetGb ?? DEFAULT_BUDGET_GB) * GB;
    if (total > budget) {
        const top = Object.entries({ cache: cache.total, out: outTotal, review, ...other }).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${fmtGb(v)}`).join(', ');
        warnings.push(`โปรเจกต์ใช้พื้นที่ ${fmtGb(total)} เกินงบ ${fmtGb(budget)} (มากสุด: ${top}) — ดู cache_gc_plan / project uses ${fmtGb(total)}, over the ${fmtGb(budget)} budget`);
    }
    return {
        drives,
        aeCache,
        project: { dir: p.dir, cache, out: { byVersion, orphans, total: outTotal }, review, other, total },
        keptVersions: p.versions.filter((v) => v.keep).map((v) => v.id),
        warnings,
    };
}
// ---------- preflight ----------
function fmtGb(b) {
    return `${(b / GB).toFixed(1)} GB`;
}
/**
 * Free-space gate for a build: error when the project drive would have < 5 GB left after writing
 * `estimatedBytes`, warn below 20 GB. `extraPaths` (e.g. the AE disk cache folder) are checked the same way
 * without the estimate.
 */
export async function preflight(p, estimatedBytes, opts = {}) {
    const statfs = opts.statfs ?? fsStatfs;
    const issues = [];
    const targets = [{ path: p.dir, est: Math.max(0, estimatedBytes || 0), label: 'project' }];
    const seen = new Set([driveRoot(p.dir)]);
    for (const x of opts.extraPaths ?? []) {
        const r = driveRoot(x);
        if (seen.has(r))
            continue;
        seen.add(r);
        targets.push({ path: x, est: 0, label: x });
    }
    for (const t of targets) {
        let free;
        try {
            free = (await freeSpace(t.path, statfs)).free;
        }
        catch (e) {
            issues.push({ kind: 'disk', severity: 'warn', message: `อ่านพื้นที่ว่างของ ${driveRoot(t.path)} ไม่ได้ / cannot read free space: ${e instanceof Error ? e.message : String(e)}` });
            continue;
        }
        const left = free - t.est;
        const where = `${driveRoot(t.path)} (${t.label})`;
        const need = t.est ? `, งานนี้ใช้ประมาณ ${fmtGb(t.est)} / this build needs ~${fmtGb(t.est)}` : '';
        if (left < DISK_ERROR_BYTES) {
            issues.push({ kind: 'disk', severity: 'error', message: `พื้นที่ว่าง ${where} เหลือ ${fmtGb(free)}${need} — ต่ำกว่า 5 GB หลังเขียน ล้าง cache ก่อน (disk_report / cache_gc_plan) / less than 5 GB would remain` });
        }
        else if (left < DISK_WARN_BYTES) {
            issues.push({ kind: 'disk', severity: 'warn', message: `พื้นที่ว่าง ${where} เหลือ ${fmtGb(free)}${need} — ต่ำกว่า 20 GB / less than 20 GB would remain` });
        }
    }
    return issues;
}
// ---------- keep flag ----------
export function setVersionKeep(p, versionId, keep) {
    const v = p.versions.find((x) => x.id === versionId);
    if (!v)
        throw new Error(`no version ${versionId}`);
    if (keep)
        v.keep = true;
    else
        delete v.keep;
    return v;
}
function versionNo(id) {
    const m = /^v(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : -1;
}
function samePath(a, b) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
async function filesUnder(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(d, e.name);
            if (e.isDirectory())
                stack.push(full);
            else if (e.isFile()) {
                const st = await lstat(full).catch(() => undefined);
                if (st?.isFile())
                    out.push({ path: full, bytes: st.size, mtimeMs: st.mtimeMs });
            }
        }
    }
    return out;
}
function planDir(p) {
    return path.join(p.dir, 'cache', 'gc');
}
/**
 * What could be deleted: versions older than the latest `keepLatest` (and not `keep`), out/ folders with no
 * version, segment cache files for clips none of the retained versions (or the current timeline) use, comp
 * renders no asset points to, and stale temp files. Writes the plan (with its hash) to cache/gc/; deletes nothing.
 */
export async function gcPlan(p, opts = {}) {
    const now = (opts.now ?? (() => new Date()))();
    const keepLatest = Math.max(0, Math.floor(opts.keepLatest ?? 3));
    const versions = [...p.versions].sort((a, b) => versionNo(a.id) - versionNo(b.id));
    const latest = new Set(versions.slice(Math.max(0, versions.length - keepLatest)).map((v) => v.id));
    const retained = versions.filter((v) => latest.has(v.id) || v.keep);
    const retainedIds = new Set(retained.map((v) => v.id));
    const items = [];
    const old = (mtimeMs) => now.getTime() - mtimeMs > MIN_AGE_MS;
    const push = (f, reason, version) => items.push({ ...f, rel: path.relative(p.dir, f.path), reason, ...(version ? { version } : {}) });
    // out/: superseded versions and orphan folders
    const outDir = path.join(p.dir, 'out');
    const known = new Set(versions.map((v) => v.id));
    for (const e of await readdir(outDir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory())
            continue;
        const dir = path.join(outDir, e.name);
        if (known.has(e.name)) {
            if (retainedIds.has(e.name))
                continue;
            for (const f of await filesUnder(dir))
                push(f, 'old-version', e.name);
        }
        else {
            const files = await filesUnder(dir);
            if (files.length && files.every((f) => old(f.mtimeMs)))
                for (const f of files)
                    push(f, 'orphan-version-folder');
        }
    }
    // cache/segments: manifest entries for clips nothing retained uses
    const segDir = path.join(p.dir, 'cache', 'segments');
    let manifest = {};
    try {
        const m = JSON.parse(await readFile(path.join(segDir, 'manifest.json'), 'utf8'));
        manifest = m.entries ?? {};
    }
    catch { /* no manifest: only orphans below */ }
    const usedClips = new Set(p.timeline.video.map((c) => c.id));
    for (const v of retained) {
        for (const s of v.reviewPlan?.shots ?? [])
            usedClips.add(s.id);
        for (const id of Object.keys(v.clipSnapshots ?? {}))
            usedClips.add(id);
    }
    const inManifest = new Set();
    let keptUnknown = 0;
    const segFiles = new Map((await filesUnder(segDir)).filter((f) => path.dirname(f.path) === segDir).map((f) => [path.basename(f.path).toLowerCase(), f]));
    for (const [key, e] of Object.entries(manifest)) {
        const name = e.file ?? `${key}.mov`;
        inManifest.add(name.toLowerCase());
        const f = segFiles.get(name.toLowerCase());
        if (!f)
            continue;
        let unused;
        if (opts.referencedSegmentKeys)
            unused = !opts.referencedSegmentKeys.has(key);
        else if (e.kind === 'segment' && e.clipId)
            unused = !usedClips.has(e.clipId);
        else {
            keptUnknown++;
            unused = false;
        }
        if (unused)
            push(f, 'unused-segment');
    }
    for (const [name, f] of segFiles) {
        if (name === 'manifest.json' || inManifest.has(name) || name.startsWith('.manifest.'))
            continue;
        if (old(f.mtimeMs))
            push(f, 'orphan-segment');
    }
    // cache/renders: comp renders no asset or retained version points to any more
    const renderDir = path.join(p.dir, 'cache', 'renders');
    const liveRenders = [
        ...Object.values(p.assets).flatMap((a) => (a.kind === 'aecomp' && a.render ? [a.render.path] : [])),
        // renders a retained version can still revert a shot to (shot_revert snapshots)
        ...retained.flatMap((v) => Object.values(v.clipSnapshots ?? {}).flatMap((s) => (s.render ? [s.render.path] : []))),
    ];
    for (const f of await filesUnder(renderDir)) {
        if (liveRenders.some((r) => samePath(r, f.path)))
            continue;
        if (old(f.mtimeMs))
            push(f, 'superseded-render');
    }
    // cache/tmp: leftovers of crashed/cancelled jobs
    for (const f of await filesUnder(path.join(p.dir, 'cache', 'tmp')))
        if (old(f.mtimeMs))
            push(f, 'stale-temp');
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const planId = `${stamp}-${randomBytes(3).toString('hex')}`;
    const body = {
        schema: 1, planId, projectDir: p.dir, createdAt: now.toISOString(), keepLatest,
        retainedVersions: retained.map((v) => v.id), items, totalBytes: items.reduce((s, i) => s + i.bytes, 0), keptUnknown,
    };
    const plan = { ...body, hash: hashJson(body) };
    await mkdir(planDir(p), { recursive: true });
    await writeFile(path.join(planDir(p), `plan-${planId}.json`), `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return plan;
}
function realOrNull(p) {
    try {
        return realpathSync.native(p);
    }
    catch {
        return null;
    }
}
function inside(child, root) {
    const rel = path.relative(root.toLowerCase(), child.toLowerCase());
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
/**
 * Delete what a recent plan listed. Refuses without the confirm token ('ลบ' | 'delete'), for a plan older than
 * 10 minutes or tampered with, and per file for anything outside <project>/cache or <project>/out, links, or files
 * changed since the plan. Marks versions whose master is gone with `purgedAt` (caller saves the project).
 */
export async function gcApply(p, planId, confirm, opts = {}) {
    if (!CONFIRM_TOKENS.has(confirm))
        throw new Error('ต้องยืนยันด้วย confirm: "ลบ" หรือ "delete" หลังผู้ใช้อนุมัติ / pass confirm: "ลบ" or "delete" after the user approved the plan');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(planId))
        throw new Error(`bad planId: ${planId}`);
    if (isProtected(p.dir))
        throw new Error('protected project folder');
    const now = (opts.now ?? (() => new Date()))();
    const file = path.join(planDir(p), `plan-${planId}.json`);
    let plan;
    try {
        plan = JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        throw new Error(`ไม่พบแผน ${planId} (หรือใช้ไปแล้ว) — เรียก cache_gc_plan ใหม่ / plan not found or already applied`);
    }
    const { hash, ...body } = plan;
    if (hash !== hashJson(body) || plan.planId !== planId)
        throw new Error('แผนถูกแก้ไข — สร้างแผนใหม่ / plan file was modified: make a new plan');
    if (!samePath(plan.projectDir, p.dir))
        throw new Error('แผนนี้เป็นของโปรเจกต์อื่น / plan belongs to another project');
    const age = now.getTime() - Date.parse(plan.createdAt);
    if (!(age >= -60_000 && age <= PLAN_MAX_AGE_MS))
        throw new Error('แผนเก่าเกิน 10 นาที — สร้างแผนใหม่แล้วให้ผู้ใช้ดูอีกครั้ง / plan is older than 10 minutes: make a new one and show it to the user');
    const projReal = realOrNull(p.dir);
    if (!projReal)
        throw new Error(`project folder missing: ${p.dir}`);
    const roots = ['cache', 'out'].map((d) => realOrNull(path.join(p.dir, d))).filter((x) => !!x);
    const gcReal = realOrNull(planDir(p));
    const deleted = [];
    const skipped = [];
    const dirs = new Set();
    for (const it of plan.items) {
        const abs = path.resolve(p.dir, it.rel);
        const parent = realOrNull(path.dirname(abs));
        const real = parent ? path.join(parent, path.basename(abs)) : null;
        if (!samePath(abs, it.path) || !real || !roots.some((r) => inside(real, r)) || (gcReal && (inside(real, gcReal) || samePath(real, gcReal)))) {
            skipped.push({ path: it.path, reason: 'outside cache/ and out/' });
            continue;
        }
        const st = await lstat(real).catch(() => undefined);
        if (!st) {
            skipped.push({ path: it.path, reason: 'already gone' });
            continue;
        }
        if (!st.isFile()) {
            skipped.push({ path: it.path, reason: 'not a plain file (link/folder)' });
            continue;
        }
        if (st.size !== it.bytes || Math.abs(st.mtimeMs - it.mtimeMs) > 1) {
            skipped.push({ path: it.path, reason: 'changed since the plan' });
            continue;
        }
        try {
            await unlink(real);
            deleted.push({ path: it.path, bytes: it.bytes });
            dirs.add(path.dirname(real));
        }
        catch (e) {
            skipped.push({ path: it.path, reason: e instanceof Error ? e.message : String(e) });
        }
    }
    // tidy now-empty folders (only below out/ or cache/, never the roots themselves)
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
        let cur = d;
        while (roots.some((r) => inside(cur, r))) {
            if ((await readdir(cur).catch(() => ['x'])).length)
                break;
            await rmdir(cur).catch(() => undefined);
            cur = path.dirname(cur);
        }
    }
    const purgedVersions = [];
    for (const v of p.versions) {
        if (deleted.some((d) => samePath(d.path, v.master))) {
            v.purgedAt = now.toISOString();
            purgedVersions.push(v.id);
        }
    }
    const histDir = path.join(p.dir, 'history');
    await mkdir(histDir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    let log = path.join(histDir, `gc-${stamp}.log`);
    for (let i = 2; existsSync(log); i++)
        log = path.join(histDir, `gc-${stamp}_${i}.log`);
    const lines = [
        `# gc plan ${planId} applied ${now.toISOString()} (confirm: ${confirm})`,
        ...deleted.map((d) => `DELETED\t${d.bytes}\t${d.path}`),
        ...skipped.map((s) => `SKIPPED\t${s.reason}\t${s.path}`),
    ];
    await writeFile(log, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(file, path.join(planDir(p), `plan-${planId}.applied.json`)); // a plan is single-use
    return { planId, deleted, skipped, freedBytes: deleted.reduce((s, d) => s + d.bytes, 0), purgedVersions, log };
}
//# sourceMappingURL=housekeeping.js.map