/**
 * Speech → timed words with whisper.cpp (`whisper-cli`), for captions and transcript-based edits.
 *
 * ffmpeg extracts 16 kHz mono WAV into an ASCII temp folder; whisper-cli writes its "JSON full" output
 * (segments + per-token offsets). Words come from Intl.Segmenter (Thai has no spaces between words), each
 * timed by the tokens that cover its characters. Transcripts are cached per source content + model + language
 * under <project>/cache/transcripts/, so captions and re-delivers never transcribe twice.
 */
import { execa } from 'execa';
import type { ToolPaths } from '../core/types.js';
/** `space`: whisper put a space (or a segment boundary) before this word, a natural phrase break in Thai. */
export interface Word {
    text: string;
    startMs: number;
    endMs: number;
    space?: boolean;
}
export interface Transcript {
    source: string;
    lang: string;
    model: string;
    text: string;
    words: Word[];
}
export interface WhisperPaths {
    cli?: string;
    model?: string;
}
/** whisper-cli: EDITMCP_WHISPER_CLI, PATH, Homebrew; model: EDITMCP_WHISPER_MODEL, else the best ggml-*.bin in <app data>/CatCut/models. */
export declare function findWhisper(env?: Record<string, string | undefined>): WhisperPaths;
export declare function modelsDir(): string;
interface WhisperToken {
    text: string;
    offsets: {
        from: number;
        to: number;
    };
}
interface WhisperSegment {
    text: string;
    offsets: {
        from: number;
        to: number;
    };
    tokens?: WhisperToken[];
}
interface WhisperJson {
    result?: {
        language?: string;
    };
    transcription?: WhisperSegment[];
}
/**
 * Words with times from whisper's JSON full. Token texts are concatenated per segment so every character
 * knows the token (and time) it came from; a word starts at its first character's token and ends at its
 * last one's. When tokens do not spell the segment text (rare), times are spread by character count.
 */
export declare function wordsFromWhisper(json: WhisperJson, lang?: string, silences?: Array<{
    startMs: number;
    endMs: number;
}>): Word[];
/**
 * whisper's token times run on through pauses (words after a pause start inside the silence), which would
 * put captions early and let jump cuts drop words. Within one segment, map whisper time linearly onto the
 * parts of [from, to) that really have sound (silences from silencedetect on the same audio).
 */
export declare function speechWarp(from: number, to: number, silences: Array<{
    startMs: number;
    endMs: number;
}>): (t: number) => number;
/** Spelling fixes (brand names, misheard words), applied word by word and across neighbouring words. */
export declare function applyFixes(words: Word[], fixes?: Array<{
    from: string;
    to: string;
}>): Word[];
export interface TranscribeOptions {
    lang?: string;
    signal?: AbortSignal;
    whisper?: WhisperPaths;
    /** injectable for tests */
    run?: typeof execa;
}
/** Transcribe one media file (its first audio stream). */
export declare function transcribeFile(tools: ToolPaths, file: string, opts?: TranscribeOptions): Promise<Transcript>;
/** Cache file name for a transcript: source content + model + language + timing method. */
export declare function transcriptKey(file: string, model: string | undefined, lang?: string): Promise<string>;
/**
 * Cached transcript of `file` (by content hash + model + language), transcribing on a miss; with
 * `cacheOnly` a miss returns undefined instead (no whisper run).
 */
export declare function cachedTranscript(tools: ToolPaths, cacheDir: string, file: string, opts: TranscribeOptions & {
    onMiss?: () => void;
    cacheOnly: true;
}): Promise<(Transcript & {
    cached: boolean;
}) | undefined>;
export declare function cachedTranscript(tools: ToolPaths, cacheDir: string, file: string, opts?: TranscribeOptions & {
    onMiss?: () => void;
    cacheOnly?: false;
}): Promise<Transcript & {
    cached: boolean;
}>;
export {};
