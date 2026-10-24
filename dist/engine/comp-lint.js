/**
 * Comp lint + font audit (DESIGN §13.2 rows 3, 5, 7). Advisory: thresholds come only from the project's
 * StyleRules (set from the brief); without them only structural facts are reported. Severity is 'warn'
 * unless the project explicitly marks a kind as an error.
 */
import { execa } from 'execa';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { clipStartFrames } from '../core/project.js';
const QC_KIND = {
    'animation-ends-early': 'comp', 'layer-ends-early': 'comp', 'background-ends-early': 'comp',
    'thai-animator': 'thai', 'thai-size': 'thai', style: 'style',
};
const ANIMATE_BY = { characters: 'char', words: 'word', lines: 'line' };
function samePath(a, b) {
    const x = resolve(a), y = resolve(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/** aecomp assets to lint: the given ids, else every aecomp the timeline uses (deduped by aep+comp). */
export function compTargets(p, assetIds) {
    const used = new Set(p.timeline.video.map((c) => c.src));
    const ids = assetIds ?? Object.keys(p.assets).filter((id) => used.has(id));
    const out = [];
    for (const id of ids) {
        const a = p.assets[id];
        if (!a)
            throw new Error(`unknown asset: ${id}`);
        if (a.kind !== 'aecomp') {
            if (assetIds)
                throw new Error(`asset ${id} is not an AE comp`);
            continue;
        }
        if (!out.some((t) => t.comp === a.comp && samePath(t.aep, a.aep)))
            out.push({ aep: a.aep, comp: a.comp });
    }
    return out;
}
/** 'error' only when the project (or caller) says so: styleRules.severity = { "<kind>": "error" } (optional, untyped). */
function severityOf(kind, project, errorKinds = []) {
    if (errorKinds.includes(kind) || errorKinds.includes(QC_KIND[kind]))
        return 'error';
    const sev = project?.styleRules?.severity;
    if (sev && typeof sev === 'object') {
        const map = sev;
        if (map[kind] === 'error' || map[QC_KIND[kind]] === 'error')
            return 'error';
    }
    return 'warn';
}
/** Map one comp's lint result onto the clips that use the comp (timeline frames), applying project rules. */
export function compLintToQcIssues(lint, aep, project, opts = {}) {
    const rules = opts.rules ?? project?.styleRules;
    const fps = project?.meta.fps ?? 25;
    const clips = project
        ? project.timeline.video.filter((c) => {
            const a = project.assets[c.src];
            return a?.kind === 'aecomp' && a.comp === lint.comp && samePath(a.aep, aep);
        })
        : [];
    const starts = project ? clipStartFrames(project) : new Map();
    const out = [];
    for (const raw of lint.issues) {
        let message = `[${lint.comp}] ${raw.message}`;
        if (raw.kind === 'thai-animator') {
            // The brief may ask for word/char animation on purpose; then the animator is intended.
            const want = rules?.thai?.animateBy;
            const basis = raw.basedOn ? ANIMATE_BY[raw.basedOn] : undefined;
            if (want && basis === want)
                continue;
            if (want)
                message += ` (project rule: animate by ${want})`;
        }
        const severity = severityOf(raw.kind, project, opts.errorKinds);
        const kind = QC_KIND[raw.kind];
        if (!clips.length) {
            out.push({ kind, severity, message: raw.frame !== undefined ? `${message} (comp frame ${raw.frame})` : message });
            continue;
        }
        for (const clip of clips) {
            const start = starts.get(clip.id) ?? 0;
            const rate = clip.speed?.rate ?? 1;
            const usedEnd = clip.in + Math.round(clip.dur * rate);
            const f = raw.frame;
            if (f !== undefined) {
                if (f >= usedEnd)
                    continue; // problem starts after the part of the comp this clip shows
                if (raw.kind === 'animation-ends-early' && usedEnd - Math.max(f, clip.in) <= fps)
                    continue; // < 1 s frozen in this clip
            }
            const from = f === undefined ? start : start + Math.max(0, Math.round((f - clip.in) / rate));
            out.push({ kind, severity, clipId: clip.id, startFrame: from, endFrame: start + clip.dur, message });
        }
    }
    return out;
}
/** Lint each target with the backend and map the results to QcIssues. Failures per comp are collected, not thrown. */
export async function lintComps(backend, targets, project, opts = {}) {
    if (!backend.lintComp)
        throw new Error('this After Effects backend cannot lint comps');
    const lint = backend.lintComp;
    const rules = opts.rules ?? project?.styleRules;
    const report = { issues: [], comps: [], failed: [], notes: [] };
    if (!rules?.thai?.minCapHeightPct)
        report.notes.push('thai-size skipped: project has no styleRules.thai.minCapHeightPct / ไม่ได้ตั้งขนาดตัวอักษรไทยขั้นต่ำในโปรเจกต์');
    if (!rules?.safeMarginPct)
        report.notes.push('safe-margin check skipped: no styleRules.safeMarginPct');
    if (!rules?.cornerRadiusPct)
        report.notes.push('corner-radius check skipped: no styleRules.cornerRadiusPct');
    report.notes.push('advisory: the brief decides; these are hints, not rules / ข้อมูลประกอบ บรีฟเป็นตัวตัดสิน');
    let done = 0;
    for (const t of targets) {
        opts.signal?.throwIfAborted();
        opts.onProgress?.({ stage: 'comp_lint', done, total: targets.length, message: t.comp });
        try {
            const res = await lint.call(backend, t.aep, t.comp, rules);
            report.comps.push({ ...res, aep: t.aep });
            report.issues.push(...compLintToQcIssues(res, t.aep, project, { ...(rules ? { rules } : {}), ...(opts.errorKinds ? { errorKinds: opts.errorKinds } : {}) }));
        }
        catch (e) {
            report.failed.push({ aep: t.aep, comp: t.comp, error: e instanceof Error ? e.message : String(e) });
        }
        done++;
    }
    opts.onProgress?.({ stage: 'comp_lint', done, total: targets.length });
    return report;
}
/** macOS font folders (user, local, system, Adobe's own). Fonts in subfolders (Supplemental) are listed too. */
function macFontDirs(home) {
    return [
        join(home, 'Library', 'Fonts'), '/Library/Fonts', '/System/Library/Fonts', '/System/Library/Fonts/Supplemental',
        '/Library/Application Support/Adobe/Fonts',
    ];
}
const FONT_KEYS = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
];
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc', '.fon', '.fnt', '.pfm', '.pfb']);
/** `reg query` value lines: "    Arial Bold (TrueType)    REG_SZ    arialbd.ttf". */
export function parseRegFonts(out) {
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
        const m = /^\s+(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*?)\s*$/.exec(line);
        if (m)
            rows.push({ name: m[1], file: m[2] });
    }
    return rows;
}
async function defaultRegQuery(key) {
    if (process.platform !== 'win32')
        return '';
    const r = await execa('reg', ['query', key], { reject: false, windowsHide: true, timeout: 15_000 });
    return r.exitCode === 0 ? String(r.stdout) : '';
}
async function defaultReadDir(dir) {
    try {
        return await readdir(dir);
    }
    catch {
        return [];
    }
}
/** Fonts the OS (and AE's own Adobe Fonts folder) can see: HKLM/HKCU registry + font folders on Windows, font folders on macOS. */
export async function listInstalledFonts(src = {}) {
    const env = src.env ?? process.env;
    const regQuery = src.regQuery ?? defaultRegQuery;
    const readDir = src.readDir ?? defaultReadDir;
    const names = [];
    const sources = [];
    for (const key of FONT_KEYS) {
        const rows = parseRegFonts(await regQuery(key).catch(() => ''));
        if (rows.length)
            sources.push(`${key} (${rows.length})`);
        for (const r of rows) {
            names.push(r.name);
            if (r.file)
                names.push(basename(r.file, extname(r.file)));
        }
    }
    const dirs = (src.platform ?? process.platform) === 'darwin' ? macFontDirs(env['HOME'] ?? os.homedir()) : [
        join(env['WINDIR'] ?? env['SystemRoot'] ?? 'C:\\Windows', 'Fonts'),
        ...(env['LOCALAPPDATA'] ? [join(env['LOCALAPPDATA'], 'Microsoft', 'Windows', 'Fonts')] : []),
        join(env['CommonProgramFiles'] ?? 'C:\\Program Files\\Common Files', 'Adobe', 'Fonts'),
    ];
    for (const dir of dirs) {
        const files = (await readDir(dir)).filter((f) => FONT_EXT.has(extname(f).toLowerCase()));
        if (files.length)
            sources.push(`${dir} (${files.length})`);
        for (const f of files)
            names.push(basename(f, extname(f)));
    }
    return { names, sources };
}
/** Lowercase letters+digits only, without "(TrueType)"-style tags. */
export function normalizeFontName(s) {
    return s.replace(/\((?:truetype|opentype|all res|vector|type 1)\)/gi, '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
const SUFFIX = /(?:regular|roman|book|normal|mt|ps)$/;
function variants(name) {
    const out = new Set();
    let v = normalizeFontName(name);
    out.add(v);
    for (let i = 0; i < 3; i++) {
        const s = v.replace(SUFFIX, '');
        if (s === v || !s)
            break;
        out.add(s);
        v = s;
    }
    return [...out];
}
/** Loose match of used font names (PostScript or family) against installed names. */
export function auditFonts(used, installed) {
    const keys = new Set();
    for (const n of installed.names)
        for (const part of n.split(/\s*&\s*/))
            for (const v of variants(part))
                if (v)
                    keys.add(v);
    const keyList = [...keys];
    const missing = [];
    const familyOnly = [];
    for (const font of used.fonts) {
        if (variants(font).some((v) => keys.has(v)))
            continue;
        const family = font.split('-')[0] ?? font;
        const fam = normalizeFontName(family);
        if (fam.length >= 3 && keyList.some((k) => k.startsWith(fam)))
            familyOnly.push({ font, family });
        else
            missing.push(font);
    }
    for (const m of used.aeMissing ?? [])
        if (!missing.includes(m))
            missing.push(m);
    return {
        used: used.fonts, missing, familyOnly, aeReportedMissing: used.aeMissing ?? null, installedCount: keys.size, sources: installed.sources,
        note: 'Adobe Fonts (Creative Cloud) activations are not in the registry; AE\'s own list (aeReportedMissing) is authoritative when present / ฟอนต์จาก Adobe Fonts ตรวจจาก registry ไม่ได้',
    };
}
//# sourceMappingURL=comp-lint.js.map