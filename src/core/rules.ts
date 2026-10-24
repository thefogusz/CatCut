/**
 * Per-project rules (DESIGN §13.2 rows 4, 5, 11 and §13.2.1).
 *
 * The brief is the highest authority. Rules exist only because the brief or the user said so, each one
 * records where it came from (source + a short quote), and a user rule that would override a brief rule
 * is refused until the agent has asked the user (`overrideBrief` / `userConfirmed`).
 * Machine-checkable constraints become QcIssue kind 'style'; the rest are a checklist to verify visually.
 * Pure model logic except `extractEvidence`, which runs ffmpeg (paths only as -i arguments).
 */
import { execa } from 'execa';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { labelFontOpt } from './platform.js';
import { planHash } from './project.js';
import { framesToTc, splitDissolve } from './timecode.js';
import type { Asset, Clip, Constraint, Cut, Frames, Project, QcIssue, ReviewShot, StyleRules, ToolPaths, Version } from './types.js';

// ---------- model ----------

export type RuleSourceKind = 'brief' | 'user';

/** Where a rule came from: the brief/board, or the user's explicit instruction in this project. */
export interface RuleSource {
  source: RuleSourceKind;
  quote: string; // short quote of the brief / user message the rule comes from
  at: string; // ISO
}

/** Constraint + provenance. Extra fields persist in project.json alongside the contract fields. */
export interface RuleConstraint extends Constraint {
  source?: RuleSourceKind;
  quote?: string;
  /** no-repeat-gimmick: the same gimmick may appear on at most this many consecutive clips (default 1) */
  max?: number;
}

/** StyleRules + per-field provenance (`sources.cornerRadiusPct`, `sources['joins:card>footage']` ...). */
export type StyleRulesRecord = StyleRules & { sources?: Record<string, RuleSource> };

type ConstraintCheck = NonNullable<Constraint['check']>;

/** Thrown when a change would override the brief (or remove a brief rule) without the user's go-ahead. */
export class RuleConflictError extends Error {
  constructor(message: string, public readonly conflicts: string[]) {
    super(message);
    this.name = 'RuleConflictError';
  }
}

const QUOTE_MAX = 400;
const MACHINE_CHECKS: ReadonlySet<ConstraintCheck> = new Set(['board-only', 'logo-static', 'no-repeat-gimmick']);
const VISUAL_CHECKS: ReadonlySet<ConstraintCheck> = new Set(['no-cover-photo', 'manual']);

const SourceSchema = z.object({
  source: z.enum(['brief', 'user']),
  quote: z.string().trim().min(1, 'quote the brief / user words this rule comes from').max(QUOTE_MAX),
});

export const ConstraintInputSchema = SourceSchema.extend({
  text: z.string().trim().min(1),
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  scope: z.string().trim().min(1).optional(),
  check: z.enum(['board-only', 'no-cover-photo', 'logo-static', 'no-repeat-gimmick', 'manual']).optional(),
  max: z.number().int().min(1).max(50).optional(),
});
export type ConstraintInput = z.input<typeof ConstraintInputSchema>;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const pct = z.number().min(0).max(50);

/** Every field optional; `null` removes a field. Unknown keys are rejected so typos never pass silently. */
export const StylePatchSchema = z.object({
  cornerRadiusPct: pct.nullable().optional(),
  safeMarginPct: pct.nullable().optional(),
  palette: z.array(z.string().regex(HEX, 'hex colour like #1A2B3C')).max(64).nullable().optional(),
  joins: z.array(z.object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    dissolve: z.number().int().min(0).max(500),
  })).nullable().optional(),
  thai: z.object({
    minCapHeightPct: z.number().min(0).max(100).nullable().optional(),
    minWeight: z.number().int().min(100).max(1000).nullable().optional(),
    lowerVowelClearancePx: z.number().min(0).max(500).nullable().optional(),
    animateBy: z.enum(['line', 'word', 'char']).nullable().optional(),
  }).strict().nullable().optional(),
  maxStaticSec: z.number().positive().max(3600).nullable().optional(),
}).strict();

// ---------- constraints CRUD ----------

export function listConstraints(p: Project): RuleConstraint[] {
  return (p.constraints ?? []) as RuleConstraint[];
}

/**
 * Add a constraint (mutates `p`; the caller saves). Returns warnings the agent must act on: a user rule that
 * looks like it competes with a brief rule (same check, same scope) means: stop and ask the user.
 */
export function addConstraint(p: Project, input: ConstraintInput, now = new Date()): { constraint: RuleConstraint; warnings: string[] } {
  const a = ConstraintInputSchema.parse(input);
  const list = listConstraints(p);
  const id = a.id ?? nextConstraintId(list);
  if (list.some((c) => c.id === id)) throw new Error(`constraint id already exists: ${id}`);
  const c: RuleConstraint = {
    id,
    text: a.text,
    ...(a.scope ? { scope: a.scope } : {}),
    ...(a.check ? { check: a.check } : {}),
    ...(a.max !== undefined ? { max: a.max } : {}),
    source: a.source,
    quote: a.quote,
    createdAt: now.toISOString(),
  };
  const warnings: string[] = [];
  if (a.source === 'user') {
    for (const b of list) {
      if (b.source !== 'brief') continue;
      const sameCheck = !!a.check && b.check === a.check;
      const sameScope = (b.scope ?? 'all') === (a.scope ?? 'all');
      if (sameCheck && sameScope) {
        warnings.push(`อาจขัดกับกฎจากบรีฟ ${b.id} ("${b.text}") — บรีฟชนะ ให้ถามผู้ใช้ก่อน / may conflict with brief rule ${b.id}: the brief wins, ask the user`);
      }
    }
  }
  if (a.check === 'logo-static' && !a.scope) {
    warnings.push('logo-static ไม่มี scope: จะเดาโลโก้จากชื่อ asset/comp/slot ("logo"/"โลโก้") — ระบุ scope (asset/slot id คั่นด้วย ,) จะแม่นกว่า / no scope: logos are guessed by name');
  }
  p.constraints = [...list, c];
  return { constraint: c, warnings };
}

/** Remove by id. Removing a brief rule needs `userConfirmed` (the user explicitly agreed to drop it). */
export function removeConstraint(p: Project, id: string, opts: { userConfirmed?: boolean } = {}): RuleConstraint {
  const list = listConstraints(p);
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`no constraint with id ${id}`);
  if (c.source === 'brief' && !opts.userConfirmed) {
    throw new RuleConflictError(
      `กฎ ${id} มาจากบรีฟ — ต้องถามผู้ใช้ก่อนลบ แล้วส่ง userConfirmed: true / rule ${id} comes from the brief: ask the user, then pass userConfirmed: true`,
      [id],
    );
  }
  p.constraints = list.filter((x) => x.id !== id);
  return c;
}

function nextConstraintId(list: RuleConstraint[]): string {
  let n = list.length + 1;
  while (list.some((c) => c.id === `c${n}`)) n++;
  return `c${n}`;
}

// ---------- style rules ----------

/**
 * Validate and merge a StyleRules patch (mutates `p`; the caller saves). Scalars replace, `thai` merges per
 * field, `joins` merge by (from, to), `palette` replaces, `null` removes. A user patch that changes a field the
 * brief set throws RuleConflictError unless `overrideBrief` (only after the user said so).
 */
export function setStyleRules(
  p: Project,
  patch: unknown,
  meta: { source: RuleSourceKind; quote: string; overrideBrief?: boolean },
  now = new Date(),
): { styleRules: StyleRulesRecord; changed: string[] } {
  const src = SourceSchema.parse({ source: meta.source, quote: meta.quote });
  const parsed = StylePatchSchema.parse(patch);
  const cur: StyleRulesRecord = structuredClone((p.styleRules ?? {}) as StyleRulesRecord);
  const sources: Record<string, RuleSource> = { ...(cur.sources ?? {}) };
  const next: StyleRulesRecord = { ...cur };
  const changed: string[] = [];
  const touch = (key: string) => changed.push(key);

  for (const k of ['cornerRadiusPct', 'safeMarginPct', 'maxStaticSec'] as const) {
    const v = parsed[k];
    if (v === undefined) continue;
    if (v === null) { if (next[k] !== undefined) { delete next[k]; touch(k); } continue; }
    if (next[k] !== v) { next[k] = v; touch(k); }
  }
  if (parsed.palette !== undefined) {
    if (parsed.palette === null) { if (next.palette) { delete next.palette; touch('palette'); } }
    else {
      const pal = parsed.palette.map((h) => h.toUpperCase());
      if (JSON.stringify(pal) !== JSON.stringify(next.palette ?? null)) { next.palette = pal; touch('palette'); }
    }
  }
  if (parsed.thai !== undefined) {
    if (parsed.thai === null) {
      for (const k of Object.keys(next.thai ?? {})) touch(`thai.${k}`);
      delete next.thai;
    } else {
      const thai: NonNullable<StyleRules['thai']> = { ...(next.thai ?? {}) };
      for (const [k, v] of Object.entries(parsed.thai) as Array<[keyof NonNullable<StyleRules['thai']>, unknown]>) {
        if (v === undefined) continue;
        if (v === null) { if (thai[k] !== undefined) { delete thai[k]; touch(`thai.${k}`); } continue; }
        if (thai[k] !== v) { (thai as Record<string, unknown>)[k] = v; touch(`thai.${k}`); }
      }
      if (Object.keys(thai).length) next.thai = thai;
      else delete next.thai;
    }
  }
  if (parsed.joins !== undefined) {
    if (parsed.joins === null) {
      for (const j of next.joins ?? []) touch(joinKey(j));
      delete next.joins;
    } else {
      const joins = [...(next.joins ?? [])];
      for (const j of parsed.joins) {
        const i = joins.findIndex((x) => x.from === j.from && x.to === j.to);
        if (i < 0) { joins.push(j); touch(joinKey(j)); }
        else if (joins[i]!.dissolve !== j.dissolve) { joins[i] = j; touch(joinKey(j)); }
      }
      next.joins = joins;
    }
  }

  const conflicts = src.source === 'user' ? changed.filter((k) => sources[k]?.source === 'brief') : [];
  if (conflicts.length && !meta.overrideBrief) {
    throw new RuleConflictError(
      `ค่าที่จะแก้มาจากบรีฟ (${conflicts.join(', ')}) — บรีฟชนะ ต้องถามผู้ใช้ก่อน แล้วส่ง overrideBrief: true / these values come from the brief: ask the user, then pass overrideBrief: true`,
      conflicts,
    );
  }
  const at = now.toISOString();
  for (const k of changed) {
    const removed = k.startsWith('joins:') ? !next.joins?.some((j) => joinKey(j) === k) : getPath(next, k) === undefined;
    if (removed) delete sources[k];
    else sources[k] = { source: src.source, quote: src.quote, at };
  }
  if (Object.keys(sources).length) next.sources = sources;
  else delete next.sources;
  p.styleRules = next;
  return { styleRules: next, changed };
}

function joinKey(j: { from: string; to: string }): string {
  return `joins:${j.from}>${j.to}`;
}

function getPath(o: StyleRulesRecord, key: string): unknown {
  const [a, b] = key.split('.');
  const v = (o as Record<string, unknown>)[a as string];
  return b === undefined ? v : (v as Record<string, unknown> | undefined)?.[b];
}

// ---------- agent checklist ----------

export interface ChecklistItem {
  id: string;
  kind: 'priority' | 'constraint' | 'style' | 'visual' | 'process';
  text: string;
  source?: string; // "brief: «quote»" / "user: «quote»"
  auto?: boolean; // checked by rules_check
}

/** Compact Thai/English checklist the agent must re-read before every edit and build. */
export function rulesForAgent(p: Project): { text: string; items: ChecklistItem[] } {
  const items: ChecklistItem[] = [
    { id: 'priority', kind: 'priority', text: 'ลำดับ: บรีฟ/บอร์ด → คำสั่งผู้ใช้ในงานนี้ → ค่าแนะนำทั่วไป; กฎขัดกับบรีฟ = หยุดถามผู้ใช้ / brief/board → user instructions in this project → defaults; a conflict with the brief = ask' },
  ];
  if (p.board) items.push({ id: 'board', kind: 'process', text: `มีบอร์ด ${p.board.slots.length} slot — ทุกคลิปต้องผูก slot / board present: every clip realises a slot`, source: `brief: ${path.basename(p.board.source)}` });
  else items.push({ id: 'board', kind: 'process', text: 'ยังไม่มีบอร์ด — ถ้ามีบรีฟ/บอร์ด ให้ board_import ก่อนตัด / no board yet: import it before cutting if one exists' });
  for (const c of listConstraints(p)) {
    const scope = c.scope && c.scope !== 'all' ? ` [scope ${c.scope}]` : '';
    const check = c.check ? ` (${c.check}${MACHINE_CHECKS.has(c.check) ? ', auto' : ', ตรวจด้วยตา/visual'})` : ' (ตรวจด้วยตา/visual)';
    items.push({
      id: c.id,
      kind: !c.check || VISUAL_CHECKS.has(c.check) ? 'visual' : 'constraint',
      text: `${c.text}${scope}${check}`,
      ...(c.source ? { source: `${c.source}: «${c.quote ?? ''}»` } : {}),
      ...(c.check && MACHINE_CHECKS.has(c.check) ? { auto: true } : {}),
    });
  }
  const s = (p.styleRules ?? {}) as StyleRulesRecord;
  const src = (k: string) => { const x = s.sources?.[k]; return x ? { source: `${x.source}: «${x.quote}»` } : {}; };
  if (s.cornerRadiusPct !== undefined) items.push({ id: 'style.cornerRadiusPct', kind: 'style', text: `มุมมน ${s.cornerRadiusPct}% ของด้านสั้น — ทุกการ์ด ทุก instance / corner radius on every card instance`, ...src('cornerRadiusPct') });
  if (s.safeMarginPct !== undefined) items.push({ id: 'style.safeMarginPct', kind: 'style', text: `safe margin ${s.safeMarginPct}%`, ...src('safeMarginPct') });
  if (s.palette?.length) items.push({ id: 'style.palette', kind: 'style', text: `palette: ${s.palette.join(' ')}`, ...src('palette') });
  for (const j of s.joins ?? []) items.push({ id: `style.${joinKey(j)}`, kind: 'style', text: `รอยต่อ ${j.from}→${j.to}: ${j.dissolve === 0 ? 'คัตตรง / hard cut' : `dissolve ${j.dissolve} เฟรม`}`, ...src(joinKey(j)) });
  if (s.thai) {
    const t = s.thai;
    const parts = [
      t.minCapHeightPct !== undefined ? `cap height ≥ ${t.minCapHeightPct}%` : '',
      t.minWeight !== undefined ? `weight ≥ ${t.minWeight}` : '',
      t.lowerVowelClearancePx !== undefined ? `ระยะสระล่าง ≥ ${t.lowerVowelClearancePx}px` : '',
      t.animateBy ? `animate by ${t.animateBy}` : '',
    ].filter(Boolean);
    if (parts.length) items.push({ id: 'style.thai', kind: 'style', text: `ตัวอักษรไทย: ${parts.join(', ')}` });
  }
  if (s.maxStaticSec !== undefined) items.push({ id: 'style.maxStaticSec', kind: 'style', text: `ฟุตเทจนิ่งเกิน ${s.maxStaticSec} วิ → เสนอ push-in (advisory)`, ...src('maxStaticSec') });
  items.push(
    { id: 'evidence', kind: 'process', text: 'ก่อนรายงานว่า "แก้ครบแล้ว" ต้องแนบเฟรมของทุก instance (rules_evidence) / attach one frame per instance before claiming a fix' },
    { id: 'incremental', kind: 'process', text: 'ใช้ build แบบ incremental; ไม่ export เต็มถ้าไม่จำเป็น / incremental builds, no full export unless needed' },
    { id: 'cost', kind: 'process', text: 'บริการ/คอนเนกเตอร์ที่เสียเงิน: บอกผู้ใช้และขออนุญาตก่อน / paid services: tell the user and ask first' },
  );
  const text = items.map((i) => `- ${i.auto ? '[auto] ' : ''}${i.text}${i.source ? ` — ${i.source}` : ''}`).join('\n');
  return { text: `กฎของโปรเจกต์ (อ่านก่อนแก้/บิลด์ทุกครั้ง) / project rules (re-read before every edit/build):\n${text}`, items };
}

/** One-line notice to show (and get a yes) before calling a paid external service or connector. */
export function costNotice(service: string): string {
  return `"${service}" อาจมีค่าใช้จ่าย — แจ้งผู้ใช้และขออนุญาตก่อนเรียก / "${service}" may cost money — tell the user and ask before calling it.`;
}

// ---------- machine checks ----------

export interface RulesCheckResult {
  issues: QcIssue[];
  /** rules a person/agent must verify by eye (no-cover-photo, manual, unchecked text) */
  checklist: ChecklistItem[];
  /** machine checks that could not run, with the reason */
  skipped: string[];
}

export interface RulesCheckOptions {
  /** effect / preset match names per asset id (e.g. from ae_inspect_comp), for no-repeat-gimmick */
  effects?: Record<string, string[]>;
}

const LOGO_RE = /logo|โลโก้/i;

export function checkRules(p: Project, opts: RulesCheckOptions = {}): RulesCheckResult {
  const issues: QcIssue[] = [];
  const checklist: ChecklistItem[] = [];
  const skipped: string[] = [];
  const clips = p.timeline.video;
  const starts = clipStarts(clips);
  const at = (c: Clip) => ({ clipId: c.id, startFrame: starts.get(c.id) ?? 0, endFrame: (starts.get(c.id) ?? 0) + c.dur });

  for (const rule of listConstraints(p)) {
    const inScope = scopeFilter(p, rule.scope);
    switch (rule.check) {
      case 'board-only': {
        if (!p.board) { skipped.push(`${rule.id} board-only: ยังไม่มีบอร์ด / no board imported`); break; }
        const slots = new Set(p.board.slots.map((s) => s.id));
        for (const c of clips.filter(inScope)) {
          if (!c.slot) issues.push({ kind: 'style', severity: 'warn', ...at(c), message: `[${rule.id}] คลิป ${c.id} ไม่ได้ผูก slot ในบอร์ด — "${rule.text}" / clip has no board slot` });
          else if (!slots.has(c.slot)) issues.push({ kind: 'style', severity: 'error', ...at(c), message: `[${rule.id}] คลิป ${c.id} ใช้ slot ${c.slot} ที่ไม่มีในบอร์ด — "${rule.text}" / slot not on the board` });
        }
        break;
      }
      case 'logo-static': {
        const scoped = rule.scope && rule.scope !== 'all' ? new Set(rule.scope.split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
        const isLogo = (c: Clip) => (scoped ? scoped.has(c.src) || (!!c.slot && scoped.has(c.slot)) || scoped.has(c.id) : looksLikeLogo(p, c));
        const logos = clips.filter(isLogo);
        if (!logos.length) { skipped.push(`${rule.id} logo-static: ไม่พบคลิปโลโก้ (ระบุ scope เป็น asset/slot id) / no logo clips found`); break; }
        for (const c of logos) {
          const moving: string[] = [];
          if (c.speed && (c.speed.rate !== 1 || (c.speed.rampFrom !== undefined && c.speed.rampFrom !== c.speed.rate))) moving.push(`speed ${c.speed.rate}`);
          if (c.pushIn) moving.push(`pushIn ${c.pushIn}%`);
          if (moving.length) issues.push({ kind: 'style', severity: 'error', ...at(c), message: `[${rule.id}] โลโก้ต้องนิ่ง แต่คลิป ${c.id} มี ${moving.join(', ')} — "${rule.text}" / logo must be static` });
        }
        break;
      }
      case 'no-repeat-gimmick': {
        const max = rule.max ?? 1;
        const gimmicks = gimmickKeys(p, clips, rule.scope, opts.effects);
        if (!gimmicks.usable) { skipped.push(`${rule.id} no-repeat-gimmick: ${gimmicks.reason}`); break; }
        for (const run of runsOf(clips, gimmicks.keys)) {
          if (run.clips.length <= max) continue;
          const first = run.clips[0]!;
          const last = run.clips[run.clips.length - 1]!;
          issues.push({
            kind: 'style', severity: 'warn', clipId: first.id,
            startFrame: starts.get(first.id) ?? 0, endFrame: (starts.get(last.id) ?? 0) + last.dur,
            message: `[${rule.id}] ลูกเล่น "${run.key}" ซ้ำ ${run.clips.length} คลิปติดกัน (${run.clips.map((c) => c.id).join(', ')}) เกิน ${max} — "${rule.text}" / gimmick repeated on consecutive clips`,
          });
        }
        if (gimmicks.reason) skipped.push(`${rule.id} no-repeat-gimmick: ${gimmicks.reason}`);
        break;
      }
      default:
        checklist.push({
          id: rule.id, kind: 'visual',
          text: `${rule.text}${rule.scope && rule.scope !== 'all' ? ` [scope ${rule.scope}]` : ''} — ${rule.check === 'no-cover-photo' ? 'ตรวจด้วยตาว่าไม่มีกราฟิกบังภาพ / verify nothing covers the photo' : 'ตรวจด้วยตา / verify visually'}`,
          ...(rule.source ? { source: `${rule.source}: «${rule.quote ?? ''}»` } : {}),
        });
    }
  }
  return { issues, checklist, skipped };
}

function clipStarts(clips: Clip[]): Map<string, Frames> {
  const m = new Map<string, Frames>();
  let pos = 0;
  for (const c of clips) { m.set(c.id, pos); pos += Math.max(0, c.dur); }
  return m;
}

function scopeFilter(p: Project, scope: string | undefined): (c: Clip) => boolean {
  if (!scope || scope === 'all') return () => true;
  const ids = new Set(scope.split(',').map((s) => s.trim()).filter(Boolean));
  return (c) => ids.has(c.id) || ids.has(c.src) || (!!c.slot && ids.has(c.slot)) || (p.assets[c.src]?.kind === 'aecomp' && ids.has((p.assets[c.src] as { comp: string }).comp));
}

function assetLabel(a: Asset | undefined): string {
  if (!a) return '';
  return a.kind === 'aecomp' ? `${a.id} ${a.comp} ${path.basename(a.aep)}` : `${a.id} ${path.basename(a.path)}`;
}

function looksLikeLogo(p: Project, c: Clip): boolean {
  if (LOGO_RE.test(assetLabel(p.assets[c.src]))) return true;
  const slot = c.slot ? p.board?.slots.find((s) => s.id === c.slot) : undefined;
  return !!slot && LOGO_RE.test(`${slot.notes ?? ''} ${slot.onScreenText ?? ''} ${slot.sourceHint ?? ''}`);
}

/**
 * Gimmick identity per clip: effect match names when supplied (optionally only the scoped one), else the
 * AE comp / graphic asset itself (same animated template back to back). Camera footage is never a gimmick.
 */
function gimmickKeys(p: Project, clips: Clip[], scope: string | undefined, effects: Record<string, string[]> | undefined): { usable: boolean; keys: Map<string, string[]>; reason?: string } {
  const keys = new Map<string, string[]>();
  const scoped = scope && scope !== 'all' ? scope.trim() : undefined;
  const haveEffects = !!effects && Object.keys(effects).length > 0;
  let missing = 0;
  for (const c of clips) {
    const a = p.assets[c.src];
    if (haveEffects) {
      const fx = effects![c.src];
      if (fx === undefined) { if (a?.kind === 'aecomp') missing++; continue; }
      const list = scoped ? fx.filter((x) => x === scoped) : fx;
      if (list.length) keys.set(c.id, [...new Set(list)]);
    } else if (a && (a.kind === 'aecomp' || a.kind === 'graphic')) {
      const k = a.kind === 'aecomp' ? `comp:${a.comp}` : `asset:${a.id}`;
      if (!scoped || scoped === a.id || (a.kind === 'aecomp' && scoped === a.comp)) keys.set(c.id, [k]);
    }
  }
  if (!haveEffects && !keys.size) {
    return { usable: false, keys, reason: 'ไม่มีข้อมูล effect และไม่มีคลิป comp/graphic — ส่ง effects {assetId: [matchName]} จาก ae_inspect_comp เพื่อตรวจ / no effect data and no comp/graphic clips: skipped' };
  }
  const reason = haveEffects
    ? (missing ? `${missing} คลิป AE ไม่มีข้อมูล effect — ไม่ได้ตรวจคลิปเหล่านั้น / ${missing} comp clip(s) without effect data were not checked` : undefined)
    : 'ไม่มีข้อมูล effect: ตรวจแค่ comp/graphic เดิมซ้ำติดกัน / no effect data: checked repeated comp/graphic assets only';
  return { usable: true, keys, ...(reason ? { reason } : {}) };
}

function runsOf(clips: Clip[], keys: Map<string, string[]>): Array<{ key: string; clips: Clip[] }> {
  const out: Array<{ key: string; clips: Clip[] }> = [];
  const open = new Map<string, Clip[]>();
  for (const c of clips) {
    const ks = new Set(keys.get(c.id) ?? []);
    for (const [k, run] of [...open]) {
      if (!ks.has(k)) { out.push({ key: k, clips: run }); open.delete(k); }
    }
    for (const k of ks) open.set(k, [...(open.get(k) ?? []), c]);
  }
  for (const [k, run] of open) out.push({ key: k, clips: run });
  return out;
}

// ---------- evidence frames ----------

export interface EvidenceInstance {
  instance: number; // 1-based, timeline order
  clipId: string;
  src: string;
  comp?: string;
  start: Frames; // clip start on the version's timeline
  dur: Frames;
  frame: Frames; // master frame to grab (inside the clip, clear of dissolves when possible)
  tc: string;
  sourceFrame: Frames; // clip in-point + offset (constant-speed estimate)
}

export interface EvidencePlan {
  versionId: string;
  master: string;
  fps: number;
  from: 'reviewPlan' | 'timeline';
  instances: EvidenceInstance[];
  warnings: string[];
}

export interface EvidenceTarget {
  assetId?: string;
  clipIds?: string[];
  /** frame inside each instance, relative to the clip start; default: middle of the dissolve-free part */
  offset?: Frames;
  /** several frames per instance (e.g. each review note's frame); overrides `offset` */
  offsets?: Frames[];
}

/**
 * Every timeline instance of an asset/comp (or the given clips) in a version, with one frame each to grab,
 * so a claim like "fixed everywhere" can be backed by one picture per instance.
 */
export function evidenceFrames(p: Project, versionId: string | undefined, target: EvidenceTarget): EvidencePlan {
  if (!target.assetId && !target.clipIds?.length) throw new Error('give assetId or clipIds');
  const version = pickVersion(p, versionId);
  const warnings: string[] = [];
  const fps = version.reviewPlan?.fps ?? p.meta.fps;
  let shots: Array<ReviewShot>;
  let cuts: Cut[];
  let from: EvidencePlan['from'];
  if (version.reviewPlan) {
    shots = version.reviewPlan.shots;
    cuts = version.reviewPlan.cuts ?? [];
    from = 'reviewPlan';
  } else {
    let pos = 0;
    shots = p.timeline.video.map((c) => {
      const a = p.assets[c.src];
      const s: ReviewShot = { id: c.id, src: c.src, start: pos, in: c.in, dur: c.dur, ...(a?.kind === 'aecomp' ? { comp: a.comp } : {}) };
      pos += Math.max(0, c.dur);
      return s;
    });
    cuts = p.timeline.cuts;
    from = 'timeline';
    if (version.planHash !== planHash(p)) warnings.push(`เวอร์ชัน ${version.id} ไม่มี reviewPlan และไทม์ไลน์เปลี่ยนไปแล้ว — ตำแหน่งเฟรมอาจไม่ตรง / no reviewPlan and the timeline changed since ${version.id}: positions may be off`);
  }

  const match = matcher(p, target, shots, warnings);
  const dissolveAfter = new Map(cuts.map((c) => [c.after, c.dissolve]));
  const instances: EvidenceInstance[] = [];
  shots.forEach((s, i) => {
    if (!match(s)) return;
    const prev = i > 0 ? shots[i - 1] : undefined;
    const inDiss = prev ? splitDissolve(dissolveAfter.get(prev.id) ?? 0).b : 0;
    const outDiss = splitDissolve(dissolveAfter.get(s.id) ?? 0).a;
    const clampOff = (o: Frames) => Math.min(Math.max(0, o), Math.max(0, s.dur - 1));
    let offs: Frames[];
    if (target.offsets?.length) offs = [...new Set(target.offsets.map(clampOff))];
    else if (target.offset !== undefined) offs = [clampOff(target.offset)];
    else {
      const lo = Math.min(inDiss, Math.max(0, s.dur - 1));
      const hi = Math.max(lo + 1, s.dur - outDiss);
      offs = [lo + Math.floor((hi - lo - 1) / 2)];
    }
    const instance = new Set(instances.map((x) => x.clipId)).size + 1;
    for (const off of offs) {
      const frame = s.start + off;
      instances.push({
        instance, clipId: s.id, src: s.src, ...(s.comp ? { comp: s.comp } : {}),
        start: s.start, dur: s.dur, frame, tc: framesToTc(frame, fps), sourceFrame: s.in + off,
      });
    }
  });
  if (!instances.length) warnings.push(`ไม่พบ instance ในเวอร์ชัน ${version.id} / no matching instance in ${version.id}`);
  return { versionId: version.id, master: version.master, fps, from, instances, warnings };
}

function pickVersion(p: Project, versionId: string | undefined): Version {
  if (!p.versions.length) throw new Error('ยังไม่มีเวอร์ชัน — build ก่อน / no versions yet: build first');
  const v = versionId ? p.versions.find((x) => x.id === versionId) : p.versions[p.versions.length - 1];
  if (!v) throw new Error(`no version ${versionId}`);
  return v;
}

function matcher(p: Project, t: EvidenceTarget, shots: ReviewShot[], warnings: string[]): (s: ReviewShot) => boolean {
  if (t.clipIds?.length) {
    const ids = new Set(t.clipIds);
    for (const id of ids) if (!shots.some((s) => s.id === id)) warnings.push(`ไม่พบคลิป ${id} ในเวอร์ชันนี้ / clip ${id} not in this version`);
    return (s) => ids.has(s.id);
  }
  const id = t.assetId as string;
  const a = p.assets[id];
  if (!a) warnings.push(`ไม่พบ asset ${id} ในโปรเจกต์ — จับคู่ด้วย id/ชื่อ comp / asset ${id} not in the project: matching by id / comp name`);
  // The same comp can be registered under several asset ids (duplicates, re-imports): match by aep + comp too.
  const sameComp = (sid: string) => {
    const b = p.assets[sid];
    return a?.kind === 'aecomp' && b?.kind === 'aecomp' && b.comp === a.comp && path.resolve(b.aep).toLowerCase() === path.resolve(a.aep).toLowerCase();
  };
  return (s) => s.src === id || sameComp(s.src) || (!a && s.comp === id);
}

// ---------- evidence extraction (ffmpeg) ----------

const SHEET_COLUMNS = 4;
const SHEET_THUMB_WIDTH = 480;
const FRAME_TIMEOUT_MS = 120_000;

export interface EvidenceResult {
  dir: string;
  frames: Array<EvidenceInstance & { path: string }>;
  contactSheet?: string;
  warnings: string[];
}

/**
 * Grab each instance's frame from the version master into <project>/review/evidence/<version>/ (new names only,
 * `-n`), then tile them into a labelled contact sheet. Frame-accurate: input seek lands on the first frame whose
 * pts >= (frame - 0.25) / fps.
 */
export async function extractEvidence(tools: Pick<ToolPaths, 'ffmpeg'>, p: Project, plan: EvidencePlan, opts: { signal?: AbortSignal } = {}): Promise<EvidenceResult> {
  if (!plan.instances.length) throw new Error('no instances to extract');
  if (!existsSync(plan.master)) throw new Error(`master not found: ${plan.master}`);
  const dir = path.join(p.dir, 'review', 'evidence', safeName(plan.versionId));
  await mkdir(dir, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}_${randomBytes(2).toString('hex')}`;
  const frames: EvidenceResult['frames'] = [];
  const warnings = [...plan.warnings];
  for (const inst of plan.instances) {
    const out = freePath(path.join(dir, `${stamp}_${String(inst.instance).padStart(2, '0')}_${safeName(inst.clipId)}_f${inst.frame}.png`));
    const ss = (Math.max(0, inst.frame - 0.25) / plan.fps).toFixed(6);
    const r = await ff(tools.ffmpeg, ['-ss', ss, '-i', plan.master, '-map', '0:v:0', '-frames:v', '1', '-update', '1', out], opts.signal);
    if (r.exitCode !== 0 || !existsSync(out)) { warnings.push(`ดึงเฟรม ${inst.frame} (${inst.clipId}) ไม่สำเร็จ: ${r.tail}`); continue; }
    frames.push({ ...inst, path: out });
  }
  let contactSheet: string | undefined;
  if (frames.length) {
    const sheet = freePath(path.join(dir, `${stamp}_contact.png`));
    contactSheet = await tileFrames(tools.ffmpeg, frames, sheet, opts.signal);
    if (!contactSheet) warnings.push('สร้าง contact sheet ไม่สำเร็จ / contact sheet failed');
  }
  return { dir, frames, ...(contactSheet ? { contactSheet } : {}), warnings };
}

async function tileFrames(ffmpeg: string, frames: Array<EvidenceInstance & { path: string }>, out: string, signal?: AbortSignal): Promise<string | undefined> {
  const cols = Math.min(SHEET_COLUMNS, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const labelFont = labelFontOpt();
  const fontOpts: Array<string | undefined> = labelFont ? [labelFont, undefined] : [undefined];
  for (const font of fontOpts) {
    const chains = frames.map((f, i) => {
      // labels are ASCII-only (clip ids sanitised), colons escaped for drawtext
      const label = `#${f.instance} ${safeName(f.clipId)} ${f.tc}`.replace(/:/g, '\\:');
      const draw = font ? `,drawtext=${font}:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4:x=8:y=8:text='${label}'` : '';
      return `[${i}:v]scale=${SHEET_THUMB_WIDTH}:-2,setsar=1,format=rgb24${draw}[v${i}]`;
    });
    const graph = `${chains.join(';')};${frames.map((_, i) => `[v${i}]`).join('')}concat=n=${frames.length}:v=1:a=0,tile=layout=${cols}x${rows}:padding=4:margin=4:color=0x202020`;
    const args = [...frames.flatMap((f) => ['-i', f.path]), '-filter_complex', graph, '-frames:v', '1', '-update', '1', out];
    const r = await ff(ffmpeg, args, signal);
    if (r.exitCode === 0 && existsSync(out)) return out;
  }
  return undefined;
}

async function ff(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<{ exitCode: number; tail: string }> {
  const r = await execa(ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-loglevel', 'error', '-n', ...args], {
    reject: false, windowsHide: true, stdin: 'ignore', timeout: FRAME_TIMEOUT_MS, forceKillAfterDelay: 2000,
    ...(signal ? { cancelSignal: signal } : {}),
  });
  if (r.isCanceled) throw new Error('cancelled');
  if (r.timedOut) throw new Error(`ffmpeg timed out after ${FRAME_TIMEOUT_MS} ms`);
  return { exitCode: r.exitCode ?? -1, tail: String(r.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' | ') };
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

function freePath(p: string): string {
  if (!existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) {
    const c = `${base}_${i}${ext}`;
    if (!existsSync(c)) return c;
  }
}
