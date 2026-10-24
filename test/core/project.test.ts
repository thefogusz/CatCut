import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type { Asset, ProbeInfo, Project, Timeline } from '../../src/core/types.js';
import {
  ProjectConflictError,
  ProjectLockedError,
  addAeComp,
  addFileAsset,
  clipStartFrames,
  createProject,
  isProtected,
  loadProject,
  nextVersionId,
  planHash,
  projectPaths,
  saveProject,
  setTimeline,
  timelineFrames,
  validateTimeline,
} from '../../src/core/project.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_ROOT = path.join(ROOT, 'tmp');

let dir: string;
beforeEach(async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  dir = await mkdtemp(path.join(TMP_ROOT, 'test-core-project-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- fixtures (no disk) ----------

const probe = (durationFrames: number, extra: Partial<ProbeInfo> = {}): ProbeInfo => ({
  durationFrames, width: 1920, height: 1080, fps: 25, hasVideo: true, hasAudio: true, ...extra,
});

function fixtureProject(overrides: Partial<Project> = {}): Project {
  const assets: Record<string, Asset> = {
    A: { id: 'A', kind: 'camera', path: 'D:\\x\\a.mp4', hash: 'hashA', probe: probe(100) },
    B: { id: 'B', kind: 'camera', path: 'D:\\x\\b.mp4', hash: 'hashB', probe: probe(100, { hasAudio: false }) },
    U: { id: 'U', kind: 'camera', path: 'D:\\x\\u.mp4' }, // unprobed: length unknown
    S: { id: 'S', kind: 'still', path: 'D:\\x\\s.png', hash: 'hashS', probe: probe(1, { hasAudio: false }) },
    VO: { id: 'VO', kind: 'audio', path: 'D:\\x\\vo.wav', hash: 'hashVO', probe: probe(200, { hasVideo: false }) },
    C: { id: 'C', kind: 'aecomp', aep: 'D:\\x\\t.aep', comp: 'Title', fingerprint: 'fpC',
      render: { path: 'D:\\x\\cache\\C.mov', frames: 50, fingerprint: 'fpC', renderedAt: 'now' } },
  };
  return {
    meta: { name: 'fx', fps: 25, width: 1920, height: 1080, createdAt: '2026-01-01T00:00:00.000Z', schema: 1 },
    dir: path.join(dir, 'nonexistent-project'),
    assets,
    timeline: { video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } },
    delivery: { targets: [] },
    versions: [],
    ...overrides,
  };
}

const okTimeline = (): Timeline => ({
  video: [
    { id: 's1', src: 'C', in: 0, dur: 40 },
    { id: 's2', src: 'A', in: 20, dur: 50, scale: 110, marker: 'เปิดเรื่อง' },
    { id: 's3', src: 'S', in: 0, dur: 25 },
  ],
  cuts: [{ after: 's1', dissolve: 10 }, { after: 's2', dissolve: 0 }],
  audio: {
    vo: [{ id: 'v1', src: 'VO', at: 0, in: 0, dur: 100 }],
    music: [{ id: 'm1', src: 'VO', at: 10, gainDb: -6, fadeIn: 5, fadeOut: 10 }],
    sfx: [],
    duck: { underDb: -12, attackMs: 50, releaseMs: 300 },
  },
});

// ---------- create / load / save ----------

describe('createProject / loadProject / saveProject', () => {
  it('creates project.json with defaults and the folder layout', async () => {
    const pdir = path.join(dir, 'proj');
    const p = await createProject(pdir, { name: 'งานทดสอบ' });
    expect(p.dir).toBe(path.resolve(pdir));
    expect(p.meta).toMatchObject({ name: 'งานทดสอบ', fps: 25, width: 1920, height: 1080, schema: 1 });
    expect(p.meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.timeline).toEqual({ video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } });
    expect(existsSync(path.join(pdir, 'project.json'))).toBe(true);
    expect(existsSync(path.join(pdir, 'cache', 'segments'))).toBe(true);
    expect(existsSync(path.join(pdir, 'out'))).toBe(true);

    const raw = JSON.parse(await readFile(path.join(pdir, 'project.json'), 'utf8'));
    expect(raw.dir).toBeUndefined(); // location is not persisted
    expect(raw.meta.name).toBe('งานทดสอบ');
  });

  it('refuses to overwrite an existing project and validates meta', async () => {
    const pdir = path.join(dir, 'proj');
    await createProject(pdir, { name: 'x', fps: 29.97, width: 1080, height: 1920 });
    await expect(createProject(pdir, { name: 'y' })).rejects.toThrow(/already exists/);
    await expect(createProject(path.join(dir, 'p2'), { name: '  ' })).rejects.toThrow(/name/);
    await expect(createProject(path.join(dir, 'p3'), { name: 'x', fps: 0 })).rejects.toThrow(/fps/);
    await expect(createProject(path.join(dir, 'p4'), { name: 'x', width: 10.5 })).rejects.toThrow(/width/);
  });

  it('round-trips through save/load, accepting the project.json path too', async () => {
    const pdir = path.join(dir, 'proj');
    const p = await createProject(pdir, { name: 'rt', fps: 50 });
    p.assets['A'] = { id: 'A', kind: 'camera', path: 'D:\\x\\a.mp4', hash: 'h' };
    setTimeline(p, okTimeline());
    p.delivery = { targets: ['yt', 'th_tv'], note: 'ส่งช่อง' };
    await saveProject(p);

    const q = await loadProject(pdir);
    expect(q).toEqual(p);
    const q2 = await loadProject(path.join(pdir, 'project.json'));
    expect(q2.dir).toBe(p.dir);
    expect(q2.meta.fps).toBe(50);
  });

  it('saves atomically: no temp files remain and the file is complete JSON', async () => {
    const pdir = path.join(dir, 'proj');
    const p = await createProject(pdir, { name: 'atomic' });
    await Promise.all([saveProject(p), saveProject(p), saveProject(p)]);
    const names = await readdir(pdir);
    expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(pdir, 'project.json'), 'utf8')).meta.name).toBe('atomic');
  });

  it('rejects missing, corrupt and unknown-schema projects', async () => {
    await expect(loadProject(path.join(dir, 'nope'))).rejects.toThrow(/no project\.json/);
    const bad = path.join(dir, 'bad');
    await mkdir(bad);
    await writeFile(path.join(bad, 'project.json'), '{ not json', 'utf8');
    await expect(loadProject(bad)).rejects.toThrow(/not valid JSON/);
    await writeFile(path.join(bad, 'project.json'), JSON.stringify({ meta: { schema: 2 } }), 'utf8');
    await expect(loadProject(bad)).rejects.toThrow(/schema/);
  });

  it('loadProject fills in missing sections', async () => {
    const pdir = path.join(dir, 'minimal');
    await mkdir(pdir);
    const meta = { name: 'm', fps: 25, width: 1920, height: 1080, createdAt: 'x', schema: 1 };
    await writeFile(path.join(pdir, 'project.json'), JSON.stringify({ meta, timeline: { video: [{ id: 'a', src: 'A', in: 0, dur: 1 }] } }), 'utf8');
    const p = await loadProject(pdir);
    expect(p.assets).toEqual({});
    expect(p.versions).toEqual([]);
    expect(p.delivery).toEqual({ targets: [] });
    expect(p.timeline.cuts).toEqual([]);
    expect(p.timeline.audio).toEqual({ vo: [], music: [], sfx: [] });
    expect(p.timeline.video).toHaveLength(1);
  });
});

describe('projectPaths', () => {
  it('returns absolute paths and creates them on demand', () => {
    const p = fixtureProject({ dir: path.join(dir, 'pp') });
    const paths = projectPaths(p);
    expect(paths).toEqual({
      cacheSegments: path.join(p.dir, 'cache', 'segments'),
      cacheRenders: path.join(p.dir, 'cache', 'renders'),
      cacheAudio: path.join(p.dir, 'cache', 'audio'),
      out: path.join(p.dir, 'out'),
      review: path.join(p.dir, 'review'),
      tmp: path.join(p.dir, 'cache', 'tmp'),
    });
    for (const d of Object.values(paths)) {
      expect(path.isAbsolute(d)).toBe(true);
      expect(existsSync(d)).toBe(true);
    }
  });
});

// ---------- assets ----------

describe('addFileAsset', () => {
  it('infers kind, hashes, resolves the path and derives ids (Thai preserved)', async () => {
    const p = fixtureProject({ assets: {} });
    const media = path.join(dir, 'media');
    await mkdir(media);
    const files = { cam: 'คลิป 01.mp4', vo: 'VO take2.wav', logo: 'logo.png', odd: '(((.mov' };
    for (const f of Object.values(files)) await writeFile(path.join(media, f), f);

    const cam = await addFileAsset(p, path.join(media, files.cam));
    expect(cam).toMatchObject({ id: 'คลิป_01', kind: 'camera', path: path.join(media, files.cam) });
    expect(cam.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(cam.probe).toBeUndefined();

    const vo = await addFileAsset(p, path.join(media, files.vo));
    expect(vo).toMatchObject({ id: 'VO_take2', kind: 'audio' });
    const logo = await addFileAsset(p, path.join(media, files.logo));
    expect(logo.kind).toBe('still');
    const odd = await addFileAsset(p, path.join(media, files.odd));
    expect(odd.id).toMatch(/^camera_[0-9a-f]{8}$/);
    expect(Object.keys(p.assets)).toEqual([cam.id, vo.id, logo.id, odd.id]);
  });

  it('honours explicit id/kind, calls probe, is idempotent for the same file and uniquifies clashes', async () => {
    const p = fixtureProject({ assets: {} });
    const f1 = path.join(dir, 'a.mp4');
    const f2 = path.join(dir, 'sub', 'a.mp4');
    await mkdir(path.dirname(f2));
    await writeFile(f1, '1');
    await writeFile(f2, '2');

    const probed: string[] = [];
    const g = await addFileAsset(p, f1, { id: 'G1', kind: 'graphic', probe: async (pp) => { probed.push(pp); return probe(10); } });
    expect(g).toMatchObject({ id: 'G1', kind: 'graphic', probe: { durationFrames: 10 } });
    expect(probed).toEqual([f1]);

    // same path, no id -> returns the existing id (updated), no duplicate
    const again = await addFileAsset(p, f1);
    expect(again.id).toBe('G1');
    expect(Object.keys(p.assets)).toEqual(['G1']);
    // same path with its own id -> allowed (update)
    expect((await addFileAsset(p, f1, { id: 'G1' })).id).toBe('G1');
    // different file, clashing id -> error
    await expect(addFileAsset(p, f2, { id: 'G1' })).rejects.toThrow(/already in use/);
    // different file, derived id clashes with nothing ('a') then uniquifies
    const a1 = await addFileAsset(p, f2);
    expect(a1.id).toBe('a');
    p.assets['a_x'] = { id: 'a_x', kind: 'camera', path: 'D:\\other\\z.mp4' };
    const f3 = path.join(dir, 'sub2', 'a.mp4');
    await mkdir(path.dirname(f3));
    await writeFile(f3, '3');
    expect((await addFileAsset(p, f3)).id).toBe('a_2');

    await expect(addFileAsset(p, path.join(dir, 'missing.mp4'))).rejects.toThrow(/file not found/);
    await expect(addFileAsset(p, dir)).rejects.toThrow(/file not found/);
    await expect(addFileAsset(p, f1, { id: 'bad/id' })).rejects.toThrow(/invalid asset id/);
    await expect(addFileAsset(p, f1, { id: '' })).rejects.toThrow(/invalid asset id/);
  });
});

describe('addAeComp', () => {
  it('creates, dedupes by (aep, comp) and resolves the aep path', () => {
    const p = fixtureProject({ assets: {} });
    const c = addAeComp(p, 'ae/ไตเติล.aep', 'Title 01');
    expect(c).toEqual({ id: 'C_Title_01', kind: 'aecomp', aep: path.resolve('ae/ไตเติล.aep'), comp: 'Title 01' });
    expect(addAeComp(p, 'ae/ไตเติล.aep', 'Title 01')).toBe(c);
    expect(addAeComp(p, 'ae/ไตเติล.aep', 'Title 01', 'C_Title_01')).toBe(c);
    const c2 = addAeComp(p, 'ae/ไตเติล.aep', 'Title 02', 'T2');
    expect(c2.id).toBe('T2');
    expect(() => addAeComp(p, 'ae/other.aep', 'Title 03', 'T2')).toThrow(/already in use/);
    expect(() => addAeComp(p, 'ae/other.aep', '  ')).toThrow(/comp name/);
    const thai = addAeComp(p, 'ae/x.aep', 'ชื่อเรื่อง');
    expect(thai.id).toBe('C_ชื่อเรื่อง');
    expect(Object.keys(p.assets)).toEqual(['C_Title_01', 'T2', 'C_ชื่อเรื่อง']);
  });
});

// ---------- timeline ----------

describe('setTimeline / timelineFrames / clipStartFrames', () => {
  it('normalises missing arrays and copies input', () => {
    const p = fixtureProject();
    const input = { video: [{ id: 'a', src: 'A', in: 0, dur: 10 }] } as unknown as Timeline;
    setTimeline(p, input);
    expect(p.timeline).toEqual({ video: [{ id: 'a', src: 'A', in: 0, dur: 10 }], cuts: [], audio: { vo: [], music: [], sfx: [] } });
    expect(p.timeline.video).not.toBe(input.video);
    expect(() => setTimeline(p, null as unknown as Timeline)).toThrow(TypeError);
  });

  it('sums durations and computes clip starts in order', () => {
    const p = fixtureProject();
    setTimeline(p, okTimeline());
    expect(timelineFrames(p)).toBe(115);
    expect([...clipStartFrames(p)]).toEqual([['s1', 0], ['s2', 40], ['s3', 90]]);
    setTimeline(p, { video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } });
    expect(timelineFrames(p)).toBe(0);
    expect(clipStartFrames(p).size).toBe(0);
  });
});

describe('validateTimeline', () => {
  const check = (mutate: (t: Timeline) => void): string[] => {
    const p = fixtureProject();
    const t = okTimeline();
    mutate(t);
    setTimeline(p, t);
    return validateTimeline(p);
  };

  it('accepts a well-formed timeline', () => {
    expect(check(() => {})).toEqual([]);
  });

  it('flags an empty timeline', () => {
    expect(check((t) => { t.video = []; t.cuts = []; })).toEqual(['timeline.video is empty']);
  });

  it('flags unknown assets on video and audio', () => {
    const errs = check((t) => { t.video[1]!.src = 'NOPE'; t.audio.vo[0]!.src = 'ZZ'; });
    expect(errs).toContain("clip[s2]: unknown asset 'NOPE'");
    expect(errs).toContain("audio.vo[v1]: unknown asset 'ZZ'");
  });

  it('flags dur <= 0, in < 0, non-integer frames and bad scale', () => {
    expect(check((t) => { t.video[1]!.dur = 0; })).toEqual(['clip[s2]: dur must be > 0 (got 0)']);
    expect(check((t) => { t.video[1]!.in = -1; })).toEqual(['clip[s2]: in must be >= 0 (got -1)']);
    expect(check((t) => { t.video[1]!.dur = 12.5; })[0]).toMatch(/clip\[s2\]: dur must be an integer/);
    expect(check((t) => { t.video[1]!.in = NaN; })[0]).toMatch(/clip\[s2\]: in must be an integer/);
    expect(check((t) => { t.video[1]!.scale = 0; })).toEqual(['clip[s2]: scale must be > 0 (got 0)']);
  });

  it('flags in+dur beyond the source when its length is known (probe or AE render), not for stills or unprobed', () => {
    expect(check((t) => { t.video[1]!.in = 60; })).toEqual(["clip[s2]: in+dur (110) exceeds source length 100 of 'A'"]);
    expect(check((t) => { t.video[1]!.in = 50; })).toEqual([]); // exactly to the end is fine
    const over = check((t) => { t.video[0]!.dur = 51; });
    expect(over).toContain("clip[s1]: in+dur (51) exceeds source length 50 of 'C'");
    expect(over).toContain("cut[after=s1]: dissolve 10 needs 5 handle frame(s) after 's1' out, source 'C' has 0");
    expect(over).toHaveLength(2);
    expect(check((t) => { t.video[2]!.dur = 5000; })).toEqual([]); // still loops
    expect(check((t) => { t.video[1]!.src = 'U'; t.video[1]!.in = 100000; })).toEqual([]); // unknown length
  });

  it('flags audio assets used as video', () => {
    expect(check((t) => { t.video[1]!.src = 'VO'; })).toEqual(["clip[s2]: asset 'VO' is audio-only, cannot be used as video"]);
  });

  it('flags cuts that refer to unknown or last clips, duplicates and bad dissolve values', () => {
    expect(check((t) => { t.cuts = [{ after: 'zz', dissolve: 0 }]; })).toEqual(['cut[after=zz]: unknown clip']);
    expect(check((t) => { t.cuts = [{ after: 's3', dissolve: 4 }]; })[0]).toMatch(/cut\[after=s3\]: refers to the last clip/);
    expect(check((t) => { t.cuts = [{ after: 's1', dissolve: 2 }, { after: 's1', dissolve: 4 }]; })).toEqual(['cut[after=s1]: duplicate cut']);
    expect(check((t) => { t.cuts = [{ after: 's1', dissolve: -2 }]; })[0]).toMatch(/dissolve must be an integer >= 0/);
    expect(check((t) => { t.cuts = [{ after: 's1', dissolve: 2.5 }]; })[0]).toMatch(/dissolve must be an integer >= 0/);
  });

  it('checks dissolve handles against known source lengths (a = floor(N/2) before, b = N - a after)', () => {
    // s1 is C (50 frames), used 0..40: 10 frames of tail handle. Dissolve 20 -> b = 10 ok; 21 -> b = 11 not ok.
    expect(check((t) => { t.cuts = [{ after: 's1', dissolve: 20 }]; })).toEqual([]);
    expect(check((t) => { t.cuts = [{ after: 's1', dissolve: 21 }]; }))
      .toEqual(["cut[after=s1]: dissolve 21 needs 11 handle frame(s) after 's1' out, source 'C' has 10"]);
    // s2 is A in=20: 20 frames of head handle. a = floor(N/2): N=40 -> a=20 ok (b=20 > 10 tail of s1 fails), so test head alone with in=4.
    expect(check((t) => { t.video[1]!.in = 4; t.cuts = [{ after: 's1', dissolve: 9 }]; })).toEqual([]); // a=4
    expect(check((t) => { t.video[1]!.in = 4; t.cuts = [{ after: 's1', dissolve: 10 }]; }))
      .toEqual(["cut[after=s1]: dissolve 10 needs 5 handle frame(s) before 's2' in, clip has 4"]);
    // handles into a still are unlimited; the camera side still needs its tail
    expect(check((t) => { t.video[1]!.in = 40; t.cuts = [{ after: 's2', dissolve: 20 }]; })).toEqual([]);
    expect(check((t) => { t.video[1]!.in = 45; t.cuts = [{ after: 's2', dissolve: 20 }]; }))
      .toEqual(["cut[after=s2]: dissolve 20 needs 10 handle frame(s) after 's2' out, source 'A' has 5"]);
    // unprobed source: no handle check possible
    expect(check((t) => { t.video[1]!.src = 'U'; t.cuts = [{ after: 's2', dissolve: 20 }]; })).toEqual([]);
  });

  it('flags dissolves that consume a whole clip', () => {
    // s2 is 50 frames; incoming b and outgoing a must leave at least 1 frame of body.
    const errs = check((t) => {
      t.video[0]!.src = 'S'; t.video[2]!.src = 'S'; t.video[2]!.dur = 60; // stills on both sides: unlimited handles
      t.video[1]!.in = 25; t.video[1]!.dur = 50;
      t.cuts = [{ after: 's1', dissolve: 50 }, { after: 's2', dissolve: 50 }];
    });
    expect(errs).toEqual(['clip[s2]: dissolves consume 50 frame(s) but the clip is only 50; at least 1 frame of body must remain']);
    // 25 (b of first) + 24 (a of second) = 49 < 51: 2 frames of body remain; tail handle 100-76=24 >= b=24.
    expect(check((t) => {
      t.video[0]!.src = 'S'; t.video[2]!.src = 'S'; t.video[2]!.dur = 60;
      t.video[1]!.in = 25; t.video[1]!.dur = 51;
      t.cuts = [{ after: 's1', dissolve: 50 }, { after: 's2', dissolve: 48 }];
    })).toEqual([]);
    // an invalid dur is reported once, without a cascading body error
    expect(check((t) => { t.video[1]!.dur = 0; })).toEqual(['clip[s2]: dur must be > 0 (got 0)']);
  });

  it('flags duplicate ids among video clips and across audio tracks', () => {
    expect(check((t) => { t.video[2]!.id = 's1'; })).toContain('clip[s1]: duplicate clip id');
    expect(check((t) => { t.audio.sfx = [{ id: 'm1', src: 'VO', at: 0 }]; })).toEqual(['audio.sfx[m1]: duplicate audio clip id']);
    expect(check((t) => { t.audio.music[0]!.id = 'v1'; })).toEqual(['audio.music[v1]: duplicate audio clip id']);
  });

  it('validates audio clip fields and source bounds', () => {
    expect(check((t) => { t.audio.vo[0]!.at = -1; })[0]).toMatch(/audio\.vo\[v1\]: at must be an integer >= 0/);
    expect(check((t) => { t.audio.vo[0]!.in = -1; })[0]).toMatch(/in must be an integer >= 0/);
    expect(check((t) => { t.audio.vo[0]!.dur = 0; })[0]).toMatch(/dur must be an integer > 0/);
    expect(check((t) => { t.audio.vo[0]!.fadeIn = -3; })[0]).toMatch(/fadeIn must be an integer >= 0/);
    expect(check((t) => { t.audio.vo[0]!.gainDb = Infinity; })[0]).toMatch(/gainDb must be a number/);
    expect(check((t) => { t.audio.vo[0]!.in = 150; t.audio.vo[0]!.dur = 60; }))
      .toEqual(["audio.vo[v1]: in+dur (210) exceeds source length 200 of 'VO'"]);
    expect(check((t) => { t.audio.music[0]!.in = 200; }))
      .toEqual(["audio.music[m1]: in (200) is at or past the end of source 'VO' (200)"]);
    expect(check((t) => { t.audio.sfx = [{ id: 'x', src: 'B', at: 0 }]; })).toEqual(["audio.sfx[x]: asset 'B' has no audio"]);
    expect(check((t) => { t.audio.sfx = [{ id: 'x', src: 'S', at: 0 }]; })).toEqual(["audio.sfx[x]: asset 'S' has no audio"]);
    expect(check((t) => { t.audio.sfx = [{ id: 'x', src: 'A', at: 0, in: 50 }]; })).toEqual([]); // camera sound
    expect(check((t) => { t.audio.sfx = [{ id: 'x', src: 'U', at: 0, in: 999 }]; })).toEqual([]); // unprobed
    expect(check((t) => { t.audio.duck = { underDb: NaN, attackMs: -1, releaseMs: 10 }; })).toEqual([
      'audio.duck.underDb must be a number',
      'audio.duck.attackMs must be >= 0',
    ]);
  });

  it('reports many problems at once', () => {
    const errs = check((t) => {
      t.video[0]!.dur = -5;
      t.video[1]!.src = 'NOPE';
      t.cuts.push({ after: 's3', dissolve: 2 });
      t.audio.vo.push({ id: 'v1', src: 'VO', at: 0 });
    });
    expect(errs.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------- planHash / versions ----------

describe('planHash', () => {
  it('is independent of key order in timeline and assets', () => {
    const p1 = fixtureProject();
    setTimeline(p1, okTimeline());
    const p2 = fixtureProject();
    // same content, different key order / insertion order
    const t = okTimeline();
    const reordered: Timeline = {
      audio: { duck: { releaseMs: 300, attackMs: 50, underDb: -12 }, sfx: [], music: t.audio.music.map((c) => ({ gainDb: c.gainDb, fadeOut: c.fadeOut, fadeIn: c.fadeIn, at: c.at, src: c.src, id: c.id })), vo: t.audio.vo },
      cuts: t.cuts.map((c) => ({ dissolve: c.dissolve, after: c.after })),
      video: t.video.map((c) => ({ dur: c.dur, in: c.in, src: c.src, id: c.id, ...(c.scale !== undefined ? { scale: c.scale } : {}), ...(c.marker !== undefined ? { marker: c.marker } : {}) })),
    };
    setTimeline(p2, reordered);
    p2.assets = Object.fromEntries(Object.entries(p1.assets).reverse());
    expect(planHash(p2)).toBe(planHash(p1));
    expect(planHash(p1)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes with timeline edits, used-asset content and picture format; not with unused assets, name or delivery', () => {
    const p = fixtureProject();
    setTimeline(p, okTimeline());
    const base = planHash(p);

    p.timeline.video[1]!.dur += 1;
    expect(planHash(p)).not.toBe(base);
    p.timeline.video[1]!.dur -= 1;
    expect(planHash(p)).toBe(base);

    p.timeline.cuts[0]!.dissolve = 12;
    expect(planHash(p)).not.toBe(base);
    p.timeline.cuts[0]!.dissolve = 10;

    (p.assets['A'] as { hash?: string }).hash = 'hashA2';
    expect(planHash(p)).not.toBe(base);
    (p.assets['A'] as { hash?: string }).hash = 'hashA';

    (p.assets['C'] as { fingerprint?: string }).fingerprint = 'fpC2';
    expect(planHash(p)).not.toBe(base);
    (p.assets['C'] as { fingerprint?: string }).fingerprint = 'fpC';

    (p.assets['B'] as { hash?: string }).hash = 'unused-change'; // B is not referenced
    p.assets['NEW'] = { id: 'NEW', kind: 'camera', path: 'D:\\n.mp4', hash: 'n' };
    p.meta.name = 'renamed';
    p.delivery = { targets: ['yt'] };
    p.versions.push({ id: 'v001', createdAt: 'x', planHash: base, master: 'm', deliverables: {}, stats: { segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} } });
    expect(planHash(p)).toBe(base);

    p.meta.fps = 50;
    expect(planHash(p)).not.toBe(base);
  });

  it('falls back to path / aep when hash / fingerprint are unknown', () => {
    const p = fixtureProject();
    setTimeline(p, { video: [{ id: 'u', src: 'U', in: 0, dur: 10 }], cuts: [], audio: { vo: [], music: [], sfx: [] } });
    const h1 = planHash(p);
    (p.assets['U'] as { path: string }).path = 'D:\\x\\moved.mp4';
    expect(planHash(p)).not.toBe(h1);
  });
});

describe('nextVersionId', () => {
  it('starts at v001 and continues past the highest existing id', () => {
    const p = fixtureProject();
    expect(nextVersionId(p)).toBe('v001');
    const v = (id: string) => ({ id, createdAt: 'x', planHash: 'h', master: 'm', deliverables: {}, stats: { segmentsTotal: 0, segmentsRendered: 0, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} } });
    p.versions.push(v('v001'), v('v003'));
    expect(nextVersionId(p)).toBe('v004');
    p.versions.push(v('weird'));
    expect(nextVersionId(p)).toBe('v004');
  });

  it('never reuses an id whose out/ folder already exists on disk', async () => {
    const p = fixtureProject({ dir: path.join(dir, 'vp') });
    await mkdir(path.join(p.dir, 'out', 'v001'), { recursive: true });
    await mkdir(path.join(p.dir, 'out', 'v002'), { recursive: true });
    expect(nextVersionId(p)).toBe('v003');
  });
});

// ---------- concurrency: optimistic merge + project.lock ----------

describe('saveProject concurrency', () => {
  const version = (id: string): Project['versions'][number] => ({
    id, createdAt: '2026-01-01T00:00:00.000Z', planHash: `ph-${id}`, master: `D:\\x\\out\\${id}\\m.mov`, deliverables: {},
    stats: { segmentsTotal: 1, segmentsRendered: 1, segmentsReused: 0, dissolvesRendered: 0, compsRendered: 0, compsReused: 0, timingsMs: {} },
  });

  it('two loaded copies each append a version: both versions are kept and the second copy sees the first', async () => {
    const pdir = path.join(dir, 'proj');
    await createProject(pdir, { name: 'merge' });
    const a = await loadProject(pdir);
    const b = await loadProject(pdir);
    a.versions.push(version('v001'));
    await saveProject(a);
    const bv = version('v002');
    b.versions.push(bv);
    await saveProject(b);
    expect(b.versions.map((v) => v.id)).toEqual(['v001', 'v002']);
    expect(b.versions[1]).toBe(bv); // merged in place: references held by a running build stay valid
    expect((await loadProject(pdir)).versions.map((v) => v.id)).toEqual(['v001', 'v002']);
    // a's next save merges b's version back in, and a's review fields on v001 survive
    a.versions[0]!.reviewProxy = 'D:\\x\\review\\v001.mp4';
    await saveProject(a);
    const after = await loadProject(pdir);
    expect(after.versions.map((v) => [v.id, v.reviewProxy])).toEqual([['v001', 'D:\\x\\review\\v001.mp4'], ['v002', undefined]]);
    expect(JSON.parse(await readFile(path.join(pdir, 'project.json'), 'utf8')).revision).toBe(4);
  });

  it('merges non-conflicting edits from both sides (timeline on one side, assets on the other)', async () => {
    const pdir = path.join(dir, 'proj');
    const p = await createProject(pdir, { name: 'merge2' });
    p.assets['A'] = { id: 'A', kind: 'camera', path: 'D:\\x\\a.mp4', hash: 'h', probe: probe(100) };
    await saveProject(p);
    const a = await loadProject(pdir);
    const b = await loadProject(pdir);
    setTimeline(a, { video: [{ id: 's1', src: 'A', in: 0, dur: 10 }], cuts: [], audio: { vo: [], music: [], sfx: [] } });
    await saveProject(a);
    b.assets['B'] = { id: 'B', kind: 'still', path: 'D:\\x\\b.png' };
    await saveProject(b);
    const disk = await loadProject(pdir);
    expect(disk.timeline.video.map((c) => c.id)).toEqual(['s1']);
    expect(Object.keys(disk.assets).sort()).toEqual(['A', 'B']);
    expect(b.timeline.video).toHaveLength(1); // adopted in memory too
  });

  it('conflicting timeline edits throw ProjectConflictError; nothing is lost', async () => {
    const pdir = path.join(dir, 'proj');
    await createProject(pdir, { name: 'conflict' });
    const a = await loadProject(pdir);
    const b = await loadProject(pdir);
    const ta: Timeline = { video: [{ id: 'from-a', src: 'X', in: 0, dur: 5 }], cuts: [], audio: { vo: [], music: [], sfx: [] } };
    const tb: Timeline = { video: [{ id: 'from-b', src: 'Y', in: 0, dur: 7 }], cuts: [], audio: { vo: [], music: [], sfx: [] } };
    setTimeline(a, ta);
    await saveProject(a);
    setTimeline(b, tb);
    const err = await saveProject(b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectConflictError);
    expect((err as ProjectConflictError).conflicts).toEqual(['timeline']);
    expect((err as Error).message).toContain('โปรเจกต์ถูกแก้จากที่อื่น');
    expect((await loadProject(pdir)).timeline.video[0]!.id).toBe('from-a'); // a's edit stays on disk
    expect(b.timeline.video[0]!.id).toBe('from-b'); // b's edit is still in memory
    const b2 = await loadProject(pdir); // after reloading, the edit can be applied again
    setTimeline(b2, tb);
    await saveProject(b2);
    expect((await loadProject(pdir)).timeline.video[0]!.id).toBe('from-b');
  });

  it('reclaims a stale lock (dead pid, or too old) and waits for / times out on a live one', async () => {
    const pdir = path.join(dir, 'proj');
    const p = await createProject(pdir, { name: 'lock' });
    const lock = path.join(pdir, 'project.lock');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    await writeFile(lock, JSON.stringify({ pid: dead, host: os.hostname(), at: new Date().toISOString(), token: 'x' }), 'utf8');
    p.delivery.note = 'after dead pid';
    await saveProject(p);
    expect(existsSync(lock)).toBe(false);

    await writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(Date.now() - 60 * 60_000).toISOString(), token: 'old' }), 'utf8');
    p.delivery.note = 'after old lock';
    await saveProject(p);
    expect(existsSync(lock)).toBe(false);

    await writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token: 'live' }), 'utf8');
    p.delivery.note = 'blocked';
    await expect(saveProject(p, { lockTimeoutMs: 150 })).rejects.toBeInstanceOf(ProjectLockedError);
    expect(JSON.parse(await readFile(lock, 'utf8')).token).toBe('live'); // someone else's lock is never removed
    const pending = saveProject(p, { lockTimeoutMs: 5_000 });
    setTimeout(() => { void rm(lock, { force: true }); }, 100);
    await pending;
    expect((await loadProject(pdir)).delivery.note).toBe('blocked');
  });

  it('protects nothing by default: a job folder is the user\'s to edit', () => {
    const prev = process.env['EDITMCP_PROTECTED_PATHS'];
    delete process.env['EDITMCP_PROTECTED_PATHS'];
    try {
      expect(isProtected('D:\\some-job\\review\\x.aep')).toBe(false);
    } finally {
      if (prev !== undefined) process.env['EDITMCP_PROTECTED_PATHS'] = prev;
    }
  });

  it('refuses to create or save projects inside protected paths', async () => {
    const locked = path.join(dir, 'locked');
    const prev = process.env['EDITMCP_PROTECTED_PATHS'];
    process.env['EDITMCP_PROTECTED_PATHS'] = ` ${path.join(dir, 'elsewhere')} ;${locked}`;
    try {
      expect(isProtected(path.join(locked.toUpperCase(), 'sub', 'project.json'))).toBe(process.platform === 'win32');
      expect(isProtected(`${locked}_other`)).toBe(false);
      expect(isProtected(path.join(locked, 'a', 'b'))).toBe(true);
      // POSIX: a backslash is part of a file name, so "locked\\x" is a sibling, not inside "locked"
      if (process.platform !== 'win32') expect(isProtected(`${locked}\\x`)).toBe(false);
      // Windows-style paths are compared the Windows way (case-insensitive, never against cwd) on every OS
      process.env['EDITMCP_PROTECTED_PATHS'] = 'D:\\Job';
      expect(isProtected('d:/job/sub/project.json')).toBe(true);
      expect(isProtected('D:\\Job_other')).toBe(false);
      process.env['EDITMCP_PROTECTED_PATHS'] = ` ${path.join(dir, 'elsewhere')} ;${locked}`;
      await expect(createProject(path.join(locked, 'p'), { name: 'x' })).rejects.toThrow(/protected/);
      expect(existsSync(locked)).toBe(false);
      await expect(saveProject(fixtureProject({ dir: path.join(locked, 'q') }))).rejects.toThrow(/protected/);
    } finally {
      if (prev === undefined) delete process.env['EDITMCP_PROTECTED_PATHS'];
      else process.env['EDITMCP_PROTECTED_PATHS'] = prev;
    }
  });
});

describe('validateTimeline with speed', () => {
  const check = (mutate: (t: Timeline) => void): string[] => {
    const p = fixtureProject();
    const t = okTimeline();
    mutate(t);
    setTimeline(p, t);
    return validateTimeline(p);
  };

  it('counts consumed source frames: round(dur * rate), ramps by their eased span', () => {
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 20, dur: 40, speed: { rate: 2 } }; })).toEqual([]);
    const errs = check((t) => { t.video[1] = { id: 's2', src: 'A', in: 20, dur: 50, speed: { rate: 2 } }; });
    expect(errs).toEqual([expect.stringMatching(/clip\[s2\]: in \+ source span \(20\+100 = 120 .*speed 200%\) exceeds source length 100/)]);
    // slow motion uses fewer source frames than realtime would
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 60, dur: 70, speed: { rate: 0.5 } }; })).toEqual([]);
    // ramp 50% -> 100% over 20 frames then 10 frames realtime: 15 + 10 = 25 source frames
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 75, dur: 30, speed: { rate: 1, rampFrom: 0.5, rampFrames: 20 } }; })).toEqual([]);
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 76, dur: 30, speed: { rate: 1, rampFrom: 0.5, rampFrames: 20 } }; }))
      .toEqual([expect.stringMatching(/s2.*76\+25 = 101.*50%→100%\/20f/)]);
  });

  it('dissolve handles go through the speed curve on both sides', () => {
    // s1 -> s2 dissolve 10: s2 must show a = 5 frames before its in; at 50% that is 3 source frames
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 3, dur: 50, speed: { rate: 0.5 } }; })).toEqual([]);
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 2, dur: 50, speed: { rate: 0.5 } }; }))
      .toEqual([expect.stringMatching(/needs 5 handle frame\(s\) before 's2' in = 3 source frame\(s\) at speed 50%, clip has 2/)]);
    // s2 -> s3 dissolve 10: s2 shows b = 5 frames past its out at 200% = 10 more source frames
    const withTail = (dur: number) => (t: Timeline) => {
      t.video[1] = { id: 's2', src: 'A', in: 20, dur, speed: { rate: 2 } };
      t.cuts = [{ after: 's1', dissolve: 0 }, { after: 's2', dissolve: 10 }];
    };
    expect(check(withTail(35))).toEqual([]);
    expect(check(withTail(36))).toEqual([expect.stringMatching(/needs 5 handle frame\(s\) after 's2' out = source frames up to 101 at speed 200%/)]);
  });

  it('rejects malformed speed and push-in values', () => {
    const errs = check((t) => {
      t.video[1] = { id: 's2', src: 'A', in: 20, dur: 10, speed: { rate: 0, rampFrom: 0.5 }, pushIn: 150 };
    });
    expect(errs).toEqual(expect.arrayContaining([
      expect.stringContaining('speed.rate must be between 0.05 and 20'),
      expect.stringContaining('speed ramp needs both rampFrom and rampFrames'),
      expect.stringContaining('pushIn must be a percent between 0 and 100'),
    ]));
    expect(check((t) => { t.video[1] = { id: 's2', src: 'A', in: 20, dur: 10, speed: { rate: 1, interpolation: 'warp' as 'blend' } }; }))
      .toEqual([expect.stringContaining('speed.interpolation must be nearest | blend | motion')]);
  });
});
