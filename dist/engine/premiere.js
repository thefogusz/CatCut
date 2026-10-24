/**
 * Premiere Pro handoff over the CatCut bridge (premiere/catcut-bridge, a CEP extension that starts
 * by itself inside Premiere): no computer use, no panel clicks. Premiere has no headless mode, so it
 * runs while CatCut talks to it; CatCut opens it with the right project (`openPremiere`) and says
 * when it may be closed. The user session (Windows or macOS) must stay logged in; the screen may be off or locked.
 *
 * Queue protocol 1 (see premiere/catcut-bridge/bridge-core.js) in an ASCII temp folder:
 * CatCut writes <id>.req.json, the bridge answers <id>.res.json and keeps bridge.json fresh (also
 * while Premiere is busy, naming the request in `busy`). XML files Premiere reads or writes are
 * staged in that folder, so Thai paths never reach Premiere's XML import/export.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ACTIONS, UserActionError } from '../core/user-action.js';
import { isBundleProcess, listPosixProcesses, localAppDataDir } from '../core/platform.js';
import { isAscii } from './aerender.js';
export const BRIDGE_ID = 'com.catcut.bridge';
const PROTOCOL = 1;
/** A request Premiere has been working on this long is most likely waiting behind a dialog. */
const DIALOG_AFTER_MS = 45_000;
/** Where bridges before 0.3 kept the queue (cleanup tools empty TEMP, which dropped the bridge). */
export function legacyQueueDir() {
    return join(os.tmpdir(), 'catcut-premiere-bridge');
}
/**
 * %LOCALAPPDATA%\CatCut\bridge (~/Library/Application Support/CatCut/bridge on macOS; same rule as the
 * bridge's index.html); TEMP only when that path is not ASCII.
 */
export function defaultQueueDir() {
    const env = process.env['CATCUT_PREMIERE_BRIDGE_DIR'];
    if (env)
        return env;
    const local = process.platform === 'win32' ? process.env['LOCALAPPDATA'] : localAppDataDir();
    return local && isAscii(local) ? join(local, 'CatCut', 'bridge') : legacyQueueDir();
}
/** Per-user CEP extensions folder: %APPDATA%\Adobe\CEP\extensions or ~/Library/Application Support/Adobe/CEP/extensions. */
export function cepExtensionsDir() {
    if (process.platform === 'darwin')
        return join(localAppDataDir(), 'Adobe', 'CEP', 'extensions');
    return join(process.env['APPDATA'] ?? join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions');
}
export function createPremiereClient(opts = {}) {
    // an explicit folder is the only one; by default an older bridge still answering in TEMP is used too
    const dirs = opts.queueDir ? [opts.queueDir] : [...new Set([defaultQueueDir(), legacyQueueDir()])];
    let queueDir = dirs[0];
    const staleMs = opts.staleMs ?? 10_000;
    const pollMs = opts.pollMs ?? 100;
    const installDir = opts.installDir ?? join(cepExtensionsDir(), BRIDGE_ID);
    let chain = Promise.resolve();
    async function beatIn(dir) {
        try {
            const hb = JSON.parse((await readFile(join(dir, 'bridge.json'), 'utf8')).replace(/^﻿/, ''));
            return hb && typeof hb.ts === 'number' ? hb : undefined;
        }
        catch {
            return undefined;
        }
    }
    async function status() {
        // the freshest heartbeat decides which folder this client talks to
        let hb;
        for (const d of dirs) {
            const b = await beatIn(d);
            if (b && (!hb || (b.ts ?? 0) > (hb.ts ?? 0))) {
                hb = b;
                queueDir = d;
            }
        }
        const base = { installed: existsSync(join(installDir, 'CSXS', 'manifest.xml')), installDir, connected: false, queueDir };
        if (!hb)
            return base;
        const age = Date.now() - hb.ts;
        return {
            ...base, connected: age < staleMs && hb.protocol === PROTOCOL, heartbeatAgeMs: Math.max(0, age),
            ...(hb.premiere ? { premiere: hb.premiere } : {}), ...(hb.bridge ? { bridge: hb.bridge } : {}), project: hb.project ?? null,
            busy: hb.busy && typeof hb.busy.since === 'number' ? { action: String(hb.busy.action ?? '?'), seconds: Math.max(0, Math.round((Date.now() - hb.busy.since) / 1000)) } : null,
        };
    }
    async function callOnce(action, args, timeoutMs) {
        const st = await status();
        if (!st.connected) {
            if (!st.installed)
                throw new UserActionError('Premiere bridge is not installed', ACTIONS.bridgeNotInstalled());
            throw new Error('Premiere is not connected: call premiere_open {project} (CatCut opens Premiere itself), or ready_check to see why / Premiere ยังไม่เชื่อม');
        }
        if (st.busy && st.busy.seconds * 1000 >= DIALOG_AFTER_MS) {
            throw new UserActionError(`Premiere is still busy with '${st.busy.action}' (${st.busy.seconds} s)`, ACTIONS.premiereDialog({ action: st.busy.action, seconds: st.busy.seconds }));
        }
        // time-ordered ids keep the bridge's queue FIFO
        const id = `${Date.now().toString(36).padStart(9, '0')}-${randomUUID().slice(0, 8)}`;
        const req = join(queueDir, `${id}.req.json`);
        const res = join(queueDir, `${id}.res.json`);
        await mkdir(queueDir, { recursive: true });
        await writeFile(`${req}.tmp`, JSON.stringify({ id, action, args, deadline: Date.now() + timeoutMs }), 'utf8');
        await rename(`${req}.tmp`, req);
        const until = Date.now() + timeoutMs;
        for (;;) {
            let raw;
            try {
                raw = await readFile(res, 'utf8');
            }
            catch { /* not yet */ }
            if (raw !== undefined) {
                await unlink(res).catch(() => undefined);
                const r = JSON.parse(raw.replace(/^﻿/, ''));
                // an older bridge without this action: keep working, say exactly what needs the update
                if (r.ok !== true && /^unknown action: /.test(r.error ?? '')) {
                    throw new UserActionError(`Premiere: ${r.error} (bridge ${st.bridge ?? 'old'})`, ACTIONS.bridgeUpdate({ installed: st.bridge ?? 'เก่า', wanted: `ใหม่กว่า (ต้องใช้คำสั่ง ${action})` }));
                }
                if (r.ok !== true)
                    throw new Error(`Premiere: ${r.error ?? 'request failed'}`);
                return r.data;
            }
            if (Date.now() > until) {
                // still unclaimed: withdraw it so a late Premiere never runs a stale request
                const withdrawn = await unlink(req).then(() => true, () => false);
                const now = await status();
                if (now.busy && now.busy.seconds * 1000 >= DIALOG_AFTER_MS) {
                    throw new UserActionError(`Premiere has been busy with '${now.busy.action}' for ${now.busy.seconds} s`, ACTIONS.premiereDialog({ action: now.busy.action, seconds: now.busy.seconds }));
                }
                throw new Error(withdrawn
                    ? `Premiere did not pick up '${action}' within ${Math.round(timeoutMs / 1000)} s`
                    : `Premiere is still working on '${action}' after ${Math.round(timeoutMs / 1000)} s; check Premiere before retrying`);
            }
            await new Promise((r) => setTimeout(r, pollMs));
        }
    }
    return {
        get queueDir() { return queueDir; },
        installDir,
        status,
        // one request at a time from this process
        call: (action, args = {}, o = {}) => {
            const run = chain.then(() => callOnce(action, args, o.timeoutMs ?? 120_000));
            chain = run.catch(() => undefined);
            return run;
        },
    };
}
/** A unique ASCII file in the queue folder for Premiere to read or write. */
export async function stagePath(client, ext) {
    if (!isAscii(client.queueDir))
        throw new Error(`Premiere bridge folder must be an ASCII path: ${client.queueDir} (set TEMP/TMP to an ASCII folder)`);
    const dir = join(client.queueDir, 'files');
    await mkdir(dir, { recursive: true });
    return join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${ext}`);
}
export function premiereHost(spawn = execa) {
    return {
        async running() {
            if (process.platform !== 'win32') {
                return (await listPosixProcesses()).filter((p) => isBundleProcess(p.command, /^Adobe Premiere Pro\b/i)).map((p) => p.pid);
            }
            const r = await spawn('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq Adobe Premiere Pro.exe'], { reject: false, windowsHide: true, timeout: 15_000 });
            return String(r.stdout ?? '').split(/\r?\n/).map((l) => /^"Adobe Premiere Pro\.exe","(\d+)"/i.exec(l)?.[1]).filter((x) => !!x).map(Number);
        },
        async debugModeMissing() {
            if (process.platform === 'darwin') {
                const missing = [];
                for (const v of CSXS_VERSIONS) {
                    const domain = `com.adobe.CSXS.${v}`;
                    const r = await spawn('defaults', ['read', domain, 'PlayerDebugMode'], { reject: false, timeout: 15_000 });
                    if (r.exitCode !== 0 || String(r.stdout ?? '').trim() !== '1')
                        missing.push(domain);
                }
                return missing;
            }
            if (process.platform !== 'win32')
                return [];
            const missing = [];
            for (const v of CSXS_VERSIONS) {
                const key = `HKCU\\Software\\Adobe\\CSXS.${v}`;
                const r = await spawn('reg', ['query', key, '/v', 'PlayerDebugMode'], { reject: false, windowsHide: true, timeout: 15_000 });
                if (r.exitCode !== 0 || !/PlayerDebugMode\s+REG_SZ\s+1\b/.test(String(r.stdout ?? '')))
                    missing.push(key);
            }
            return missing;
        },
        launch(exe, project) {
            // detached + unref: Premiere outlives this call and CatCut never waits on it; no shell.
            // macOS: `exe` is the .app bundle, started through LaunchServices.
            const child = /\.app\/?$/i.test(exe)
                ? nodeSpawn('open', ['-a', exe, project], { detached: true, stdio: 'ignore' })
                : nodeSpawn(exe, [project], { detached: true, stdio: 'ignore', windowsHide: false });
            child.on('error', () => undefined);
            child.unref();
            return { pid: child.pid };
        },
    };
}
async function packageVersion(dir) {
    try {
        return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
    }
    catch {
        return undefined;
    }
}
export async function diagnosePremiere(client, host, opts = {}) {
    const status = await client.status();
    const versions = { catcut: await packageVersion(opts.sourceDir ?? bridgeSourceDir()), installed: await packageVersion(client.installDir), ...(status.bridge ? { loaded: status.bridge } : {}) };
    const running = status.connected || (await host.running()).length > 0;
    const out = (o) => ({ ready: false, status, running, versions, ...o });
    if (!opts.premiereExe && !running)
        return out({ userAction: ACTIONS.premiereNotFound(), note: 'Premiere Pro not found' });
    if (!status.installed && !status.connected)
        return out({ userAction: ACTIONS.bridgeNotInstalled(), note: 'bridge not installed' });
    // an old install or an old bridge in memory: keep working, advise the update
    let advice;
    if (versions.catcut && versions.installed !== versions.catcut) {
        advice = { userAction: ACTIONS.bridgeUpdate({ installed: versions.installed ?? 'เก่า', wanted: versions.catcut }), note: `installed bridge ${versions.installed ?? '?'} is older than CatCut's ${versions.catcut}` };
    }
    else if (status.connected && versions.installed && status.bridge !== versions.installed) {
        advice = { userAction: ACTIONS.bridgeOutdated({ running: status.bridge ?? 'เก่า', wanted: versions.installed }), note: `Premiere runs bridge ${status.bridge ?? '?'}, installed ${versions.installed}` };
    }
    if (status.connected) {
        if (status.busy && status.busy.seconds * 1000 >= DIALOG_AFTER_MS) {
            return out({ userAction: ACTIONS.premiereDialog({ action: status.busy.action, seconds: status.busy.seconds }), note: `Premiere busy with ${status.busy.action} for ${status.busy.seconds} s` });
        }
        const where = `Premiere ${status.premiere ?? '?'}, project ${status.project?.name ?? 'none'}`;
        if (advice)
            return out({ ready: true, limited: true, userAction: advice.userAction, note: `connected (${where}); ${advice.note}: newer premiere_* tools need the update` });
        return out({ ready: true, note: `connected: ${where}` });
    }
    if (advice)
        return out(advice);
    const missing = await host.debugModeMissing();
    if (missing.length)
        return out({ userAction: ACTIONS.bridgeNotInstalled(), note: `PlayerDebugMode not set: ${missing.join(', ')}` });
    if (running)
        return out({ userAction: ACTIONS.bridgeNotStarted(), note: 'Premiere runs but the bridge does not answer' });
    return out({ note: 'Premiere is closed (fine: premiere_open starts it with the project)' });
}
// ---------- open Premiere with a project, wait for the bridge ----------
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
/**
 * Make `project` the active project in a connected Premiere: start Premiere with it when closed,
 * open it through the bridge when Premiere runs another one. Never closes or saves anything.
 */
export async function openPremiere(client, host, opts) {
    const project = resolve(opts.project);
    if (!/\.prproj$/i.test(project))
        throw new Error(`not a Premiere project (.prproj): ${project}`);
    if (!existsSync(project))
        throw new Error(`Premiere project not found: ${project}`);
    const waitMs = opts.waitMs ?? 240_000;
    const pollMs = opts.pollMs ?? 1000;
    let d = await diagnosePremiere(client, host, { ...(opts.premiereExe ? { premiereExe: opts.premiereExe } : {}), ...(opts.sourceDir ? { sourceDir: opts.sourceDir } : {}) });
    let launched = false;
    let pid;
    if (!d.ready && d.userAction && !['bridge-not-started', 'bridge-update', 'bridge-outdated'].includes(d.userAction.code))
        throw new UserActionError(d.note, d.userAction);
    if (!d.status.connected) {
        if (!d.running) {
            if (!opts.premiereExe)
                throw new UserActionError('Premiere Pro not found', ACTIONS.premiereNotFound());
            pid = host.launch(opts.premiereExe, project).pid;
            launched = true;
        }
        // a freshly started Premiere needs a while; a running one that never connects needs the panel
        const until = Date.now() + (launched ? waitMs : Math.min(waitMs, 30_000));
        for (;;) {
            const st = await client.status();
            if (st.connected)
                break;
            if (Date.now() > until) {
                if (launched)
                    throw new UserActionError(`Premiere started but the bridge did not connect within ${Math.round(waitMs / 1000)} s`, ACTIONS.premiereStartTimeout({ seconds: Math.round(waitMs / 1000) }));
                throw new UserActionError('Premiere runs but the bridge does not answer', ACTIONS.bridgeNotStarted());
            }
            await new Promise((r) => setTimeout(r, pollMs));
        }
        d = await diagnosePremiere(client, host, { ...(opts.premiereExe ? { premiereExe: opts.premiereExe } : {}), ...(opts.sourceDir ? { sourceDir: opts.sourceDir } : {}) });
        if (!d.ready && d.userAction)
            throw new UserActionError(d.note, d.userAction);
    }
    // Premiere opened from the command line may still be loading the project when the bridge connects;
    // after a minute it is more likely sitting on its home screen: open the project through the bridge
    const until = Date.now() + (launched ? Math.min(waitMs, 60_000) : 0);
    for (;;) {
        const st = await client.status();
        if (st.project && samePath(st.project.path, project))
            return { project: st.project, launched, openedProject: false, ...(pid !== undefined ? { pid } : {}) };
        if (Date.now() >= until)
            break;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    const r = await client.call('openProject', { path: project }, { timeoutMs: 180_000 });
    return { project: r.project, launched, openedProject: r.opened, ...(pid !== undefined ? { pid } : {}) };
}
// ---------- install (run by the user via `catcut premiere-bridge install`) ----------
export function bridgeSourceDir() {
    return fileURLToPath(new URL('../../premiere/catcut-bridge', import.meta.url));
}
/** CEP runtimes Premiere 2020 → 2026 load (CSXS.9 … CSXS.12). */
const CSXS_VERSIONS = [9, 10, 11, 12];
/** Where replaced bridges are kept (outside the CEP folder: Premiere must not load them). */
export function bridgeBackupRoot() {
    return join(localAppDataDir(), 'CatCut', 'bridge-backups');
}
/**
 * Copies the extension into the user's CEP folder (replacing an older CatCut bridge only) and sets
 * PlayerDebugMode=1 for the CEP runtimes, which lets Premiere load an unsigned extension.
 * A running Premiere picks up host.jsx changes by itself; bridge-core/index changes need one restart.
 */
export async function installBridge(opts = {}) {
    const spawn = opts.spawn ?? execa;
    const source = opts.source ?? bridgeSourceDir();
    if (!existsSync(join(source, 'CSXS', 'manifest.xml')))
        throw new Error(`bridge sources not found: ${source}`);
    const dest = join(opts.extensionsDir ?? cepExtensionsDir(), BRIDGE_ID);
    let backup;
    let userFile;
    if (existsSync(dest)) {
        // a bridge someone edited in place must not vanish: keep a full copy, carry host.user.jsx over
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backup = join(opts.backupRoot ?? bridgeBackupRoot(), `${BRIDGE_ID}-${stamp}`);
        await mkdir(dirname(backup), { recursive: true });
        await cp(dest, backup, { recursive: true, errorOnExist: true, force: false });
        if (existsSync(join(dest, 'host.user.jsx')))
            userFile = join(backup, 'host.user.jsx');
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(source, dest, { recursive: true });
    if (userFile)
        await cp(userFile, join(dest, 'host.user.jsx'));
    const keys = [];
    const mac = (opts.platform ?? process.platform) === 'darwin';
    for (const v of CSXS_VERSIONS) {
        // Windows: registry value; macOS: the com.adobe.CSXS.<v> user defaults domain
        const key = mac ? `com.adobe.CSXS.${v}` : `HKCU\\Software\\Adobe\\CSXS.${v}`;
        const r = mac
            ? await spawn('defaults', ['write', key, 'PlayerDebugMode', '1'], { reject: false, timeout: 15_000 })
            : await spawn('reg', ['add', key, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], { reject: false, windowsHide: true, timeout: 15_000 });
        if (r.exitCode !== 0)
            throw new Error(`could not set ${key} PlayerDebugMode: ${String(r.stderr ?? '').trim()}`);
        keys.push(key);
    }
    return { installedTo: dest, debugModeKeys: keys, ...(backup ? { backup } : {}), keptUserActions: !!userFile };
}
/** Removes the extension folder (PlayerDebugMode stays: other unsigned extensions may need it). */
export async function uninstallBridge(opts = {}) {
    const dest = join(opts.extensionsDir ?? cepExtensionsDir(), BRIDGE_ID);
    await rm(dest, { recursive: true, force: true });
    return dest;
}
//# sourceMappingURL=premiere.js.map