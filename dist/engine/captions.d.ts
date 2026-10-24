/**
 * Captions and on-screen text as an ASS subtitle file, burned into deliverables by libass.
 *
 * Words carry source times (ms) from transcripts; they are placed on the timeline through the clips (or VO
 * clips) that use that source, grouped into short captions (Reels style: a few words, big, centred low),
 * and written with one event per word in the `pop` style so the spoken word is highlighted.
 */
import type { CaptionSettings, Frames, Project, ToolPaths } from '../core/types.js';
import { type Word } from './transcribe.js';
export interface TimedWord {
    text: string;
    start: Frames;
    end: Frames;
    space?: boolean;
}
export interface Caption {
    words: TimedWord[];
    start: Frames;
    end: Frames;
}
/** Targets that never get burned-in text unless named explicitly. */
export declare const CLEAN_TARGETS: Set<string>;
export declare function captionTargets(c: CaptionSettings | undefined, all: string[]): string[];
/** Which speech to caption: the VO track when it has clips (auto), else the camera audio of the video clips. */
export declare function captionSource(p: Project): 'clips' | 'vo';
/** Asset ids whose speech the captions need (in timeline order, unique). */
export declare function captionAssets(p: Project): string[];
/**
 * Source-time words → timeline frames. A word shows where its source frames are used: a video clip's
 * [in, in + dur·rate) (speed ramps use the end rate) or a VO clip's [in, in + dur). A word that overlaps
 * several uses (cut in two, or repeated) shows once, where most of it is; words cut out entirely do not
 * appear; a partly cut word is clamped to the clip.
 */
export declare function placeWords(p: Project, words: Map<string, Word[]>): TimedWord[];
export declare function joinWords(words: string[]): string;
/** Characters as they take space on screen: Thai vowel and tone marks above/below do not count. */
export declare function visibleLength(s: string): number;
/**
 * Group words into captions: at most maxChars visible characters and maxWords Latin words (Thai words from
 * the segmenter are too small to count), never across a pause longer than ~0.4 s or after sentence
 * punctuation, and preferably where the speaker paused (whisper's spaces). Each caption stays up until the
 * next starts when the gap is short.
 */
export declare function chunkWords(words: TimedWord[], fps: number, o?: {
    maxWords?: number;
    maxChars?: number;
}): Caption[];
/** Default caption font per OS: a family that has Thai and Latin glyphs. */
export declare function defaultCaptionFont(platform?: NodeJS.Platform): string;
/** '#RRGGBB' → ASS '&H00BBGGRR'. */
export declare function assColor(hex: string | undefined, fallback: string): string;
export interface AssOptions {
    width: number;
    height: number;
    fps: number;
}
/** The whole subtitle file: caption events (from `captions`) plus the project's text overlays. */
export declare function buildAss(c: CaptionSettings, captions: Caption[], o: AssOptions): string;
/**
 * Timed words per caption asset, from cached transcripts (transcribing on a miss), with the project's
 * spelling fixes applied. `onTranscribe` reports each asset that needs whisper (slow).
 */
export declare function projectWords(p: Project, tools: ToolPaths, cacheDir: string, opts?: {
    signal?: AbortSignal;
    onTranscribe?: (assetId: string) => void;
    cacheOnly?: boolean;
    missing?: string[];
}): Promise<Map<string, Word[]>>;
export declare function transcriptsDir(p: Project): string;
/** The ASS text for one output size, or undefined when there is nothing to burn. */
export declare function assFor(p: Project, words: Map<string, Word[]>, size: {
    width: number;
    height: number;
}): string | undefined;
/** `subtitles=` filter for an ASCII file path (Windows drive colons escaped for the filter graph). */
export declare function subtitlesFilter(file: string): string;
