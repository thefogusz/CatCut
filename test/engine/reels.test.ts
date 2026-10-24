import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildAss, captionTargets, chunkWords, joinWords, placeWords, subtitlesFilter, visibleLength, type TimedWord } from '../../src/engine/captions.js';
import { applySplits, detectSilences, parseSilences, speechRanges, splitClip } from '../../src/engine/jumpcut.js';
import { applyFixes, wordsFromWhisper } from '../../src/engine/transcribe.js';
import { findFfmpeg } from '../../src/core/tools.js';
import type { Clip, Project } from '../../src/core/types.js';

/** whisper-cli -ojf output for "สวัสดีครับ วันนี้เรา" + "AI" (heard as เอเฮ่), trimmed to what the parser reads. */
const WHISPER = {
  result: { language: 'th' },
  transcription: [
    {
      text: ' สวัสดีครับ วันนี้เรา', offsets: { from: 0, to: 2100 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
        { text: ' ส', offsets: { from: 100, to: 200 } }, { text: 'วัสดี', offsets: { from: 200, to: 600 } },
        { text: 'คร', offsets: { from: 660, to: 890 } }, { text: 'ับ', offsets: { from: 890, to: 1080 } },
        { text: ' วัน', offsets: { from: 1260, to: 1500 } }, { text: 'นี้', offsets: { from: 1500, to: 1760 } },
        { text: 'เรา', offsets: { from: 1760, to: 2060 } }, { text: '[_TT_100]', offsets: { from: 2100, to: 2100 } },
      ],
    },
    { text: ' เอเฮ่ กันนะ', offsets: { from: 2100, to: 3000 }, tokens: [{ text: 'garbled', offsets: { from: 2100, to: 3000 } }] },
  ],
};

describe('transcripts → words', () => {
  it('times each Thai word by the tokens covering its characters and marks phrase breaks', () => {
    const w = wordsFromWhisper(WHISPER, 'th');
    expect(w.slice(0, 5)).toEqual([
      { text: 'สวัสดี', startMs: 100, endMs: 600, space: true },
      { text: 'ครับ', startMs: 660, endMs: 1080 },
      { text: 'วัน', startMs: 1260, endMs: 1500, space: true },
      { text: 'นี้', startMs: 1500, endMs: 1760 },
      { text: 'เรา', startMs: 1760, endMs: 2060 },
    ]);
    // tokens that do not spell the segment: times spread over the characters, still inside the segment
    const tail = w.slice(5);
    expect(tail.map((x) => x.text)).toEqual(['เอ', 'เฮ่', 'กัน', 'นะ']);
    expect(tail[0]!.startMs).toBeGreaterThanOrEqual(2100);
    expect(tail[3]!.endMs).toBeLessThanOrEqual(3000);
  });

  it('applies fixes across the words the segmenter split, keeping the outer times', () => {
    const fixed = applyFixes(wordsFromWhisper(WHISPER, 'th'), [{ from: 'เอเฮ่', to: 'AI' }, { from: 'สวัสดีครับ', to: 'สวัสดีค่ะ' }]);
    expect(fixed.map((x) => x.text)).toEqual(['สวัสดีค่ะ', 'วัน', 'นี้', 'เรา', 'AI', 'กัน', 'นะ']);
    expect(fixed[0]).toMatchObject({ startMs: 100, endMs: 1080, space: true });
  });
});

function project(over: Partial<Project> = {}): Project {
  return {
    meta: { name: 'reel', fps: 25, width: 1080, height: 1920, createdAt: '', schema: 1 },
    dir: '/tmp/x', assets: { cam: { id: 'cam', kind: 'camera', path: '/tmp/cam.mov' }, vo: { id: 'vo', kind: 'audio', path: '/tmp/vo.wav' } },
    timeline: { video: [], cuts: [], audio: { vo: [], music: [], sfx: [] } }, delivery: { targets: ['vert'] }, versions: [], ...over,
  };
}

describe('captions on the timeline', () => {
  const words = new Map([['cam', [
    { text: 'one', startMs: 0, endMs: 400 }, { text: 'two', startMs: 1000, endMs: 1400 }, { text: 'three', startMs: 2000, endMs: 2400 },
  ]]]);

  it('places source words through the clips that use them (in-point, cuts, speed)', () => {
    const p = project();
    p.timeline.video = [
      { id: 'a', src: 'cam', in: 20, dur: 20 }, // source 0.8–1.6 s: "two"
      { id: 'b', src: 'cam', in: 50, dur: 10, speed: { rate: 2 } }, // source 2.0–2.8 s at 2x: "three"
    ];
    expect(placeWords(p, words)).toEqual([
      { text: 'two', start: 5, end: 15 },
      { text: 'three', start: 20, end: 25 },
    ]);
  });

  it('uses the VO track when it has clips (auto)', () => {
    const p = project();
    p.timeline.video = [{ id: 'a', src: 'cam', in: 0, dur: 200 }];
    p.timeline.audio.vo = [{ id: 'v', src: 'vo', at: 100, in: 25 }];
    const w = new Map([['vo', [{ text: 'hi', startMs: 1000, endMs: 1200 }, { text: 'early', startMs: 0, endMs: 200 }]]]);
    expect(placeWords(p, w)).toEqual([{ text: 'hi', start: 100, end: 105 }]);
  });

  it('chunks Thai by visible characters and phrases, keeping split compounds together', () => {
    const t = (text: string, start: number, space?: boolean): TimedWord => ({ text, start, end: start + 4, ...(space ? { space } : {}) });
    const caps = chunkWords([
      t('สวัสดี', 0, true), t('ครับ', 4), t('วัน', 8, true), t('นี้', 12), t('เรา', 16), t('จะ', 20), t('มา', 24),
      t('สอน', 28), t('ตัด', 32), t('ต่อ', 36), t('วิดีโอ', 40),
    ], 25);
    expect(caps.map((c) => joinWords(c.words.map((w) => w.text)))).toEqual(['สวัสดีครับ', 'วันนี้เราจะมา', 'สอนตัดต่อวิดีโอ']);
    expect(visibleLength('วันนี้')).toBe(3);
    expect(caps[0]!.end).toBe(caps[1]!.start); // short gap: stays up until the next caption
  });

  it('chunks Latin words by count and breaks on pauses and sentence ends', () => {
    const t = (text: string, start: number): TimedWord => ({ text, start, end: start + 5 });
    const caps = chunkWords([t('This', 0), t('is', 5), t('so', 10), t('cool.', 15), t('Next', 20), t('one', 60)], 25);
    expect(caps.map((c) => joinWords(c.words.map((w) => w.text)))).toEqual(['This is so', 'cool.', 'Next', 'one']);
    expect(joinWords(['ง่ายๆ', 'AI', 'กัน'])).toBe('ง่ายๆ AI กัน');
  });

  it('writes an ASS file: output-sized styles, one event per spoken word, escaped text, overlays', () => {
    const caps = chunkWords([{ text: '{hi}', start: 0, end: 10 }, { text: 'there', start: 10, end: 20 }], 25);
    const ass = buildAss({ enabled: true, highlight: '#FF0000', texts: [{ id: 'h', text: 'Watch\nthis', at: 0, dur: 50, style: 'hook' }] }, caps, { width: 1080, height: 1920, fps: 25 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('{\\c&H000000FF'); // red highlight, ASS BGR order
    expect(events[0]).toContain('(hi)'); // braces can never open override tags
    expect(events[1]).toMatch(/^Dialogue: 0,0:00:00\.40,0:00:00\.80,Caption/);
    expect(ass).toMatch(/Dialogue: 1,0:00:00\.00,0:00:02\.00,Hook,.*Watch\\Nthis/);
    expect(buildAss({ enabled: false }, caps, { width: 1920, height: 1080, fps: 25 })).not.toContain('Dialogue:');
  });

  it('burns into social targets by default, never into broadcast/master unless named', () => {
    expect(captionTargets({ enabled: true }, ['vert', 'yt', 'th_tv', 'm422hq'])).toEqual(['vert', 'yt']);
    expect(captionTargets({ enabled: true, targets: ['th_tv'] }, ['vert', 'th_tv'])).toEqual(['th_tv']);
    expect(captionTargets(undefined, ['vert'])).toEqual([]);
  });

  it('puts only plain ASCII paths into the subtitles filter, escaping drive colons', () => {
    expect(subtitlesFilter('/tmp/catcut-subs-x/vert.ass')).toBe("subtitles=filename='/tmp/catcut-subs-x/vert.ass'");
    expect(subtitlesFilter('C:\\Temp\\s\\vert.ass')).toBe("subtitles=filename='C\\:/Temp/s/vert.ass'");
    expect(() => subtitlesFilter('/tmp/งาน/vert.ass')).toThrow(/ASCII/);
    expect(() => subtitlesFilter("/tmp/a'b.ass")).toThrow();
  });
});

describe('jump cuts', () => {
  it('turns silencedetect output into speech ranges, padded, dropping crumbs', () => {
    const sil = parseSilences([
      '[silencedetect @ 0x1] silence_start: 0', '[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.5',
      '[silencedetect @ 0x1] silence_start: 1.5', '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1',
      '[silencedetect @ 0x1] silence_start: 2.6', '[silencedetect @ 0x1] silence_end: 3.4',
      '[silencedetect @ 0x1] silence_start: 3.8',
    ].join('\n'), 4);
    expect(sil).toEqual([{ startSec: 0, endSec: 0.5 }, { startSec: 1.5, endSec: 2.5 }, { startSec: 2.6, endSec: 3.4 }, { startSec: 3.8, endSec: 4 }]);
    // 25 fps, 100 frames: speech 0.5–1.5 s and 3.4–3.8 s; 2.5–2.6 s is a 2.5-frame crumb (< 200 ms) and goes
    expect(speechRanges(sil, 100, 25, { padMs: 80 })).toEqual([[10, 40], [83, 97]]);
  });

  it('splits a clip into pieces and moves the outgoing cut to the last piece', () => {
    const clip: Clip = { id: 's1', src: 'cam', in: 100, dur: 100, marker: 'open', scale: 110 };
    const pieces = splitClip(clip, [[10, 40], [83, 97]], new Set(['s1', 's1_j1']));
    expect(pieces).toEqual([
      { id: 's1_j1_2', src: 'cam', in: 110, dur: 30, marker: 'open', scale: 110 },
      { id: 's1_j2', src: 'cam', in: 183, dur: 14, scale: 110 },
    ]);
    const t = applySplits({ video: [clip, { id: 's2', src: 'b', in: 0, dur: 10 }], cuts: [{ after: 's1', dissolve: 4 }], audio: { vo: [], music: [], sfx: [] } }, new Map([['s1', pieces]]));
    expect(t.video.map((c) => c.id)).toEqual(['s1_j1_2', 's1_j2', 's2']);
    expect(t.cuts).toEqual([{ after: 's1_j2', dissolve: 4 }]);
    expect(splitClip(clip, [[0, 100]], new Set())).toEqual([clip]);
  });

  const ff = findFfmpeg();
  const dirs: string[] = [];
  afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
  it.skipIf(!ff)('finds the pauses in real audio (ffmpeg silencedetect, synthetic tone bursts)', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'catcut-jump-'));
    dirs.push(dir);
    const file = join(dir, 'talk.wav');
    // tone 0–1 s and 1.8–3 s, silence elsewhere (4 s)
    await execa(ff!.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0,1)+between(t,1.8,3),0.5*sin(2*PI*440*t),0)':s=48000:d=4", file]);
    const sil = await detectSilences({ ffmpeg: ff!.ffmpeg, ffprobe: ff!.ffprobe }, file, 0, 4);
    expect(sil).toHaveLength(2);
    expect(sil[0]!.startSec).toBeCloseTo(1, 1);
    expect(sil[0]!.endSec).toBeCloseTo(1.8, 1);
    expect(speechRanges(sil, 100, 25, { padMs: 0 })).toEqual([[0, 25], [45, 75]]);
  });
});
