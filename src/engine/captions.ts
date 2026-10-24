/**
 * Captions and on-screen text as an ASS subtitle file, burned into deliverables by libass.
 *
 * Words carry source times (ms) from transcripts; they are placed on the timeline through the clips (or VO
 * clips) that use that source, grouped into short captions (Reels style: a few words, big, centred low),
 * and written with one event per word in the `pop` style so the spoken word is highlighted.
 */
import type { CaptionSettings, Frames, Project, TextOverlay, ToolPaths } from '../core/types.js';
import { clipStartFrames } from '../core/project.js';
import { join } from 'node:path';
import { applyFixes, cachedTranscript, type Word } from './transcribe.js';

export interface TimedWord { text: string; start: Frames; end: Frames; space?: boolean }
export interface Caption { words: TimedWord[]; start: Frames; end: Frames }

/** Targets that never get burned-in text unless named explicitly. */
export const CLEAN_TARGETS = new Set(['th_tv', 'th_prores', 'm422hq']);

export function captionTargets(c: CaptionSettings | undefined, all: string[]): string[] {
  if (!c) return [];
  return c.targets ?? all.filter((t) => !CLEAN_TARGETS.has(t));
}

/** Which speech to caption: the VO track when it has clips (auto), else the camera audio of the video clips. */
export function captionSource(p: Project): 'clips' | 'vo' {
  const s = p.captions?.source ?? 'auto';
  if (s !== 'auto') return s;
  return p.timeline.audio.vo.length ? 'vo' : 'clips';
}

/** Asset ids whose speech the captions need (in timeline order, unique). */
export function captionAssets(p: Project): string[] {
  const ids = captionSource(p) === 'vo' ? p.timeline.audio.vo.map((c) => c.src) : p.timeline.video.map((c) => c.src);
  return [...new Set(ids)].filter((id) => p.assets[id] && p.assets[id]!.kind !== 'aecomp' && p.assets[id]!.kind !== 'still');
}

/**
 * Source-time words → timeline frames. A word shows where its source frames are used: a video clip's
 * [in, in + dur·rate) (speed ramps use the end rate) or a VO clip's [in, in + dur). A word that overlaps
 * several uses (cut in two, or repeated) shows once, where most of it is; words cut out entirely do not
 * appear; a partly cut word is clamped to the clip.
 */
export function placeWords(p: Project, words: Map<string, Word[]>): TimedWord[] {
  const fps = p.meta.fps;
  const best = new Map<Word, { overlap: number; w: TimedWord }>();
  const place = (list: Word[] | undefined, at: Frames, srcIn: Frames, srcLen: Frames, rate: number) => {
    for (const w of list ?? []) {
      const s = (w.startMs / 1000) * fps;
      const e = Math.max((w.endMs / 1000) * fps, s + 0.5);
      const a = Math.max(s, srcIn);
      const b = Math.min(e, srcIn + srcLen);
      if (b <= a || (b - a) < (e - s) * 0.3) continue; // mostly cut away
      const start = Math.round(at + (a - srcIn) / rate);
      const end = Math.round(at + (b - srcIn) / rate);
      const prev = best.get(w);
      if (!prev || b - a > prev.overlap) best.set(w, { overlap: b - a, w: { text: w.text, start, end: Math.max(end, start + 1), ...(w.space ? { space: true } : {}) } });
    }
  };
  if (captionSource(p) === 'vo') {
    for (const c of p.timeline.audio.vo) place(words.get(c.src), c.at, c.in ?? 0, c.dur ?? Number.MAX_SAFE_INTEGER, 1);
  } else {
    const starts = clipStartFrames(p);
    for (const c of p.timeline.video) {
      const rate = c.speed?.rate ?? 1;
      place(words.get(c.src), starts.get(c.id) ?? 0, c.in, c.dur * rate, rate);
    }
  }
  return [...best.values()].map((x) => x.w).sort((a, b) => a.start - b.start);
}

const LATIN_END = /[\p{Script=Latin}\d,.!?']$/u;
const LATIN_START = /^[\p{Script=Latin}\d]/u;

/** Thai and other scripts without spaces join directly; a space wherever a Latin word or number meets another word. */
function needsSpace(prev: string, next: string): boolean {
  return !!prev && (LATIN_END.test(prev) || LATIN_START.test(next));
}

export function joinWords(words: string[]): string {
  let s = '';
  for (const w of words) s += needsSpace(s, w) ? ` ${w}` : w;
  return s;
}

/** Characters as they take space on screen: Thai vowel and tone marks above/below do not count. */
export function visibleLength(s: string): number {
  return s.replace(/\p{M}/gu, '').length;
}

/**
 * Group words into captions: at most maxChars visible characters and maxWords Latin words (Thai words from
 * the segmenter are too small to count), never across a pause longer than ~0.4 s or after sentence
 * punctuation, and preferably where the speaker paused (whisper's spaces). Each caption stays up until the
 * next starts when the gap is short.
 */
export function chunkWords(words: TimedWord[], fps: number, o: { maxWords?: number; maxChars?: number } = {}): Caption[] {
  const maxWords = o.maxWords ?? 3;
  const maxChars = o.maxChars ?? 12;
  const pause = Math.round(fps * 0.4);
  const out: Caption[] = [];
  let cur: TimedWord[] = [];
  const flush = () => { if (cur.length) out.push({ words: cur, start: cur[0]!.start, end: cur[cur.length - 1]!.end }); cur = []; };
  for (const w of words) {
    const last = cur[cur.length - 1];
    const now = visibleLength(joinWords(cur.map((x) => x.text)));
    const len = visibleLength(joinWords([...cur.map((x) => x.text), w.text]));
    const latin = cur.filter((x) => LATIN_START.test(x.text)).length + (LATIN_START.test(w.text) ? 1 : 0);
    // a space between Thai words is a pause in the speech; spaces around numbers and English are just writing
    const thai = (x: string) => /\p{Script=Thai}/u.test(x);
    const phraseBreak = !!last && w.space && thai(last.text.slice(-1)) && thai(w.text.charAt(0)) && now >= 3;
    // the segmenter splits Thai compounds (ตัด|ต่อ, วัน|นี้): a tiny Thai word stays with the one before
    const tinyThai = !w.space && /^\p{Script=Thai}/u.test(w.text) && visibleLength(w.text) <= 2 && len <= maxChars + 3;
    const tooLong = len > maxChars && !tinyThai;
    if (last && (latin > maxWords || tooLong || phraseBreak || w.start - last.end > pause || /[.!?。]$/.test(last.text))) flush();
    cur.push(w);
  }
  flush();
  // a lone short word ("หมด", "ok") reads badly as its own caption: join it to the one before when close
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const text = (c: Caption) => joinWords(c.words.map((w) => w.text));
    if (visibleLength(text(b)) > 3 || b.start - a.end > pause || /[.!?。]$/.test(a.words[a.words.length - 1]!.text)) continue;
    if (visibleLength(text(a)) + visibleLength(text(b)) <= maxChars + 4) {
      out.splice(i - 1, 2, { words: [...a.words, ...b.words], start: a.start, end: b.end });
    } else if (a.words.length >= 2) {
      // too long together: hand the last word over so neither caption is a lone word
      const moved = a.words.pop()!;
      b.words.unshift(moved);
      b.start = moved.start;
      a.end = a.words[a.words.length - 1]!.end;
    }
  }
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (b.start - a.end <= pause) a.end = b.start;
    else a.end = Math.min(a.end + Math.round(fps * 0.25), b.start);
  }
  return out;
}

// ---------- ASS ----------

/** Default caption font per OS: a family that has Thai and Latin glyphs. */
export function defaultCaptionFont(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'Thonburi';
  if (platform === 'win32') return 'Leelawadee UI';
  return 'Noto Sans Thai';
}

/** '#RRGGBB' → ASS '&H00BBGGRR'. */
export function assColor(hex: string | undefined, fallback: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '') ?? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fallback)!;
  return `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

function assTime(frames: Frames, fps: number): string {
  const cs = Math.max(0, Math.round((frames / fps) * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Text safe inside an ASS event: braces and backslashes would start override tags. */
function assText(s: string): string {
  return s.replace(/\\/g, '⧵').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\r?\n/g, '\\N');
}

export interface AssOptions { width: number; height: number; fps: number }

/** The whole subtitle file: caption events (from `captions`) plus the project's text overlays. */
export function buildAss(c: CaptionSettings, captions: Caption[], o: AssOptions): string {
  const { width: W, height: H, fps } = o;
  const short = Math.min(W, H);
  const vertical = H > W;
  const scale = c.fontScale ?? 1;
  const font = c.font ?? defaultCaptionFont();
  const white = assColor(c.color, '#FFFFFF');
  const hi = assColor(c.highlight, '#FFE135');
  const size = Math.round(short * (vertical ? 0.078 : 0.062) * scale);
  const outline = Math.max(2, Math.round(size * 0.09));
  const pos = c.position ?? (vertical ? 'middle' : 'bottom');
  const align = pos === 'top' ? 8 : pos === 'middle' ? 5 : 2;
  // middle sits a little low (faces are usually in the upper half); bottom clears the app UI on vertical video
  const marginV = pos === 'middle' ? 0 : Math.round(H * (vertical ? 0.2 : 0.07));
  const midShift = pos === 'middle' ? Math.round(H * 0.12) : 0;
  const marginH = Math.round(W * 0.08);
  const styles = [
    `Style: Caption,${font},${size},${white},${white},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},0,${align},${marginH},${marginH},${marginV},1`,
    `Style: Hook,${font},${Math.round(short * (vertical ? 0.085 : 0.07) * scale)},&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,${Math.round(short * 0.018)},0,8,${marginH},${marginH},${Math.round(H * (vertical ? 0.14 : 0.08))},1`,
    `Style: Title,${font},${Math.round(short * 0.1 * scale)},${white},${white},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline + 1},0,5,${marginH},${marginH},0,1`,
    `Style: Lower,${font},${Math.round(short * 0.045 * scale)},${white},${white},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,${Math.round(short * 0.012)},0,1,${Math.round(W * 0.06)},${marginH},${Math.round(H * 0.12)},1`,
  ];
  const ev: string[] = [];
  const upper = (s: string) => (c.uppercase ? s.replace(/\p{Script=Latin}+/gu, (x) => x.toUpperCase()) : s);
  const at = midShift ? `{\\an5\\pos(${Math.round(W / 2)},${Math.round(H / 2 + midShift)})}` : '';
  if (c.enabled) {
    for (const cap of captions) {
      const texts = cap.words.map((w) => upper(w.text));
      if ((c.style ?? 'pop') === 'clean') {
        ev.push(`Dialogue: 0,${assTime(cap.start, fps)},${assTime(cap.end, fps)},Caption,,0,0,0,,${at}${assText(joinWords(texts))}`);
        continue;
      }
      // pop: one event per spoken word, that word coloured and popping in
      cap.words.forEach((w, i) => {
        const from = i === 0 ? cap.start : w.start;
        const to = i + 1 < cap.words.length ? cap.words[i + 1]!.start : cap.end;
        if (to <= from) return;
        const parts = texts.map((t, j) => (j === i ? `{\\c${hi}\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)}${assText(t)}{\\c${white}}` : assText(t)));
        ev.push(`Dialogue: 0,${assTime(from, fps)},${assTime(to, fps)},Caption,,0,0,0,,${at}${joinWordsTagged(texts, parts)}`);
      });
    }
  }
  for (const t of c.texts ?? []) ev.push(overlayEvent(t, fps, upper));
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: TV.709', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...ev, '',
  ].join('\n');
}

/** joinWords spacing decided on the plain texts, applied to the tagged parts. */
function joinWordsTagged(plain: string[], tagged: string[]): string {
  let s = '';
  plain.forEach((w, i) => { s += (i > 0 && needsSpace(plain[i - 1]!, w) ? ' ' : '') + tagged[i]; });
  return s;
}

function overlayEvent(t: TextOverlay, fps: number, upper: (s: string) => string): string {
  const style = t.style === 'title' ? 'Title' : t.style === 'lower' ? 'Lower' : 'Hook';
  // hooks and titles pop in; everything fades out briefly
  const tags = style === 'Lower' ? '{\\fad(150,150)}' : '{\\fad(0,120)\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)}';
  return `Dialogue: 1,${assTime(t.at, fps)},${assTime(t.at + t.dur, fps)},${style},,0,0,0,,${tags}${assText(upper(t.text))}`;
}

// ---------- words for a project (transcripts) ----------

/**
 * Timed words per caption asset, from cached transcripts (transcribing on a miss), with the project's
 * spelling fixes applied. `onTranscribe` reports each asset that needs whisper (slow).
 */
export async function projectWords(
  p: Project, tools: ToolPaths, cacheDir: string,
  opts: { signal?: AbortSignal; onTranscribe?: (assetId: string) => void; cacheOnly?: boolean; missing?: string[] } = {},
): Promise<Map<string, Word[]>> {
  const out = new Map<string, Word[]>();
  for (const id of captionAssets(p)) {
    const a = p.assets[id];
    if (!a || a.kind === 'aecomp') continue;
    const common = { ...(p.captions?.lang ? { lang: p.captions.lang } : {}), ...(opts.signal ? { signal: opts.signal } : {}) };
    const t = opts.cacheOnly
      ? await cachedTranscript(tools, cacheDir, a.path, { ...common, cacheOnly: true })
      : await cachedTranscript(tools, cacheDir, a.path, { ...common, onMiss: () => opts.onTranscribe?.(id) });
    if (!t) { opts.missing?.push(id); continue; }
    out.set(id, applyFixes(t.words, p.captions?.fixes));
  }
  return out;
}

export function transcriptsDir(p: Project): string {
  return join(p.dir, 'cache', 'transcripts');
}

/** The ASS text for one output size, or undefined when there is nothing to burn. */
export function assFor(p: Project, words: Map<string, Word[]>, size: { width: number; height: number }): string | undefined {
  const c = p.captions;
  if (!c || (!c.enabled && !c.texts?.length)) return undefined;
  const caps = c.enabled ? chunkWords(placeWords(p, words), p.meta.fps, { ...(c.maxWords ? { maxWords: c.maxWords } : {}), ...(c.maxChars ? { maxChars: c.maxChars } : {}) }) : [];
  return buildAss(c, caps, { ...size, fps: p.meta.fps });
}

/** `subtitles=` filter for an ASCII file path (Windows drive colons escaped for the filter graph). */
export function subtitlesFilter(file: string): string {
  if (!/^[\x20-\x7e]+$/.test(file) || /['\[\];,]/.test(file)) throw new Error(`subtitle file path must be plain ASCII: ${file}`);
  return `subtitles=filename='${file.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}
