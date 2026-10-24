import { execa } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hashFile, hashJson } from '../core/hash.js';
import { freeRamBytes, isBundleProcess, listPosixProcesses } from '../core/platform.js';
import { ACTIONS, UserActionError } from '../core/user-action.js';
import { aeScriptingPref } from './housekeeping.js';
import { aerender, defaultMfrPercent, isAscii, isMissingOmTemplate, killTree, moveFile, purgeIfLowCacheSpace, uniqueOutputPath, } from './aerender.js';
/** Only the threshold fields the runner understands travel into the job. */
function runnerRules(rules) {
    if (!rules)
        return null;
    const out = {};
    if (rules.thai?.minCapHeightPct !== undefined)
        out['thai'] = { minCapHeightPct: rules.thai.minCapHeightPct };
    if (rules.safeMarginPct !== undefined)
        out['safeMarginPct'] = rules.safeMarginPct;
    if (rules.cornerRadiusPct !== undefined)
        out['cornerRadiusPct'] = rules.cornerRadiusPct;
    return Object.keys(out).length ? out : null;
}
// One Adobe process at a time, including renders, across backend instances.
let queue = Promise.resolve();
function serial(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
}
/**
 * AfterFX.exe processes via `tasklist /V` (window title separates a GUI from -noui instances). On macOS
 * every After Effects process is a GUI (there is no -noui), so each gets its app name as title.
 */
export async function listAfterFxProcesses(spawn = execa) {
    if (process.platform !== 'win32') {
        const procs = await listPosixProcesses();
        return procs.filter((p) => isBundleProcess(p.command, /^Adobe After Effects\b/i))
            .map((p) => ({ name: basename(p.command), pid: p.pid, title: p.command.replace(/^.*\/([^/]+)\.app\/.*$/, '$1') }));
    }
    const r = await spawn('tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq AfterFX.exe'], { reject: false, windowsHide: true, timeout: 15_000 });
    const out = [];
    for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
        const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
        if (cells.length < 2 || !/^afterfx\.exe$/i.test(cells[0]))
            continue;
        out.push({ name: cells[0], pid: Number(cells[1]), title: cells.length >= 9 ? cells[cells.length - 1] : '' });
    }
    return out;
}
/** macOS: `afterfx` is the app bundle and scripts go through AppleScript. */
function isMacBundle(afterfx) {
    return /\.app\/?$/i.test(afterfx);
}
/** AppleScript that runs a JSX file in After Effects and waits for it (AE's own DoScriptFile command). */
export function doScriptFile(app, jsx, timeoutMs) {
    const q = (v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    return [
        `with timeout of ${Math.ceil(timeoutMs / 1000)} seconds`,
        `  tell application ${q(basename(app).replace(/\.app\/?$/i, ''))} to DoScriptFile ${q(jsx)}`,
        'end timeout',
    ].join('\n');
}
/** The runner quits AE; wait for that (the next job must not land in a closing AE), then kill leftovers. */
async function waitForAeExit(list, waitMs) {
    const until = Date.now() + waitMs;
    for (;;) {
        const left = await list().catch(() => []);
        if (!left.length)
            return;
        if (Date.now() >= until) {
            for (const p of left) {
                try {
                    process.kill(p.pid, 'SIGKILL');
                }
                catch { /* gone */ }
            }
            return;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}
function guiWindows(procs) {
    return procs.filter((p) => p.title && !/^n\/a$/i.test(p.title.trim()));
}
export function createAeBackend(tools, opts = {}) {
    const spawn = opts.spawn ?? execa;
    const runner = fileURLToPath(new URL('../../jsx/runner.jsx', import.meta.url));
    const listProcesses = opts.listProcesses ?? (() => listAfterFxProcesses(spawn));
    const shortTimeout = opts.timeoutMs ?? 120_000;
    const longTimeout = opts.fingerprintTimeoutMs ?? Math.max(shortTimeout, 600_000);
    // Comp timing per project, valid while the .aep hash is unchanged (filled by every job that reads comps).
    const timings = new Map();
    const renderOpts = {
        spawn,
        ...(opts.statfs ? { statfs: opts.statfs } : {}),
        ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
        ...(opts.minFreeDiskGb !== undefined ? { minFreeGb: opts.minFreeDiskGb } : {}),
        ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
    };
    const scriptingPref = opts.scriptingPref ?? (() => aeScriptingPref());
    async function noResult(action, exitCode, stderr) {
        const detail = `AfterFX ${action}: exit ${exitCode ?? '?'}, no result${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
        const pref = await scriptingPref();
        if (pref.allowed === false)
            return new UserActionError(detail, ACTIONS.aeAllowScripts());
        return new UserActionError(detail, ACTIONS.aeFirstRun({ detail: `exit ${exitCode ?? '?'}` }));
    }
    async function run(action, payload = {}) {
        if (!tools.afterfx)
            throw new UserActionError('AfterFX not found; install After Effects or set EDITMCP_AE_DIR', ACTIONS.aeNotFound());
        const minRam = opts.minFreeRamGb ?? 0.75;
        if (freeRamBytes() / 2 ** 30 < minRam)
            throw new Error(`not enough free RAM for After Effects (need ${minRam} GB)`);
        const tempRoot = os.tmpdir();
        if (!isAscii(tempRoot))
            throw new Error('After Effects needs an ASCII TEMP directory; set TEMP/TMP to an ASCII path');
        const dir = await mkdtemp(join(tempRoot, 'editmcp-ae-'));
        try {
            const jobPath = join(dir, 'job.json');
            // Same name the runner derives from the job path when the job itself cannot be read.
            const resultPath = join(dir, 'job.result.json');
            await writeFile(jobPath, JSON.stringify({ ...payload, action, result: resultPath }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'), 'utf8');
            const launcher = join(dir, 'launch.jsx');
            // Only generated paths are embedded in JSX; user values go through the UTF-8 JSON job.
            await writeFile(launcher, `var EDITMCP_JOB = ${JSON.stringify(jobPath)};\n$.evalFile(new File(${JSON.stringify(runner)}));\n`, 'utf8');
            const timeoutMs = action === 'list' || action === 'version' ? shortTimeout : longTimeout;
            const mac = isMacBundle(tools.afterfx);
            if (mac) {
                // One AE per Mac user and the runner ends with app.quit(): never run inside the person's open AE.
                const open = await listProcesses().catch(() => []);
                if (open.length)
                    throw new UserActionError(`After Effects is open (PID ${open.map((p) => p.pid).join(', ')})`, ACTIONS.aeCloseMac());
            }
            const child = mac
                ? spawn('osascript', ['-e', doScriptFile(tools.afterfx, launcher, timeoutMs)], { reject: false, timeout: 0 })
                : spawn(tools.afterfx, ['-m', '-noui', '-r', launcher], { reject: false, windowsHide: true, timeout: 0 });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; void killTree(child.pid, spawn, child); }, timeoutMs);
            let output;
            try {
                output = await child;
            }
            finally {
                clearTimeout(timer);
            }
            if (mac)
                await waitForAeExit(listProcesses, timedOut ? 0 : opts.macQuitWaitMs ?? 60_000);
            if (timedOut)
                throw new Error(`AfterFX ${action} timed out after ${timeoutMs} ms (process tree killed)`);
            const report = await readFile(resultPath, 'utf8').catch(() => undefined);
            const stderr = String(output.stderr ?? '').slice(-500);
            if (mac && report === undefined && /-1743|not authori[sz]ed/i.test(stderr))
                throw new UserActionError(`osascript: ${stderr.trim()}`, ACTIONS.macAutomation());
            // No result at all: the runner never got to write one (scripts may not write files, or AE quit
            // at a first-run screen). Both need the person, so say which one instead of a raw error.
            if (report === undefined)
                throw await noResult(action, output.exitCode, stderr);
            // osascript often fails once AE quits under it (-609): on macOS the result file decides
            if (!mac && output.exitCode !== 0)
                throw new Error(`AfterFX failed (${output.exitCode}): ${report}`);
            const result = JSON.parse(report.replace(/^\uFEFF/, ''));
            if (result.ok !== true) {
                if (/cannot write /.test(result.error ?? '') && (await scriptingPref()).allowed === false) {
                    throw new UserActionError(`AfterFX: ${result.error}`, ACTIONS.aeAllowScripts());
                }
                throw new Error(`AfterFX: ${result.error ?? 'job failed'}`);
            }
            return result;
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
    function timingOf(v) {
        const o = v;
        if (!o || typeof o.durationFrames !== 'number')
            return undefined;
        return {
            durationFrames: o.durationFrames, displayStartFrame: typeof o.displayStartFrame === 'number' ? o.displayStartFrame : 0,
            ...(typeof o.width === 'number' && typeof o.height === 'number' ? { width: o.width, height: o.height } : {}),
        };
    }
    function remember(aep, stamp, entries, complete) {
        const key = resolve(aep).toLowerCase();
        let slot = timings.get(key);
        if (!slot || slot.stamp !== stamp || complete) {
            slot = { stamp, comps: new Map() };
            timings.set(key, slot);
        }
        for (const [name, v] of entries) {
            const t = timingOf(v);
            if (!t)
                continue;
            slot.comps.set(name, complete && slot.comps.has(name) ? 'ambiguous' : t);
        }
    }
    /** Duration and display start of a comp; reuses the last job's data while the .aep is unchanged. */
    async function compTiming(aep, comp) {
        const stamp = await hashFile(aep);
        let hit = timings.get(resolve(aep).toLowerCase());
        if (!hit || hit.stamp !== stamp || !hit.comps.has(comp)) {
            const { data } = await run('list', { aep: resolve(aep) });
            remember(aep, stamp, data.map((c) => [c.name, c]), true);
            hit = timings.get(resolve(aep).toLowerCase());
        }
        const t = hit?.comps.get(comp);
        if (!t)
            throw new Error(`comp not found: ${comp}`);
        if (t === 'ambiguous')
            throw new Error(`ambiguous comp name: ${comp}`);
        if (!(t.durationFrames > 0))
            throw new Error(`comp has no frames: ${comp}`);
        return t;
    }
    async function fingerprintSnapshot(snapshot) {
        const files = new Set();
        const sequences = new Set();
        let opaque = false;
        function collect(v) {
            if (Array.isArray(v)) {
                v.forEach(collect);
                return;
            }
            if (v && typeof v === 'object') {
                const obj = v;
                if (typeof obj.file === 'string')
                    files.add(obj.file);
                if (typeof obj.file === 'string' && obj.sequence === true)
                    sequences.add(obj.file);
                if (obj.opaque === true)
                    opaque = true;
                Object.values(obj).forEach(collect);
            }
        }
        collect(snapshot);
        for (const file of sequences) {
            const stem = basename(file, extname(file));
            const prefix = stem.replace(/\d+$/, '');
            for (const entry of await readdir(dirname(file), { withFileTypes: true })) {
                if (entry.isFile() && entry.name.startsWith(prefix) && extname(entry.name).toLowerCase() === extname(file).toLowerCase())
                    files.add(join(dirname(file), entry.name));
            }
        }
        const media = {};
        for (const file of files)
            media[file] = await hashFile(file);
        // No .aep hash: expressions are fingerprinted by text + sampled values, opaque values are only
        // flagged (see jsx/README.md), so merely re-saving the project does not re-render every comp.
        return { hash: hashJson({ snapshot, media }), opaque };
    }
    async function fingerprintDetailed(aep, comps) {
        const stamp = await hashFile(aep);
        const { data } = await run('fingerprint', { aep: resolve(aep), comps });
        remember(aep, stamp, Object.entries(data), false);
        const out = {};
        for (const [name, snapshot] of Object.entries(data))
            out[name] = await fingerprintSnapshot(snapshot);
        return out;
    }
    async function edit(req) {
        const source = resolve(req.aep);
        const savedTo = req.saveAs ? resolve(req.saveAs) : source;
        if (req.saveAs && savedTo.toLowerCase() === source.toLowerCase())
            throw new Error('saveAs must differ from the source; omit it for an in-place edit with backup');
        if (req.saveAs && existsSync(savedTo))
            throw new Error(`refusing to overwrite ${savedTo}`);
        const before = await hashFile(source);
        const working = join(dirname(source), `.editmcp-${randomUUID()}${extname(source) || '.aep'}`);
        await copyFile(source, working, constants.COPYFILE_EXCL);
        try {
            const result = await run('edit', { aep: working, comp: req.comp, ops: req.ops });
            const { hash: fingerprint } = await fingerprintSnapshot(result.data.snapshot);
            const changed = 'source .aep changed during edit; original preserved, retry against the new version';
            if (await hashFile(source) !== before)
                throw new Error(changed);
            const log = result.log ?? [];
            let aeGuiRunning = false;
            let warning;
            if (req.saveAs) {
                await copyFile(working, savedTo, constants.COPYFILE_EXCL);
            }
            else {
                // A GUI holding this project in memory would silently revert the edit on its next save.
                const gui = guiWindows(await listProcesses().catch(() => []));
                if (gui.length) {
                    aeGuiRunning = true;
                    const name = basename(source).toLowerCase();
                    const showing = gui.some((p) => p.title.toLowerCase().includes(name));
                    warning = `After Effects GUI is running${showing ? ' with this project open' : ''} (PID ${gui.map((p) => p.pid).join(', ')}): `
                        + 'saving there will overwrite this edit. Close it without saving and reopen, or use saveAs to write a new .aep. '
                        + '/ After Effects เปิดอยู่ ถ้ากด save ในโปรแกรม การแก้ไขนี้จะหาย ให้ปิดแล้วเปิดใหม่ หรือใช้ saveAs';
                    log.push(`WARNING: ${warning}`);
                }
                const backup = uniqueOutputPath(join(dirname(source), `${basename(source, extname(source))}_backup_${Date.now()}.aep`));
                await copyFile(source, backup, constants.COPYFILE_EXCL);
                log.push(`backup: ${backup}`);
                // Re-check right before replacing so a save during the backup copy is never lost.
                if (await hashFile(source) !== before) {
                    await rm(backup, { force: true });
                    throw new Error(changed);
                }
                await rename(working, source);
                timings.delete(source.toLowerCase());
            }
            return { ok: true, savedTo, fingerprint, log, aeGuiRunning, ...(warning ? { warning } : {}) };
        }
        finally {
            await rm(working, { force: true });
        }
    }
    async function create(req) {
        const savedTo = resolve(req.saveAs);
        if (extname(savedTo).toLowerCase() !== '.aep')
            throw new Error('saveAs must be a .aep path');
        if (existsSync(savedTo))
            throw new Error(`refusing to overwrite ${savedTo}`);
        const working = join(dirname(savedTo), `.editmcp-${randomUUID()}.aep`);
        try {
            const result = await run('create', { jsx: req.jsx, saveAs: working, ...(req.scriptDir ? { scriptDir: resolve(req.scriptDir) } : {}) });
            if (!existsSync(working))
                throw new Error('After Effects did not save the new project');
            await copyFile(working, savedTo, constants.COPYFILE_EXCL);
            return { savedTo, comps: result.data ?? [], log: result.log ?? [] };
        }
        finally {
            await rm(working, { force: true });
        }
    }
    async function render(req) {
        const aep = resolve(req.aep);
        const t = await compTiming(aep, req.comp);
        const startFrame = req.startFrame ?? 0;
        const endFrame = req.endFrame ?? t.durationFrames - 1;
        if (endFrame >= t.durationFrames)
            throw new Error(`endFrame ${endFrame} is past the end of ${req.comp} (${t.durationFrames} frames)`);
        const base = {
            ...req, aep, startFrame, endFrame, frameOffset: t.displayStartFrame,
            mfrPercent: req.mfrPercent ?? defaultMfrPercent(),
            rsTemplate: req.renderSettings ?? 'Best Settings', strictRam: true, minFreeRamGb: opts.minFreeRamGb,
            ...(t.width && t.height ? { width: t.width, height: t.height } : {}),
        };
        const omTemplate = req.outputModule ?? 'EDITMCP ProRes 422 HQ';
        try {
            return await aerender(tools, { ...base, omTemplate }, renderOpts);
        }
        catch (error) {
            // Fall back only when aerender itself says the ProRes OM template is missing.
            if (req.outputModule || !isMissingOmTemplate(error, [req.comp, aep, omTemplate]))
                throw error;
            return aerender(tools, { ...base, omTemplate: 'Lossless', fallback: true }, renderOpts);
        }
    }
    const backend = {
        kind: 'extendscript-headless',
        listComps: (aep) => serial(async () => {
            const stamp = await hashFile(aep);
            const { data } = await run('list', { aep: resolve(aep) });
            remember(aep, stamp, data.map((c) => [c.name, c]), true);
            return data;
        }),
        inspectComp: (aep, comp, atFrame = 0) => serial(async () => {
            if (!Number.isInteger(atFrame) || atFrame < 0)
                throw new Error('atFrame must be a non-negative integer');
            const stamp = await hashFile(aep);
            const { data } = await run('inspect', { aep: resolve(aep), comp, atFrame });
            const { snapshot, ...detail } = data;
            remember(aep, stamp, [[comp, detail]], false);
            return { ...detail, fingerprint: (await fingerprintSnapshot(snapshot)).hash };
        }),
        fingerprint: (aep, comps) => serial(async () => {
            const hashes = {};
            for (const [name, d] of Object.entries(await fingerprintDetailed(aep, comps)))
                hashes[name] = d.hash;
            return hashes;
        }),
        fingerprintDetailed: (aep, comps) => serial(() => fingerprintDetailed(aep, comps)),
        edit: (req) => serial(() => edit(req)),
        create: (req) => serial(() => create(req)),
        render: (req) => serial(() => render(req)),
        previewFrame: (aep, comp, frame, outPng) => serial(async () => {
            if (!Number.isInteger(frame) || frame < 0)
                throw new Error('frame must be a non-negative integer');
            const t = await compTiming(aep, comp);
            if (frame >= t.durationFrames)
                throw new Error(`frame ${frame} is past the end of ${comp} (${t.durationFrames} frames)`);
            // Lossless is universally available; extract PNG with ffmpeg rather than relying on image templates.
            const out = uniqueOutputPath(resolve(outPng));
            const tempRoot = os.tmpdir();
            if (!isAscii(tempRoot))
                throw new Error('After Effects needs an ASCII TEMP directory');
            const dir = await mkdtemp(join(tempRoot, 'editmcp-preview-'));
            try {
                const clip = await aerender(tools, { aep: resolve(aep), comp, startFrame: frame, endFrame: frame, frameOffset: t.displayStartFrame, outPath: join(dir, 'frame.mov'), omTemplate: 'Lossless', rsTemplate: 'Best Settings', strictRam: true, minFreeRamGb: opts.minFreeRamGb, ...(t.width && t.height ? { width: t.width, height: t.height } : {}) }, renderOpts);
                const png = join(dir, 'frame.png');
                const r = await spawn(tools.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-i', clip.path, '-frames:v', '1', png], { reject: false, windowsHide: true, timeout: 60_000 });
                if (r.exitCode !== 0)
                    throw new Error(`PNG conversion failed: ${r.stderr}`);
                await moveFile(png, out);
                return out;
            }
            finally {
                await rm(dir, { recursive: true, force: true });
            }
        }),
        version: () => serial(async () => (await run('version')).data),
        scanTemplate: (aep) => serial(async () => {
            const { data } = await run('scanTemplate', { aep: resolve(aep) });
            return { aep: resolve(aep), comps: data.comps ?? [], warnings: data.warnings ?? [] };
        }),
        lintComp: (aep, comp, rules) => serial(async () => (await run('lintComp', { aep: resolve(aep), comp, rules: runnerRules(rules) })).data),
        listFonts: (aep) => serial(async () => (await listFontsDetailed(aep)).fonts),
        listFontsDetailed: (aep) => serial(() => listFontsDetailed(aep)),
        purgeCaches: () => serial(async () => { await run('purge'); }),
        afterRenderBatch: (policy) => purgeIfLowCacheSpace(backend, { ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}), ...(opts.statfs ? { statfs: opts.statfs } : {}), ...opts.purge, ...policy }),
    };
    return backend;
    async function listFontsDetailed(aep) {
        const { data } = await run('listFonts', { aep: resolve(aep) });
        return { fonts: data.fonts ?? [], families: data.families ?? [], aeMissing: data.aeMissing ?? null };
    }
}
const THAI_RE = /\p{Script=Thai}/u;
const REPLACEABLE_RE = /placeholder|replace|drop|insert|your|media|image|photo|picture|video|footage|logo|screen|ใส่|แทน|รูป|ภาพ|วิดีโอ|โลโก้/i;
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function isVisual(l) {
    if (['null', 'camera', 'light', 'adjustment'].includes(l.kind))
        return false;
    return l.enabled !== false || l.isMatte === true;
}
function coverOf(b) {
    if (!b)
        return 0;
    const w = Math.max(0, Math.min(b.x + b.w, 1) - Math.max(b.x, 0));
    const h = Math.max(0, Math.min(b.y + b.h, 1) - Math.max(b.y, 0));
    return w * h;
}
/** Same rules as runner.jsx `lint()`, over a MockComp. */
export function lintMockComp(c, rules) {
    const issues = [];
    const fps = c.fps ?? 25;
    const end = c.durationFrames;
    const height = c.height ?? 1080;
    let bottom = -1;
    for (let i = c.layers.length - 1; i >= 0 && bottom < 0; i--) {
        const l = c.layers[i];
        if (isVisual(l) && l.enabled !== false && !l.isMatte)
            bottom = i;
    }
    c.layers.forEach((l, i) => {
        if (!isVisual(l))
            return;
        const inF = l.inFrame ?? 0;
        const outF = l.outFrame ?? end;
        if (inF >= end || outF <= 0)
            return;
        if (outF >= end) {
            const mf = l.lastKeyFrame;
            if (!l.continuous && mf !== undefined && mf > inF && mf < end - Math.round(fps)) {
                issues.push({ kind: 'animation-ends-early', layer: l.name, frame: mf, message: `"${l.name}": last keyframe at frame ${mf} but the layer stays visible to frame ${end} (stops moving)` });
            }
        }
        else if (l.enabled !== false && !l.isMatte) {
            const cover = coverOf(l.bounds);
            if (cover > 0.9)
                issues.push({ kind: 'background-ends-early', layer: l.name, frame: outF, message: `"${l.name}" covers ${Math.round(cover * 100)}% of the frame and ends at frame ${outF} before comp end ${end}` });
            else if (i === bottom)
                issues.push({ kind: 'layer-ends-early', layer: l.name, frame: outF, message: `bottom layer "${l.name}" ends at frame ${outF} before comp end ${end}` });
        }
        if (l.kind === 'text' && l.text !== undefined) {
            if (THAI_RE.test(l.text)) {
                for (const a of l.animators ?? []) {
                    if (a.basedOn !== 'characters' && a.basedOn !== 'words')
                        continue;
                    issues.push(Object.assign({ kind: 'thai-animator', layer: l.name, message: `"${l.name}": animator "${a.name ?? 'Animator'}" is based on ${a.basedOn}; Thai clusters may split` }, { basedOn: a.basedOn }));
                }
                const min = rules?.thai?.minCapHeightPct;
                if (min !== undefined && min > 0 && l.fontSize) {
                    const pct = Math.round((l.fontSize * Math.abs(l.scalePct ?? 100) / 100 / height * 100) * 100) / 100;
                    if (pct < min)
                        issues.push({ kind: 'thai-size', layer: l.name, message: `"${l.name}": Thai text size ${pct}% of frame height < project rule ${min}%` });
                }
            }
            const m = rules?.safeMarginPct;
            if (m !== undefined && m > 0 && l.bounds) {
                const f = m / 100, b = l.bounds;
                if (b.x < f || b.y < f || b.x + b.w > 1 - f || b.y + b.h > 1 - f) {
                    issues.push(Object.assign({ kind: 'style', layer: l.name, message: `"${l.name}": text crosses the ${m}% safe margin` }, { rule: 'safeMarginPct' }));
                }
            }
        }
        const want = rules?.cornerRadiusPct;
        if (want !== undefined && want > 0 && l.kind === 'shape' && l.cornerRadiusPct !== undefined && Math.abs(l.cornerRadiusPct - want) > 1) {
            issues.push(Object.assign({ kind: 'style', layer: l.name, message: `"${l.name}": corner radius ${l.cornerRadiusPct}% of the short side, project rule ${want}%` }, { rule: 'cornerRadiusPct' }));
        }
    });
    return { comp: c.name, issues };
}
/** Same rules as runner.jsx `scanComp()`, over a MockComp. */
export function scanMockComp(c, warnings = []) {
    const out = { name: c.name, durationFrames: c.durationFrames, width: c.width ?? 1920, height: c.height ?? 1080, placeholders: [], expressionLocked: [], fonts: [], textAnimators: [] };
    for (const l of c.layers) {
        if (!l.isMatte) {
            let kind;
            if (l.kind === 'text')
                kind = 'text';
            else if (l.kind === 'footage')
                kind = l.still ? 'image' : 'footage';
            else if (l.kind === 'precomp' && (REPLACEABLE_RE.test(l.name) || REPLACEABLE_RE.test(l.source ?? '')))
                kind = 'precomp';
            if (kind)
                out.placeholders.push({ layer: l.name, kind, ...(l.source ? { source: l.source } : {}), moving: l.matted ? !!l.transformAnimated : true });
        }
        if (l.kind === 'text') {
            if (l.font && !out.fonts.includes(l.font))
                out.fonts.push(l.font);
            for (const a of l.animators ?? [])
                out.textAnimators.push({ layer: l.name, basedOn: a.basedOn });
        }
        for (const e of l.expressions ?? [])
            out.expressionLocked.push(`${l.name} > ${e}`);
        if (l.controls?.length)
            warnings.push(`${c.name}: layer "${l.name}" holds expression controls (${l.controls.join(', ')}); expression-driven values are set there`);
    }
    return out;
}
/**
 * In-memory AeBackend. Every .aep path sees the same comps. previewFrame/render write small placeholder
 * files (never overwriting); calls are recorded in `calls`.
 */
export class MockAeBackend {
    kind = 'mock';
    calls = [];
    purged = 0;
    comps;
    aeMissingFonts;
    constructor(opts = {}) {
        this.comps = opts.comps ?? [];
        this.aeMissingFonts = opts.aeMissingFonts ?? null;
        this.ver = opts.version ?? 'mock';
    }
    ver;
    comp(name) {
        const c = this.comps.find((x) => x.name === name);
        if (!c)
            throw new Error(`comp not found: ${name}`);
        return c;
    }
    info(c) {
        return { id: this.comps.indexOf(c) + 1, name: c.name, width: c.width ?? 1920, height: c.height ?? 1080, fps: c.fps ?? 25, durationFrames: c.durationFrames, numLayers: c.layers.length };
    }
    async listComps() { this.calls.push('listComps'); return this.comps.map((c) => this.info(c)); }
    async inspectComp(_aep, comp) {
        this.calls.push(`inspectComp:${comp}`);
        const c = this.comp(comp);
        const layers = c.layers.map((l, i) => ({
            index: i + 1, name: l.name, kind: l.kind, inFrame: l.inFrame ?? 0, outFrame: l.outFrame ?? c.durationFrames, enabled: l.enabled !== false, effects: l.controls ?? [],
            ...(l.text !== undefined ? { text: l.text } : {}), ...(l.source ? { source: l.source } : {}), ...(l.bounds ? { bounds: l.bounds } : {}),
        }));
        return { ...this.info(c), layers, fingerprint: hashJson(c) };
    }
    async fingerprint(_aep, comps) {
        this.calls.push('fingerprint');
        const out = {};
        for (const c of this.comps)
            if (!comps || comps.includes(c.name))
                out[c.name] = hashJson(c);
        return out;
    }
    async edit(req) {
        this.calls.push(`edit:${req.comp}`);
        return { ok: true, savedTo: req.saveAs ?? req.aep, fingerprint: hashJson(this.comp(req.comp)), log: req.ops.map((o) => o.op) };
    }
    async render(req) {
        this.calls.push(`render:${req.comp}`);
        const c = this.comp(req.comp);
        const out = uniqueOutputPath(resolve(req.outPath));
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, 'mock render', { flag: 'wx' });
        const frames = (req.endFrame ?? c.durationFrames - 1) - (req.startFrame ?? 0) + 1;
        return { path: out, frames, elapsedMs: 0, usedFallback: false, log: 'mock' };
    }
    async previewFrame(_aep, comp, frame, outPng) {
        this.calls.push(`previewFrame:${comp}:${frame}`);
        const c = this.comp(comp);
        if (!Number.isInteger(frame) || frame < 0 || frame >= c.durationFrames)
            throw new Error(`frame ${frame} is past the end of ${comp} (${c.durationFrames} frames)`);
        const out = uniqueOutputPath(resolve(outPng));
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, Buffer.from(PNG_1X1, 'base64'), { flag: 'wx' });
        return out;
    }
    async version() { return this.ver; }
    async scanTemplate(aep) {
        this.calls.push('scanTemplate');
        const warnings = [];
        return { aep: resolve(aep), comps: this.comps.map((c) => scanMockComp(c, warnings)), warnings };
    }
    async lintComp(_aep, comp, rules) {
        this.calls.push(`lintComp:${comp}`);
        return lintMockComp(this.comp(comp), rules);
    }
    async listFontsDetailed() {
        this.calls.push('listFonts');
        const fonts = new Set(), families = new Set();
        for (const c of this.comps)
            for (const l of c.layers)
                if (l.kind === 'text') {
                    if (l.font)
                        fonts.add(l.font);
                    if (l.fontFamily)
                        families.add(l.fontFamily);
                }
        return { fonts: [...fonts], families: [...families], aeMissing: this.aeMissingFonts };
    }
    async listFonts() { return (await this.listFontsDetailed()).fonts; }
    async purgeCaches() { this.calls.push('purgeCaches'); this.purged++; }
}
//# sourceMappingURL=ae.js.map