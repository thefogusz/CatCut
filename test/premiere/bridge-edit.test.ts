/**
 * In-place editing (CATCUT_FEATURE_REQUEST.md) against a fake Premiere object model: timeline read,
 * effects read, guarded ops with dry run / signature / checkpoint / undo, AE comp placement,
 * frames + range export, user actions, old-bridge compatibility and install backups.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { basename, join, win32 } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import { UserActionError } from '../../src/core/user-action.js';
import { MockAeBackend } from '../../src/engine/ae.js';
import type { SpawnFn } from '../../src/engine/aerender.js';
import { BRIDGE_ID, createPremiereClient, installBridge } from '../../src/engine/premiere.js';
import * as xmemlApi from '../../src/io/xmeml.js';
import { safeEnvironment, type AppState } from '../../src/mcp/state.js';
import { callTool, toolResultData } from '../../src/mcp/tools.js';

const require = createRequire(import.meta.url);
const { createBridge } = require('../../premiere/catcut-bridge/bridge-core.js') as {
  createBridge: (o: Record<string, unknown>) => { tick(): Promise<boolean>; heartbeat(): Promise<boolean> };
};
const BRIDGE_SRC = join(process.cwd(), 'premiere', 'catcut-bridge');
const HOST = readFileSync(join(BRIDGE_SRC, 'host.jsx'), 'utf8');
const SOURCE_VERSION = (JSON.parse(readFileSync(join(BRIDGE_SRC, 'package.json'), 'utf8')) as { version: string }).version;
const FPS = 25;

// ---------- fake Premiere ----------

interface Prop { displayName: string; value: unknown; keys?: Array<{ seconds: number; value: unknown }>; color?: number[] }
interface Comp { displayName: string; matchName: string; props: Prop[] }
interface Item { type: number; name: string; nodeId: string; media: string; inSec?: number; outSec?: number; durSec: number; hasAudio: boolean }
interface Clip { name: string; item: Item; start: number; end: number; inP: number; speed: number; comps: Comp[] }

const baseComps = (): Comp[] => [
  { displayName: 'Opacity', matchName: 'AE.ADBE Opacity', props: [{ displayName: 'Opacity', value: 100 }] },
  { displayName: 'Motion', matchName: 'AE.ADBE Motion', props: [{ displayName: 'Position', value: [0.5, 0.5] }, { displayName: 'Scale', value: 100 }, { displayName: 'Rotation', value: 0 }] },
];

function fakePremiere(projectPath: string) {
  const fs = require('node:fs') as typeof import('node:fs');
  let nextNode = 1;
  const items: Item[] = [];
  const bins: string[] = [];
  // fixtures use Windows media paths: win32.basename splits on both separators on every OS
  const mkItem = (media: string, name = win32.basename(media), hasAudio = true, durSec = 100): Item => { const it = { type: 1, name, nodeId: String(nextNode++), media, durSec, hasAudio }; items.push(it); return it; };
  const video: Clip[][] = [[], [], []];
  const audio: Clip[][] = [[], []];
  const saves: string[] = [];
  let closed = 0;
  let sideEffect: (() => void) | undefined; // simulate Premiere changing an unrelated clip
  const sec = (f: number) => ({ seconds: f / FPS, ticks: String(Math.round((f / FPS) * 254016000000)) });
  const T = (s: { seconds: number }) => Math.round(s.seconds * FPS);
  const propObj = (p: Prop) => ({
    get displayName() { return p.displayName; },
    getValue: () => p.value, setValue: (v: unknown) => { p.value = v; },
    isTimeVarying: () => !!p.keys, setTimeVarying: (on: boolean) => { p.keys = on ? (p.keys ?? []) : undefined; },
    getKeys: () => (p.keys ?? []).map((k) => ({ seconds: k.seconds })), getValueAtKey: (t: { seconds: number }) => p.keys?.find((k) => k.seconds === t.seconds)?.value,
    addKey: (t: { seconds: number }) => { p.keys!.push({ seconds: t.seconds, value: null }); }, setValueAtKey: (t: { seconds: number }, v: unknown) => { p.keys!.find((k) => k.seconds === t.seconds)!.value = v; },
    getColorValue: () => p.color, setColorValue: (a: number, r: number, g: number, b: number) => { p.color = [a, r, g, b]; p.value = 5_000_000_000; },
  });
  const clipObj = (c: Clip, list: Clip[]) => ({
    get name() { return c.name; }, set name(v: string) { c.name = v; },
    get start() { return sec(c.start); }, set start(t: { seconds: number }) { c.start = T(t); },
    get end() { return sec(c.end); }, set end(t: { seconds: number }) { c.end = T(t); },
    get inPoint() { return sec(c.inP); }, set inPoint(t: { seconds: number }) { c.inP = T(t); },
    get outPoint() { return sec(c.inP + Math.round((c.end - c.start) * c.speed)); },
    projectItem: { get nodeId() { return c.item.nodeId; }, getMediaPath: () => c.item.media, hasProxy: () => false },
    getSpeed: () => c.speed,
    get components() { const o: Record<string, unknown> = { numItems: c.comps.length }; c.comps.forEach((x, i) => { o[i] = { displayName: x.displayName, matchName: x.matchName, get properties() { const p: Record<string, unknown> = { numItems: x.props.length }; x.props.forEach((y, j) => { p[j] = propObj(y); }); return p; } }; }); return o; },
    remove: () => { list.splice(list.indexOf(c), 1); },
    move: (t: { seconds: number }) => { const d = T(t); c.start += d; c.end += d; },
  });
  const sortAll = () => [...video, ...audio].forEach((l) => l.sort((a, b) => a.start - b.start));
  const trackObj = (list: Clip[], kind: 'V' | 'A', index: number) => ({
    get clips() { sortAll(); const o: Record<string, unknown> = { numItems: list.length }; list.forEach((c, i) => { o[i] = clipObj(c, list); }); return o; },
    overwriteClip(itemObj: { nodeId: string }, atSec: number) {
      const it = items.find((x) => x.nodeId === itemObj.nodeId)!;
      const at = Math.round(atSec * FPS), dur = Math.round(((it.outSec ?? it.durSec) - (it.inSec ?? 0)) * FPS), inF = Math.round((it.inSec ?? 0) * FPS);
      for (const c of [...list]) if (c.start >= at && c.end <= at + dur) list.splice(list.indexOf(c), 1);
      list.push({ name: it.name, item: it, start: at, end: at + dur, inP: inF, speed: 1, comps: baseComps() });
      if (kind === 'V' && it.hasAudio) audio[Math.min(index, audio.length - 1)]!.push({ name: it.name, item: it, start: at, end: at + dur, inP: inF, speed: 1, comps: [] });
      sideEffect?.();
    },
    insertClip() { throw new Error('insert not expected'); },
  });
  const tracks = (lists: Clip[][], kind: 'V' | 'A') => { const o: Record<string, unknown> = { numTracks: lists.length }; lists.forEach((l, i) => { o[i] = trackObj(l, kind, i); }); return o; };
  let inOut = { in: -400000, out: -400000 };
  const seq = {
    name: 'EDIT', sequenceID: 'seq-1', end: String(Math.round(20 * 254016000000)),
    getSettings: () => ({ videoFrameRate: { seconds: 1 / FPS }, videoDisplayFormat: 101, videoFrameWidth: 1920, videoFrameHeight: 1080 }),
    get videoTracks() { return tracks(video, 'V'); }, get audioTracks() { return tracks(audio, 'A'); },
    getInPoint: () => String(inOut.in), getOutPoint: () => String(inOut.out),
    setInPoint: (s: number) => { inOut.in = s; }, setOutPoint: (s: number) => { inOut.out = s; }, clearInPoint: () => { inOut.in = -400000; }, clearOutPoint: () => { inOut.out = -400000; },
    exportAsMediaDirect: (p: string) => { fs.writeFileSync(p, `range ${inOut.in}-${inOut.out}`); return ''; },
  };
  const itemObj = (it: Item) => ({
    type: it.type, get name() { return it.name; }, nodeId: it.nodeId, getMediaPath: () => it.media,
    setInPoint: (s: number) => { it.inSec = s; }, setOutPoint: (s: number) => { it.outSec = s; }, clearInPoint: () => { delete it.inSec; }, clearOutPoint: () => { delete it.outSec; },
    canChangeMediaPath: () => true, changeMediaPath: (p: string) => { it.media = p; return true; }, hasProxy: () => false,
  });
  const root = {
    get children() { const o: Record<string, unknown> = { numItems: bins.length + items.length }; bins.forEach((b, i) => { o[i] = { type: 2, name: b, children: { numItems: 0 }, createBin: () => undefined }; }); items.forEach((it, i) => { o[bins.length + i] = itemObj(it); }); return o; },
    createBin: (n: string) => { bins.push(n); },
  };
  const project = {
    get name() { return basename(app.path); }, get path() { return app.path; }, rootItem: root, activeSequence: seq, sequences: { numSequences: 1, 0: seq },
    openSequence: () => true, save: () => { saves.push(app.path); return 0; },
    importFiles: (paths: string[]) => { for (const p of paths) mkItem(p); return true; },
    importAEComps: (_aep: string, names: string[]) => { for (const n of names) mkItem(`${_aep}#${n}`, n, true, 50); return true; },
    closeDocument: () => { closed++; app.open = false; return true; },
  };
  const app = {
    version: '26.0.0', path: projectPath, open: true,
    get project() { return app.open ? project : null; },
    openDocument: (p: string) => { app.path = p; app.open = true; return true; }, enableQE: () => undefined, setEnableProxies: () => undefined,
  };
  const qe = {
    project: {
      getVideoEffectByName: (n: string) => (n === 'Lumetri Color' || n === 'Gaussian Blur' ? { name: n } : null),
      getActiveSequence: () => ({
        getVideoTrackAt: (ti: number) => {
          sortAll();
          const list = video[ti]!;
          const qItems = [{ type: 'Empty', name: '' }, ...list.map((c) => ({
            type: 'Clip', name: c.name,
            setSpeed: (s: number) => { c.speed = s; c.start += 2; c.end += 2; }, // QE nudges the clip
            setTimeInterpolationType: () => undefined,
            addVideoEffect: (fx: { name: string }) => { c.comps.push({ displayName: fx.name, matchName: `AE.${fx.name}`, props: [{ displayName: 'Exposure', value: 0 }] }); },
            getComponentAt: (i: number) => ({ remove: () => { c.comps.splice(i, 1); } }),
          }))];
          return { numItems: qItems.length, getItemAt: (i: number) => qItems[i] };
        },
        exportFramePNG: (tc: string, p: string) => { fs.writeFileSync(`${p}.png`, tc); },
      }),
    },
  };
  function Time(this: { seconds: number; getFormatted: () => string }) { this.seconds = 0; this.getFormatted = () => '00:00:01:00'; }
  function File(this: { exists: boolean; fsName: string; parent: unknown }, p: string) { this.exists = !!p && fs.existsSync(p); this.fsName = p; this.parent = { fsName: '' }; }
  const userFile: { src?: string } = {};
  const ctx = vm.createContext({ app, qe, Time, File, $: { fileName: '', evalFile: () => { if (userFile.src) vm.runInContext(userFile.src, ctx); } } });
  vm.runInContext(HOST, ctx);
  const dispatch = (action: string, args: Record<string, unknown> = {}) => JSON.parse(String(vm.runInContext(`catcut_dispatch(${JSON.stringify({ action, args })})`, ctx))) as { ok: boolean; data?: Record<string, any>; error?: string };
  const evalScript = vi.fn(async (script: string) => String(vm.runInContext(script.replace(/^\$\.evalFile\([^;]*\);/, ''), ctx)));
  // a cut: V1 a (0-100) b (100-150) c (150-250), linked audio on A1; V2 title over b
  const a = mkItem('D:\\card\\C0001.MP4'), b = mkItem('D:\\card\\C0002.MP4'), c = mkItem('D:\\card\\C0003.MP4'), t = mkItem('D:\\gfx\\title.png', 'title.png', false);
  const put = (list: Clip[], it: Item, start: number, end: number, inP = 0) => list.push({ name: it.name, item: it, start, end, inP, speed: 1, comps: baseComps() });
  put(video[0]!, a, 0, 100); put(video[0]!, b, 100, 150, 50); put(video[0]!, c, 150, 250);
  put(audio[0]!, a, 0, 100); put(audio[0]!, b, 100, 150, 50); put(audio[0]!, c, 150, 250);
  put(video[1]!, t, 100, 150);
  return { app, items, video, audio, saves, dispatch, evalScript, closed: () => closed, setSideEffect: (f: () => void) => { sideEffect = f; }, userFile, ctx };
}

const tmps: string[] = [];
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp(): Promise<string> { const d = await mkdtemp(join(os.tmpdir(), 'catcut-edit-')); tmps.push(d); return d; }
const sel = (track: string, start: number, end: number, name?: string) => ({ track, start, end, ...(name ? { name } : {}) });

describe('host.jsx: reading the editor\'s sequence', () => {
  it('timeline: every clip on every track in frames, with media, node, speed and effect names', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    const r = p.dispatch('timeline', {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ fps: 25, width: 1920, height: 1080, end: 500, tracks: { video: 3, audio: 2 } });
    expect(r.data!['video'][1]).toMatchObject({ track: 'V1', index: 1, name: 'C0002.MP4', start: 100, end: 150, in: 50, out: 100, media: 'D:\\card\\C0002.MP4', speed: 1, effects: ['Opacity', 'Motion'] });
    expect(r.data!['audio']).toHaveLength(3);
  });

  it('clipEffects: values, keyframes and colours of one clip', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    p.video[0]![0]!.comps.push({ displayName: 'Tint', matchName: 'AE.ADBE Tint', props: [{ displayName: 'Map Black To', value: 5_000_000_000, color: [255, 10, 20, 30] }, { displayName: 'Amount', value: 0, keys: [{ seconds: 1, value: 50 }] }] });
    const r = p.dispatch('clipEffects', { clip: sel('V1', 0, 100, 'C0001.MP4') });
    expect(r.data!['effects'][2]).toMatchObject({ index: 2, name: 'Tint', properties: [{ name: 'Map Black To', color: [255, 10, 20, 30] }, { name: 'Amount', varying: true, keys: [{ seconds: 1, value: 50 }] }] });
  });
});

describe('host.jsx: premiere_edit ops', () => {
  it('dry run checks every op against the sequence and changes nothing', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    const before = JSON.stringify(p.video);
    const r = p.dispatch('edit', { ops: [
      { op: 'remove', clip: sel('V1', 100, 150, 'C0002.MP4') },
      { op: 'trim', clip: sel('V1', 150, 260, 'C0003.MP4'), end: 200 }, // the editor already changed it
    ] });
    expect(r.data).toMatchObject({ applied: false, problems: [{ op: 1, error: expect.stringMatching(/precondition failed: 0 clips .*there now: .*C0003\.MP4 150-250.*nothing changed/) }] });
    expect(r.data!['plan'][0]).toMatchObject({ op: 'remove', clip: { name: 'C0002.MP4' }, linkedAudio: 1 });
    expect(JSON.stringify(p.video)).toBe(before);
  });

  it('applies a client note in place: cut a shot 1 s, remove one, rename, regrade; nothing else moves', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    const r = p.dispatch('edit', { apply: true, ops: [
      { op: 'trim', clip: sel('V1', 150, 250, 'C0003.MP4'), end: 225 },
      { op: 'remove', clip: sel('V2', 100, 150, 'title.png') },
      { op: 'rename', clip: sel('V1', 0, 100), name: 'OPEN' },
      { op: 'set_motion', clip: sel('V1', 0, 100, 'OPEN'), scale: 110, position: [0.5, 0.45] },
      { op: 'add_effect', clip: sel('V1', 100, 150), effect: 'Lumetri Color' },
      { op: 'set_effect_param', clip: sel('V1', 100, 150), effect: 'Lumetri Color', param: 'Exposure', value: 0.4 },
    ] });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ applied: true, failed: null, untouchedChanged: [], saved: false });
    expect(p.video[0]!.map((c) => [c.name, c.start, c.end])).toEqual([['OPEN', 0, 100], ['C0002.MP4', 100, 150], ['C0003.MP4', 150, 225]]);
    expect(p.video[1]).toEqual([]);
    expect(p.video[0]![0]!.comps[1]!.props.map((x) => x.value)).toEqual([[0.5, 0.45], 110, 0]);
    expect(p.video[0]![1]!.comps[2]).toMatchObject({ displayName: 'Lumetri Color', props: [{ value: 0.4 }] });
    expect(p.saves).toEqual([]); // saved only when asked
  });

  it('remove takes the linked audio along; trim of the head keeps the picture in sync; speed keeps the clip in place', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    const r = p.dispatch('edit', { apply: true, save: true, ops: [
      { op: 'remove', clip: sel('V1', 0, 100, 'C0001.MP4') },
      { op: 'trim', clip: sel('V1', 150, 250), start: 175 },
      { op: 'set_speed', clip: sel('V1', 100, 150), rate: 60 },
    ] });
    expect(r.data).toMatchObject({ failed: null, saved: true });
    expect(p.audio[0]!.map((c) => c.name)).toEqual(['C0002.MP4', 'C0003.MP4']);
    expect(p.video[0]!.find((c) => c.name === 'C0003.MP4')).toMatchObject({ start: 175, end: 250, inP: 25 });
    expect(p.video[0]!.find((c) => c.name === 'C0002.MP4')).toMatchObject({ start: 100, end: 150, speed: 0.6 });
    expect(p.saves).toHaveLength(1);
  });

  it('move refuses to land on another clip; overwrite refuses to cover clips unless asked', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    expect(p.dispatch('edit', { ops: [{ op: 'move', clip: sel('V2', 100, 150), to: 120 }] }).data!['problems']).toEqual([]);
    expect(p.dispatch('edit', { ops: [{ op: 'move', clip: sel('V1', 0, 100), to: 40 }] }).data!['problems'][0].error).toMatch(/would overlap C0002\.MP4/);
    expect(p.dispatch('edit', { ops: [{ op: 'overwrite', track: 'V1', at: 120, dur: 10, media: 'D:\\x.mov' }] }).data!['problems'][0].error).toMatch(/would cover C0002\.MP4 100-150/);
  });

  it('places an AE comp on a free range: imports it once, drops its empty audio', async () => {
    const d = await tmp();
    const aep = join(d, 'gfx.aep'); await writeFile(aep, '');
    const p = fakePremiere('C:\\job\\JOB.prproj');
    const r = p.dispatch('edit', { apply: true, ops: [{ op: 'overwrite', track: 'V3', at: 200, dur: 50, aeComp: { aep, comp: 'CORNER_01' } }] });
    expect(r.data).toMatchObject({ failed: null, untouchedChanged: [], results: [{ op: 'overwrite', clip: { track: 'V3', name: 'CORNER_01', start: 200, end: 250 } }] });
    expect(p.audio.flat().some((c) => c.name === 'CORNER_01')).toBe(false);
    expect(p.items.filter((i) => i.name === 'CORNER_01')).toHaveLength(1);
  });

  it('a change outside the ops is reported and blocks the save', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    p.setSideEffect(() => { p.video[0]![0]!.end = 90; });
    const r = p.dispatch('edit', { apply: true, save: true, ops: [{ op: 'overwrite', track: 'V3', at: 300, dur: 25, media: 'D:\\card\\C0001.MP4' }] });
    expect(r.data!['untouchedChanged']).toHaveLength(2); // C0001 0-100 gone, 0-90 appeared
    expect(r.data!['saved']).toBe(false);
    expect(p.saves).toEqual([]);
  });

  it('a failing op stops the run and names it', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    const r = p.dispatch('edit', { apply: true, ops: [{ op: 'rename', clip: sel('V1', 0, 100), name: 'X' }, { op: 'remove_effect', clip: sel('V1', 0, 100), effect: 'Motion' }] });
    expect(r.data).toMatchObject({ failed: { op: 1, error: expect.stringMatching(/Motion and Opacity cannot be removed/) }, results: [{ op: 'rename' }] });
  });

  it('per-job actions in host.user.jsx are dispatched with the helpers', () => {
    const p = fakePremiere('C:\\job\\JOB.prproj');
    vm.runInContext('catcut_user_actions.countV1 = function (a, h) { var s = h.findSequence(); return { n: s.videoTracks[0].clips.numItems, fps: h.seqFps(s) }; };', p.ctx);
    expect(p.dispatch('countV1').data).toEqual({ n: 3, fps: 25 });
    expect(p.dispatch('ping').data!['actions']).toEqual(expect.arrayContaining(['edit', 'timeline', 'frames', 'aeRun']));
  });
});

// ---------- tools over a live bridge ----------

const pumps: NodeJS.Timeout[] = [];
afterEach(() => { pumps.splice(0).forEach(clearInterval); });
const envBackup = { ...process.env };
afterEach(() => {
  for (const k of ['LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'HOME']) {
    if (envBackup[k] === undefined) delete process.env[k]; else process.env[k] = envBackup[k];
  }
});

async function live() {
  const root = await tmp();
  process.env['LOCALAPPDATA'] = join(root, 'local');
  process.env['HOME'] = join(root, 'home');
  const queue = join(root, 'q'); await mkdir(queue);
  const projectPath = join(root, 'งาน.prproj'); await writeFile(projectPath, 'v1');
  const prem = fakePremiere(projectPath);
  prem.app.project!.save = () => { writeFileSync(prem.app.path, `saved ${Date.now()}`); prem.saves.push(prem.app.path); return 0; };
  const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir: queue, pid: process.pid, version: SOURCE_VERSION, evalScript: prem.evalScript });
  await bridge.heartbeat();
  pumps.push(setInterval(() => { void bridge.tick(); void bridge.heartbeat(); }, 5));
  const inst = join(root, 'ext', BRIDGE_ID);
  await mkdir(join(inst, 'CSXS'), { recursive: true });
  await writeFile(join(inst, 'CSXS', 'manifest.xml'), '<x/>');
  await writeFile(join(inst, 'package.json'), JSON.stringify({ version: SOURCE_VERSION }));
  const { env } = await safeEnvironment();
  const state: AppState = {
    env, ae: new MockAeBackend(), jobs: new JobManager(), problems: [],
    assembler: { build: async () => { throw new Error('x'); }, deliver: async () => ({}), reviewProxy: async () => '' },
    api: { project: projectApi, xmeml: xmemlApi, probe: async () => ({ durationFrames: 1, hasVideo: true, hasAudio: false }) },
    premiere: createPremiereClient({ queueDir: queue, installDir: inst, pollMs: 5 }),
    premiereHost: { running: async () => [], debugModeMissing: async () => [], launch: () => ({}) },
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await callTool(state, name, args); return { isError: !!r.isError, data: toolResultData(r) as Record<string, any> }; };
  return { root, projectPath, prem, state, call };
}

describe('premiere_edit / premiere_undo_last tools', () => {
  it('apply saves a checkpoint copy first; undo closes without saving, restores it and reopens', async () => {
    const { projectPath, prem, call } = await live();
    const dry = await call('premiere_edit', { project: projectPath, ops: [{ op: 'remove', clip: sel('V2', 100, 150, 'title.png') }] });
    expect(dry.data).toMatchObject({ ok: true, dryRun: true, plan: [{ op: 'remove' }] });
    expect(prem.video[1]).toHaveLength(1);
    const applied = await call('premiere_edit', { project: projectPath, apply: true, ops: [{ op: 'remove', clip: sel('V2', 100, 150, 'title.png') }] });
    expect(applied.data).toMatchObject({ ok: true, saved: false, backup: expect.stringContaining(join('CatCut', 'premiere-backups')) });
    const checkpointText = await readFile(applied.data['backup'], 'utf8');
    expect(checkpointText).toMatch(/^saved /); // what the editor had, saved just before the edit
    await writeFile(projectPath, 'edited and saved later');
    const undo = await call('premiere_undo_last', { project: projectPath });
    expect(undo.data).toMatchObject({ ok: true, project: { path: projectPath } });
    expect(await readFile(projectPath, 'utf8')).toBe(checkpointText);
    expect(await readFile(undo.data['keptCurrentAs'], 'utf8')).toBe('edited and saved later');
    expect(prem.closed()).toBe(1);
    const again = await call('premiere_undo_last', { project: projectPath });
    expect(again).toMatchObject({ isError: true, data: { error: expect.stringMatching(/ยังไม่มีจุดย้อนกลับ/) } });
  });

  it('premiere_place_ae_comp is a guarded overwrite (dry run first)', async () => {
    const { root, projectPath, prem, call } = await live();
    const aep = join(root, 'g.aep'); await writeFile(aep, '');
    const dry = await call('premiere_place_ae_comp', { project: projectPath, aep, comp: 'LOGO', track: 'V3', at: 0, dur: 50 });
    expect(dry.data).toMatchObject({ dryRun: true, ok: true });
    expect(prem.items.some((i) => i.name === 'LOGO')).toBe(false);
    const done = await call('premiere_place_ae_comp', { project: projectPath, aep, comp: 'LOGO', track: 'V3', at: 0, dur: 50, apply: true });
    expect(done.data).toMatchObject({ ok: true, results: [{ clip: { name: 'LOGO', start: 0, end: 50 } }] });
  });

  it('premiere_timeline_get / premiere_frames / premiere_export_range', async () => {
    const { root, projectPath, call } = await live();
    expect((await call('premiere_timeline_get', { project: projectPath })).data['video']).toHaveLength(4);
    const frames = await call('premiere_frames', { project: projectPath, frames: [0, '00:00:04:00'] });
    expect(frames.data['frames'].map((f: { tc: string }) => f.tc)).toEqual(['00:00:00:00', '00:00:04:00']);
    for (const f of frames.data['frames']) expect(existsSync(f.file)).toBe(true);
    const preset = join(root, 'p.epr'); await writeFile(preset, '');
    const out = join(root, 'check.mp4');
    const r = await call('premiere_export_range', { project: projectPath, from: 25, to: 50, preset, out });
    expect(r.data).toMatchObject({ ok: true, path: out, from: 25, to: 50 });
    expect(await readFile(out, 'utf8')).toBe('range 1-2');
    const r2 = await call('premiere_export_range', { project: projectPath, from: 25, to: 50, preset, out });
    expect(r2.data['path']).not.toBe(out); // never overwrites
  });
});

describe('bridge compatibility and resilience', () => {
  it('an older bridge without an action answers with the update card, not a raw error', async () => {
    const root = await tmp();
    const queue = join(root, 'q'); await mkdir(queue);
    const old = vi.fn(async (s: string) => (s.includes('"ping"') ? JSON.stringify({ ok: true, data: { premiere: '26', project: null } }) : JSON.stringify({ ok: false, error: 'unknown action: timeline' })));
    const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir: queue, pid: process.pid, version: '0.1.0', evalScript: old });
    await bridge.heartbeat();
    pumps.push(setInterval(() => { void bridge.tick(); void bridge.heartbeat(); }, 5));
    const c = createPremiereClient({ queueDir: queue, installDir: join(root, 'none'), pollMs: 5 });
    const e = await c.call('timeline').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UserActionError);
    expect((e as UserActionError).userAction).toMatchObject({ code: 'bridge-update', why: expect.stringContaining('timeline') });
  });

  it('by default the client talks to %LOCALAPPDATA%\\CatCut\\bridge, and still finds an old bridge in TEMP', async () => {
    const root = await tmp();
    process.env['LOCALAPPDATA'] = join(root, 'local');
    process.env['HOME'] = join(root, 'home');
    process.env['TEMP'] = join(root, 'temp'); process.env['TMP'] = join(root, 'temp'); process.env['TMPDIR'] = join(root, 'temp');
    await mkdir(join(root, 'temp', 'catcut-premiere-bridge'), { recursive: true });
    const c = createPremiereClient({ installDir: join(root, 'none') });
    // macOS: ~/Library/Application Support/CatCut/bridge (same rule as the bridge's index.html)
    expect(c.queueDir).toBe(process.platform === 'darwin' ? join(root, 'home', 'Library', 'Application Support', 'CatCut', 'bridge') : join(root, 'local', 'CatCut', 'bridge'));
    await writeFile(join(root, 'temp', 'catcut-premiere-bridge', 'bridge.json'), JSON.stringify({ protocol: 1, pid: 1, ts: Date.now(), bridge: '0.1.0' }));
    expect(await c.status()).toMatchObject({ connected: true, bridge: '0.1.0', queueDir: join(root, 'temp', 'catcut-premiere-bridge') });
  });

  it('the bridge recreates its queue folder when a cleanup tool deletes it', async () => {
    const root = await tmp();
    const queue = join(root, 'q');
    const ok = vi.fn(async () => JSON.stringify({ ok: true, data: {} }));
    const bridge = createBridge({ fs: require('node:fs'), path: require('node:path'), dir: queue, pid: process.pid, version: SOURCE_VERSION, evalScript: ok });
    await bridge.heartbeat();
    expect(existsSync(join(queue, 'bridge.json'))).toBe(true);
    await rm(queue, { recursive: true, force: true });
    await bridge.heartbeat();
    expect(existsSync(join(queue, 'bridge.json'))).toBe(true);
  });

  it('install keeps the replaced bridge outside the CEP folder and carries host.user.jsx over', async () => {
    const root = await tmp();
    const extensionsDir = join(root, 'extensions');
    const old = join(extensionsDir, BRIDGE_ID);
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'host.jsx'), '// codex edits: ccTimelineDump');
    await writeFile(join(old, 'host.user.jsx'), 'catcut_user_actions.mine = function () { return 1; };');
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const r = await installBridge({ spawn: spawn as unknown as SpawnFn, extensionsDir, source: BRIDGE_SRC, backupRoot: join(root, 'backups') });
    expect(r.backup).toMatch(/backups[\\/]com\.catcut\.bridge-/);
    expect(await readFile(join(r.backup!, 'host.jsx'), 'utf8')).toContain('ccTimelineDump');
    expect(r.keptUserActions).toBe(true);
    expect(await readFile(join(old, 'host.user.jsx'), 'utf8')).toContain('mine');
    expect(await readFile(join(old, 'host.jsx'), 'utf8')).toBe(readFileSync(join(BRIDGE_SRC, 'host.jsx'), 'utf8'));
    expect(await readdir(extensionsDir)).toEqual([BRIDGE_ID]);
  });
});
