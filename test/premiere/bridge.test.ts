/**
 * Premiere handoff bridge without Premiere: host.jsx runs in a Node vm against a fake Premiere object
 * model, bridge-core.js serves a real temp-folder queue, and the CatCut client/tools talk to it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { basename, join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import { MockAeBackend } from '../../src/engine/ae.js';
import type { SpawnFn } from '../../src/engine/aerender.js';
import { BRIDGE_ID, createPremiereClient, installBridge, uninstallBridge } from '../../src/engine/premiere.js';
import * as xmemlApi from '../../src/io/xmeml.js';
import { safeEnvironment, type AppState } from '../../src/mcp/state.js';
import { callTool, toolResultData } from '../../src/mcp/tools.js';

const require = createRequire(import.meta.url);
const { createBridge } = require('../../premiere/catcut-bridge/bridge-core.js') as {
  createBridge: (o: Record<string, unknown>) => { start(): void; stop(): void; tick(): Promise<boolean>; heartbeat(): Promise<boolean>; state: { serving: boolean; handled: number } };
};
const BRIDGE_SRC = join(process.cwd(), 'premiere', 'catcut-bridge');
const HOST = readFileSync(join(BRIDGE_SRC, 'host.jsx'), 'utf8');
const SOURCE_VERSION = (JSON.parse(readFileSync(join(BRIDGE_SRC, 'package.json'), 'utf8')) as { version: string }).version;

// ---------- fake Premiere (just the object model host.jsx touches) ----------

interface FakeSeq { name: string; sequenceID: string; xml: string; exportAsFinalCutProXML(path: string, suppress: number): boolean }

function fakePremiere(projectPath = 'C:\\jobs\\JOB_EDIT.prproj', opts: { onExport?: (xml: string) => string } = {}) {
  let next = 1;
  const seqs: FakeSeq[] = [];
  const bins: Array<{ name: string; type: number }> = [];
  const imports: string[] = [];
  const makeSeq = (name: string, xml = ''): FakeSeq => {
    const s: FakeSeq = {
      name, sequenceID: `seq-${next++}`, xml,
      exportAsFinalCutProXML(path) { require('node:fs').writeFileSync(path, opts.onExport ? opts.onExport(s.xml) : s.xml, 'utf8'); return true; },
    };
    seqs.push(s);
    return s;
  };
  const project = {
    name: basename(projectPath.replace(/\\/g, '/')), path: projectPath,
    activeSequence: null as FakeSeq | null,
    get sequences() { const o: Record<string, unknown> = { numSequences: seqs.length }; seqs.forEach((s, i) => { o[i] = s; }); return o; },
    rootItem: {
      get children() { const o: Record<string, unknown> = { numItems: bins.length }; bins.forEach((b, i) => { o[i] = b; }); return o; },
      createBin(name: string) { bins.push({ name, type: 2 }); },
    },
    importFiles(paths: string[]) {
      for (const p of paths) {
        const xml = readFileSync(p, 'utf8');
        imports.push(xml);
        makeSeq(/<sequence[^>]*>\s*<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? 'imported', xml);
      }
      return true;
    },
    openSequence(id: string) { project.activeSequence = seqs.find((s) => s.sequenceID === id) ?? null; return true; },
  };
  const app = { version: '26.0.0', project: project as typeof project | null };
  const ctx = vm.createContext({ app, File: function File(this: { exists: boolean }, p: string) { this.exists = existsSync(p); } });
  vm.runInContext(HOST, ctx);
  const evalScript = vi.fn(async (script: string) => String(vm.runInContext(script, ctx)));
  const dispatch = (job: unknown) => JSON.parse(String(vm.runInContext(`catcut_dispatch(${JSON.stringify(job)})`, ctx))) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { app, project, seqs, bins, imports, makeSeq, evalScript, dispatch };
}

// ---------- queue: bridge-core serving a temp folder ----------

const pumps: NodeJS.Timeout[] = [];
afterEach(() => { pumps.splice(0).forEach(clearInterval); });

async function liveBridge(prem = fakePremiere(), o: { pid?: number } = {}) {
  const root = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
  const dir = join(root, 'queue');
  await mkdir(dir, { recursive: true });
  const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir, pid: o.pid ?? process.pid, version: SOURCE_VERSION, evalScript: prem.evalScript });
  await bridge.heartbeat();
  pumps.push(setInterval(() => { void bridge.tick(); }, 5));
  const installDir = join(root, 'ext', BRIDGE_ID);
  await mkdir(join(installDir, 'CSXS'), { recursive: true });
  await writeFile(join(installDir, 'CSXS', 'manifest.xml'), '<x/>');
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ version: SOURCE_VERSION }));
  const client = createPremiereClient({ queueDir: dir, installDir, pollMs: 5 });
  return { root, dir, bridge, client, prem, installDir };
}

describe('host.jsx (ExtendScript side) against a fake Premiere', () => {
  it('reports Premiere, the open project and its sequences', () => {
    const prem = fakePremiere();
    prem.makeSeq('A'); const b = prem.makeSeq('B'); prem.project.activeSequence = b;
    const r = prem.dispatch({ action: 'status' });
    expect(r).toEqual({ ok: true, data: { premiere: '26.0.0', project: { name: 'JOB_EDIT.prproj', path: 'C:\\jobs\\JOB_EDIT.prproj' }, sequences: [{ name: 'A', id: 'seq-1', active: false }, { name: 'B', id: 'seq-2', active: true }] } });
  });

  it('importXml: imports into the CatCut bin (created once), returns only new sequences and opens the first', async () => {
    const prem = fakePremiere();
    prem.makeSeq('existing');
    const dir = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const xml = join(dir, 'cut.xml');
    await writeFile(xml, '<xmeml><sequence id="s"><name>งาน_v001</name></sequence></xmeml>');
    const r1 = prem.dispatch({ action: 'importXml', args: { path: xml, bin: 'CatCut', expectProject: 'c:/jobs/job_edit.prproj' } });
    expect(r1.ok).toBe(true);
    expect(r1.data).toMatchObject({ bin: 'CatCut', sequences: [{ name: 'งาน_v001', id: 'seq-2' }], opened: { name: 'งาน_v001', id: 'seq-2' } });
    expect(prem.project.activeSequence?.name).toBe('งาน_v001');
    prem.dispatch({ action: 'importXml', args: { path: xml } });
    expect(prem.bins).toEqual([{ name: 'CatCut', type: 2 }]);
  });

  it('importXml refuses when another project is open, or nothing was imported', async () => {
    const prem = fakePremiere();
    const dir = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const xml = join(dir, 'cut.xml');
    await writeFile(xml, '<xmeml><sequence><name>x</name></sequence></xmeml>');
    expect(prem.dispatch({ action: 'importXml', args: { path: xml, expectProject: 'C:\\jobs\\OTHER.prproj' } })).toMatchObject({ ok: false, error: expect.stringMatching(/project changed.*nothing imported/) });
    expect(prem.imports).toHaveLength(0);
    expect(prem.dispatch({ action: 'importXml', args: { path: join(dir, 'missing.xml') } })).toMatchObject({ ok: false, error: expect.stringMatching(/xml not found/) });
    prem.project.importFiles = () => true; // Premiere "succeeds" without a sequence
    expect(prem.dispatch({ action: 'importXml', args: { path: xml } })).toMatchObject({ ok: false, error: expect.stringMatching(/no new sequence/) });
    prem.app.project = null;
    expect(prem.dispatch({ action: 'importXml', args: { path: xml } })).toMatchObject({ ok: false, error: 'no project open in Premiere' });
  });

  it('exportXml: active sequence by default, else by exact name or id; ambiguity and unknown actions are errors', async () => {
    const prem = fakePremiere();
    const a = prem.makeSeq('Cut', '<xmeml>a</xmeml>'); const b = prem.makeSeq('Cut', '<xmeml>b</xmeml>'); prem.makeSeq('Solo', '<xmeml>s</xmeml>');
    const dir = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    expect(prem.dispatch({ action: 'exportXml', args: { path: join(dir, '0.xml') } })).toMatchObject({ ok: false, error: expect.stringMatching(/no active sequence/) });
    prem.project.activeSequence = b;
    expect(prem.dispatch({ action: 'exportXml', args: { path: join(dir, '1.xml') } }).data).toMatchObject({ sequence: { name: 'Cut', id: b.sequenceID } });
    expect(await readFile(join(dir, '1.xml'), 'utf8')).toBe('<xmeml>b</xmeml>');
    expect(prem.dispatch({ action: 'exportXml', args: { sequence: 'Solo', path: join(dir, '2.xml') } }).ok).toBe(true);
    expect(prem.dispatch({ action: 'exportXml', args: { sequence: a.sequenceID, path: join(dir, '3.xml') } }).data).toMatchObject({ sequence: { id: a.sequenceID } });
    expect(prem.dispatch({ action: 'exportXml', args: { sequence: 'Cut', path: join(dir, '4.xml') } })).toMatchObject({ ok: false, error: expect.stringMatching(/ambiguous/) });
    expect(prem.dispatch({ action: 'saveProject' })).toMatchObject({ ok: false, error: 'unknown action: saveProject' });
  });

  it('stays ES3 (ExtendScript): no arrow functions, let/const, template literals or Array#indexOf', () => {
    const code = HOST.replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/=>|\blet\b|\bconst\b|`|\.indexOf\(/);
    expect(HOST).not.toMatch(/[\u2028\u2029]/);
  });
});

describe('bridge queue (bridge-core.js ⇄ CatCut client)', () => {
  it('serves requests in order and keeps a heartbeat the client reads as connected', async () => {
    const { client, dir } = await liveBridge();
    const st = await client.status();
    expect(st).toMatchObject({ connected: true, installed: true, premiere: '26.0.0', bridge: SOURCE_VERSION, project: { name: 'JOB_EDIT.prproj' }, busy: null });
    const [s1, s2] = await Promise.all([client.call<{ premiere: string }>('status'), client.call<{ premiere: string }>('ping')]);
    expect(s1.premiere).toBe('26.0.0');
    expect(s2.premiere).toBe('26.0.0');
    expect((await readdir(dir)).sort()).toEqual(['bridge.json']); // no request/result files left behind
  });

  it('passes U+2028/2029 to ExtendScript escaped', async () => {
    const { client, prem } = await liveBridge();
    await client.call('status', { note: 'a\u2028b\u2029c' });
    const script = prem.evalScript.mock.calls.map((c) => c[0]).find((s) => s.includes('"status"'))!;
    expect(script).toContain('a\\u2028b\\u2029c');
    expect(script).not.toMatch(/[\u2028\u2029]/);
  });

  it('turns Premiere errors into rejections', async () => {
    const { client } = await liveBridge();
    await expect(client.call('exportXml', { path: 'x.xml' })).rejects.toThrow(/^Premiere: no active sequence/);
  });

  it('says what to do when the bridge is not installed or not running', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const installDir = join(root, 'ext', BRIDGE_ID);
    const client = createPremiereClient({ queueDir: join(root, 'queue'), installDir, pollMs: 5 });
    expect(await client.status()).toMatchObject({ installed: false, connected: false });
    await expect(client.call('status')).rejects.toMatchObject({ message: expect.stringMatching(/not installed/), userAction: { code: 'bridge-not-installed', steps: expect.arrayContaining([expect.stringContaining('catcut premiere-bridge install')]) } });
    await mkdir(join(installDir, 'CSXS'), { recursive: true });
    await writeFile(join(installDir, 'CSXS', 'manifest.xml'), '<x/>');
    await expect(client.call('status')).rejects.toThrow(/premiere_open/);
  });

  it('a stale heartbeat is not connected; an unclaimed request is withdrawn on timeout', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const dir = join(root, 'queue');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now() - 60_000 }));
    expect((await createPremiereClient({ queueDir: dir }).status()).connected).toBe(false);
    await writeFile(join(dir, 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now() + 60_000 })); // fresh, but nobody serves
    const client = createPremiereClient({ queueDir: dir, pollMs: 5 });
    await expect(client.call('status', {}, { timeoutMs: 60 })).rejects.toThrow(/did not pick up 'status'/);
    expect((await readdir(dir)).filter((f) => f.includes('.req.'))).toEqual([]);
  });

  it('answers an expired request with an error instead of running it', async () => {
    const prem = fakePremiere();
    const root = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir: root, pid: process.pid, version: '0.1.0', evalScript: prem.evalScript });
    await bridge.heartbeat();
    await writeFile(join(root, 'x1.req.json'), JSON.stringify({ id: 'x1', action: 'importXml', args: {}, deadline: Date.now() - 1 }));
    expect(await bridge.tick()).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'x1.res.json'), 'utf8'))).toMatchObject({ id: 'x1', ok: false, error: expect.stringMatching(/expired/) });
    expect(prem.evalScript.mock.calls.some((c) => c[0].includes('importXml'))).toBe(false);
  });

  it('only one bridge serves: a second instance stands by while the first heartbeat is fresh', async () => {
    const { dir } = await liveBridge();
    const prem2 = fakePremiere();
    let clock = Date.now();
    const second = createBridge({ fs: require('node:fs'), path: require('node:path'), dir, pid: process.pid + 777_777, version: '0.1.0', evalScript: prem2.evalScript, now: () => clock });
    expect(await second.heartbeat()).toBe(false);
    expect(second.state.serving).toBe(false);
    expect(await second.tick()).toBe(false);
    clock += 60_000; // the first one went quiet
    expect(await second.heartbeat()).toBe(true);
    expect(second.state.serving).toBe(true);
  });
});

// ---------- MCP tools over the simulated bridge ----------

async function toolState(prem: ReturnType<typeof fakePremiere>) {
  const live = await liveBridge(prem);
  const { env: real } = await safeEnvironment();
  // a Premiere install is part of the fixture (the host is mocked), not of the machine running the tests
  const env = { ...real, tools: { ...real.tools, premiereExe: join(os.tmpdir(), 'Adobe Premiere Pro.exe') } };
  const state: AppState = {
    env, ae: new MockAeBackend(), jobs: new JobManager(), problems: [],
    assembler: { build: async () => { throw new Error('no build'); }, deliver: async () => ({}), reviewProxy: async () => '' },
    api: { project: projectApi, xmeml: xmemlApi, probe: async () => ({ durationFrames: 500, width: 1920, height: 1080, fps: 25, hasVideo: true, hasAudio: false }) },
    premiere: live.client,
    premiereHost: { running: async () => [], debugModeMissing: async () => [], launch: () => ({}) },
  };
  const dir = join(live.root, 'โปรเจกต์');
  const p = await projectApi.createProject(dir, { name: 'งานทดสอบ' });
  const media = join(live.root, 'cam.mov');
  await writeFile(media, 'not really a movie');
  await projectApi.addFileAsset(p, media, { id: 'cam', kind: 'camera', probe: state.api.probe });
  projectApi.setTimeline(p, {
    video: [{ id: 'a', src: 'cam', in: 0, dur: 50, marker: 'เปิด' }, { id: 'b', src: 'cam', in: 100, dur: 50 }],
    cuts: [{ after: 'a', dissolve: 0 }],
    audio: { vo: [], music: [], sfx: [], useClipAudio: false },
  });
  await projectApi.saveProject(p);
  state.project = p;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(state, name, args);
    return { isError: !!r.isError, data: toolResultData(r) };
  };
  return { ...live, state, call, p };
}

describe('premiere_status / premiere_push / premiere_pull', () => {
  it('premiere_status: hint when not connected, project + sequences when connected', async () => {
    const { call, state } = await toolState(fakePremiere());
    const st = await call('premiere_status');
    expect(st.data).toMatchObject({ connected: true, premiere: '26.0.0', project: { name: 'JOB_EDIT.prproj' }, sequences: [] });
    state.premiere = createPremiereClient({ queueDir: join(os.tmpdir(), 'catcut-no-bridge-here'), installDir: join(os.tmpdir(), 'catcut-no-ext') });
    expect((await call('premiere_status')).data).toMatchObject({ connected: false, installed: false, ready: false, userAction: { code: 'bridge-not-installed', say: expect.stringContaining('catcut premiere-bridge install') } });
  });

  it('premiere_push refuses another open project, then hands the cut over as a new opened sequence', async () => {
    const prem = fakePremiere();
    const { call, dir } = await toolState(prem);
    const wrong = await call('premiere_push', { project: 'OTHER_JOB.prproj' });
    expect(wrong.isError).toBe(true);
    expect(wrong.data).toMatchObject({ open: { name: 'JOB_EDIT.prproj' }, wanted: 'OTHER_JOB.prproj' });
    expect(prem.imports).toHaveLength(0);
    const ok = await call('premiere_push', { project: 'JOB_EDIT' });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ ok: true, version: 'draft', bin: 'CatCut', opened: { name: 'งานทดสอบ_draft' } });
    expect(existsSync(String(ok.data['xml']))).toBe(true); // CatCut keeps its own copy under out/
    expect(prem.imports[0]).toContain('<name>เปิด</name>');
    expect(prem.project.activeSequence?.name).toBe('งานทดสอบ_draft');
    expect(await readdir(join(dir, 'files'))).toEqual([]); // staged copy removed
  });

  it('premiere_pull: dry run by default, never overwrites its XML, apply commits the editor\'s change', async () => {
    const prem = fakePremiere(undefined, { onExport: (xml) => xml.replace('<name>เปิด</name>', '<name>เปิดใหม่</name>') });
    const { call, state } = await toolState(prem);
    await call('premiere_push', { project: 'C:\\jobs\\JOB_EDIT.prproj' });
    const dry = await call('premiere_pull');
    expect(dry.isError).toBe(false);
    expect(dry.data).toMatchObject({ dryRun: true, applied: false, valid: true, pulledFrom: { project: { name: 'JOB_EDIT.prproj' }, sequence: { name: 'งานทดสอบ_draft' } } });
    expect(state.project!.timeline.video[0]!.marker).toBe('เปิด');
    const applied = await call('premiere_pull', { sequence: 'งานทดสอบ_draft', apply: true });
    expect(applied.data).toMatchObject({ applied: true });
    expect(applied.data['xml']).not.toBe(dry.data['xml']);
    expect(String(applied.data['xml'])).toMatch(/[\\/]out[\\/]premiere[\\/]งานทดสอบ_draft_2\.xml$/);
    expect(state.project!.timeline.video[0]!.marker).toBe('เปิดใหม่');
  });

  it('premiere_pull reports Premiere\'s error (no active sequence)', async () => {
    const { call } = await toolState(fakePremiere());
    const r = await call('premiere_pull');
    expect(r.isError).toBe(true);
    expect(String(r.data['error'])).toMatch(/no active sequence/);
  });
});

describe('premiere-bridge install', () => {
  it('copies the extension (replacing an older one) and sets PlayerDebugMode for CSXS 9–12 without a shell', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const extensionsDir = join(root, 'extensions');
    await mkdir(join(extensionsDir, BRIDGE_ID), { recursive: true });
    await writeFile(join(extensionsDir, BRIDGE_ID, 'stale.js'), 'old');
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const r = await installBridge({ spawn: spawn as unknown as SpawnFn, extensionsDir, source: BRIDGE_SRC, platform: 'win32' });
    expect(r.installedTo).toBe(join(extensionsDir, BRIDGE_ID));
    for (const f of ['CSXS/manifest.xml', 'index.html', 'bridge-core.js', 'host.jsx']) expect(existsSync(join(r.installedTo, f))).toBe(true);
    expect(existsSync(join(r.installedTo, 'stale.js'))).toBe(false);
    expect(spawn.mock.calls.map((c) => (c as unknown as [string, string[]])[1][1])).toEqual(['HKCU\\Software\\Adobe\\CSXS.9', 'HKCU\\Software\\Adobe\\CSXS.10', 'HKCU\\Software\\Adobe\\CSXS.11', 'HKCU\\Software\\Adobe\\CSXS.12']);
    const [bin, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(bin).toBe('reg');
    expect(args).toEqual(['add', 'HKCU\\Software\\Adobe\\CSXS.9', '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f']);
    expect(opts['shell']).toBeUndefined();
    await uninstallBridge({ extensionsDir });
    expect(existsSync(join(extensionsDir, BRIDGE_ID))).toBe(false);
  });

  it('macOS: sets PlayerDebugMode in the com.adobe.CSXS.<n> user defaults instead of the registry', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'catcut-ppro-'));
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const r = await installBridge({ spawn: spawn as unknown as SpawnFn, extensionsDir: join(root, 'extensions'), source: BRIDGE_SRC, backupRoot: join(root, 'backups'), platform: 'darwin' });
    expect(r.debugModeKeys).toEqual(['com.adobe.CSXS.9', 'com.adobe.CSXS.10', 'com.adobe.CSXS.11', 'com.adobe.CSXS.12']);
    const [bin, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(bin).toBe('defaults');
    expect(args).toEqual(['write', 'com.adobe.CSXS.9', 'PlayerDebugMode', '1']);
    expect(opts['shell']).toBeUndefined();
  });

  it('manifest: invisible auto-start extension plus a visible fallback panel, Premiere host, Node enabled', () => {
    const m = readFileSync(join(BRIDGE_SRC, 'CSXS', 'manifest.xml'), 'utf8');
    expect(m).toContain(`ExtensionBundleId="${BRIDGE_ID}"`);
    expect(m).toMatch(/<Host Name="PPRO"/);
    expect(m).toMatch(/<Extension Id="com\.catcut\.bridge\.auto">[\s\S]*?<AutoVisible>false<\/AutoVisible>[\s\S]*?ApplicationActivate[\s\S]*?<Type>Custom<\/Type>/);
    expect(m).toMatch(/<Extension Id="com\.catcut\.bridge\.panel">[\s\S]*?<Type>Panel<\/Type>/);
    expect(m.match(/--enable-nodejs/g)).toHaveLength(2);
  });
});
