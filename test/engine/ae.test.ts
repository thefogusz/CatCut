import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { createAeBackend, doScriptFile, listAfterFxProcesses, lintMockComp, MockAeBackend, type AeProcess } from '../../src/engine/ae.js';
import type { SpawnFn } from '../../src/engine/aerender.js';
import { UserActionError } from '../../src/core/user-action.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-ae-test-'));
  dirs.push(dir);
  const aep = join(dir, 'งาน.aep');
  await writeFile(aep, 'original');
  const comp = { id: 1, name: 'Title', width: 320, height: 180, fps: 25, durationFrames: 100, numLayers: 1, layers: [], snapshot: { text: 'สวัสดี' } };
  const spawn = vi.fn(async (_bin: string, args: string[]) => {
    expect(args.slice(0, 3)).toEqual(['-m', '-noui', '-r']);
    const launcher = await readFile(args[3]!, 'utf8');
    const jobPath = JSON.parse(launcher.match(/var EDITMCP_JOB = (.*);/)![1]!);
    const job = JSON.parse(await readFile(jobPath, 'utf8'));
    if (job.action === 'edit') {
      expect(job.aep).not.toBe(aep);
      await writeFile(job.aep, 'edited');
    }
    const data = job.action === 'version' ? '26.0' : job.action === 'list' ? [comp] : job.action === 'fingerprint' ? { Title: comp.snapshot } : comp;
    await writeFile(job.result, JSON.stringify({ ok: true, data, log: ['done'] }));
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const processes = vi.fn(async (): Promise<AeProcess[]> => []);
  const backend = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com' }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, listProcesses: processes });
  return { dir, aep, spawn, backend, comp, processes };
}

/** Backend whose fake AfterFX answers list/fingerprint and whose fake aerender writes `frames` frames. */
async function renderSetup(opts: { comp?: string; durationFrames?: number; displayStartFrame?: number; aerender?: (args: string[]) => { exitCode: number; stdout: string; write?: boolean } } = {}) {
  const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-ae-render-'));
  dirs.push(dir);
  const aep = join(dir, 'โปรเจกต์.aep');
  await writeFile(aep, 'project');
  const name = opts.comp ?? 'คอมพ์ไทย';
  const info = { id: 1, name, width: 320, height: 180, fps: 25, durationFrames: opts.durationFrames ?? 50, displayStartFrame: opts.displayStartFrame ?? 0, numLayers: 0 };
  const written = new Map<string, number>();
  const spawn = vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'AfterFX.com') {
      const launcher = await readFile(args[3]!, 'utf8');
      const job = JSON.parse(await readFile(JSON.parse(launcher.match(/var EDITMCP_JOB = (.*);/)![1]!), 'utf8'));
      const data = job.action === 'list' ? [info] : { [name]: { ...info, layers: [] } };
      await writeFile(job.result, JSON.stringify({ ok: true, data }));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (bin === 'aerender.exe') {
      const r = opts.aerender?.(args) ?? { exitCode: 0, stdout: 'PROGRESS: Frame Rate: 25\nPROGRESS: Duration: 0:00:00:10' };
      const out = args[args.indexOf('-output') + 1]!;
      if (r.exitCode === 0 && r.write !== false) {
        await writeFile(out, args[args.indexOf('-OMtemplate') + 1]!);
        written.set(out, Number(args[args.indexOf('-e') + 1]) - Number(args[args.indexOf('-s') + 1]) + 1);
      }
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: '' };
    }
    if (bin === 'ffprobe') return { exitCode: 0, stdout: String(written.get(args[args.length - 1]!) ?? 0), stderr: '' };
    if (bin === 'ffmpeg') {
      const src = args[args.indexOf('-i') + 1]!;
      await writeFile(args[args.length - 1]!, 'converted');
      written.set(args[args.length - 1]!, written.get(src) ?? 0);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const backend = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com', aerender: 'aerender.exe' }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, listProcesses: async () => [], statfs: async () => ({ bavail: 10 ** 12, bsize: 1 }), retryDelayMs: 0 });
  return { dir, aep, name, spawn, backend };
}
const callsOf = (spawn: { mock: { calls: unknown[][] } }, bin: string) => spawn.mock.calls.filter((c) => c[0] === bin).map((c) => c[1] as string[]);

describe('headless AE backend (mock processes only)', () => {
  it('is lazy; lists, inspects and fingerprints using a UTF-8 file job', async () => {
    const { aep, spawn, backend } = await setup();
    expect(spawn).not.toHaveBeenCalled();
    expect((await backend.listComps(aep))[0]?.name).toBe('Title');
    const detail = await backend.inspectComp(aep, 'Title');
    expect(detail.fingerprint).toMatch(/^[a-f0-9]{40}$/);
    expect((await backend.fingerprint(aep, ['Title'])).Title).toBe(detail.fingerprint);
    expect(await backend.version()).toBe('26.0');
  });
  it('edits a working copy, backs up the source, and never overwrites saveAs', async () => {
    const { dir, aep, backend } = await setup();
    const result = await backend.edit({ aep, comp: 'Title', ops: [{ op: 'setText', layer: 'Text', text: 'ใหม่' }] });
    expect(result.ok).toBe(true);
    expect(await readFile(aep, 'utf8')).toBe('edited');
    const backup = result.log.find((l) => l.startsWith('backup: '))!.slice(8);
    expect(await readFile(backup, 'utf8')).toBe('original');
    const saveAs = join(dir, 'copy.aep');
    await copyFile(aep, saveAs, constants.COPYFILE_EXCL);
    await expect(backend.edit({ aep, comp: 'Title', ops: [], saveAs })).rejects.toThrow(/exist|overwrite/);
  });
  it('keeps the original intact on AE failure or concurrent source changes', async () => {
    const { aep, spawn, backend } = await setup();
    spawn.mockImplementationOnce(async () => ({ exitCode: 1, stdout: '', stderr: 'bad effect' }));
    await expect(backend.edit({ aep, comp: 'Title', ops: [] })).rejects.toThrow(/bad effect/);
    expect(await readFile(aep, 'utf8')).toBe('original');
    const run = spawn.getMockImplementation()!;
    spawn.mockImplementationOnce(async (bin, args) => { const r = await run(bin, args); await writeFile(aep, 'changed externally'); return r; });
    await expect(backend.edit({ aep, comp: 'Title', ops: [] })).rejects.toThrow(/changed/);
    expect(await readFile(aep, 'utf8')).toBe('changed externally');
  });
  it('reports missing AE only when a command is used', async () => {
    const backend = createAeBackend({ ffmpeg: '', ffprobe: '' });
    await expect(backend.version()).rejects.toThrow(/AfterFX/);
  });
  it('invalidates proxies and changes to later image-sequence frames, but not a bare project re-save', async () => {
    const { dir, aep, comp, backend } = await setup();
    const first = join(dir, 'frame001.png'), later = join(dir, 'frame002.png'), proxy = join(dir, 'proxy.mov');
    await writeFile(first, 'first'); await writeFile(later, 'later'); await writeFile(proxy, 'proxy');
    const snapshot = { usesExpression: true, sequenceSource: { file: first, sequence: true }, proxy: { file: proxy } };
    Object.assign(comp, { snapshot });
    const a = (await backend.fingerprint(aep)).Title;
    await writeFile(later, 'changed later frame');
    const b = (await backend.fingerprint(aep)).Title;
    expect(b).not.toBe(a);
    await writeFile(proxy, 'changed proxy');
    const c = (await backend.fingerprint(aep)).Title;
    expect(c).not.toBe(b);
    await writeFile(aep, 'project saved, comp unchanged');
    expect((await backend.fingerprint(aep)).Title).toBe(c);
  });
  it('changes with sampled expression values and reports comps with opaque values', async () => {
    const { aep, comp, backend } = await setup();
    const prop = { expression: 'thisComp.layer("Ctrl").effect("S")(1)', samples: [{ f: 0, v: 1 }, { f: 99, v: 1 }] };
    Object.assign(comp, { snapshot: { layers: [{ properties: [prop, { matchName: 'ADBE CurvesCustom', opaque: true }] }] } });
    const before = await backend.fingerprintDetailed(aep, ['Title']);
    expect(before.Title!.opaque).toBe(true);
    prop.samples[1]!.v = 2; // the controlling comp changed what the expression returns
    expect((await backend.fingerprintDetailed(aep, ['Title'])).Title!.hash).not.toBe(before.Title!.hash);
    Object.assign(comp, { snapshot: { layers: [] } });
    expect((await backend.fingerprintDetailed(aep, ['Title'])).Title!.opaque).toBe(false);
  });
  it('warns when an After Effects GUI is running during an in-place edit', async () => {
    const { aep, backend, processes } = await setup();
    processes.mockResolvedValue([{ name: 'AfterFX.exe', pid: 4242, title: 'Adobe After Effects 2026 - D:\\job\\งาน.aep' }, { name: 'AfterFX.exe', pid: 7, title: 'N/A' }]);
    const result = await backend.edit({ aep, comp: 'Title', ops: [{ op: 'setText', layer: 'Text', text: 'ใหม่' }] });
    expect(result.aeGuiRunning).toBe(true);
    expect(result.warning).toMatch(/4242.*saveAs/);
    expect(result.warning).not.toMatch(/\b7\b/);
    expect(result.log.some((l) => l.startsWith('WARNING:') && l.includes('this project open'))).toBe(true);
    processes.mockResolvedValue([{ name: 'AfterFX.exe', pid: 7, title: 'N/A' }]);
    expect((await backend.edit({ aep, comp: 'Title', ops: [] })).aeGuiRunning).toBe(false);
  });
  it('re-checks the source right before replacing it', async () => {
    const { aep, backend, processes } = await setup();
    // Runs after the first hash check and before the rename: simulates a GUI save in that window.
    processes.mockImplementation(async () => { await writeFile(aep, 'saved by GUI meanwhile'); return []; });
    await expect(backend.edit({ aep, comp: 'Title', ops: [] })).rejects.toThrow(/changed/);
    expect(await readFile(aep, 'utf8')).toBe('saved by GUI meanwhile');
  });
  it('parses tasklist output for AfterFX processes', async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: [
      '"AfterFX.exe","1234","Console","1","2,000,000 K","Running","PC\\u","0:01:00","Adobe After Effects 2026 - D:\\a.aep"',
      '"AfterFX.exe","99","Console","1","500,000 K","Unknown","PC\\u","0:00:05","N/A"',
    ].join('\r\n') }));
    const procs = await listAfterFxProcesses(spawn as unknown as SpawnFn);
    if (process.platform !== 'win32') { expect(procs).toEqual([]); return; }
    expect(procs).toEqual([{ name: 'AfterFX.exe', pid: 1234, title: 'Adobe After Effects 2026 - D:\\a.aep' }, { name: 'AfterFX.exe', pid: 99, title: 'N/A' }]);
  });
  it('kills a hung fingerprint job after the configurable timeout', async () => {
    const { aep } = await setup();
    const spawn = vi.fn((bin: string) => {
      if (bin === 'taskkill') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      let finish: (value: unknown) => void;
      const promise = new Promise((resolve) => { finish = resolve; });
      return Object.assign(promise, { pid: 999, kill: () => finish({ exitCode: 1, stdout: '', stderr: '' }) });
    });
    const backend = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com' }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, fingerprintTimeoutMs: 30 });
    await expect(backend.fingerprint(aep)).rejects.toThrow(/fingerprint timed out after 30 ms/);
  });
});

describe('AE renders through the backend (mock processes only)', () => {
  it('renders the whole comp with an explicit range from the comp duration, display start and -mfr', async () => {
    const { dir, aep, name, spawn, backend } = await renderSetup({ durationFrames: 50, displayStartFrame: 90000 });
    await backend.fingerprint(aep, [name]);
    const r = await backend.render({ aep, comp: name, outPath: join(dir, 'ผลลัพธ์.mov') });
    expect(r.frames).toBe(50);
    const [args] = callsOf(spawn, 'aerender.exe');
    expect(args![args!.indexOf('-project') + 1]).toBe(aep);
    expect(args![args!.indexOf('-comp') + 1]).toBe(name);
    expect(args).toEqual(expect.arrayContaining(['-s', '90000', '-e', '90049', '-mfr', 'ON']));
    expect(Number(args![args!.indexOf('-mfr') + 2])).toBeGreaterThan(0);
    expect(callsOf(spawn, 'AfterFX.com')).toHaveLength(1); // timing reused from the fingerprint job
    await writeFile(aep, 'saved again');
    await backend.render({ aep, comp: name, outPath: join(dir, 'ผลลัพธ์.mov') });
    expect(callsOf(spawn, 'AfterFX.com')).toHaveLength(2); // project changed -> timing re-read
  });
  it('previews a frame using the display-start offset', async () => {
    const { dir, aep, name, spawn, backend } = await renderSetup({ durationFrames: 50, displayStartFrame: 100 });
    await backend.previewFrame(aep, name, 7, join(dir, 'เฟรม.png'));
    expect(callsOf(spawn, 'aerender.exe')[0]).toEqual(expect.arrayContaining(['-s', '107', '-e', '107']));
    await expect(backend.previewFrame(aep, name, 50, join(dir, 'x.png'))).rejects.toThrow(/past the end/);
  });
  it('falls back to Lossless only for a missing ProRes output-module template', async () => {
    const { dir, aep, name, spawn, backend } = await renderSetup({
      aerender: (args) => args.includes('EDITMCP ProRes 422 HQ')
        ? { exitCode: 1, stdout: 'aerender ERROR: No output module template was found with the given name.' }
        : { exitCode: 0, stdout: '' },
    });
    const r = await backend.render({ aep, comp: name, outPath: join(dir, 'a.mov') });
    expect(r.usedFallback).toBe(true);
    expect(callsOf(spawn, 'aerender.exe').map((a) => a[a.indexOf('-OMtemplate') + 1])).toEqual(['EDITMCP ProRes 422 HQ', 'Lossless']);
    expect(callsOf(spawn, 'ffmpeg')[0]).toEqual(expect.arrayContaining(['-colorspace', 'bt709']));
  });
  it('falls back when aerender reports the missing template but exits 0 without output (AE 2026)', async () => {
    const { dir, aep, name, spawn, backend } = await renderSetup({
      aerender: (args) => args.includes('EDITMCP ProRes 422 HQ')
        ? { exitCode: 0, stdout: 'PROGRESS: Launching After Effects...\naerender ERROR: No output module template was found with the given name.', write: false }
        : { exitCode: 0, stdout: '' },
    });
    const r = await backend.render({ aep, comp: name, outPath: join(dir, 'a.mov') });
    expect(r.usedFallback).toBe(true);
    expect(callsOf(spawn, 'aerender.exe').map((a) => a[a.indexOf('-OMtemplate') + 1])).toEqual(['EDITMCP ProRes 422 HQ', 'Lossless']);
  });
  it('does not fall back when names merely contain "missing"/"not"/"invalid"', async () => {
    const comp = 'template missing not invalid';
    const { dir, aep, spawn, backend } = await renderSetup({
      comp,
      aerender: () => ({ exitCode: 1, stdout: `aerender ERROR: Unable to render ${comp}: the output module template is invalid for "${comp}"` }),
    });
    await expect(backend.render({ aep, comp, outPath: join(dir, 'a.mov') })).rejects.toThrow(/exited with code 1/);
    expect(callsOf(spawn, 'aerender.exe')).toHaveLength(1);
  });
});

describe('AE analysis commands through the headless backend (mock processes only)', () => {
  /** Fake AfterFX answering each runner action with `answers[action]`; records every job. */
  async function analysisSetup(answers: Record<string, unknown>, opts: { statfsGb?: number } = {}) {
    const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-ae-analysis-'));
    dirs.push(dir);
    const aep = join(dir, 'เทมเพลต.aep');
    await writeFile(aep, 'template');
    const jobs: Array<Record<string, unknown>> = [];
    const spawn = vi.fn(async (_bin: string, args: string[]) => {
      const launcher = await readFile(args[3]!, 'utf8');
      const job = JSON.parse(await readFile(JSON.parse(launcher.match(/var EDITMCP_JOB = (.*);/)![1]!), 'utf8'));
      jobs.push(job);
      await writeFile(job.result, JSON.stringify({ ok: true, data: answers[job.action] ?? null }));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com' }, {
      spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, listProcesses: async () => [],
      statfs: async () => ({ bavail: (opts.statfsGb ?? 100) * 2 ** 30, bsize: 1 }), cacheDir: dir,
    });
    return { aep, spawn, jobs, backend };
  }

  it('parses scanTemplate results and fills aep/warnings', async () => {
    const comp = { name: 'Scene 1', durationFrames: 150, width: 1920, height: 1080, fonts: ['Kanit-Bold'], expressionLocked: ['Title > Transform > Position'],
      placeholders: [{ layer: 'Photo', kind: 'footage', moving: false, matte: 'Window' }], textAnimators: [{ layer: 'Title', basedOn: 'words' }] };
    const { aep, jobs, backend } = await analysisSetup({ scanTemplate: { comps: [comp] } });
    const scan = await backend.scanTemplate(aep);
    expect(scan.aep).toBe(aep);
    expect(scan.warnings).toEqual([]);
    expect(scan.comps[0]).toMatchObject({ name: 'Scene 1', placeholders: [{ layer: 'Photo', moving: false }] });
    expect(jobs[0]).toMatchObject({ action: 'scanTemplate', aep });
  });
  it('lintComp sends only threshold rules to the runner and returns its issues', async () => {
    const lint = { comp: 'Title', issues: [{ kind: 'animation-ends-early', layer: 'หัวข้อ', frame: 25, message: 'stops' }] };
    const { aep, jobs, backend } = await analysisSetup({ lintComp: lint });
    expect(await backend.lintComp(aep, 'Title')).toEqual(lint);
    expect(jobs[0]).toMatchObject({ action: 'lintComp', comp: 'Title', rules: null });
    await backend.lintComp(aep, 'Title', { thai: { minCapHeightPct: 4, animateBy: 'line' }, safeMarginPct: 5, palette: ['#fff'] });
    expect(jobs[1]!.rules).toEqual({ thai: { minCapHeightPct: 4 }, safeMarginPct: 5 });
  });
  it('lists fonts (plain and detailed) and purges caches without opening a project', async () => {
    const { aep, jobs, backend } = await analysisSetup({ listFonts: { fonts: ['Kanit-Bold', 'ArialMT'], families: ['Kanit', 'Arial'], aeMissing: null }, purge: { purged: 'ALL_CACHES' } });
    expect(await backend.listFonts(aep)).toEqual(['Kanit-Bold', 'ArialMT']);
    expect(await backend.listFontsDetailed(aep)).toEqual({ fonts: ['Kanit-Bold', 'ArialMT'], families: ['Kanit', 'Arial'], aeMissing: null });
    await backend.purgeCaches();
    expect(jobs.map((j) => j.action)).toEqual(['listFonts', 'listFonts', 'purge']);
    expect(jobs[2]!.aep).toBeUndefined();
  });
  it('afterRenderBatch purges only when the cache drive is low', async () => {
    const roomy = await analysisSetup({ purge: {} }, { statfsGb: 80 });
    expect(await roomy.backend.afterRenderBatch()).toMatchObject({ purged: false });
    expect(roomy.spawn).not.toHaveBeenCalled();
    const low = await analysisSetup({ purge: {} }, { statfsGb: 8 });
    expect(await low.backend.afterRenderBatch()).toMatchObject({ purged: true, freeGbBefore: 8 });
    expect(low.jobs.map((j) => j.action)).toEqual(['purge']);
    expect(await low.backend.afterRenderBatch({ enabled: false })).toMatchObject({ purged: false, reason: 'disabled' });
  });
});

describe('MockAeBackend', () => {
  const comp = {
    name: 'Card', width: 1920, height: 1080, durationFrames: 250,
    layers: [
      { name: 'Title', kind: 'text' as const, text: 'Hello', font: 'Kanit-Bold', fontFamily: 'Kanit', lastKeyFrame: 30, animators: [{ basedOn: 'words' as const }] },
      { name: 'Photo', kind: 'footage' as const, source: 'photo.mov', matted: true, continuous: true },
      { name: 'Window', kind: 'shape' as const, isMatte: true, enabled: false },
      { name: 'Logo slot', kind: 'precomp' as const, source: 'logo comp' },
      { name: 'BG', kind: 'solid' as const, outFrame: 200, bounds: { x: 0, y: 0, w: 1, h: 1 } },
    ],
  };
  it('scans placeholders like the runner (matte window = still) and never spawns', async () => {
    const ae = new MockAeBackend({ comps: [comp], aeMissingFonts: ['Kanit-Bold'] });
    const scan = await ae.scanTemplate('x.aep');
    expect(scan.comps[0]!.placeholders).toEqual([
      { layer: 'Title', kind: 'text', moving: true },
      { layer: 'Photo', kind: 'footage', source: 'photo.mov', moving: false },
      { layer: 'Logo slot', kind: 'precomp', source: 'logo comp', moving: true },
    ]);
    expect(await ae.listFontsDetailed()).toEqual({ fonts: ['Kanit-Bold'], families: ['Kanit'], aeMissing: ['Kanit-Bold'] });
    await ae.purgeCaches();
    expect(ae.purged).toBe(1);
  });
  it('lints with the runner rules', () => {
    const kinds = lintMockComp(comp).issues.map((i) => `${i.kind}:${i.layer}`);
    expect(kinds).toEqual(['animation-ends-early:Title', 'background-ends-early:BG']);
  });
  it('writes preview frames without overwriting', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-mock-'));
    dirs.push(dir);
    const ae = new MockAeBackend({ comps: [comp] });
    const a = await ae.previewFrame('x.aep', 'Card', 10, join(dir, 'f.png'));
    const b = await ae.previewFrame('x.aep', 'Card', 10, join(dir, 'f.png'));
    expect(a).not.toBe(b);
    expect((await readFile(a)).subarray(1, 4).toString()).toBe('PNG');
    await expect(ae.previewFrame('x.aep', 'Card', 250, join(dir, 'g.png'))).rejects.toThrow(/past the end/);
  });
});

describe('After Effects on macOS (AppleScript DoScriptFile)', () => {
  const APP = '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app';

  it('builds an AppleScript that targets the app by name and waits up to the job timeout', () => {
    const script = doScriptFile(APP, '/tmp/editmcp-ae-x/launch.jsx', 120_500);
    expect(script).toBe([
      'with timeout of 121 seconds',
      '  tell application "Adobe After Effects 2026" to DoScriptFile "/tmp/editmcp-ae-x/launch.jsx"',
      'end timeout',
    ].join('\n'));
    expect(doScriptFile(APP, '/tmp/a"b\\c.jsx', 1000)).toContain('DoScriptFile "/tmp/a\\"b\\\\c.jsx"');
  });

  it('runs jobs through osascript, trusts the result file over osascript\'s exit code, and waits for AE to quit', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'editmcp-ae-mac-'));
    dirs.push(dir);
    let aeOpen = false;
    const spawn = vi.fn(async (bin: string, args: string[]) => {
      expect(bin).toBe('osascript');
      const launcher = /DoScriptFile "(.*)"/.exec(args[1]!)![1]!;
      const job = JSON.parse(await readFile(JSON.parse((await readFile(launcher, 'utf8')).match(/var EDITMCP_JOB = (.*);/)![1]!), 'utf8'));
      await writeFile(job.result, JSON.stringify({ ok: true, data: '26.0' }));
      aeOpen = true;
      setTimeout(() => { aeOpen = false; }, 30);
      // AE quitting under osascript: connection invalid (-609), exit 1
      return { exitCode: 1, stdout: '', stderr: 'execution error: Connection is invalid. (-609)' };
    });
    const listProcesses = vi.fn(async (): Promise<AeProcess[]> => (aeOpen ? [{ name: 'After Effects', pid: 4242, title: 'Adobe After Effects 2026' }] : []));
    const backend = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: APP }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, listProcesses, macQuitWaitMs: 5000 });
    expect(await backend.version()).toBe('26.0');
    expect(aeOpen).toBe(false);
    expect(listProcesses.mock.calls.length).toBeGreaterThan(1);
  });

  it('refuses to run inside an After Effects the person has open, and asks for Automation access when macOS blocks it', async () => {
    const spawn = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'Not authorized to send Apple events to Adobe After Effects 2026. (-1743)' }));
    const open = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: APP }, {
      spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, listProcesses: async () => [{ name: 'After Effects', pid: 7, title: 'Adobe After Effects 2026' }],
    });
    const e1 = await open.version().catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(UserActionError);
    expect((e1 as UserActionError).userAction.code).toBe('ae-close-mac');
    expect(spawn).not.toHaveBeenCalled();

    const blocked = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: APP }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, listProcesses: async () => [] });
    const e2 = await blocked.version().catch((e: unknown) => e);
    expect((e2 as UserActionError).userAction.code).toBe('mac-automation');
  });
});
