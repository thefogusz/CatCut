/**
 * MCP server tests over InMemoryTransport.
 * Part 1 uses the real core modules (project, jobs) and fakes only the process-spawning parts
 * (Assembler/probe, xmeml, AE) so no ffmpeg/AE runs. Part 2 requires every real module
 * to load and uses ffmpeg on a tiny synthetic clip; Adobe is never launched.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import type { AeBackend, Project, Timeline, Version } from '../../src/core/types.js';
import { createServer } from '../../src/mcp/server.js';
import { createAppState, safeEnvironment, type AppState } from '../../src/mcp/state.js';
import { applyEditOps, callTool, diffTimelines, toolResultData, TOOLS, uniquePath } from '../../src/mcp/tools.js';

const TMP_ROOT = join(process.cwd(), 'tmp', 'mcp-test');
const MEDIA_DIR = join(process.cwd(), 'tmp', 'test-media');

// doctor launches After Effects only when EDITMCP_ALLOW_AE=1: never let a developer's shell enable that here.
const savedAllowAe = process.env['EDITMCP_ALLOW_AE'];
delete process.env['EDITMCP_ALLOW_AE'];
afterAll(() => {
  if (savedAllowAe !== undefined) process.env['EDITMCP_ALLOW_AE'] = savedAllowAe;
});

// ---------- fakes for the process-spawning modules ----------

function fakeAe(): AeBackend {
  let fp = 1;
  return {
    kind: 'mock',
    async listComps() { return [{ id: 1, name: 'Title_01', width: 1920, height: 1080, fps: 25, durationFrames: 100, numLayers: 2 }]; },
    async inspectComp(_aep, comp) { return { id: 1, name: comp, width: 1920, height: 1080, fps: 25, durationFrames: 100, numLayers: 0, layers: [], fingerprint: `fp${fp}` }; },
    async fingerprint() { return { Title_01: `fp${fp}` }; },
    async edit(req) { fp++; return { ok: true, savedTo: req.saveAs ?? req.aep, fingerprint: `fp${fp}`, log: ['edited'] }; },
    async create(req) {
      if (req.jsx.includes('throw')) throw new Error('AfterFX: Error: boom (line 1)');
      await writeFile(req.saveAs, req.jsx);
      return { savedTo: req.saveAs, comps: [{ id: 1, name: 'HeartFX', width: 1920, height: 1080, fps: 30, durationFrames: 180, numLayers: 3 }], log: ['built'] };
    },
    async render() { throw new Error('render not available in fake'); },
    async previewFrame(_aep, _comp, _frame, outPng) { await writeFile(outPng, ''); return outPng; },
    async version() { return 'fake 26.5'; },
  };
}

async function fakeState(): Promise<AppState> {
  const { env } = await safeEnvironment();
  return {
    env,
    ae: fakeAe(),
    jobs: new JobManager(),
    problems: [],
    api: {
      project: projectApi,
      xmeml: {
        writeXmeml: (p, o) => `<?xml version="1.0" encoding="UTF-8"?><xmeml version="5"><sequence><name>${o.sequenceName}</name><clips>${p.timeline.video.length}</clips></sequence></xmeml>`,
        readXmeml: (xml, p) => {
          const tl = JSON.parse(xml) as Timeline; // the test feeds JSON through the fake reader
          return { fps: p?.meta.fps ?? 25, width: 1920, height: 1080, timeline: tl, unresolvedPaths: [] };
        },
      },
      probe: async () => ({ durationFrames: 100, width: 640, height: 360, fps: 25, hasVideo: true, hasAudio: true }),
    },
    assembler: {
      async build(p, opts) {
        opts?.onProgress?.({ stage: 'segments', done: 1, total: 1 });
        if (opts?.signal?.aborted) throw new Error('aborted');
        const id = projectApi.nextVersionId(p);
        const frames = projectApi.timelineFrames(p);
        const v: Version = {
          id, createdAt: new Date().toISOString(), planHash: projectApi.planHash(p), master: join(p.dir, 'out', id, `${p.meta.name}_${id}.mov`), deliverables: {},
          qc: { ok: true, frames, expectedFrames: frames, issues: [] },
          stats: { segmentsTotal: p.timeline.video.length, segmentsRendered: 0, segmentsReused: p.timeline.video.length, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: { total: 1 } },
        };
        p.versions.push(v);
        await projectApi.saveProject(p);
        return { version: v, stats: v.stats };
      },
      async deliver(p, versionId, targets) {
        return Object.fromEntries(targets.map((t) => [t, join(p.dir, 'out', versionId, `${t}.mp4`)]));
      },
      async reviewProxy(p, versionId) { return join(p.dir, 'review', `${versionId}.mp4`); },
    },
  };
}

async function connect(state: AppState): Promise<Client> {
  const server = await createServer(state);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

type Body = Record<string, unknown>;
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: Body }> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  let data: Body;
  try {
    data = JSON.parse(text) as Body;
  } catch {
    data = { error: text }; // schema rejections come from the SDK as plain "MCP error -32602: ..." text
  }
  return { isError: !!r.isError, data };
}

const EXPECTED_TOOLS = [
  'project_new', 'project_open', 'project_status', 'delivery_presets', 'asset_add', 'asset_list', 'timeline_set', 'timeline_edit', 'audio_add',
  'ae_list_comps', 'ae_inspect_comp', 'ae_edit', 'ae_create', 'ae_preview_frame', 'build', 'deliver', 'job_status', 'job_wait', 'job_list',
  'qc_report', 'export_premiere_xml', 'import_premiere_xml', 'timeline_restore', 'doctor',
  'preview', 'review_open', 'review_notes', 'review_submit', 'review_close',
];

// ---------- part 1: real core, fake engines ----------

describe('mcp server (real core, fake engines)', () => {
  let client: Client;
  let state: AppState;
  let dir: string;
  let mediaFile: string;

  beforeAll(async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    dir = await mkdtemp(join(TMP_ROOT, 'proj-'));
    mediaFile = join(dir, 'คลิป01.mov');
    await writeFile(mediaFile, 'not really a movie');
    state = await fakeState();
    client = await connect(state);
  });
  afterAll(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists all agreed tools with descriptions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of EXPECTED_TOOLS) expect(names).toContain(n);
    expect(names).toEqual([...new Set(names)]);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(5);
    expect(TOOLS.length).toBe(tools.length);
  });

  it('doctor reports tools, encoders, RAM and never launches AE', async () => {
    const { isError, data } = await call(client, 'doctor');
    expect(isError).toBe(false);
    expect(data['tools']).toBeDefined();
    expect(data['encoders']).toBeDefined();
    expect((data['ram'] as Body)['totalGb']).toBeGreaterThan(0);
    expect(data['aeVersion']).toBe('unknown (not launched)');
    expect((data['compat'] as string[]).length).toBeGreaterThan(3);
  });

  it('refuses project tools before a project is open', async () => {
    const { isError, data } = await call(client, 'project_status');
    expect(isError).toBe(true);
    expect(String(data['error'])).toMatch(/project_new|project_open/);
  });

  it('project_new creates project.json and becomes current; never overwrites', async () => {
    const pdir = join(dir, 'โปรเจกต์');
    const { isError, data } = await call(client, 'project_new', { dir: pdir, name: 'ทดสอบ', fps: 25 });
    expect(isError).toBe(false);
    expect(data['name']).toBe('ทดสอบ');
    expect(data['size']).toBe('1920x1080');
    expect(existsSync(join(pdir, 'project.json'))).toBe(true);
    const again = await call(client, 'project_new', { dir: pdir, name: 'x' });
    expect(again.isError).toBe(true);
    expect(state.project!.meta.name).toBe('ทดสอบ');
  });

  it('timeline_set rejects an invalid timeline with validation errors and keeps the old one', async () => {
    const { isError, data } = await call(client, 'timeline_set', {
      timeline: { video: [{ id: 's1', src: 'NOPE', in: 0, dur: 0 }], cuts: [{ after: 's1', dissolve: 10 }] },
    });
    expect(isError).toBe(true);
    const errors = data['errors'] as string[];
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join('\n')).toMatch(/unknown asset/);
    expect(state.project!.timeline.video).toHaveLength(0);
  });

  it('timeline_set rejects malformed input (schema) without touching the project', async () => {
    const { isError } = await call(client, 'timeline_set', { timeline: { video: [{ id: 's1' }] } });
    expect(isError).toBe(true);
    expect(state.project!.timeline.video).toHaveLength(0);
  });

  it('asset_add + timeline_set + timeline_edit + audio_add', async () => {
    const a1 = await call(client, 'asset_add', { path: mediaFile, id: 'A01' });
    expect(a1.isError).toBe(false);
    expect((a1.data['asset'] as Body)['frames']).toBe(100);
    const a2 = await call(client, 'asset_add', { path: mediaFile, id: 'A02', kind: 'graphic' });
    expect(a2.isError).toBe(false);
    expect((a2.data['asset'] as Body)['kind']).toBe('graphic');
    const bad = await call(client, 'asset_add', {});
    expect(bad.isError).toBe(true);
    const missing = await call(client, 'asset_add', { path: join(dir, 'nope.mov') });
    expect(missing.isError).toBe(true);
    const list = await call(client, 'asset_list');
    expect((list.data['assets'] as Body[]).map((a) => a['id'])).toEqual(['A01', 'A02']);

    const set = await call(client, 'timeline_set', {
      timeline: { video: [{ id: 's1', src: 'A01', in: 0, dur: 50 }, { id: 's2', src: 'A02', in: 10, dur: 40, marker: 'เปิดเรื่อง' }] },
    });
    expect(set.isError).toBe(false);
    const tl = set.data['timeline'] as Body;
    expect(tl['frames']).toBe(90);
    expect(tl['tc']).toBe('00:00:03:15');
    expect((tl['clips'] as Body[])[1]!['startTc']).toBe('00:00:02:00');

    const edit = await call(client, 'timeline_edit', {
      ops: [
        { op: 'set_dissolve', after: 's1', frames: 10 },
        { op: 'insert', clip: { id: 's3', src: 'A01', in: 50, dur: 25 }, after: 's2' },
        { op: 'trim', id: 's2', dur: 30 },
        { op: 'set_scale', id: 's3', scale: 110 },
      ],
    });
    expect(edit.isError).toBe(false);
    const p = state.project!;
    expect(p.timeline.video.map((c) => c.id)).toEqual(['s1', 's2', 's3']);
    expect(p.timeline.cuts).toEqual([{ after: 's1', dissolve: 10 }]);
    expect(p.timeline.video[1]!.dur).toBe(30);
    expect(p.timeline.video[2]!.scale).toBe(110);

    const invalid = await call(client, 'timeline_edit', { ops: [{ op: 'trim', id: 's1', dur: 200 }] });
    expect(invalid.isError).toBe(true);
    expect((invalid.data['errors'] as string[]).join()).toMatch(/exceeds source length/);
    expect(p.timeline.video[0]!.dur).toBe(50);

    const unknown = await call(client, 'timeline_edit', { ops: [{ op: 'remove', id: 'zzz' }] });
    expect(unknown.isError).toBe(true);

    const au = await call(client, 'audio_add', { track: 'music', src: 'A01', at: 0, duck: { underDb: -12, attackMs: 150, releaseMs: 400 } });
    expect(au.isError).toBe(false);
    expect((au.data['clip'] as Body)['id']).toBe('music1');
    expect(p.timeline.audio.duck?.underDb).toBe(-12);
    const auBad = await call(client, 'audio_add', { track: 'vo', src: 'NOPE' });
    expect(auBad.isError).toBe(true);
    expect(p.timeline.audio.vo).toHaveLength(0);
    const rmAudio = await call(client, 'timeline_edit', { ops: [{ op: 'remove_audio', id: 'music1' }, { op: 'set_marker', id: 's2' }] });
    expect(rmAudio.isError).toBe(false);
    expect(p.timeline.audio.music).toHaveLength(0);
    expect(p.timeline.video[1]!.marker).toBeUndefined();
    const au2 = await call(client, 'audio_add', { track: 'music', src: 'A01' });
    expect(au2.isError).toBe(false);

    const saved = JSON.parse(await readFile(join(p.dir, 'project.json'), 'utf8')) as Project;
    expect(saved.timeline.audio.music).toHaveLength(1);
    expect(saved.timeline.video).toHaveLength(3);
  });

  it('build returns a job id immediately; job_status shows the result; deliver uses the version', async () => {
    const b = await call(client, 'build', {});
    expect(b.isError).toBe(false);
    const jobId = String(b.data['jobId']);
    expect(jobId).toMatch(/^job-\d{4}$/);
    const info = await state.jobs.wait(jobId);
    expect(info.status).toBe('done');
    const js = await call(client, 'job_status', { id: jobId });
    expect(js.isError).toBe(false);
    expect((js.data['result'] as Body)['version']).toBe('v001');
    expect((js.data['log'] as string[]).join()).toMatch(/segments 1\/1/);
    const st = await call(client, 'project_status');
    expect(((st.data['versions'] as Body)['latest'] as Body)['id']).toBe('v001');
    const qc = await call(client, 'qc_report', {});
    expect((qc.data['qc'] as Body)['ok']).toBe(true);
    const jl = await call(client, 'job_list');
    expect((jl.data['jobs'] as Body[]).length).toBe(1);
    const jsBad = await call(client, 'job_status', { id: 'job-9999' });
    expect(jsBad.isError).toBe(true);

    const d = await call(client, 'deliver', { targets: ['yt', 'th_tv'] });
    expect(d.isError).toBe(false);
    const dinfo = await state.jobs.wait(String(d.data['jobId']));
    expect(Object.keys((dinfo.result as Body)['deliverables'] as Body)).toEqual(['yt', 'th_tv']);
    const dbad = await call(client, 'deliver', { version: 'v999' });
    expect(dbad.isError).toBe(true);
    const dnone = await call(client, 'deliver', {});
    expect(dnone.isError).toBe(true); // project.delivery.targets is empty by default
  });

  it('export_premiere_xml writes a new file every time (never overwrites)', async () => {
    const x1 = await call(client, 'export_premiere_xml', {});
    expect(x1.isError).toBe(false);
    const p1 = String(x1.data['path']);
    expect(existsSync(p1)).toBe(true);
    expect(p1).toMatch(/[\\/]out[\\/]v001[\\/]/);
    const x2 = await call(client, 'export_premiere_xml', {});
    expect(String(x2.data['path'])).not.toBe(p1);
    expect(await readFile(p1, 'utf8')).toContain('<xmeml');
    const xbad = await call(client, 'export_premiere_xml', { version: 'v777' });
    expect(xbad.isError).toBe(true);
  });

  it('export_premiere_xml {target: "filmcraft"} writes its own file with explicit clip edges', async () => {
    const x = await call(client, 'export_premiere_xml', { target: 'filmcraft' });
    expect(x.isError).toBe(false);
    expect(x.data['target']).toBe('filmcraft');
    const path = String(x.data['path']);
    expect(path).toMatch(/_filmcraft(_\d+)?\.xml$/);
    const xml = await readFile(path, 'utf8');
    expect(xml).toContain('<xmeml');
    expect(xml).not.toMatch(/<(start|end)>-1</);
    expect((await call(client, 'export_premiere_xml', { target: 'avid' })).isError).toBe(true);
  });

  it('import_premiere_xml is a dry run by default; apply backs up the timeline first; timeline_restore undoes it', async () => {
    const p = state.project!;
    const original: Timeline = structuredClone(p.timeline);
    const edited: Timeline = structuredClone(p.timeline);
    edited.video[0]!.dur = 45;
    edited.cuts = [{ after: 's1', dissolve: 13 }];
    const file = join(dir, 'from_premiere.xml');
    await writeFile(file, JSON.stringify(edited), 'utf8');
    const dry = await call(client, 'import_premiere_xml', { path: file });
    expect(dry.isError).toBe(false);
    expect(dry.data).toMatchObject({ dryRun: true, applied: false, valid: true });
    const diff = dry.data['diff'] as Body;
    expect((diff['clips'] as Body)['changed']).toEqual([{ index: 0, id: 's1', field: 'dur', from: 50, to: 45 }]);
    expect(diff['dissolves']).toEqual([{ after: 's1', from: 10, to: 13 }]);
    const summary = (dry.data['summary'] as string[]).join('\n');
    expect(summary).toContain("คลิป #1 's1': dur 50 → 45");
    expect(summary).toContain("dissolve หลัง 's1': 10 → 13");
    expect(p.timeline.video[0]!.dur).toBe(50); // untouched
    expect(existsSync(join(p.dir, 'history'))).toBe(false);

    const r = await call(client, 'import_premiere_xml', { path: file, apply: true });
    expect(r.isError).toBe(false);
    expect(r.data['applied']).toBe(true);
    expect(p.timeline.video[0]!.dur).toBe(45);
    const backup = String(r.data['backup']);
    expect(backup).toMatch(/[\\/]history[\\/]timeline-\d{4}-\d{2}-\d{2}T[\d-]+Z-1\.json$/);
    expect((JSON.parse(await readFile(backup, 'utf8')) as { timeline: Timeline }).timeline).toEqual(original);

    edited.video[0]!.src = 'MISSING';
    await writeFile(file, JSON.stringify(edited), 'utf8');
    const badDry = await call(client, 'import_premiere_xml', { path: file });
    expect(badDry.isError).toBe(false);
    expect(badDry.data['valid']).toBe(false);
    const bad = await call(client, 'import_premiere_xml', { path: file, apply: true });
    expect(bad.isError).toBe(true);
    expect(p.timeline.video[0]!.src).toBe('A01');

    const list = await call(client, 'timeline_restore', {});
    const backups = list.data['backups'] as Body[];
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ clips: 3, frames: original.video.reduce((s, c) => s + c.dur, 0) });
    const traversal = await call(client, 'timeline_restore', { backup: '../project.json' });
    expect(traversal.isError).toBe(true);
    const restored = await call(client, 'timeline_restore', { backup: String(backups[0]!['name']) });
    expect(restored.isError).toBe(false);
    expect(state.project!.timeline).toEqual(original);
    expect(((await call(client, 'timeline_restore', {})).data['backups'] as Body[])).toHaveLength(2); // the restore backed up first
    expect(((JSON.parse(await readFile(join(p.dir, 'project.json'), 'utf8')) as Project).timeline.video[0]!.dur)).toBe(50);
  });

  it('surfaces a conflicting save from another process and reloads so the retry works', async () => {
    const pdir = state.project!.dir;
    const other = await projectApi.loadProject(pdir); // e.g. the CLI in another terminal
    other.timeline.video[2]!.dur = 20;
    await projectApi.saveProject(other);
    const r = await call(client, 'timeline_edit', { ops: [{ op: 'trim', id: 's3', dur: 22 }] });
    expect(r.isError).toBe(true);
    expect(String(r.data['error'])).toContain('โปรเจกต์ถูกแก้จากที่อื่น — โหลดใหม่แล้วลองอีกครั้ง');
    expect(r.data).toMatchObject({ conflicts: ['timeline'], reloaded: true });
    expect(state.project!.timeline.video[2]!.dur).toBe(20); // the other process's edit is kept
    const retry = await call(client, 'timeline_edit', { ops: [{ op: 'trim', id: 's3', dur: 22 }] });
    expect(retry.isError).toBe(false);
    // a version appended elsewhere is merged, not overwritten
    const other2 = await projectApi.loadProject(pdir);
    other2.versions.push({ ...other2.versions[0]!, id: 'v050' });
    await projectApi.saveProject(other2);
    expect((await call(client, 'timeline_edit', { ops: [{ op: 'trim', id: 's3', dur: 25 }] })).isError).toBe(false);
    expect(state.project!.versions.map((v) => v.id)).toContain('v050');
    expect((JSON.parse(await readFile(join(pdir, 'project.json'), 'utf8')) as Project).versions.map((v) => v.id)).toContain('v050');
  });

  it('ae_edit marks matching aecomp assets stale; ae_preview_frame never overwrites', async () => {
    const aep = join(dir, 'titles.aep');
    await writeFile(aep, '');
    const add = await call(client, 'asset_add', { aep, comp: 'Title_01', id: 'C_title' });
    expect(add.isError).toBe(false);
    expect((add.data['asset'] as Body)['needsRender']).toBe(true);
    const e = await call(client, 'ae_edit', { aep, comp: 'Title_01', ops: [{ op: 'setText', layer: 'Text', text: 'สวัสดี' }] });
    expect(e.isError).toBe(false);
    expect(e.data['staleAssets']).toEqual(['C_title']);
    const st = await call(client, 'project_status');
    expect((st.data['assets'] as Body)['compsNeedingRender']).toEqual(['C_title']);
    const comps = await call(client, 'ae_list_comps', { aep });
    expect((comps.data['comps'] as Body[])[0]!['name']).toBe('Title_01');

    const f1 = await call(client, 'ae_preview_frame', { aep, comp: 'Title_01', frame: 10 });
    const f2 = await call(client, 'ae_preview_frame', { aep, comp: 'Title_01', frame: 10 });
    expect(f1.isError).toBe(false);
    expect(String(f1.data['png'])).toMatch(/[\\/]review[\\/]preview_Title_01_10\.png$/);
    expect(String(f1.data['png'])).not.toBe(String(f2.data['png']));
  });

  it('project_open reloads from disk', async () => {
    const pdir = state.project!.dir;
    const r = await call(client, 'project_open', { dir: pdir });
    expect(r.isError).toBe(false);
    expect((r.data['timeline'] as Body)['clips']).toHaveLength(3);
    const bad = await call(client, 'project_open', { dir: join(dir, 'nowhere') });
    expect(bad.isError).toBe(true);
  });
});

describe('AE jobs, write confinement and forceAssets', () => {
  let dir: string;
  beforeAll(async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    dir = await mkdtemp(join(TMP_ROOT, 'ae-'));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function withProject(name: string) {
    const st = await fakeState();
    st.project = await projectApi.createProject(join(dir, name), { name });
    const aep = join(dir, `${name}.aep`);
    await writeFile(aep, '');
    return { st, aep };
  }

  it('AE tools return a job id at once while the job queue is busy; job_status gets the result later', async () => {
    const { st, aep } = await withProject('busy');
    let finish!: () => void;
    const blocker = st.jobs.start('build', () => new Promise<void>((r) => { finish = r; }));
    const t0 = Date.now();
    const r = toolResultData(await callTool(st, 'ae_list_comps', { aep }));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r).toMatchObject({ ok: true, pending: true, status: 'queued' });
    const id = String(r['jobId']);
    finish();
    await st.jobs.wait(blocker.id);
    const done = await st.jobs.wait(id);
    expect(done.status).toBe('done');
    expect((done.result as Body)['comps']).toEqual([expect.objectContaining({ name: 'Title_01' })]);
    // idle queue: waits and returns the result inline; wait:false never waits
    const inline = toolResultData(await callTool(st, 'ae_inspect_comp', { aep, comp: 'Title_01' }));
    expect(inline).toMatchObject({ name: 'Title_01', fingerprint: 'fp1' });
    expect(inline['jobId']).toMatch(/^job-/);
    const nowait = toolResultData(await callTool(st, 'ae_list_comps', { aep, wait: false }));
    expect(nowait['pending']).toBe(true);
    await st.jobs.wait(String(nowait['jobId']));
  });

  it('ae_create builds a new .aep from a script, registers the comp and repoints it on revision', async () => {
    const { st } = await withProject('create');
    const dirP = st.project!.dir;
    const jsxPath = join(dirP, 'ae', 'build_heart.jsx');
    mkdirSync(join(dirP, 'ae'), { recursive: true });
    await writeFile(jsxPath, 'var c = app.project.items.addComp("HeartFX", 1920, 1080, 1, 6, 30);');
    const v1 = toolResultData(await callTool(st, 'ae_create', { jsxPath, saveAs: join(dirP, 'ae', 'heart_v001.aep'), asset: { comp: 'HeartFX', id: 'heart' } }));
    expect(v1).toMatchObject({ ok: true, log: ['built'], asset: { id: 'heart', kind: 'aecomp' } });
    expect(st.project!.assets['heart']).toMatchObject({ aep: join(dirP, 'ae', 'heart_v001.aep'), comp: 'HeartFX' });
    // never overwrites; a revision gets a new file and the same asset id now points at it, needing a render
    const again = toolResultData(await callTool(st, 'ae_create', { jsxPath, saveAs: join(dirP, 'ae', 'heart_v001.aep') }));
    expect(String(again['error'])).toMatch(/overwrite/);
    (st.project!.assets['heart'] as { render?: unknown }).render = { path: 'old.mov' };
    const v2 = toolResultData(await callTool(st, 'ae_create', { jsxPath, saveAs: join(dirP, 'ae', 'heart_v002.aep'), asset: { comp: 'HeartFX', id: 'heart' } }));
    expect(v2['ok']).toBe(true);
    expect(st.project!.assets['heart']).toEqual({ id: 'heart', kind: 'aecomp', aep: join(dirP, 'ae', 'heart_v002.aep'), comp: 'HeartFX' });
    // confinement, input checks and script errors
    expect(String(toolResultData(await callTool(st, 'ae_create', { jsx: 'x', saveAs: join(TMP_ROOT, 'out.aep') }))['error'])).toMatch(/project folder/);
    expect(String(toolResultData(await callTool(st, 'ae_create', { jsx: 'x', jsxPath, saveAs: join(dirP, 'a.aep') }))['error'])).toMatch(/exactly one/);
    expect(String(toolResultData(await callTool(st, 'ae_create', { jsx: 'x', saveAs: join(dirP, 'a.aep'), asset: { comp: 'Nope' } }))['error'])).toMatch(/comp not found/);
    expect(String(toolResultData(await callTool(st, 'ae_create', { jsx: 'throw 1', saveAs: join(dirP, 'b.aep') }))['error'])).toMatch(/boom/);
  });

  it('job_wait blocks until a job ends and reports done:false on timeout', async () => {
    const { st } = await withProject('jobwait');
    let finish!: () => void;
    const job = st.jobs.start('build', () => new Promise<{ version: string }>((r) => { finish = () => r({ version: 'v001' }); }));
    const early = toolResultData(await callTool(st, 'job_wait', { id: job.id, timeoutSec: 1 }));
    expect(early).toMatchObject({ done: false, status: 'running' });
    setTimeout(() => finish(), 50);
    const done = toolResultData(await callTool(st, 'job_wait', { id: job.id }));
    expect(done).toMatchObject({ done: true, status: 'done', result: { version: 'v001' } });
    expect(String(toolResultData(await callTool(st, 'job_wait', { id: 'job-9999' }))['error'])).toMatch(/unknown job/);
  });

  it('delivery_presets feeds a picker; project_new stores chosen targets and rejects unknown ones', async () => {
    const st = await fakeState();
    const list = toolResultData(await callTool(st, 'delivery_presets'));
    expect(list['presets']).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'yt', container: 'mp4', size: '1920x1080', lufs: -14 })]));
    const bad = toolResultData(await callTool(st, 'project_new', { dir: join(dir, 'pick-bad'), name: 'x', targets: ['yt', 'nope'] }));
    expect(String(bad['error'])).toMatch(/nope/);
    expect(existsSync(join(dir, 'pick-bad', 'project.json'))).toBe(false);
    const made = toolResultData(await callTool(st, 'project_new', { dir: join(dir, 'pick'), name: 'pick', fps: 30, targets: ['yt', 'vert', 'yt'] }));
    expect(made['ok']).toBe(true);
    expect(st.project!.delivery.targets).toEqual(['yt', 'vert']);
    expect(toolResultData(await callTool(st, 'delivery_presets'))['projectTargets']).toEqual(['yt', 'vert']);
  });

  it('surfaces opaque comps with a force hint when the backend reports them', async () => {
    const { st, aep } = await withProject('opaque');
    st.api.project.addAeComp(st.project!, aep, 'Title_01', 'C_t');
    const inspect = st.ae.inspectComp.bind(st.ae);
    st.ae.inspectComp = async (a, c, f) => ({ ...(await inspect(a, c, f)), opaque: true }) as Awaited<ReturnType<AeBackend['inspectComp']>>;
    const r = toolResultData(await callTool(st, 'ae_inspect_comp', { aep, comp: 'Title_01' }));
    expect(r).toMatchObject({ opaque: true, opaqueAssets: ['C_t'] });
    expect(String(r['opaqueHint'])).toContain('build {forceAssets: ["C_t"]}');
    const plain = toolResultData(await callTool(st, 'ae_edit', { aep, comp: 'Title_01', ops: [{ op: 'setText', layer: 1, text: 'x' }] }));
    expect(plain['opaque']).toBeUndefined(); // backend did not flag the edit result
  });

  it('confines ae_preview_frame.out / ae_edit.saveAs and refuses protected paths everywhere', async () => {
    const { st, aep } = await withProject('confine');
    const outside = join(TMP_ROOT, 'not-here.png');
    const r1 = toolResultData(await callTool(st, 'ae_preview_frame', { aep, comp: 'Title_01', out: outside }));
    expect(String(r1['error'])).toMatch(/project folder or next to the \.aep/);
    const inside = toolResultData(await callTool(st, 'ae_preview_frame', { aep, comp: 'Title_01', out: join(st.project!.dir, 'stills', 'f.png'), wait: true }));
    expect(String(inside['png'])).toContain('stills');
    const r2 = toolResultData(await callTool(st, 'ae_edit', { aep, comp: 'Title_01', ops: [{ op: 'setText', layer: 1, text: 'x' }], saveAs: join(os.tmpdir(), 'x.aep') }));
    expect(String(r2['error'])).toMatch(/saveAs/);
    const prev = process.env['EDITMCP_PROTECTED_PATHS'];
    const locked = join(dir, 'locked');
    const locked2 = join(dir, 'locked2');
    // keep what the test run protects (vitest.config.ts) on top of this test's own folders
    process.env['EDITMCP_PROTECTED_PATHS'] = [locked, locked2, prev].filter(Boolean).join(';');
    try {
      const n = await callTool(st, 'project_new', { dir: join(locked, 'p'), name: 'x' });
      expect(n.isError).toBe(true);
      expect(toolResultData(n)['error']).toMatch(/protected/);
      expect(existsSync(locked)).toBe(false);
      expect((await callTool(st, 'project_new', { dir: join(locked2, 'editmcp'), name: 'x' })).isError).toBe(true);
      expect(existsSync(locked2)).toBe(false);
      process.env['EDITMCP_PROTECTED_PATHS'] = [dir, prev].filter(Boolean).join(';'); // now the open project itself is protected
      const e = await callTool(st, 'timeline_edit', { ops: [{ op: 'remove_audio', id: 'none' }] });
      expect(toolResultData(e)['error']).toMatch(/protected/);
      expect((await callTool(st, 'ae_edit', { aep, comp: 'Title_01', ops: [{ op: 'setText', layer: 1, text: 'x' }] })).isError).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['EDITMCP_PROTECTED_PATHS'];
      else process.env['EDITMCP_PROTECTED_PATHS'] = prev;
    }
  });

  it('build {forceAssets} drops the render record and keeps the old render file aside', async () => {
    const { st, aep } = await withProject('force');
    const p = st.project!;
    const asset = st.api.project.addAeComp(p, aep, 'Title_01', 'C_t');
    const render = join(p.dir, 'cache', 'renders', 'C_t_abcdef12.mov');
    mkdirSync(join(p.dir, 'cache', 'renders'), { recursive: true });
    await writeFile(render, 'old render');
    asset.fingerprint = 'abcdef12';
    asset.render = { path: render, frames: 100, fingerprint: 'abcdef12', renderedAt: 'then' };
    asset.probe = { durationFrames: 100, hasVideo: true, hasAudio: false };
    p.timeline.video = [{ id: 's1', src: 'C_t', in: 0, dur: 50 }];
    await st.api.project.saveProject(p);
    const bad = await callTool(st, 'build', { forceAssets: ['nope'] });
    expect(toolResultData(bad)['error']).toMatch(/aecomp/);
    let seen: unknown;
    const build = st.assembler.build.bind(st.assembler);
    st.assembler.build = async (proj, opts) => { seen = { render: (proj.assets['C_t'] as { render?: unknown }).render, forceAssets: (opts as { forceAssets?: string[] }).forceAssets }; return build(proj, opts); };
    const r = toolResultData(await callTool(st, 'build', { forceAssets: ['C_t'] }));
    const info = await st.jobs.wait(String(r['jobId']));
    expect(info.status).toBe('done');
    expect(seen).toEqual({ render: undefined, forceAssets: ['C_t'] });
    expect(existsSync(render)).toBe(false);
    const moved = ((info.result as Body)['movedRenders'] as Record<string, string>)['C_t']!;
    expect(moved).toMatch(/C_t_abcdef12_forced\.mov$/);
    expect(await readFile(moved, 'utf8')).toBe('old render');
  });
});

// ---------- pure helpers ----------

describe('background job isolation', () => {
  const reviewStates: AppState[] = [];
  const reviewDirs: string[] = [];
  afterAll(async () => {
    for (const st of reviewStates) for (const review of st.reviews?.values() ?? []) await review.close();
    for (const dir of reviewDirs) await rm(dir, { recursive: true, force: true });
  });
  async function reviewFixture() {
    const st = await fakeState();
    const dir = await mkdtemp(join(TMP_ROOT, 'review-'));
    reviewDirs.push(dir); reviewStates.push(st);
    st.project = await projectApi.createProject(dir, { name: 'review', width: 320, height: 180 });
    st.project.timeline.video = [{ id: 's1', src: 'cam', in: 0, dur: 25 }];
    await st.assembler.build(st.project);
    return { st, dir };
  }
  it('keeps a project stable while build runs and resumes mutations afterwards', async () => {
    const state = await fakeState();
    let finish!: () => void;
    const job = state.jobs.start('build', () => new Promise<void>((r) => { finish = r; }));
    for (const name of ['project_new', 'project_open', 'asset_add', 'timeline_set', 'timeline_edit', 'audio_add', 'ae_edit', 'import_premiere_xml']) {
      const def = TOOLS.find((t) => t.name === name)!;
      const result = await (await import('../../src/mcp/tools.js')).runTool(def, {}, state);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text).toContain('wait for build');
    }
    finish(); await state.jobs.wait(job.id);
    expect((await callTool(state, 'project_status')).content[0]?.text).not.toContain('wait for build');
  });
  it('passes cancellation through to a running delivery', async () => {
    const state = await fakeState();
    state.project = { meta: { name: 'test', fps: 25, width: 320, height: 180, schema: 1, createdAt: '' }, dir: TMP_ROOT, assets: {}, timeline: { video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } }, delivery: { targets: ['yt'] }, versions: [{ id: 'v001' } as Version] };
    let cancelled = false;
    state.assembler.deliver = async (_p, _version, _targets, opts) => new Promise((_resolve, reject) => {
      opts!.signal!.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); }, { once: true });
    });
    const result = await callTool(state, 'deliver');
    expect(result.isError).not.toBe(true);
    const id = JSON.parse(result.content[0]!.text).jobId;
    state.jobs.cancel(id);
    expect((await state.jobs.wait(id)).status).toBe('cancelled');
    expect(cancelled).toBe(true);
  });

  it('opens a version review, reads submitted notes through MCP, and closes the local server', async () => {
    const { st, dir } = await reviewFixture();
    const p = st.project!;
    const v = p.versions[p.versions.length - 1]!;
    v.reviewPlan = projectApi.captureReviewPlan(p);
    const proxy = join(dir, 'review-fixture.mp4');
    st.assembler.reviewProxy = async (_p, _id, opts) => {
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      await writeFile(proxy, 'review bytes'); return proxy;
    };
    const start = toolResultData(await callTool(st, 'review_open', { version: v.id }));
    const job = await st.jobs.wait(String(start.jobId));
    expect(job.status).toBe('done');
    const url = (job.result as { url: string }).url;
    expect((await fetch(url)).status).toBe(200);
    const body = await fetch(url + 'data').then(r => r.json());
    const save = await fetch(url + 'session', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify({ revision: 0, notes: [{ id: 'n1', frame: 0, in: 0, out: 1, intent: 'text', text: 'แก้หัวเรื่อง', strokes: [] }] }) });
    expect(save.status).toBe(200);
    expect(body.version).toBe(v.id);
    const sent = await callTool(st, 'review_submit', { version: v.id, revision: 1 });
    expect(sent.isError).not.toBe(true);
    const notes = toolResultData(await callTool(st, 'review_notes', { version: v.id }));
    expect(notes).toMatchObject({ session: { status: 'submitted', notes: [{ text: 'แก้หัวเรื่อง' }] } });
    expect((await callTool(st, 'review_close', { version: v.id })).isError).not.toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('passes cancellation to preview and blocks timeline mutation during proxy creation', async () => {
    const { st } = await reviewFixture();
    let cancelled = false;
    st.assembler.reviewProxy = async (_p, _id, opts) => new Promise((_resolve, reject) => {
      opts!.signal!.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); }, { once: true });
    });
    const result = toolResultData(await callTool(st, 'preview', { wait: false }));
    const id = String(result.jobId);
    await new Promise(r => setTimeout(r, 5));
    expect((await callTool(st, 'timeline_edit', { ops: [] })).isError).toBe(true);
    expect((await callTool(st, 'build')).isError).toBe(true);
    st.jobs.cancel(id);
    expect((await st.jobs.wait(id)).status).toBe('cancelled');
    expect(cancelled).toBe(true);
  });
});

describe('timeline helpers', () => {
  const base: Timeline = {
    video: [{ id: 'a', src: 'X', in: 0, dur: 10 }, { id: 'b', src: 'X', in: 0, dur: 10 }, { id: 'c', src: 'X', in: 0, dur: 10 }],
    cuts: [{ after: 'a', dissolve: 4 }, { after: 'b', dissolve: 6 }],
    audio: { vo: [], music: [], sfx: [] },
  };

  it('remove drops the cut keyed by the removed clip and prunes cuts after the new last clip', () => {
    const t = applyEditOps(base, [{ op: 'remove', id: 'c' }]);
    expect(t.video.map((c) => c.id)).toEqual(['a', 'b']);
    expect(t.cuts).toEqual([{ after: 'a', dissolve: 4 }]);
  });

  it('move keeps valid cuts and prunes the one now at the end', () => {
    const t = applyEditOps(base, [{ op: 'move', id: 'a', index: 2 }]);
    expect(t.video.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(t.cuts).toEqual([{ after: 'b', dissolve: 6 }]);
  });

  it('set_dissolve 0 removes; after last clip is an error; set_marker without name removes', () => {
    const t = applyEditOps(base, [{ op: 'set_dissolve', after: 'a', frames: 0 }, { op: 'set_marker', id: 'a', name: 'm' }]);
    expect(t.cuts).toEqual([{ after: 'b', dissolve: 6 }]);
    expect(t.video[0]!.marker).toBe('m');
    expect(applyEditOps(t, [{ op: 'set_marker', id: 'a' }]).video[0]!.marker).toBeUndefined();
    expect(() => applyEditOps(base, [{ op: 'set_dissolve', after: 'c', frames: 5 }])).toThrow(/last clip/);
    expect(() => applyEditOps(base, [{ op: 'insert', clip: { id: 'a', src: 'X', in: 0, dur: 1 } }])).toThrow(/duplicate/);
    expect(base.cuts).toHaveLength(2); // input untouched
  });

  it('diffTimelines is positional and reports dissolve changes', () => {
    const b = structuredClone(base);
    b.video.pop();
    b.video[1]!.in = 5;
    b.cuts = [{ after: 'a', dissolve: 4 }];
    const d = diffTimelines(base, b);
    expect(d.frames).toEqual({ before: 30, after: 20 });
    expect(d.clips.changed).toEqual([{ index: 1, id: 'b', field: 'in', from: 0, to: 5 }, { index: 2, id: 'c', field: 'removed', from: base.video[2] }]);
    expect(d.dissolves).toEqual([{ after: 'b', from: 6, to: 0 }]);
  });

  it('uniquePath suffixes before the extension', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const d = await mkdtemp(join(TMP_ROOT, 'uniq-'));
    const f = join(d, 'a.xml');
    expect(uniquePath(f)).toBe(f);
    await writeFile(f, '');
    expect(uniquePath(f)).toBe(join(d, 'a_2.xml'));
    await writeFile(join(d, 'a_2.xml'), '');
    expect(uniquePath(f)).toBe(join(d, 'a_3.xml'));
    await rm(d, { recursive: true, force: true });
  });
});

// ---------- part 2: every real module ----------

const realState = await createAppState();

describe.skipIf(!realState.env.tools.ffmpeg)('mcp server (all real modules)', () => {
  let client: Client;
  let dir: string;
  const clip = join(MEDIA_DIR, 'mcp_smoke_2s.mp4'); // 50 frames @ 25 fps, 640x360

  beforeAll(async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    mkdirSync(MEDIA_DIR, { recursive: true });
    dir = await mkdtemp(join(TMP_ROOT, 'real-'));
    if (!existsSync(clip)) {
      await execa(realState!.env.tools.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip,
      ], { windowsHide: true, timeout: 60_000 });
    }
    client = await connect(realState!);
  });
  afterAll(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('doctor works without launching AE', async () => {
    const { isError, data } = await call(client, 'doctor');
    expect(isError).toBe(false);
    expect(data['aeVersion']).toBe('unknown (not launched)');
    expect((data['encoders'] as Body)['prores_ks']).toBe(true);
  });

  it('project_new → asset_add (real probe) → timeline_set invalid then valid', async () => {
    const r = await call(client, 'project_new', { dir: join(dir, 'p'), name: 'real' });
    expect(r.isError).toBe(false);
    const a = await call(client, 'asset_add', { path: clip, id: 'A01' });
    expect(a.isError).toBe(false);
    expect((a.data['asset'] as Body)['frames']).toBe(50);
    const bad = await call(client, 'timeline_set', { timeline: { video: [{ id: 's1', src: 'A01', in: 0, dur: 60 }, { id: 's2', src: 'NOPE', in: 0, dur: 0 }] } });
    expect(bad.isError).toBe(true);
    expect((bad.data['errors'] as string[]).length).toBeGreaterThanOrEqual(2);
    const ok = await call(client, 'timeline_set', { timeline: { video: [{ id: 's1', src: 'A01', in: 0, dur: 50 }] } });
    expect(ok.isError).toBe(false);
    expect((ok.data['timeline'] as Body)['tc']).toBe('00:00:02:00');
    const x = await call(client, 'export_premiere_xml', {});
    expect(x.isError).toBe(false);
    expect(await readFile(String(x.data['path']), 'utf8')).toContain('<xmeml');
  });
});
