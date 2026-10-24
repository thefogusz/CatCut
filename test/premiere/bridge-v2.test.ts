/**
 * Bridge 0.2 (DESIGN.md §14): busy-aware heartbeat, host.jsx hot reload, quit after the answer,
 * the new host actions (openProject/save/quit/importMedia/setSpeed) against a fake Premiere, the
 * "why is it not connected" diagnosis, and CatCut opening Premiere by itself. No real Premiere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { basename, join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import { UserActionError } from '../../src/core/user-action.js';
import { MockAeBackend } from '../../src/engine/ae.js';
import { BRIDGE_ID, createPremiereClient, diagnosePremiere, openPremiere, parseWindowProbe, winHelperScript, type PremiereHost, type PremiereWindows } from '../../src/engine/premiere.js';
import * as xmemlApi from '../../src/io/xmeml.js';
import { safeEnvironment, type AppState } from '../../src/mcp/state.js';
import { _binFor } from '../../src/mcp/tools-premiere.js';
import { callTool, toolResultData } from '../../src/mcp/tools.js';

const require = createRequire(import.meta.url);
const { createBridge } = require('../../premiere/catcut-bridge/bridge-core.js') as {
  createBridge: (o: Record<string, unknown>) => { start(): void; stop(): void; tick(): Promise<boolean>; heartbeat(): Promise<boolean>; state: { serving: boolean; handled: number; busy: unknown } };
};
const BRIDGE_SRC = join(process.cwd(), 'premiere', 'catcut-bridge');
const HOST = readFileSync(join(BRIDGE_SRC, 'host.jsx'), 'utf8');
const SOURCE_VERSION = (JSON.parse(readFileSync(join(BRIDGE_SRC, 'package.json'), 'utf8')) as { version: string }).version;

// ---------- a fake Premiere with media items, proxies, sequences and QE ----------

interface Item { type: number; name: string; children?: Item[]; media?: string; proxy?: string; noProxy?: boolean }
interface FakeClip { name: string; start: { seconds: number }; end: { seconds: number }; speed: number }

function fakePremiere(projectPath: string) {
  const fs = require('node:fs') as typeof import('node:fs');
  const root: Item = { type: 3, name: 'root', children: [] };
  const projects: Record<string, boolean> = {};
  const saves: string[] = [];
  let quit = 0;
  const fps = 25;
  const clips: FakeClip[] = [];
  const QE_SHIFT = { start: 0 }; // simulate QE moving the clip's head
  const wrap = (it: Item): Record<string, unknown> => {
    const o: Record<string, unknown> = {
      type: it.type, get name() { return it.name; }, set name(v: string) { it.name = v; },
      get children() { const c: Record<string, unknown> = { numItems: it.children?.length ?? 0 }; (it.children ?? []).forEach((x, i) => { c[i] = wrap(x); }); return c; },
      createBin(name: string) { it.children!.push({ type: 2, name, children: [] }); },
    };
    if (it.type === 1) {
      Object.assign(o, {
        getMediaPath: () => it.media, hasProxy: () => !!it.proxy, getProxyPath: () => it.proxy ?? '', canProxy: () => !it.noProxy,
        attachProxy: (p: string) => { it.proxy = p; return 0; },
      });
    }
    return o;
  };
  const findBin = (b: Record<string, unknown>): Item => {
    const walk = (x: Item): Item | undefined => (x.type !== 1 && x.name === b['name'] ? x : (x.children ?? []).map(walk).find(Boolean));
    return walk(root)!;
  };
  const seq = {
    name: 'Cut', sequenceID: 'seq-1',
    getSettings: () => ({ videoFrameRate: { seconds: 1 / fps }, videoDisplayFormat: 101 }),
    get videoTracks() {
      const t = {
        get clips() {
          const c: Record<string, unknown> = { numItems: clips.length };
          clips.forEach((x, i) => {
            c[i] = {
              get name() { return x.name; }, get start() { return x.start; }, set start(v: { seconds: number }) { x.start = { seconds: v.seconds }; },
              get end() { return x.end; }, set end(v: { seconds: number }) { x.end = { seconds: v.seconds }; }, getSpeed: () => x.speed,
              inPoint: { seconds: 0 }, outPoint: { seconds: 0 }, components: { numItems: 0 }, projectItem: null,
            };
          });
          return c;
        },
      };
      return { 0: t, numTracks: 1 };
    },
  };
  const interp: number[] = [];
  const project = {
    get name() { return basename(app.project_path.replace(/\\/g, '/')); },
    get path() { return app.project_path; },
    rootItem: wrap(root),
    activeSequence: seq,
    sequences: { numSequences: 1, 0: seq },
    importFiles(paths: string[], _s: boolean, bin: Record<string, unknown>) { const b = findBin(bin); for (const p of paths) b.children!.push({ type: 1, name: basename(p), media: p }); return true; },
    openSequence() { return true; },
    save() { saves.push(app.project_path); return 0; },
  };
  const app = {
    version: '26.0.0', project_path: projectPath,
    get project() { return app.project_path ? project : null; },
    openDocument(p: string) { if (!fs.existsSync(p)) return false; projects[p] = true; app.project_path = p; return true; },
    setEnableProxies: vi.fn(), getEnableProxies: () => 1, enableQE: () => undefined,
    quit: () => { quit++; },
  };
  const qe = {
    project: {
      getActiveSequence: () => ({
        getVideoTrackAt: () => {
          // a gap first, then the clips: QE lists empties too
          const items = [{ type: 'Empty', name: '' }, ...clips.map((x) => ({
            type: 'Clip', name: x.name,
            setSpeed: (s: number) => { const len = x.end.seconds - x.start.seconds; x.speed = s; x.start = { seconds: x.start.seconds + QE_SHIFT.start }; x.end = { seconds: x.start.seconds + len }; },
            setTimeInterpolationType: (n: number) => { interp.push(n); },
          }))];
          return { numItems: items.length, getItemAt: (i: number) => items[i] };
        },
      }),
    },
  };
  function Time(this: { seconds: number }) { this.seconds = 0; }
  Time.prototype.getFormatted = function () { return '00:00:01:00'; };
  function File(this: { exists: boolean; fsName: string }, p: string) { this.exists = fs.existsSync(p); this.fsName = p; }
  const ctx = vm.createContext({ app, qe, Time, File, $: { evalFile: () => undefined } });
  vm.runInContext(HOST, ctx);
  const dispatch = (job: unknown) => JSON.parse(String(vm.runInContext(`catcut_dispatch(${JSON.stringify(job)})`, ctx))) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  const evalScript = vi.fn(async (script: string) => String(vm.runInContext(script.replace(/^\$\.evalFile\([^;]*\);/, ''), ctx)));
  return { app, root, saves, clips, interp, QE_SHIFT, dispatch, evalScript, quits: () => quit, projects };
}

const tmps: string[] = [];
async function tmp(): Promise<string> { const d = await mkdtemp(join(os.tmpdir(), 'catcut-b2-')); tmps.push(d); return d; }
const pumps: NodeJS.Timeout[] = [];
afterEach(() => { pumps.splice(0).forEach(clearInterval); });

describe('host.jsx 0.2 actions', () => {
  it('openProject opens another .prproj, refuses a missing one, and is a no-op for the active one', async () => {
    const d = await tmp();
    const a = join(d, 'A.prproj'); const b = join(d, 'งาน B.prproj');
    await writeFile(a, ''); await writeFile(b, '');
    const prem = fakePremiere(a);
    expect(prem.dispatch({ action: 'openProject', args: { path: a } }).data).toMatchObject({ opened: false });
    expect(prem.dispatch({ action: 'openProject', args: { path: b } }).data).toMatchObject({ opened: true, project: { path: b } });
    expect(prem.dispatch({ action: 'openProject', args: { path: join(d, 'missing.prproj') } })).toMatchObject({ ok: false, error: expect.stringMatching(/project not found/) });
  });

  it('save and quit only touch the expected project; quit answers quitting:true after saving', async () => {
    const d = await tmp();
    const a = join(d, 'A.prproj'); await writeFile(a, '');
    const prem = fakePremiere(a);
    expect(prem.dispatch({ action: 'save', args: { expectProject: join(d, 'B.prproj') } })).toMatchObject({ ok: false, error: expect.stringMatching(/nothing changed/) });
    expect(prem.saves).toEqual([]);
    expect(prem.dispatch({ action: 'quit', args: { expectProject: a } }).data).toMatchObject({ saved: true, quitting: true });
    expect(prem.saves).toEqual([a]);
    expect(prem.quits()).toBe(0); // the bridge quits, after writing the answer
  });

  it('importMedia: originals into nested bins, proxies attached, a second run resumes without duplicates', async () => {
    const d = await tmp();
    const a = join(d, 'A.prproj'); await writeFile(a, '');
    const src1 = join(d, 'C0001.MP4'); const src2 = join(d, 'C0002.MP4'); const px1 = join(d, 'C0001_Proxy.mp4');
    for (const f of [src1, src2, px1]) await writeFile(f, 'x');
    const prem = fakePremiere(a);
    const items = [{ source: src1, proxy: px1, bin: 'FOOTAGE/CARD 1' }, { source: src2, bin: 'FOOTAGE/CARD 1' }, { source: join(d, 'gone.MP4'), bin: 'X' }];
    const r1 = prem.dispatch({ action: 'importMedia', args: { expectProject: a, items, enableProxies: true } });
    expect(r1.ok).toBe(true);
    expect(r1.data!['items']).toEqual([
      { source: join(d, 'gone.MP4'), error: 'source not found' },
      { source: src1, bin: 'FOOTAGE/CARD 1', name: 'C0001.MP4', imported: true, proxy: 'attached' },
      { source: src2, bin: 'FOOTAGE/CARD 1', name: 'C0002.MP4', imported: true, proxy: 'none' },
    ]);
    const card = prem.root.children![0]!.children![0]!;
    expect([prem.root.children![0]!.name, card.name, card.children!.map((c) => c.name)]).toEqual(['FOOTAGE', 'CARD 1', ['C0001.MP4', 'C0002.MP4']]);
    const r2 = prem.dispatch({ action: 'importMedia', args: { expectProject: a, items: items.slice(0, 2) } });
    expect((r2.data!['items'] as Array<{ proxy: string }>).map((x) => x.proxy)).toEqual(['already', 'none']);
    expect(card.children).toHaveLength(2);
  });

  it('setSpeed: native speed + optical flow on the clip at a frame or timecode; the clip keeps its place', async () => {
    const d = await tmp();
    const a = join(d, 'A.prproj'); await writeFile(a, '');
    const prem = fakePremiere(a);
    prem.clips.push({ name: 'C0001.MP4', start: { seconds: 0 }, end: { seconds: 4 }, speed: 1 }, { name: 'C0002.MP4', start: { seconds: 4 }, end: { seconds: 6 }, speed: 1 });
    prem.QE_SHIFT.start = 0.4; // QE moves the head: the bridge must put it back
    const r = prem.dispatch({ action: 'setSpeed', args: { expectProject: a, clips: [{ at: 110, speed: 0.6, interpolation: 'optical-flow' }, { at: '00:00:01:00', speed: 0.5 }] } });
    expect(r.ok).toBe(true);
    expect(r.data!['clips']).toEqual([
      { name: 'C0002.MP4', at: 110, start: 100, end: 150, speed: 0.6, interpolation: 'optical-flow' },
      { name: 'C0001.MP4', at: 25, start: 0, end: 100, speed: 0.5, interpolation: 'optical-flow' },
    ]);
    expect(prem.interp).toEqual([2, 2]);
    expect(prem.dispatch({ action: 'setSpeed', args: { expectProject: a, clips: [{ at: 999, speed: 0.6 }] } })).toMatchObject({ ok: false, error: expect.stringMatching(/no clip on V1 at 999/) });
  });

  it('stays ES3', () => {
    const code = HOST.replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/=>|\blet\b|\bconst\b|`|\.indexOf\(/);
  });
});

describe('bridge-core 0.2', () => {
  it('keeps beating while Premiere works on a request and names it in busy; never pings into a busy Premiere', async () => {
    const dir = await tmp();
    let release: (v: string) => void = () => undefined;
    const evalScript = vi.fn((script: string) => script.includes('"ping"')
      ? Promise.resolve(JSON.stringify({ ok: true, data: { premiere: '26', project: null } }))
      : new Promise<string>((r) => { release = r; }));
    let clock = 1_000_000;
    const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir, pid: process.pid, version: '0.2.0', evalScript, now: () => clock });
    await bridge.heartbeat();
    await writeFile(join(dir, 'a1.req.json'), JSON.stringify({ id: 'a1', action: 'importMedia', args: {} }));
    const work = bridge.tick();
    clock += 60_000;
    await bridge.heartbeat();
    const hb = JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8')) as { busy: { action: string; since: number }; ts: number };
    expect(hb).toMatchObject({ busy: { action: 'importMedia', since: 1_000_000 }, ts: 1_060_000 });
    expect(evalScript.mock.calls.filter((c) => c[0].includes('"ping"'))).toHaveLength(1);
    release(JSON.stringify({ ok: true, data: { quitting: true } }));
    await work;
    expect(JSON.parse(await readFile(join(dir, 'a1.res.json'), 'utf8'))).toMatchObject({ ok: true });
    expect(evalScript).toHaveBeenLastCalledWith('app.quit()'); // only after the answer is on disk
    expect(JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8')).busy).toBeNull();
  });

  it('re-evaluates host.jsx when the file changes, not on every call', async () => {
    const dir = await tmp();
    const hostFile = join(dir, 'host.jsx');
    await writeFile(hostFile, '// v1');
    const evalScript = vi.fn(async () => JSON.stringify({ ok: true, data: {} }));
    const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir, pid: process.pid, version: '0.2.0', evalScript, hostFile });
    bridge.start(); bridge.stop(); // remembers the version the manifest loaded
    await bridge.heartbeat();
    await bridge.heartbeat();
    await writeFile(hostFile, '// v2');
    await utimes(hostFile, new Date(), new Date(Date.now() + 5000));
    await bridge.heartbeat();
    await bridge.heartbeat();
    const reloads = evalScript.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('$.evalFile('));
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toContain(hostFile.replace(/\\/g, '/'));
  });
});

// ---------- diagnosis + CatCut opening Premiere ----------

function fakeHost(o: { running?: number[]; debugMissing?: string[]; onLaunch?: () => void; windows?: PremiereWindows; onActivate?: () => void } = {}): PremiereHost & { launches: Array<[string, string]>; activations: number[][] } {
  const launches: Array<[string, string]> = [];
  const activations: number[][] = [];
  return {
    launches, activations,
    running: async () => o.running ?? [],
    debugModeMissing: async () => o.debugMissing ?? [],
    launch: (exe, project) => { launches.push([exe, project]); o.onLaunch?.(); return { pid: 4242 }; },
    ...(o.windows ? { windows: async () => o.windows } : {}),
    activate: async (pids) => { activations.push(pids); o.onActivate?.(); return 'active' as const; },
  };
}

async function installed(root: string, version = SOURCE_VERSION): Promise<string> {
  const dir = join(root, 'ext', BRIDGE_ID);
  await mkdir(join(dir, 'CSXS'), { recursive: true });
  await writeFile(join(dir, 'CSXS', 'manifest.xml'), '<x/>');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
}

describe('diagnosePremiere: one reason, one card', () => {
  it('names the reason: not installed, old install, debug mode, not started, outdated in memory, dialog, closed', async () => {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    const exe = { premiereExe: 'C:\\Adobe\\Premiere.exe' };
    const c0 = createPremiereClient({ queueDir: queue, installDir: join(root, 'none') });
    expect((await diagnosePremiere(c0, fakeHost(), exe)).userAction?.code).toBe('bridge-not-installed');
    expect((await diagnosePremiere(c0, fakeHost(), {})).userAction?.code).toBe('premiere-not-found');

    const c1 = createPremiereClient({ queueDir: queue, installDir: await installed(join(root, 'old'), '0.1.0') });
    expect((await diagnosePremiere(c1, fakeHost(), exe)).userAction?.code).toBe('bridge-update');

    const c = createPremiereClient({ queueDir: queue, installDir: await installed(root) });
    expect((await diagnosePremiere(c, fakeHost({ debugMissing: ['HKCU\\Software\\Adobe\\CSXS.12'] }), exe)).userAction?.code).toBe('bridge-not-installed');
    const closed = await diagnosePremiere(c, fakeHost(), exe);
    expect(closed).toMatchObject({ ready: false, running: false, note: expect.stringMatching(/closed/) });
    expect(closed.userAction).toBeUndefined();
    expect((await diagnosePremiere(c, fakeHost({ running: [77] }), exe)).userAction?.code).toBe('bridge-not-started');

    const beat = (o: Record<string, unknown>) => writeFile(join(queue, 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now(), bridge: SOURCE_VERSION, project: null, ...o }));
    await beat({ bridge: '0.1.0' });
    expect((await diagnosePremiere(c, fakeHost(), exe)).userAction?.code).toBe('bridge-outdated');
    await beat({ busy: { action: 'importMedia', since: Date.now() - 120_000 } });
    const dlg = await diagnosePremiere(c, fakeHost(), exe);
    expect(dlg.userAction).toMatchObject({ code: 'premiere-dialog', why: expect.stringContaining('importMedia') });
    await beat({});
    expect(await diagnosePremiere(c, fakeHost(), exe)).toMatchObject({ ready: true });
  });

  it('a long busy spell is told apart: a dialog gets the card with its title, rendering gets "wait, nothing to click"', async () => {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    const exe = { premiereExe: 'C:\\Adobe\\Premiere.exe' };
    const c = createPremiereClient({ queueDir: queue, installDir: await installed(root) });
    await writeFile(join(queue, 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now(), bridge: SOURCE_VERSION, busy: { action: 'frames', since: Date.now() - 70_000 } }));
    const dialog = await diagnosePremiere(c, fakeHost({ running: [7], windows: { modal: true, dialogs: ['Link Media'], hung: false } }), exe);
    expect(dialog.userAction).toMatchObject({ code: 'premiere-dialog', title: expect.stringContaining('Link Media'), why: expect.stringContaining('frames') });
    const working = await diagnosePremiere(c, fakeHost({ running: [7], windows: { modal: false, dialogs: [], hung: true } }), exe);
    expect(working).toMatchObject({ ready: true, busy: true, note: expect.stringMatching(/no dialog open/) });
    expect(working.userAction).toBeUndefined();
  });

  it('a call behind a rendering Premiere waits for it instead of sending the person to look for a dialog', async () => {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    const beat = (busy: unknown) => writeFile(join(queue, 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now(), bridge: SOURCE_VERSION, busy }));
    await beat({ action: 'exportRange', since: Date.now() - 90_000 });
    const rendering = createPremiereClient({ queueDir: queue, installDir: await installed(root), pollMs: 5, host: fakeHost({ running: [7], windows: { modal: false, dialogs: [], hung: false } }) });
    const e = await rendering.call('status', {}, { timeoutMs: 60 }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(UserActionError);
    expect(String((e as Error).message)).toMatch(/ไม่มีหน้าต่างค้าง.*no dialog open/s);
    // the render finishes: the waiting call goes through
    const answered = rendering.call<{ ok: boolean }>('status', {}, { timeoutMs: 5_000 });
    setTimeout(() => {
      void (async () => {
        await beat(null);
        for (let i = 0; i < 400; i++) {
          const name = (await readdir(queue)).find((x) => x.endsWith('.req.json'));
          if (name) { await writeFile(join(queue, name.replace('.req.json', '.res.json')), JSON.stringify({ ok: true, data: { ok: true } })); return; }
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
    }, 30);
    expect(await answered).toEqual({ ok: true });
    const blocked = createPremiereClient({ queueDir: queue, installDir: await installed(root), pollMs: 5, host: fakeHost({ running: [7], windows: { modal: true, dialogs: ['Import Files'], hung: false } }) });
    await beat({ action: 'importMedia', since: Date.now() - 90_000 });
    const d = await blocked.call('status', {}, { timeoutMs: 60 }).catch((x: unknown) => x);
    expect((d as UserActionError).userAction).toMatchObject({ code: 'premiere-dialog', title: expect.stringContaining('Import Files') });
  });

  it('reads Premiere\'s windows with a fixed Win32 helper: pids only, nothing clicked', () => {
    const script = winHelperScript('Probe', [12, -1, 3.5, 99]);
    expect(script).toContain('[CatCutWin]::Probe([uint32[]]@(12,99))');
    expect(script).not.toMatch(/keybd_event|SendInput|mouse_event/);
    expect(parseWindowProbe('MODAL\r\nDIALOG\tLink Media\r\nHUNG\r\nEND\r\n')).toEqual({ modal: true, dialogs: ['Link Media'], hung: true });
    expect(parseWindowProbe('END\n')).toEqual({ modal: false, dialogs: [], hung: false });
    expect(parseWindowProbe('Add-Type failed')).toBeUndefined();
  });

  it('a call into a Premiere stuck behind a dialog returns the dialog card instead of queueing', async () => {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    await writeFile(join(queue, 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now(), busy: { action: 'importMedia', since: Date.now() - 300_000 } }));
    const c = createPremiereClient({ queueDir: queue, installDir: await installed(root) });
    const e = await c.call('status').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UserActionError);
    expect((e as UserActionError).userAction.code).toBe('premiere-dialog');
  });
});

describe('openPremiere: CatCut starts Premiere with the project', () => {
  async function setup(o: { running?: number[]; heartbeatProject?: 'target' | 'none' } = {}) {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    const project = join(root, 'งาน.prproj'); await writeFile(project, '');
    const prem = fakePremiere(o.heartbeatProject === 'none' ? '' : project);
    const startBridge = async () => {
      const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir: queue, pid: process.pid, version: SOURCE_VERSION, evalScript: prem.evalScript });
      await bridge.heartbeat();
      pumps.push(setInterval(() => { void bridge.tick(); void bridge.heartbeat(); }, 5));
    };
    const host = fakeHost({ ...(o.running ? { running: o.running } : {}), onLaunch: () => setTimeout(startBridge, 30) });
    const client = createPremiereClient({ queueDir: queue, installDir: await installed(root), pollMs: 5 });
    return { root, queue, project, prem, host, client, startBridge };
  }

  it('starts a closed Premiere with the project and waits for the bridge', async () => {
    const s = await setup();
    const r = await openPremiere(s.client, s.host, { premiereExe: 'C:\\Adobe\\Premiere.exe', project: s.project, pollMs: 5 });
    expect(s.host.launches).toEqual([['C:\\Adobe\\Premiere.exe', s.project]]);
    expect(r).toMatchObject({ launched: true, openedProject: false, pid: 4242, project: { path: s.project } });
  });

  it('opens the project through the bridge when Premiere runs without it', async () => {
    const s = await setup({ heartbeatProject: 'none' });
    await s.startBridge();
    const r = await openPremiere(s.client, s.host, { premiereExe: 'x.exe', project: s.project, pollMs: 5 });
    expect(r).toMatchObject({ launched: false, openedProject: true, project: { path: s.project } });
    expect(s.host.launches).toEqual([]);
  });

  it('a running Premiere without the bridge is brought to the front first (ApplicationActivate starts it)', async () => {
    const s = await setup({ running: [9] });
    const host = fakeHost({ running: [9], onActivate: () => { void s.startBridge(); } });
    const r = await openPremiere(s.client, host, { premiereExe: 'x.exe', project: s.project, pollMs: 5, waitMs: 5_000 });
    expect(host.activations).toEqual([[9]]);
    expect(r).toMatchObject({ launched: false, project: { path: s.project } });
  });

  it('a launched Premiere is brought to the front only after it had time to start the bridge itself', async () => {
    const s = await setup();
    const host = fakeHost({ onActivate: () => { void s.startBridge(); } });
    host.running = async () => (host.launches.length ? [4242] : []);
    const r = await openPremiere(s.client, host, { premiereExe: 'x.exe', project: s.project, pollMs: 5, waitMs: 5_000, activateAfterMs: 60 });
    expect(host.activations).toEqual([[4242]]);
    expect(r).toMatchObject({ launched: true });
  });

  it('a Premiere that never connects ends with a card, not a hang', async () => {
    const s = await setup({ running: [9] });
    const e = await openPremiere(s.client, s.host, { premiereExe: 'x.exe', project: s.project, pollMs: 5, waitMs: 50 }).catch((x: unknown) => x);
    expect((e as UserActionError).userAction).toMatchObject({ code: 'bridge-not-started', frequency: 'once', steps: expect.arrayContaining([expect.stringContaining('อย่ากดปิด')]) });
    const s2 = await setup();
    s2.host.launch = () => ({ pid: 1 }); // started, but no bridge ever comes up
    const e2 = await openPremiere(s2.client, s2.host, { premiereExe: 'x.exe', project: s2.project, pollMs: 5, waitMs: 50 }).catch((x: unknown) => x);
    expect((e2 as UserActionError).userAction.code).toBe('premiere-start-timeout');
  });

  it('refuses a non-project path before touching Premiere', async () => {
    const s = await setup();
    await expect(openPremiere(s.client, s.host, { premiereExe: 'x.exe', project: join(s.root, 'cut.xml') })).rejects.toThrow(/not a Premiere project/);
    await expect(openPremiere(s.client, s.host, { premiereExe: 'x.exe', project: join(s.root, 'missing.prproj') })).rejects.toThrow(/not found/);
    expect(s.host.launches).toEqual([]);
  });
});

// ---------- tools ----------

describe('premiere tools over the simulated bridge', () => {
  async function toolSetup() {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    const project = join(root, 'JOB.prproj'); await writeFile(project, '');
    const prem = fakePremiere(project);
    const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir: queue, pid: process.pid, version: SOURCE_VERSION, evalScript: prem.evalScript });
    await bridge.heartbeat();
    pumps.push(setInterval(() => { void bridge.tick(); void bridge.heartbeat(); }, 5));
    const { env } = await safeEnvironment();
    const state: AppState = {
      env: { ...env, tools: { ...env.tools, premiereExe: 'C:\\Adobe\\Premiere.exe' } }, ae: new MockAeBackend(), jobs: new JobManager(), problems: [],
      assembler: { build: async () => { throw new Error('no build'); }, deliver: async () => ({}), reviewProxy: async () => '' },
      api: { project: projectApi, xmeml: xmemlApi, probe: async () => ({ durationFrames: 100, fps: 25, hasVideo: true, hasAudio: false }) },
      premiere: createPremiereClient({ queueDir: queue, installDir: await installed(root), pollMs: 5 }),
      premiereHost: fakeHost(),
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await callTool(state, name, args); return { isError: !!r.isError, data: toolResultData(r) }; };
    return { root, project, prem, state, call };
  }

  it('premiere_import_media: card folders become bins, camera structure skipped, proxies matched by name, saved', async () => {
    const { root, project, prem, call } = await toolSetup();
    const card = join(root, 'FOOTAGE', 'CARD 1', 'PRIVATE', 'M4ROOT', 'CLIP');
    const px = join(root, 'Proxy', 'CARD 1');
    await mkdir(card, { recursive: true }); await mkdir(px, { recursive: true });
    for (const f of ['C0001.MP4', 'C0002.MP4']) await writeFile(join(card, f), 'x');
    await writeFile(join(px, 'C0001_Proxy.mp4'), 'x');
    const r = await call('premiere_import_media', { project, sources: [join(root, 'FOOTAGE')], proxyDir: join(root, 'Proxy') });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ ok: true, files: 2, imported: 2, proxies: { attached: 1, none: 1 }, bins: ['FOOTAGE/CARD 1'], saved: true, closeHint: expect.stringContaining('Save แล้ว') });
    expect(prem.saves).toEqual([project]);
    expect(prem.app.setEnableProxies).toHaveBeenCalledWith(1);
  });

  it('bin names: source folder plus the first non-camera folder', () => {
    expect(_binFor(join('D:', 'job', 'FOOTAGE', 'CARD 2', 'PRIVATE', 'M4ROOT', 'CLIP', 'C1.MP4'), join('D:', 'job', 'FOOTAGE'))).toBe('FOOTAGE/CARD 2');
    expect(_binFor(join('D:', 'job', 'CARD 3', 'C1.MP4'), join('D:', 'job', 'CARD 3'))).toBe('CARD 3');
    expect(_binFor(join('D:', 'client', 'old', 'a.mov'))).toBe('old');
  });

  it('premiere_set_speed converts percent, saves, and tells whether Premiere may be closed', async () => {
    const { project, prem, call } = await toolSetup();
    prem.clips.push({ name: 'C0001.MP4', start: { seconds: 0 }, end: { seconds: 4 }, speed: 1 });
    const r = await call('premiere_set_speed', { project: basename(project), clips: [{ at: 10, speed: 60 }] });
    expect(r.data).toMatchObject({ ok: true, clips: [{ speed: 0.6, interpolation: 'optical-flow' }], saved: true });
    expect(prem.clips[0]!.speed).toBe(0.6);
  });

  it('premiere_close quits only a Premiere CatCut started, unless the user asked (force)', async () => {
    const { project, prem, state, call } = await toolSetup();
    const refused = await call('premiere_close', { project });
    expect(refused).toMatchObject({ isError: true, data: { error: expect.stringMatching(/ไม่ได้เปิด Premiere เอง/) } });
    state.premiereLaunched = { project };
    const ok = await call('premiere_close', { project });
    expect(ok.data).toMatchObject({ ok: true, closed: true, saved: true });
    await vi.waitFor(() => expect(prem.quits()).toBe(1));
    expect(state.premiereLaunched).toBeUndefined();
  });

  it('premiere_status shows the card for a Premiere that runs without the bridge', async () => {
    const { state, call } = await toolSetup();
    state.premiere = createPremiereClient({ queueDir: join(os.tmpdir(), 'catcut-nobody-here'), installDir: state.premiere!.installDir });
    state.premiereHost = fakeHost({ running: [5] });
    const r = await call('premiere_status');
    expect(r.data).toMatchObject({ ready: false, userAction: { code: 'bridge-not-started', say: expect.stringContaining('Window > Extensions > CatCut Bridge') } });
  });

  it('a bare project name with Premiere closed asks for the full path', async () => {
    const { state, call } = await toolSetup();
    state.premiere = createPremiereClient({ queueDir: join(os.tmpdir(), 'catcut-nobody-here-2'), installDir: state.premiere!.installDir });
    const r = await call('premiere_save', { project: 'JOB.prproj' });
    expect(r).toMatchObject({ isError: true, data: { error: expect.stringMatching(/path เต็ม/) } });
    expect(existsSync(state.premiere.installDir)).toBe(true);
  });
});
