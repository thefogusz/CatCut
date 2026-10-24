/**
 * DESIGN.md §14 (field feedback): user action cards, AE failures that need the person, AE prefs read
 * without AE, ready_check, disk budget, slow-mo lint, board file names, proxies (real ffmpeg on a
 * tiny synthetic clip). No Adobe app is started.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as projectApi from '../../src/core/project.js';
import { JobManager } from '../../src/core/jobs.js';
import { discoverTools } from '../../src/core/tools.js';
import type { Board, Clip, Project, ToolPaths } from '../../src/core/types.js';
import { ACTIONS, card, UserActionError, userActionText } from '../../src/core/user-action.js';
import { createAeBackend, MockAeBackend } from '../../src/engine/ae.js';
import type { SpawnFn } from '../../src/engine/aerender.js';
import { aeScriptingPref, diskReport } from '../../src/engine/housekeeping.js';
import { createPremiereClient } from '../../src/engine/premiere.js';
import { makeProxies, planProxies } from '../../src/engine/proxy.js';
import { lintTimeline } from '../../src/engine/timeline-lint.js';
import { boardFileIds, compareBoardToCut } from '../../src/io/board.js';
import * as xmemlApi from '../../src/io/xmeml.js';
import { safeEnvironment, type AppState } from '../../src/mcp/state.js';
import { fail } from '../../src/mcp/tooldef.js';
import { readiness } from '../../src/mcp/tools-ready.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp(): Promise<string> { const d = await mkdtemp(join(os.tmpdir(), 'catcut-seam-')); dirs.push(d); return d; }

describe('user action cards', () => {
  it('every card says what, why, how often, whether to keep the app open, and when to close it', () => {
    for (const make of Object.values(ACTIONS)) {
      const a = make();
      expect(a.steps.length).toBeGreaterThan(0);
      expect(a.why).not.toBe('');
      const text = userActionText(a);
      expect(text).toContain('ทำไม:');
      expect(text).toContain('ปิดได้เมื่อ:');
      expect(text).toMatch(/ทำครั้งเดียว|ทำเมื่อเกิดขึ้น/);
    }
    // AE never needs to stay open or a project
    for (const a of [ACTIONS.aeFirstRun(), ACTIONS.aeAllowScripts()]) expect(a).toMatchObject({ keepOpen: false, needsProject: false });
    expect(userActionText(ACTIONS.aeAllowScripts())).toContain('ไม่ต้องสร้างหรือเปิดโปรเจกต์');
  });

  it('a UserActionError becomes a tool failure carrying the card and the relay instruction', () => {
    const r = fail(new UserActionError('AfterFX: cannot write x', ACTIONS.aeAllowScripts()));
    const body = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    expect(r.isError).toBe(true);
    expect(body).toMatchObject({ ok: false, error: 'AfterFX: cannot write x', userAction: { code: 'ae-allow-scripts', say: expect.stringContaining('Allow Scripts') }, relay: expect.stringContaining('exactly as written') });
    expect(card(ACTIONS.diskLow({ drive: 'C:\\', freeGb: 3 })).say).toContain('C:\\');
  });
});

describe('After Effects failures that need the person', () => {
  async function backend(o: { allowed?: boolean; prefs?: boolean; runnerError?: string; stderr?: string }) {
    const spawn = vi.fn(async (_bin: string, args: string[]) => {
      if (o.runnerError) {
        const launcher = await readFile(args[3]!, 'utf8');
        const job = JSON.parse(await readFile(JSON.parse(/var EDITMCP_JOB = (.*);/.exec(launcher)![1]!), 'utf8')) as { result: string };
        await writeFile(job.result, JSON.stringify({ ok: false, error: o.runnerError }));
      }
      return { exitCode: 0, stdout: '', stderr: o.stderr ?? '' }; // AE quit without running the script: no result
    });
    const scriptingPref = async () => (o.prefs === false ? {} : { prefsFile: 'p.txt', aeVersion: '26.5', ...(o.allowed !== undefined ? { allowed: o.allowed } : {}) });
    return createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com' }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, retryDelayMs: 1, listProcesses: async () => [], scriptingPref });
  }
  const codeOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as UserActionError).userAction?.code;

  it('no result + Allow Scripts off → the Allow Scripts card; no result otherwise → open AE once to sign in', async () => {
    expect(await codeOf((await backend({ allowed: false })).version())).toBe('ae-allow-scripts');
    expect(await codeOf((await backend({ allowed: true })).version())).toBe('ae-first-run');
    expect(await codeOf((await backend({ prefs: false })).version())).toBe('ae-first-run');
  });

  it('a GPU sanity-test / log failure is not a sign-in problem: its own card, but Allow Scripts off still wins', async () => {
    expect(await codeOf((await backend({ allowed: true, stderr: 'GPU3 failed (previous) sanity test' })).version())).toBe('ae-headless-failed');
    expect(await codeOf((await backend({ allowed: true, stderr: 'InitializeFileLogging failed' })).version())).toBe('ae-headless-failed');
    expect(await codeOf((await backend({ allowed: false, stderr: 'GPU3 failed sanity test' })).version())).toBe('ae-allow-scripts');
  });

  it('a startup failure is retried once before the card (second launch may pass)', async () => {
    let n = 0;
    const spawn = vi.fn(async (_b: string, args: string[]) => {
      n++;
      if (n > 1) {
        const launcher = await readFile(args[3]!, 'utf8');
        const job = JSON.parse(await readFile(JSON.parse(/var EDITMCP_JOB = (.*);/.exec(launcher)![1]!), 'utf8')) as { result: string };
        await writeFile(job.result, JSON.stringify({ ok: true, data: { version: '26.5' } }));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: 'GPU3 failed (previous) sanity test' };
    });
    const b = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', afterfx: 'AfterFX.com' }, { spawn: spawn as unknown as SpawnFn, minFreeRamGb: 0, retryDelayMs: 1, listProcesses: async () => [], scriptingPref: async () => ({ prefsFile: 'p', allowed: true }) });
    await b.version().catch(() => undefined);
    expect(n).toBe(2);
  });

  it('"cannot write" from the runner maps to the card only when the pref really is off', async () => {
    expect(await codeOf((await backend({ allowed: false, runnerError: 'cannot write C:\\x.json' })).version())).toBe('ae-allow-scripts');
    const e = await (await backend({ allowed: true, runnerError: 'cannot write C:\\x.json' })).version().catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(UserActionError);
    expect(String(e)).toMatch(/cannot write/);
  });

  it('no After Effects installed → the not-found card', async () => {
    const b = createAeBackend({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, { minFreeRamGb: 0 });
    expect(await codeOf(b.version())).toBe('ae-not-found');
  });

  it('reads "Allow Scripts to Write Files" from the newest AE prefs (quoted or raw hex), without AE', async () => {
    const appdata = await tmp();
    const write = async (ver: string, line: string) => {
      const d = join(appdata, 'Adobe', 'After Effects', ver);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, `Adobe After Effects ${ver} Prefs.txt`), `["Main Pref Section v2"]\n\t${line}\n`);
    };
    expect(await aeScriptingPref({ APPDATA: appdata })).toEqual({});
    await write('26.0', '"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = 00');
    expect(await aeScriptingPref({ APPDATA: appdata })).toMatchObject({ allowed: false, aeVersion: '26.0' });
    await write('26.5', '"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"');
    expect(await aeScriptingPref({ APPDATA: appdata })).toMatchObject({ allowed: true, aeVersion: '26.5' });
    await write('26.10', '"Something Else" = "1"');
    expect(await aeScriptingPref({ APPDATA: appdata })).toEqual({ prefsFile: expect.stringContaining('26.10'), aeVersion: '26.10' });
  });
});

describe('ready_check', () => {
  async function state(o: { afterfx?: boolean; ffmpeg?: boolean } = {}): Promise<AppState> {
    const { env } = await safeEnvironment();
    const root = await tmp();
    return {
      env: { ...env, tools: { ...env.tools, ffmpeg: o.ffmpeg === false ? '' : 'ffmpeg', ...(o.afterfx === false ? { afterfx: undefined } : { afterfx: 'AfterFX.com' }), premiereExe: 'C:\\Adobe\\Premiere.exe' } },
      ae: new MockAeBackend(), jobs: new JobManager(), problems: o.ffmpeg === false ? ['ffmpeg not found'] : [],
      assembler: { build: async () => { throw new Error('x'); }, deliver: async () => ({}), reviewProxy: async () => '' },
      api: { project: projectApi, xmeml: xmemlApi, probe: async () => ({ durationFrames: 1, hasVideo: true, hasAudio: false }) },
      premiere: createPremiereClient({ queueDir: join(root, 'q'), installDir: join(root, 'not-installed') }),
      premiereHost: { running: async () => [], debugModeMissing: async () => [], launch: () => ({}) },
    };
  }

  it('lists each app with what stays open and the cards to follow', async () => {
    const r = await readiness(await state(), { aePref: async () => ({ prefsFile: 'p', aeVersion: '26.5', allowed: false }), freeGb: async () => 6 });
    expect(r.ready).toBe(false);
    expect(r.apps.map((a) => [a.app, a.status, a.keepOpen])).toEqual([
      ['ffmpeg', 'ok', 'never'],
      ['after-effects', 'action', 'never'],
      ['premiere', 'action', 'catcut-opens-it'],
      ['disk', 'action', 'never'],
    ]);
    expect(r.apps.map((a) => a.userAction?.code)).toEqual([undefined, 'ae-allow-scripts', 'bridge-not-installed', 'disk-low']);
    expect(r.say).toContain('ต้องทำ:');
    expect(r.say).toContain('Allow Scripts to Write Files');
  });

  it('all ready: says nothing needs to stay open', async () => {
    const s = await state();
    const inst = join(await tmp(), 'ext');
    await mkdir(join(inst, 'CSXS'), { recursive: true });
    await writeFile(join(inst, 'CSXS', 'manifest.xml'), '<x/>');
    await writeFile(join(inst, 'package.json'), await readFile(join(process.cwd(), 'premiere', 'catcut-bridge', 'package.json'), 'utf8'));
    s.premiere = createPremiereClient({ queueDir: join(await tmp(), 'q'), installDir: inst });
    const r = await readiness(s, { aePref: async () => ({ prefsFile: 'p', aeVersion: '26.5', allowed: true }), freeGb: async () => 300 });
    expect(r.ready).toBe(true);
    expect(r.apps.find((a) => a.app === 'premiere')).toMatchObject({ status: 'ok', keepOpen: 'catcut-opens-it', note: expect.stringContaining('CatCut เปิดให้') });
    expect(r.say).toContain('ไม่ต้องเปิดโปรแกรมไหนค้างไว้');
  });

  it('12 GB free is a note, not a card that stops the agent; under 8 GB is a card', async () => {
    const note = await readiness(await state(), { aePref: async () => ({ prefsFile: 'p', aeVersion: '26.5', allowed: true }), freeGb: async () => 12 });
    expect(note.apps.filter((a) => a.app === 'disk').every((a) => a.status === 'ok' && !a.userAction && a.note.includes('ทำงานต่อได้'))).toBe(true);
    const low = await readiness(await state(), { aePref: async () => ({ prefsFile: 'p', aeVersion: '26.5', allowed: true }), freeGb: async () => 6 });
    expect(low.apps.find((a) => a.app === 'disk')).toMatchObject({ status: 'action', userAction: { code: 'disk-low' } });
  });

  it('missing AE is optional, missing ffmpeg is an action', async () => {
    const r = await readiness(await state({ afterfx: false, ffmpeg: false }), { freeGb: async () => 300 });
    expect(r.apps.find((a) => a.app === 'after-effects')).toMatchObject({ status: 'optional' });
    expect(r.apps.find((a) => a.app === 'ffmpeg')).toMatchObject({ status: 'action', userAction: { code: 'ffmpeg-missing' } });
  });
});

describe('disk_report: every folder in the project and a budget', () => {
  it('lists folders that are not CatCut\'s and warns past the budget', async () => {
    const dir = join(await tmp(), 'งาน');
    const p = await projectApi.createProject(dir, { name: 'x' });
    await mkdir(join(dir, 'review', 'evidence'), { recursive: true });
    await writeFile(join(dir, 'review', 'evidence', 'f.png'), Buffer.alloc(2000));
    await mkdir(join(dir, 'SLOWMO_EXPORTS'), { recursive: true });
    await writeFile(join(dir, 'SLOWMO_EXPORTS', 'b46_1.mov'), Buffer.alloc(5000));
    const statfs = async () => ({ bavail: 10 ** 9, bsize: 1, blocks: 10 ** 10 });
    const rep = await diskReport(p, { statfs, env: {}, budgetGb: 5000 / 1024 ** 3 });
    expect(rep.project.other['SLOWMO_EXPORTS']).toBe(5000);
    expect(rep.project.review).toBe(2000);
    expect(rep.project.total).toBeGreaterThanOrEqual(7000);
    expect(rep.warnings.some((w) => /เกินงบ/.test(w) && /SLOWMO_EXPORTS/.test(w))).toBe(true);
    expect((await diskReport(p, { statfs, env: {} })).warnings.some((w) => /เกินงบ/.test(w))).toBe(false);
  });
});

describe('timeline_lint slowmo', () => {
  const project = (video: Clip[]): Project => ({
    meta: { name: 't', fps: 25, width: 320, height: 180, createdAt: '2026-10-12T00:00:00Z', schema: 1 },
    dir: 'X:/nowhere',
    assets: {
      client: { id: 'client', kind: 'camera', path: 'X:/client.mp4', probe: { durationFrames: 500, fps: 25, hasVideo: true, hasAudio: false } },
      reshoot: { id: 'reshoot', kind: 'camera', path: 'X:/C0001.MP4', probe: { durationFrames: 1000, fps: 50, hasVideo: true, hasAudio: false } },
    },
    timeline: { video, cuts: [], audio: { vo: [], music: [], sfx: [] } },
    delivery: { targets: [] }, versions: [],
  });

  it('flags slowed footage that has to repeat frames unless it uses motion interpolation', () => {
    const p = project([
      { id: 'a', src: 'client', in: 0, dur: 50, speed: { rate: 0.6 } },
      { id: 'b', src: 'client', in: 100, dur: 50, speed: { rate: 0.6, interpolation: 'motion' } },
      { id: 'c', src: 'reshoot', in: 0, dur: 50, speed: { rate: 0.5 } }, // 50 fps at 50% = 25 real frames: fine
      { id: 'd', src: 'reshoot', in: 100, dur: 50, speed: { rate: 0.4 } },
      { id: 'e', src: 'client', in: 200, dur: 50, speed: { rate: 1, rampFrom: 0.5, rampFrames: 10 } },
    ]);
    const issues = lintTimeline(p, {}, { checks: ['slowmo'] });
    expect(issues.map((i) => i.clipId)).toEqual(['a', 'd', 'e']);
    expect(issues[0]).toMatchObject({ kind: 'slowmo', startFrame: 0, tc: '00:00:00:00', message: expect.stringContaining('Optical Flow') });
  });
});

describe('board_vs_cut: file names written on the board win', () => {
  it('extracts clip ids from board text', () => {
    expect(boardFileIds('C094 หรือ C095')).toEqual(['C094', 'C095']);
    expect(boardFileIds('CARD 1 / B025C030_261009FG.MP4')).toEqual(['B025C030_261009FG']);
    expect(boardFileIds('C005, C008 or color')).toEqual(['C005', 'C008']);
    expect(boardFileIds('ฟุตเก่า')).toEqual([]);
  });

  it('flags a slot cut from other files, accepts Sony zero padding and longer names', () => {
    const board: Board = {
      source: 'b.pdf', importedAt: '',
      slots: [
        { id: '14', order: 1, sourceHint: 'C094 หรือ C095' },
        { id: '29', order: 2, sourceHint: 'C005, C008' },
        { id: '59', order: 3, sourceHint: 'B025C030_261009FG.MP4' },
        { id: '60', order: 4 },
      ],
    };
    const shots = [
      { id: 'x1', src: 'a', start: 0, dur: 10, slot: '14', file: 'C0094.MP4' },
      { id: 'x2', src: 'b', start: 10, dur: 10, slot: '29', file: 'C0007.MP4' },
      { id: 'x3', src: 'c', start: 20, dur: 10, slot: '59', file: 'B025C030_261009FG.MP4' },
      { id: 'x4', src: 'd', start: 30, dur: 10, slot: '60', file: 'anything.mov' },
    ];
    const r = compareBoardToCut(board, shots, 40, 25, 5);
    expect(r.slots.filter((s) => s.fileMismatch).map((s) => [s.slot, s.fileMismatch])).toEqual([['29', { wanted: ['C005', 'C008'], used: ['C0007.MP4'] }]]);
    expect(r.issues.find((i) => i.clipId === 'x2')).toMatchObject({ severity: 'error', message: expect.stringContaining('C005 / C008') });
    expect(r.summary.join('\n')).toContain('ใช้ไฟล์ไม่ตรงที่บอร์ดระบุ 1 slot (29)');
    // C0033 must not satisfy a board asking for C003
    const strict = compareBoardToCut({ source: '', importedAt: '', slots: [{ id: '1', order: 1, sourceHint: 'C003' }] }, [{ id: 'y', src: 'a', start: 0, dur: 5, slot: '1', file: 'C0033.MP4' }], 5, 25, 5);
    expect(strict.slots[0]!.fileMismatch).toBeDefined();
  });
});

describe('proxy_make (real ffmpeg, tiny synthetic clip)', () => {
  let tools: ToolPaths;
  beforeAll(async () => { tools = await discoverTools(); });

  it('keeps the original name + _Proxy, the folder layout, frame count, timecode and audio; never overwrites', async () => {
    const root = await tmp();
    const card = join(root, 'CARD 1');
    await mkdir(card, { recursive: true });
    const src = join(card, 'C0001.MP4');
    await execa(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=50:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-timecode', '10:00:00:00', '-shortest', src]);
    const proxyDir = join(root, 'Proxy');
    const plan = await planProxies([card], proxyDir);
    expect(plan).toEqual([{ source: src, proxy: join(proxyDir, 'CARD 1', 'C0001_Proxy.mp4') }]);
    const r = await makeProxies(tools, { h264_nvenc: false, h264_qsv: false, hevc_nvenc: false, libx264: true, prores_ks: true, dnxhd: true, mpeg2video: true }, plan, { height: 180 });
    expect(r.rows).toMatchObject([{ status: 'made', frames: 50 }]);
    const probe = await execa(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height,r_frame_rate,channels:stream_tags=timecode', '-of', 'json', plan[0]!.proxy]);
    const streams = (JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>> }).streams;
    expect(streams.find((s) => s['codec_type'] === 'video')).toMatchObject({ codec_name: 'h264', height: 180, r_frame_rate: '50/1' });
    expect(streams.find((s) => s['codec_type'] === 'audio')).toMatchObject({ channels: 2 });
    expect(JSON.stringify(streams)).toContain('10:00:00:00');
    const again = await makeProxies(tools, { h264_nvenc: false, h264_qsv: false, hevc_nvenc: false, libx264: true, prores_ks: true, dnxhd: true, mpeg2video: true }, plan, { height: 180 });
    expect(again.rows).toMatchObject([{ status: 'exists' }]);
    expect(existsSync(join(proxyDir, 'CARD 1', '.C0001_Proxy.part.mp4'))).toBe(false);
  }, 60_000);
});
