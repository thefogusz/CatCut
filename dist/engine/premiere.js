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
/** After this long on one request, look whether a dialog holds Premiere (or it is just rendering). */
const DIALOG_AFTER_MS = 45_000;
/** How often a long wait looks for a dialog again. */
const PROBE_EVERY_MS = 10_000;
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
/**
 * Why Premiere has been busy so long: a modal dialog waits for the person, or Premiere is working
 * (rendering After Effects comps through Dynamic Link takes minutes and needs no click).
 * 'unknown' when the windows cannot be read (no host, not Windows, probe failed).
 */
async function busyCause(host) {
    if (!host?.windows)
        return { cause: 'unknown', dialogs: [] };
    const pids = await host.running().catch(() => []);
    if (!pids.length)
        return { cause: 'unknown', dialogs: [] };
    const w = await host.windows(pids).catch(() => undefined);
    if (!w)
        return { cause: 'unknown', dialogs: [] };
    return w.modal ? { cause: 'dialog', dialogs: w.dialogs, hung: w.hung } : { cause: 'working', dialogs: [], hung: w.hung };
}
/** Plain error (no card) for a Premiere that is working, not waiting: nothing for the person to click. */
function stillWorking(action, seconds, hung) {
    return new Error(`Premiere ยังทำคำสั่ง ${action} อยู่ (${seconds} วินาที) ไม่มีหน้าต่างค้าง — มักเป็นการเรนเดอร์คอมป์ AE ผ่าน Dynamic Link ไม่ต้องให้ผู้ใช้กดอะไร รอแล้วเรียกใหม่ (premiere_status ดูความคืบหน้า)`
        + ` / Premiere is still working on '${action}' (${seconds} s) with no dialog open${hung ? ' (Windows shows it as not responding)' : ''}: probably rendering After Effects comps through Dynamic Link; wait and call again`);
}
export function createPremiereClient(opts = {}) {
    // an explicit folder is the only one; by default an older bridge still answering in TEMP is used too
    const dirs = opts.queueDir ? [opts.queueDir] : [...new Set([defaultQueueDir(), legacyQueueDir()])];
    let queueDir = dirs[0];
    const staleMs = opts.staleMs ?? 10_000;
    const pollMs = opts.pollMs ?? 100;
    const installDir = opts.installDir ?? join(cepExtensionsDir(), BRIDGE_ID);
    let chain = Promise.resolve();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    /** The dialog card (also when the cause cannot be read: the person looks once). */
    function dialogCard(busy, b) {
        return new UserActionError(`Premiere has been busy with '${busy.action}' for ${busy.seconds} s${b.dialogs.length ? ` behind "${b.dialogs.join('", "')}"` : ''}`, ACTIONS.premiereDialog({ action: busy.action, seconds: busy.seconds, ...(b.dialogs.length ? { dialogs: b.dialogs.join('", "') } : {}) }));
    }
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
        let st = await status();
        if (!st.connected) {
            if (!st.installed)
                throw new UserActionError('Premiere bridge is not installed', ACTIONS.bridgeNotInstalled());
            throw new Error('Premiere is not connected: call premiere_open {project} (CatCut opens Premiere itself), or ready_check to see why / Premiere ยังไม่เชื่อม');
        }
        const until = Date.now() + timeoutMs;
        // an earlier request still running: a dialog gets the card; Premiere working gets waited for
        for (let probedAt = 0; st.busy && st.busy.seconds * 1000 >= DIALOG_AFTER_MS;) {
            if (Date.now() - probedAt >= PROBE_EVERY_MS) {
                probedAt = Date.now();
                const b = await busyCause(opts.host);
                if (b.cause !== 'working')
                    throw dialogCard(st.busy, b);
            }
            if (Date.now() > until)
                throw stillWorking(st.busy.action, st.busy.seconds);
            await sleep(pollMs);
            st = await status();
            if (!st.connected)
                throw new Error(`Premiere stopped answering while busy with '${st.busy?.action ?? '?'}' / Premiere หยุดตอบ: ready_check`);
        }
        // time-ordered ids keep the bridge's queue FIFO
        const id = `${Date.now().toString(36).padStart(9, '0')}-${randomUUID().slice(0, 8)}`;
        const req = join(queueDir, `${id}.req.json`);
        const res = join(queueDir, `${id}.res.json`);
        await mkdir(queueDir, { recursive: true });
        await writeFile(`${req}.tmp`, JSON.stringify({ id, action, args, deadline: Date.now() + timeoutMs }), 'utf8');
        await rename(`${req}.tmp`, req);
        let probedAt = Date.now();
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
                    const b = await busyCause(opts.host);
                    throw b.cause === 'working' ? stillWorking(now.busy.action, now.busy.seconds, b.hung) : dialogCard(now.busy, b);
                }
                throw new Error(withdrawn
                    ? `Premiere did not pick up '${action}' within ${Math.round(timeoutMs / 1000)} s`
                    : `Premiere is still working on '${action}' after ${Math.round(timeoutMs / 1000)} s; check Premiere before retrying`);
            }
            // a dialog that comes up while this request runs is reported now, not at the timeout
            if (opts.host?.windows && Date.now() - probedAt >= PROBE_EVERY_MS) {
                probedAt = Date.now();
                const now = await status();
                if (now.busy && now.busy.seconds * 1000 >= DIALOG_AFTER_MS) {
                    const b = await busyCause(opts.host);
                    if (b.cause === 'dialog')
                        throw dialogCard(now.busy, b);
                }
            }
            await sleep(pollMs);
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
// Win32 window helpers for PowerShell's Add-Type (C# 5): no input is simulated, nothing is clicked.
const WIN_HELPER = `
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class CatCutWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  static List<IntPtr> Of(uint[] pids) {
    var all = new List<IntPtr>(); var set = new HashSet<uint>(pids);
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h)) all.Add(h); return true; }, IntPtr.Zero);
    return all;
  }
  static bool Owned(IntPtr h) { return GetWindow(h, 4) != IntPtr.Zero; }
  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString().Replace('\\t', ' ').Replace('\\r', ' ').Replace('\\n', ' '); }
  public static string Probe(uint[] pids) {
    bool modal = false, hung = false; var dialogs = new List<string>();
    foreach (var h in Of(pids)) {
      if (!Owned(h)) { if (!IsWindowEnabled(h)) modal = true; if (IsHungAppWindow(h)) hung = true; }
      else if (IsWindowEnabled(h)) { var t = Title(h); if (t.Length > 0) dialogs.Add(t); }
    }
    var sb = new StringBuilder();
    if (modal) { sb.Append("MODAL\\n"); foreach (var d in dialogs) sb.Append("DIALOG\\t" + d + "\\n"); }
    if (hung) sb.Append("HUNG\\n");
    sb.Append("END\\n");
    return sb.ToString();
  }
  public static string Activate(uint[] pids) {
    foreach (var h in Of(pids)) {
      if (Owned(h) || Title(h).Length == 0) continue;
      if (IsIconic(h)) ShowWindow(h, 9);
      if (!SetForegroundWindow(h) || GetForegroundWindow() != h) SwitchToThisWindow(h, true);
      return GetForegroundWindow() == h ? "ACTIVE" : "TRIED";
    }
    return "NOWINDOW";
  }
}`;
/** PowerShell command for one CatCutWin call; pids are integers, so nothing user-supplied reaches the script. */
export function winHelperScript(method, pids) {
    const ids = pids.filter((p) => Number.isInteger(p) && p > 0).join(',');
    return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -TypeDefinition @'\n${WIN_HELPER}\n'@\n[CatCutWin]::${method}([uint32[]]@(${ids}))`;
}
/** Parse CatCutWin.Probe output; undefined when the probe did not finish. */
export function parseWindowProbe(stdout) {
    const lines = stdout.split(/\r?\n/);
    if (!lines.includes('END'))
        return undefined;
    return { modal: lines.includes('MODAL'), hung: lines.includes('HUNG'), dialogs: lines.filter((l) => l.startsWith('DIALOG\t')).map((l) => l.slice(7).trim()).filter(Boolean) };
}
export function premiereHost(spawn = execa) {
    const ps = (method, pids) => spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(winHelperScript(method, pids), 'utf16le').toString('base64'),
    ], { reject: false, windowsHide: true, timeout: 30_000 });
    return {
        async windows(pids) {
            if (process.platform !== 'win32' || !pids.length)
                return undefined;
            const r = await ps('Probe', pids);
            return r.exitCode === 0 ? parseWindowProbe(String(r.stdout ?? '')) : undefined;
        },
        async activate(pids) {
            if (process.platform !== 'win32' || !pids.length)
                return undefined;
            const r = await ps('Activate', pids);
            const out = String(r.stdout ?? '').trim();
            return out === 'ACTIVE' ? 'active' : out === 'TRIED' ? 'tried' : out === 'NOWINDOW' ? 'no-window' : undefined;
        },
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
            const b = await busyCause(host);
            if (b.cause === 'working') {
                return out({ ready: true, busy: true, note: `Premiere is working on ${status.busy.action} for ${status.busy.seconds} s, no dialog open (probably rendering After Effects comps): wait, nothing to click` });
            }
            return out({
                userAction: ACTIONS.premiereDialog({ action: status.busy.action, seconds: status.busy.seconds, ...(b.dialogs.length ? { dialogs: b.dialogs.join('", "') } : {}) }),
                note: `Premiere busy with ${status.busy.action} for ${status.busy.seconds} s${b.cause === 'dialog' ? ` behind a dialog${b.dialogs.length ? ` ("${b.dialogs.join('", "')}")` : ''}` : ''}`,
            });
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
/** A launched Premiere without a bridge this long is brought to the front (it shows its window by ~20 s). */
const ACTIVATE_AFTER_MS = 20_000;
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
        // a freshly started Premiere needs a while; a running one that never connects needs the panel.
        // CEP starts the hidden bridge on ApplicationActivate, which never fires while Premiere sits
        // behind other windows: bring it to the front (at most twice) before asking the person.
        const started = Date.now();
        const until = started + (launched ? waitMs : Math.min(waitMs, 30_000));
        const after = opts.activateAfterMs ?? ACTIVATE_AFTER_MS;
        const activateAt = launched ? [after, after * 3] : [0, after];
        let activations = 0;
        for (;;) {
            const st = await client.status();
            if (st.connected)
                break;
            if (host.activate && activations < activateAt.length && Date.now() - started >= activateAt[activations]) {
                activations++;
                const pids = await host.running().catch(() => []);
                if (pids.length)
                    await host.activate(pids).catch(() => undefined);
            }
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