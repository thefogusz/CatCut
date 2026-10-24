/**
 * Reels tools end to end with the real modules and ffmpeg on synthetic media: jumpcut → punch_in →
 * sfx_on_cuts → captions (transcript placed in the cache, so whisper is not needed) + hook → build →
 * deliver, then the burned-in captions are checked in the pixels.
 */
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clip } from '../../src/core/types.js';
import { transcriptsDir } from '../../src/engine/captions.js';
import { hasFilter } from '../../src/engine/ffmpeg.js';
import { findWhisper, transcriptKey } from '../../src/engine/transcribe.js';
import { createAppState } from '../../src/mcp/state.js';
import { callTool, toolResultData } from '../../src/mcp/tools.js';

const TMP_ROOT = join(process.cwd(), 'tmp', 'reels-test');
const st = await createAppState();
const ff = st.env.tools.ffmpeg;
const libass = ff ? await hasFilter(ff, 'subtitles') : false;

type Body = Record<string, unknown>;
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Body> => {
  const r = await callTool(st, name, args);
  const data = toolResultData(r);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
  return data;
};
const job = async (name: string, args: Record<string, unknown> = {}): Promise<Body> => {
  const started = await call(name, args);
  const done = await call('job_wait', { id: started['jobId'] });
  expect(done['status']).toBe('done');
  return done['result'] as Body;
};

/** 90x160 grey pixels of one frame. */
async function grey(file: string, sec: number): Promise<Buffer> {
  const r = await execa(ff, ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=90:160,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  return Buffer.from(r.stdout);
}
const meanDiff = (a: Buffer, b: Buffer) => a.reduce((n, v, i) => n + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

describe.skipIf(!ff)('reels tools (real modules, synthetic media)', () => {
  let dir: string;
  let cam: string;

  beforeAll(async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    dir = await mkdtemp(join(TMP_ROOT, 'p-'));
    cam = join(dir, 'คลิปพูด.mp4');
    // 4 s of flat colour; "speech" (a tone) at 0–1 s and 1.8–3 s
    await execa(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x204060:s=360x640:r=25:d=4',
      '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0,1)+between(t,1.8,3),0.5*sin(2*PI*440*t),0)':s=48000:d=4",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', cam]);
    await execa(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=900:d=0.3', join(dir, 'whoosh.wav')]);
    await call('project_new', { dir: join(dir, 'reel'), name: 'reel', width: 360, height: 640, fps: 25 });
    await call('asset_add', { path: cam, id: 'cam' });
    await call('asset_add', { path: join(dir, 'whoosh.wav'), id: 'whoosh' });
    await call('timeline_set', { timeline: { video: [{ id: 's1', src: 'cam', in: 0, dur: 100 }] } });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('jumpcut: dry run, then splits the clip at the pause and drops the silent tail', async () => {
    const dry = await call('jumpcut', { padMs: 0 });
    expect(dry['applied']).toBe(false);
    expect((dry['clips'] as Body[])[0]).toMatchObject({ clip: 's1', pieces: 2 });
    const r = await call('jumpcut', { padMs: 0, apply: true });
    expect(r['applied']).toBe(true);
    const video = st.project!.timeline.video;
    expect(video.map((c) => c.id)).toEqual(['s1_j1', 's1_j2']);
    expect(video[0]).toMatchObject({ in: 0 });
    expect(video[0]!.dur).toBeGreaterThanOrEqual(24);
    expect(video[1]!.in).toBeGreaterThanOrEqual(44);
    expect(video[0]!.dur + video[1]!.dur).toBeLessThan(80); // ~1.8 s of 4 s was silence
  });

  it('punch_in alternates the zoom on pieces of the same source; sfx_on_cuts lands on the cut', async () => {
    const z = await call('punch_in', { apply: true });
    expect(z['changes']).toEqual([{ clip: 's1_j2', from: 100, to: 115 }]);
    expect(st.project!.timeline.video.map((c: Clip) => c.scale ?? 100)).toEqual([100, 115]);
    const s = await call('sfx_on_cuts', { srcs: ['whoosh'], cuts: 'all', apply: true });
    const cutAt = st.project!.timeline.video[0]!.dur;
    expect(st.project!.timeline.audio.sfx).toEqual([{ id: 'sfx_auto_1', src: 'whoosh', at: cutAt - 2, gainDb: -8 }]);
    expect(s['replaced']).toBe(0);
    expect((await call('sfx_on_cuts', { srcs: ['whoosh'], apply: true }))['added']).toEqual([]); // same source: no source change
  });

  it('captions from the cached transcript, placed through the jump cuts, plus a hook', async () => {
    const plan0 = await call('captions_plan');
    expect(plan0['missing']).toEqual(['cam']);
    const cache = transcriptsDir(st.project!);
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, `${await transcriptKey(cam, findWhisper().model, 'auto')}.json`), JSON.stringify({
      source: cam, lang: 'en', model: 'test', text: 'hello world gone',
      words: [{ text: 'hello', startMs: 100, endMs: 600 }, { text: 'world', startMs: 2000, endMs: 2600 }, { text: 'gone', startMs: 3500, endMs: 3800 }],
    }));
    const set = await call('captions_set', { style: 'pop', uppercase: true });
    expect(set['captions']).toMatchObject({ enabled: true, style: 'pop' });
    await call('text_add', { text: 'HOOK', dur: 20 });
    const plan = await call('captions_plan');
    const caps = plan['captions'] as Array<{ start: number; text: string }>;
    // "gone" sits in the cut-out tail; "world" moves earlier by the removed pause
    expect(caps.map((c) => c.text)).toEqual(['hello', 'world']);
    expect(caps[1]!.start).toBe(st.project!.timeline.video[0]!.dur + (50 - st.project!.timeline.video[1]!.in));
  });

  it.skipIf(!libass)('deliver burns captions and the hook into vert, the master stays clean', async () => {
    const built = await job('build', {});
    const master = String(built['master']);
    const out = await job('deliver', { targets: ['vert'] });
    const vert = String((out['deliverables'] as Body)['vert']);
    // 0.3 s: hook + "HELLO" on screen; compare with the master at the same time (same flat colour otherwise)
    expect(meanDiff(await grey(vert, 0.3), await grey(master, 0.3))).toBeGreaterThan(2);
    // after the last caption ends there is nothing burned in
    const end = (st.project!.timeline.video[0]!.dur + st.project!.timeline.video[1]!.dur) / 25 - 0.05;
    expect(meanDiff(await grey(vert, end), await grey(master, end))).toBeLessThan(1);
  });
});
