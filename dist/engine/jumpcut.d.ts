import type { Clip, Frames, Timeline, ToolPaths } from '../core/types.js';
export interface Silence {
    startSec: number;
    endSec: number;
}
export interface JumpcutOptions {
    noiseDb?: number;
    minSilenceMs?: number;
    padMs?: number;
    minPieceMs?: number;
}
/** silencedetect lines → silences, closing one still open at the end of the range. */
export declare function parseSilences(stderr: string, totalSec: number): Silence[];
/** Pauses inside [fromSec, fromSec + durSec) of a file's first audio stream, relative to fromSec. */
export declare function detectSilences(tools: ToolPaths, file: string, fromSec: number, durSec: number, o?: JumpcutOptions & {
    signal?: AbortSignal;
}): Promise<Silence[]>;
/**
 * Speech ranges in frames relative to the clip in-point: the gaps between silences, padded, with the
 * leading/trailing silence of the clip removed as well and tiny leftovers dropped.
 */
export declare function speechRanges(silences: Silence[], durFrames: Frames, fps: number, o?: JumpcutOptions): Array<[Frames, Frames]>;
/** The clip as pieces `<id>_j1`, `<id>_j2`… (marker/slot stay on the first); unchanged when nothing is cut. */
export declare function splitClip(clip: Clip, ranges: Array<[Frames, Frames]>, taken: Set<string>): Clip[];
/** Replace clips by their pieces; a cut after a split clip moves to its last piece, cuts inside are hard. */
export declare function applySplits(t: Timeline, pieces: Map<string, Clip[]>): Timeline;
