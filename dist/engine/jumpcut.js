/**
 * Jump cuts for talking-head footage: find the pauses in a clip's own audio (ffmpeg silencedetect) and
 * split the clip into the parts with speech, so the edit loses the dead air. Only the timeline changes;
 * source media is untouched and every piece is an ordinary clip (trim, scale, revert work as usual).
 */
import { execa } from 'execa';
/** silencedetect lines → silences, closing one still open at the end of the range. */
export function parseSilences(stderr, totalSec) {
    const out = [];
    let open;
    for (const line of stderr.split(/\r?\n/)) {
        const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (s) {
            open = Math.max(0, Number(s[1]));
            continue;
        }
        const e = /silence_end:\s*([\d.]+)/.exec(line);
        if (e && open !== undefined) {
            out.push({ startSec: open, endSec: Number(e[1]) });
            open = undefined;
        }
    }
    if (open !== undefined && open < totalSec)
        out.push({ startSec: open, endSec: totalSec });
    return out;
}
/** Pauses inside [fromSec, fromSec + durSec) of a file's first audio stream, relative to fromSec. */
export async function detectSilences(tools, file, fromSec, durSec, o = {}) {
    const noise = o.noiseDb ?? -35;
    const d = (o.minSilenceMs ?? 350) / 1000;
    const r = await execa(tools.ffmpeg, [
        '-hide_banner', '-nostdin', '-ss', fromSec.toFixed(6), '-t', durSec.toFixed(6), '-i', file,
        '-map', '0:a:0', '-vn', '-af', `silencedetect=noise=${noise}dB:d=${d}`, '-f', 'null', '-',
    ], { reject: false, windowsHide: true, timeout: Math.max(120_000, durSec * 2000), cancelSignal: o.signal });
    if (r.exitCode !== 0)
        throw new Error(`ffmpeg silencedetect failed on ${file}: ${String(r.stderr ?? '').trim().slice(-300)}`);
    return parseSilences(String(r.stderr ?? ''), durSec);
}
/**
 * Speech ranges in frames relative to the clip in-point: the gaps between silences, padded, with the
 * leading/trailing silence of the clip removed as well and tiny leftovers dropped.
 */
export function speechRanges(silences, durFrames, fps, o = {}) {
    const pad = ((o.padMs ?? 80) / 1000) * fps;
    const minPiece = ((o.minPieceMs ?? 200) / 1000) * fps;
    const ranges = [];
    let pos = 0;
    for (const s of [...silences].sort((a, b) => a.startSec - b.startSec)) {
        const a = s.startSec * fps;
        const b = s.endSec * fps;
        if (a > pos)
            ranges.push([pos, a]);
        pos = Math.max(pos, b);
    }
    if (pos < durFrames)
        ranges.push([pos, durFrames]);
    const out = [];
    for (const [a, b] of ranges) {
        if (b - a < minPiece)
            continue; // judged before padding: a click padded twice is still a click
        const s = Math.max(0, Math.floor(a - pad));
        const e = Math.min(durFrames, Math.ceil(b + pad));
        const last = out[out.length - 1];
        if (last && s <= last[1])
            last[1] = Math.max(last[1], e); // padding made them touch
        else
            out.push([s, e]);
    }
    return out;
}
/** The clip as pieces `<id>_j1`, `<id>_j2`… (marker/slot stay on the first); unchanged when nothing is cut. */
export function splitClip(clip, ranges, taken) {
    if (!ranges.length)
        return [];
    if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === clip.dur)
        return [clip];
    return ranges.map(([a, b], i) => {
        let id = `${clip.id}_j${i + 1}`;
        for (let n = 2; taken.has(id); n++)
            id = `${clip.id}_j${i + 1}_${n}`;
        taken.add(id);
        const piece = { ...clip, id, in: clip.in + a, dur: b - a };
        if (i > 0) {
            delete piece.marker;
            delete piece.slot;
        }
        return piece;
    });
}
/** Replace clips by their pieces; a cut after a split clip moves to its last piece, cuts inside are hard. */
export function applySplits(t, pieces) {
    const next = structuredClone(t);
    next.video = t.video.flatMap((c) => pieces.get(c.id) ?? [c]);
    next.cuts = t.cuts.flatMap((cut) => {
        const p = pieces.get(cut.after);
        if (!p)
            return [cut];
        if (!p.length)
            return []; // the whole clip was silence
        return [{ ...cut, after: p[p.length - 1].id }];
    });
    return next;
}
//# sourceMappingURL=jumpcut.js.map