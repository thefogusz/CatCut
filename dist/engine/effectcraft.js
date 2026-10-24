/**
 * EffectCraft (ArtCraft) motion backend: the AeBackend contract over `effectcraft-cli`, for comps
 * that live in a `.ecproj`. createMotionBackend() routes by file: `.ecproj` here, everything else
 * to After Effects, so build / fingerprint / render / ae_* tools need no EffectCraft branches.
 *
 * - list, timing and fingerprints read the `.ecproj` JSON directly (no process launched).
 * - inspect / edit / create run jsx/ec-runner.jsx through `effectcraft-cli script`.
 * - render / preview use `effectcraft-cli render` / `render-frame` into an ASCII temp folder, then move:
 *   the CLI overwrites silently, CatCut never does.
 * `render --comp` takes a name (unique, checked here) and `render-frame --comp` an item id (0.8.0 CLI).
 * Range bounds are passed half a frame wide: the CLI renders frames whose time is in [start, end)
 * and snaps to frame times, so ±0.5 frame is immune to float rounding at 23.976 / 29.97.
 */
import { execa } from 'execa';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hashFile, hashJson } from '../core/hash.js';
import { isAscii, killTree, moveFile, uniqueOutputPath } from './aerender.js';
import { freeRamBytes } from '../core/platform.js';
/** EffectCraft / FilmCraft time unit: divides evenly by every common frame and sample rate. */
const TICKS_PER_SECOND = 254_016_000_000;
const MARK = '@@CATCUT@@';
export const isEcProject = (path) => extname(path).toLowerCase() === '.ecproj';
async function readProject(ecproj) {
    let raw;
    try {
        raw = await readFile(ecproj, 'utf8');
    }
    catch {
        throw new Error(`project not found: ${ecproj}`);
    }
    try {
        return JSON.parse(raw.replace(/^﻿/, ''));
    }
    catch (e) {
        throw new Error(`not an EffectCraft project (${ecproj}): ${e.message}`);
    }
}
const compsOf = (j) => Object.values(j.items ?? {}).filter((it) => it.kind?.type === 'Comp');
function fpsOf(c) {
    const r = c.kind?.frame_rate;
    return r && r.num > 0 && r.den > 0 ? r.num / r.den : 25;
}
function compInfo(c) {
    const fps = fpsOf(c);
    return {
        id: c.id, name: c.name, width: c.kind?.width ?? 0, height: c.kind?.height ?? 0, fps: Math.round(fps * 1000) / 1000,
        durationFrames: Math.round(((c.kind?.duration ?? 0) * fps) / TICKS_PER_SECOND), numLayers: c.kind?.layers?.length ?? 0,
    };
}
function findComp(j, name) {
    const hits = compsOf(j).filter((c) => c.name === name);
    if (hits.length === 0)
        throw new Error(`comp not found: ${name}`);
    if (hits.length > 1)
        throw new Error(`ambiguous comp name: ${name}`);
    return hits[0];
}
/**
 * Comp fingerprint: the comp, every item it reaches through layer sources and comp("…") expression
 * references (precomps, solids, footage), project render settings, and the content hash of each
 * footage file. Labels/UI state of unrelated items never invalidate a render.
 */
async function fingerprintComp(j, comp) {
    const items = j.items ?? {};
    const byName = new Map();
    for (const it of Object.values(items))
        byName.set(it.name, [...(byName.get(it.name) ?? []), it]);
    const seen = new Map();
    const visit = (it) => {
        if (!it || seen.has(it.id))
            return;
        seen.set(it.id, it);
        for (const l of it.kind?.layers ?? [])
            if (typeof l.source?.item === 'number')
                visit(items[String(l.source.item)]);
        // expressions are JSON strings here, so comp("X") appears as comp(\"X\")
        for (const m of JSON.stringify(it.kind ?? {}).matchAll(/comp\(\s*(?:\\"|')([^"'\\]+)(?:\\"|')\s*\)/g))
            for (const ref of byName.get(m[1] ?? '') ?? [])
                visit(ref);
    };
    visit(comp);
    const media = {};
    for (const it of seen.values()) {
        const p = it.kind?.path;
        if (typeof p === 'string' && !(p in media))
            media[p] = await hashFile(p).catch(() => 'missing');
    }
    const closure = [...seen.values()].sort((a, b) => a.id - b.id);
    return hashJson({ host: 'effectcraft', settings: j.settings ?? null, closure, media });
}
// One EffectCraft process at a time (independent of the After Effects queue).
let queue = Promise.resolve();
function serial(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
}
export function createEffectCraftBackend(tools, opts = {}) {
    const spawn = opts.spawn ?? execa;
    const runnerPath = fileURLToPath(new URL('../../jsx/ec-runner.jsx', import.meta.url));
    const shortTimeout = opts.timeoutMs ?? 120_000;
    const scriptTimeout = opts.scriptTimeoutMs ?? Math.max(shortTimeout, 600_000);
    async function cli(args, timeoutMs, what, signal) {
        const exe = tools.effectcraftCli;
        if (!exe)
            throw new Error('effectcraft-cli not found; install EffectCraft or set EDITMCP_EFFECTCRAFT_DIR');
        const minRam = opts.minFreeRamGb ?? 0.75;
        if (freeRamBytes() / 2 ** 30 < minRam)
            throw new Error(`not enough free RAM for EffectCraft (need ${minRam} GB)`);
        if (signal?.aborted)
            throw new Error('aborted');
        const child = spawn(exe, args, { reject: false, windowsHide: true, timeout: 0, stdin: 'ignore' });
        let timedOut = false;
        const kill = () => { void killTree(child.pid, spawn, child); };
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        signal?.addEventListener('abort', kill, { once: true });
        let out;
        try {
            out = await child;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', kill);
        }
        if (timedOut)
            throw new Error(`EffectCraft ${what} timed out after ${timeoutMs} ms (process tree killed)`);
        if (signal?.aborted)
            throw new Error('aborted');
        const stdout = String(out.stdout ?? '');
        if (out.exitCode !== 0)
            throw new Error(`EffectCraft ${what} failed (${out.exitCode}): ${(String(out.stderr ?? '') || stdout).trim().slice(-2000)}`);
        return stdout;
    }
    async function tempDir(prefix) {
        const root = os.tmpdir();
        if (!isAscii(root))
            throw new Error('EffectCraft renders go through an ASCII TEMP directory; set TEMP/TMP to an ASCII path');
        return mkdtemp(join(root, prefix));
    }
    /** Run ec-runner.jsx with a job; `project` is opened first, `save` writes it back (or saveAs). */
    async function runner(job, project) {
        const dir = await tempDir('catcut-ec-');
        try {
            const launch = join(dir, 'launch.jsx');
            // The job travels as a JSON literal; U+2028/9 are line terminators in older JS engines.
            const literal = JSON.stringify(job).split(String.fromCharCode(0x2028)).join("\\u2028").split(String.fromCharCode(0x2029)).join("\\u2029");
            await writeFile(launch, `var CATCUT_JOB = ${literal};\n${await readFile(runnerPath, 'utf8')}`, 'utf8');
            const args = ['script', launch];
            if (project.open)
                args.push(project.open);
            else
                args.push('--empty');
            if (project.save)
                args.push('--save');
            if (project.saveAs)
                args.push('--save-as', project.saveAs);
            const timeout = job['action'] === 'inspect' ? shortTimeout : scriptTimeout;
            const stdout = await cli(args, timeout, String(job['action']));
            const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(MARK));
            if (!line)
                throw new Error(`EffectCraft ${String(job['action'])}: no result from the runner: ${stdout.trim().slice(-1000)}`);
            const res = JSON.parse(line.slice(MARK.length));
            if (res.ok !== true)
                throw new Error(`EffectCraft: ${res.error ?? 'job failed'}`);
            return res;
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
    async function edit(req) {
        const source = resolve(req.aep);
        const savedTo = req.saveAs ? resolve(req.saveAs) : source;
        if (req.saveAs && !isEcProject(savedTo))
            throw new Error('saveAs must be a .ecproj path');
        if (req.saveAs && savedTo.toLowerCase() === source.toLowerCase())
            throw new Error('saveAs must differ from the source; omit it for an in-place edit with backup');
        if (req.saveAs && existsSync(savedTo))
            throw new Error(`refusing to overwrite ${savedTo}`);
        const before = await hashFile(source);
        const working = join(dirname(source), `.catcut-${randomUUID()}.ecproj`);
        await copyFile(source, working, constants.COPYFILE_EXCL);
        try {
            const res = await runner({ action: 'edit', comp: req.comp, ops: req.ops }, { open: working, save: true });
            const j = await readProject(working);
            const fingerprint = await fingerprintComp(j, findComp(j, req.comp));
            const changed = 'source .ecproj changed during edit; original preserved, retry against the new version';
            if (await hashFile(source) !== before)
                throw new Error(changed);
            const log = res.log ?? [];
            if (req.saveAs) {
                await copyFile(working, savedTo, constants.COPYFILE_EXCL);
            }
            else {
                log.push('note: an EffectCraft window with this project open would overwrite this edit on its next save / ถ้าเปิดโปรเจกต์นี้ใน EffectCraft อยู่ ให้ปิดโดยไม่ save แล้วเปิดใหม่');
                const backup = uniqueOutputPath(join(dirname(source), `${basename(source, extname(source))}_backup_${Date.now()}.ecproj`));
                await copyFile(source, backup, constants.COPYFILE_EXCL);
                log.push(`backup: ${backup}`);
                if (await hashFile(source) !== before) {
                    await rm(backup, { force: true });
                    throw new Error(changed);
                }
                await rename(working, source);
            }
            return { ok: true, savedTo, fingerprint, log };
        }
        finally {
            await rm(working, { force: true });
        }
    }
    async function create(req) {
        const savedTo = resolve(req.saveAs);
        if (!isEcProject(savedTo))
            throw new Error('saveAs must be a .ecproj path');
        if (existsSync(savedTo))
            throw new Error(`refusing to overwrite ${savedTo}`);
        await mkdir(dirname(savedTo), { recursive: true }); // the CLI does not create folders for --save-as
        const working = join(dirname(savedTo), `.catcut-${randomUUID()}.ecproj`);
        try {
            const res = await runner({ action: 'create', jsx: req.jsx, ...(req.scriptDir ? { scriptDir: resolve(req.scriptDir) } : {}) }, { saveAs: working });
            if (!existsSync(working))
                throw new Error('EffectCraft did not save the new project');
            await copyFile(working, savedTo, constants.COPYFILE_EXCL);
            return { savedTo, comps: compsOf(await readProject(savedTo)).map(compInfo), log: res.log ?? [] };
        }
        finally {
            await rm(working, { force: true });
        }
    }
    async function render(req) {
        const ecproj = resolve(req.aep);
        const comp = findComp(await readProject(ecproj), req.comp);
        const { durationFrames, fps } = compInfo(comp);
        const rate = fpsOf(comp);
        if (!(durationFrames > 0))
            throw new Error(`comp has no frames: ${req.comp}`);
        const startFrame = req.startFrame ?? 0;
        const endFrame = req.endFrame ?? durationFrames - 1;
        if (startFrame < 0 || endFrame < startFrame)
            throw new Error(`bad frame range ${startFrame}..${endFrame}`);
        if (endFrame >= durationFrames)
            throw new Error(`endFrame ${endFrame} is past the end of ${req.comp} (${durationFrames} frames)`);
        const frames = endFrame - startFrame + 1;
        const dir = await tempDir('catcut-ecr-');
        const t0 = Date.now();
        try {
            const tmp = join(dir, 'render.mov');
            const sec = (f) => (Math.max(0, f) / rate).toFixed(6);
            req.onProgress?.({ stage: 'effectcraft', done: 0, total: frames, message: req.comp });
            const log = await cli(['render', '--project', ecproj, '--comp', comp.name, '--out', tmp, '--format', 'prores', '--prores', 'hq', '--audio', 'off',
                '--start', sec(startFrame - 0.5), '--end', sec(endFrame + 0.5)], Math.min(3_600_000, 300_000 + frames * 2_000), 'render', req.signal);
            if (!existsSync(tmp))
                throw new Error(`EffectCraft render wrote no file: ${log.trim().slice(-500)}`);
            const out = uniqueOutputPath(resolve(req.outPath));
            await moveFile(tmp, out);
            req.onProgress?.({ stage: 'effectcraft', done: frames, total: frames, message: req.comp });
            return { path: out, frames, elapsedMs: Date.now() - t0, usedFallback: false, log: `EffectCraft ${fps} fps ProRes 422 HQ\n${log.trim()}` };
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
    async function previewFrame(aep, comp, frame, outPng) {
        if (!Number.isInteger(frame) || frame < 0)
            throw new Error('frame must be a non-negative integer');
        const ecproj = resolve(aep);
        const c = findComp(await readProject(ecproj), comp);
        const { durationFrames } = compInfo(c);
        if (frame >= durationFrames)
            throw new Error(`frame ${frame} is past the end of ${comp} (${durationFrames} frames)`);
        const dir = await tempDir('catcut-ecp-');
        try {
            const tmp = join(dir, 'frame.png');
            await cli(['render-frame', '--project', ecproj, '--comp', String(c.id), '--frame', String(frame), '--out', tmp], shortTimeout, 'preview');
            if (!existsSync(tmp))
                throw new Error('EffectCraft preview wrote no file');
            const out = uniqueOutputPath(resolve(outPng));
            await moveFile(tmp, out);
            return out;
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
    return {
        kind: 'effectcraft',
        listComps: async (aep) => compsOf(await readProject(resolve(aep))).map(compInfo),
        inspectComp: (aep, comp, atFrame = 0) => serial(async () => {
            if (!Number.isInteger(atFrame) || atFrame < 0)
                throw new Error('atFrame must be a non-negative integer');
            const ecproj = resolve(aep);
            const { data } = await runner({ action: 'inspect', comp, atFrame }, { open: ecproj });
            const j = await readProject(ecproj);
            return { ...data, fingerprint: await fingerprintComp(j, findComp(j, comp)) };
        }),
        fingerprint: async (aep, comps) => {
            const j = await readProject(resolve(aep));
            const out = {};
            for (const c of compsOf(j)) {
                if (comps && !comps.includes(c.name))
                    continue;
                if (out[c.name] !== undefined)
                    throw new Error(`ambiguous comp name: ${c.name}`);
                out[c.name] = await fingerprintComp(j, c);
            }
            return out;
        },
        edit: (req) => serial(() => edit(req)),
        create: (req) => serial(() => create(req)),
        render: (req) => serial(() => render(req)),
        previewFrame: (aep, comp, frame, outPng) => serial(() => previewFrame(aep, comp, frame, outPng)),
        version: () => serial(async () => (await cli(['--version'], shortTimeout, 'version')).trim()),
    };
}
// ---------- router ----------
/**
 * One AeBackend over both hosts: `.ecproj` paths go to EffectCraft, all others to After Effects.
 * Optional analysis methods stay After Effects only and say so for `.ecproj`. `kind` is the After
 * Effects backend's, so existing reports do not change.
 */
export function createMotionBackend(ae, ec) {
    const pick = (path) => (isEcProject(path) ? ec : ae);
    const aeOnly = (what, path) => {
        if (isEcProject(path))
            throw new Error(`${what} is not available for EffectCraft projects yet (${basename(path)})`);
    };
    const routed = {
        kind: ae.kind,
        listComps: (aep) => pick(aep).listComps(aep),
        inspectComp: (aep, comp, atFrame) => pick(aep).inspectComp(aep, comp, atFrame),
        fingerprint: (aep, comps) => pick(aep).fingerprint(aep, comps),
        edit: (req) => pick(req.aep).edit(req),
        render: (req) => pick(req.aep).render(req),
        previewFrame: (aep, comp, frame, outPng) => pick(aep).previewFrame(aep, comp, frame, outPng),
        version: () => ae.version(),
        create: (req) => {
            const b = pick(req.saveAs);
            if (!b.create)
                throw new Error('this backend cannot create projects');
            return b.create(req);
        },
    };
    // Every other member (scanTemplate, lintComp, listFontsDetailed, fingerprintDetailed, afterRenderBatch...)
    // forwards to After Effects; members that take a project path refuse `.ecproj` explicitly.
    const out = { ...routed };
    for (const key of new Set([...Object.keys(ae), ...Object.getOwnPropertyNames(Object.getPrototypeOf(ae) ?? {})])) {
        if (key in out || key === 'constructor')
            continue;
        const v = ae[key];
        if (typeof v !== 'function')
            continue;
        out[key] = (...args) => {
            if (typeof args[0] === 'string')
                aeOnly(key, args[0]);
            return v.apply(ae, args);
        };
    }
    return out;
}
//# sourceMappingURL=effectcraft.js.map