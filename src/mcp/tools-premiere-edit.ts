/**
 * Editing the sequence the editor already works in (CATCUT_FEATURE_REQUEST.md): read the timeline
 * and effects, change clips in place with ops[], never touch what the ops do not name.
 * Safety: every op names its clip by track + start + end (+ name/media) and is refused when the
 * clip moved; dry run by default; apply saves a checkpoint copy of the .prproj first (undo restores
 * it) and checks that every other clip is unchanged; the edit itself is saved only with save: true.
 */
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { localAppDataDir } from '../core/platform.js';
import { uniqueOutputPath } from '../engine/aerender.js';
import { stagePath, type PremiereProjectRef, type PremiereSequenceRef } from '../engine/premiere.js';
import type { AppState } from './state.js';
import { client, closeHint, ensureProject } from './tools-premiere.js';
import { tool, ToolError, type ToolDef } from './tooldef.js';

const frameOrTc = z.union([z.number().int().min(0), z.string().regex(/^\d{1,2}:\d{2}:\d{2}[:;]\d{2}$/)]);
const clipSel = z.object({
  track: z.string().regex(/^[VAva]\d+$/).describe('V1, V2 … or A1 …'),
  start: frameOrTc.describe('timeline start the clip has now (frame or HH:MM:SS:FF)'),
  end: frameOrTc.describe('timeline end (exclusive) the clip has now'),
  name: z.string().optional().describe('clip name as Premiere shows it (recommended)'),
  media: z.string().optional().describe('media file path (alternative to name)'),
}).describe('which clip: it must be exactly here now, or nothing changes');
const source = {
  media: z.string().optional().describe('a media file (imported into bin "CatCut" when the project lacks it)'),
  aeComp: z.object({ aep: z.string(), comp: z.string() }).optional().describe('an After Effects comp (Dynamic Link import into bin "CatCut AE")'),
  in: z.number().int().min(0).optional().describe('source in, frames at sequence fps'),
  keepAudio: z.boolean().optional().describe('keep the linked audio (default: dropped for comps and stills)'),
};
const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), clip: clipSel, linked: z.boolean().optional().describe('also remove its linked audio (default true)') }),
  z.object({ op: z.literal('trim'), clip: clipSel, start: frameOrTc.optional(), end: frameOrTc.optional() }),
  z.object({ op: z.literal('move'), clip: clipSel, to: frameOrTc }),
  z.object({ op: z.literal('set_speed'), clip: clipSel, rate: z.number().positive().describe('percent, e.g. 60'), interpolation: z.enum(['optical-flow', 'frame-blend', 'frame-sampling']).optional() }),
  z.object({ op: z.literal('overwrite'), track: z.string().regex(/^[Vv]\d+$/), at: frameOrTc, dur: z.number().int().min(1), name: z.string().optional(), replaceExisting: z.boolean().optional(), ...source }),
  z.object({ op: z.literal('replace_media'), clip: clipSel, keepName: z.boolean().optional(), ...source }),
  z.object({ op: z.literal('relink'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('rename'), clip: clipSel, name: z.string().min(1) }),
  z.object({
    op: z.literal('set_motion'), clip: clipSel, scale: z.number().optional(), rotation: z.number().optional(), opacity: z.number().min(0).max(100).optional(),
    position: z.tuple([z.number(), z.number()]).optional().describe('normalized 0–1 (0.5,0.5 = centre)'),
  }),
  z.object({ op: z.literal('add_effect'), clip: clipSel, effect: z.string().describe('Premiere effect name, e.g. "Lumetri Color"') }),
  z.object({ op: z.literal('remove_effect'), clip: clipSel, effect: z.union([z.string(), z.number().int().min(2)]) }),
  z.object({
    op: z.literal('set_effect_param'), clip: clipSel, effect: z.union([z.string(), z.number().int().min(0)]), param: z.union([z.string(), z.number().int().min(0)]),
    value: z.unknown().optional(), color: z.tuple([z.number(), z.number(), z.number()]).or(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional().describe('[r,g,b(,a)] 0–255'),
    keys: z.array(z.object({ seconds: z.number(), value: z.unknown() })).optional().describe('keyframes in the times premiere_clip_effects reports'),
  }),
]);
type Op = z.infer<typeof OP>;

const seqArg = z.string().optional().describe('sequence name or id (default: the active one)');
const projectArg = z.string().describe('full path of the .prproj (opened when needed) or the open project name');
const timeoutArg = z.number().int().min(10).max(3600).optional().describe('seconds to wait for Premiere (default 180)');

// ---------- checkpoints ----------

function backupDir(projectPath: string): string {
  const root = join(localAppDataDir(), 'CatCut', 'premiere-backups');
  const id = createHash('sha1').update(resolve(projectPath).toLowerCase()).digest('hex').slice(0, 8);
  return join(root, `${basename(projectPath, '.prproj').replace(/[^\w.-]+/g, '_')}-${id}`);
}

const stampNow = (): string => new Date().toISOString().replace(/[:.]/g, '-');

/** Save what the editor sees, then copy the .prproj aside: undo returns exactly here. */
async function checkpoint(state: AppState, project: PremiereProjectRef, timeoutMs: number): Promise<string> {
  await client(state).call('save', { expectProject: project.path }, { timeoutMs });
  const dir = backupDir(project.path);
  await mkdir(dir, { recursive: true });
  const file = uniqueOutputPath(join(dir, `${stampNow()}.prproj`));
  await copyFile(project.path, file, constants.COPYFILE_EXCL);
  return file;
}

async function latestCheckpoint(projectPath: string): Promise<string | undefined> {
  const dir = backupDir(projectPath);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^\d{4}-.*\.prproj$/.test(f) && !f.includes('before-undo') && !f.includes('.used.')).sort();
  return files.length ? join(dir, files[files.length - 1]!) : undefined;
}

/** Premiere's own H.264 "Match Source" preset, found in its install folder. */
async function defaultPreset(premiereExe: string | undefined): Promise<string | undefined> {
  if (!premiereExe) return undefined;
  const want = /^Match Source - Adaptive High Bitrate\.epr$/i;
  const stack = [dirname(premiereExe)];
  for (let budget = 4000; stack.length && budget > 0; budget--) {
    const d = stack.pop()!;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) stack.push(join(d, e.name));
      else if (want.test(e.name)) return join(d, e.name);
    }
  }
  return undefined;
}

function outDirFor(state: AppState, kind: string, seq: string): string {
  const base = state.project ? join(state.project.dir, 'review', kind) : join(localAppDataDir(), 'CatCut', kind);
  return join(base, `${seq.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-${stampNow()}`);
}

export const PREMIERE_EDIT_TOOLS: ToolDef[] = [
  tool({
    name: 'premiere_timeline_get',
    description: 'อ่าน sequence ใน Premiere (ไม่แก้อะไร): ทุกคลิปทุกแทร็ก track/start/end/in/out เป็นเฟรม, ไฟล์, nodeId, speed, proxy, รายชื่อเอฟเฟกต์ — ใช้ค่าจากที่นี่ระบุคลิปใน premiere_edit · Read a Premiere sequence (frames)',
    input: { project: projectArg, sequence: seqArg, timeoutSec: timeoutArg },
    handler: async (a, state) => {
      const { project } = await ensureProject(state, a.project);
      return client(state).call('timeline', { expectProject: project.path, sequence: a.sequence }, { timeoutMs: (a.timeoutSec ?? 180) * 1000 });
    },
  }),

  tool({
    name: 'premiere_clip_effects',
    description: 'อ่านเอฟเฟกต์ของคลิปเดียวแบบละเอียด: ค่าพารามิเตอร์ทุกตัว คีย์เฟรม และสี [a,r,g,b] · Every effect parameter, keyframe and colour of one clip',
    input: { project: projectArg, sequence: seqArg, clip: clipSel, timeoutSec: timeoutArg },
    handler: async (a, state) => {
      const { project } = await ensureProject(state, a.project);
      return client(state).call('clipEffects', { expectProject: project.path, sequence: a.sequence, clip: a.clip }, { timeoutMs: (a.timeoutSec ?? 180) * 1000 });
    },
  }),

  tool({
    name: 'premiere_edit',
    description: 'แก้คลิปใน sequence เดิมของ editor (ไม่สร้าง sequence ใหม่): remove, trim, move, set_speed, overwrite (ไฟล์หรือ AE comp), replace_media, relink, rename, set_motion, add/remove_effect, set_effect_param. '
      + 'ทุก op ระบุคลิปด้วย track+start+end(+name) ตามที่เป็นอยู่ตอนนี้ (ดู premiere_timeline_get) ถ้าคลิปขยับไปแล้วจะไม่แก้อะไรเลย. ค่าเริ่มต้น dry run; apply: true จะ Save สถานะปัจจุบันเป็นจุดย้อนกลับก่อน แล้วแก้ แล้วตรวจว่าคลิปอื่นไม่เปลี่ยน; Save ผลแก้เมื่อ save: true; ย้อนด้วย premiere_undo_last. '
      + 'Ops run in order: a later op names its clip where the earlier ops left it. · Edit the editor\'s sequence in place, guarded.',
    input: {
      project: projectArg, sequence: seqArg, ops: z.array(OP).min(1).max(200),
      apply: z.boolean().optional().describe('default false = dry run (plan + problems)'),
      save: z.boolean().optional().describe('save the edit when it applied cleanly (default false)'),
      timeoutSec: timeoutArg,
    },
    handler: async (a, state) => {
      const { project } = await ensureProject(state, a.project);
      const c = client(state);
      const timeoutMs = (a.timeoutSec ?? 180) * 1000;
      const ops = a.ops as Op[];
      const args = { expectProject: project.path, sequence: a.sequence, ops };
      if (a.apply !== true) {
        const r = await c.call<{ plan: unknown[]; problems: Array<{ op: number; error: string }> }>('edit', { ...args, apply: false }, { timeoutMs });
        return { ...r, ok: r.problems.length === 0, dryRun: true, hint: r.problems.length ? 'แก้ op ที่มีปัญหาก่อน (ดู problems) / fix the problems first' : 'ตรวจแผนแล้วเรียกซ้ำด้วย apply: true / review, then apply: true' };
      }
      const backup = await checkpoint(state, project, timeoutMs);
      const r = await c.call<{ results: unknown[]; failed: { op: number; error: string } | null; untouchedChanged: unknown[]; saved: boolean; sequence: PremiereSequenceRef }>('edit', { ...args, apply: true, save: a.save === true }, { timeoutMs });
      const clean = !r.failed && r.untouchedChanged.length === 0;
      return {
        ...r, ok: clean, backup,
        ...(clean ? {} : { warning: r.failed ? `op ${r.failed.op} ล้ม: ${r.failed.error} — op ก่อนหน้าถูกใช้ไปแล้ว ไม่ได้ Save / op failed; earlier ops applied, not saved` : 'คลิปที่ไม่ได้สั่งเปลี่ยนไป — ไม่ได้ Save / clips outside the ops changed; not saved', undo: 'premiere_undo_last คืนสถานะก่อนแก้ทั้งหมด / restores the checkpoint' }),
        closeHint: closeHint(state, r.saved),
      };
    },
  }),

  tool({
    name: 'premiere_undo_last',
    description: 'ย้อนการแก้ครั้งล่าสุดของ premiere_edit: ปิดโปรเจกต์โดยไม่ Save, คืนไฟล์ .prproj จากจุดย้อนกลับ, เปิดใหม่ (สำเนาฉบับก่อนย้อนเก็บไว้ด้วย) · Restore the last premiere_edit checkpoint',
    input: { project: z.string().describe('full path of the .prproj'), timeoutSec: timeoutArg },
    handler: async (a, state) => {
      const target = resolve(a.project);
      const backup = await latestCheckpoint(target);
      if (!backup) throw new ToolError('ยังไม่มีจุดย้อนกลับของโปรเจกต์นี้ / no checkpoint for this project', { project: target });
      const { project } = await ensureProject(state, target);
      const c = client(state);
      const timeoutMs = (a.timeoutSec ?? 180) * 1000;
      await c.call('closeProject', { expectProject: project.path, save: false }, { timeoutMs });
      const before = uniqueOutputPath(join(dirname(backup), `${stampNow()}-before-undo.prproj`));
      await copyFile(target, before, constants.COPYFILE_EXCL);
      await copyFile(backup, target);
      // the checkpoint is used: the next undo goes one further back
      await rename(backup, backup.replace(/\.prproj$/, '.used.prproj'));
      const r = await c.call<{ project: PremiereProjectRef }>('openProject', { path: target }, { timeoutMs });
      return { ok: true, restoredFrom: backup, keptCurrentAs: before, project: r.project, closeHint: closeHint(state, true) };
    },
  }),

  tool({
    name: 'premiere_place_ae_comp',
    description: 'วาง comp ของ After Effects ลง sequence เดิม (Dynamic Link) ที่ track/at/dur และลบเสียงเปล่าที่ติดมา — ทางลัดของ premiere_edit overwrite · Place an AE comp in the sequence (dry run unless apply)',
    input: {
      project: projectArg, sequence: seqArg, aep: z.string(), comp: z.string(), track: z.string().regex(/^[Vv]\d+$/), at: frameOrTc, dur: z.number().int().min(1),
      replaceExisting: z.boolean().optional(), apply: z.boolean().optional(), save: z.boolean().optional(), timeoutSec: timeoutArg,
    },
    handler: async (a, state) => {
      const { callTool, toolResultData } = await import('./tools.js');
      const r = await callTool(state, 'premiere_edit', {
        project: a.project, sequence: a.sequence, apply: a.apply, save: a.save, timeoutSec: a.timeoutSec,
        ops: [{ op: 'overwrite', track: a.track, at: a.at, dur: a.dur, aeComp: { aep: resolve(a.aep), comp: a.comp }, replaceExisting: a.replaceExisting }],
      });
      const data = toolResultData(r);
      if (r.isError) throw new ToolError(String(data['error'] ?? 'premiere_edit failed'), data);
      return data;
    },
  }),

  tool({
    name: 'premiere_frames',
    description: 'ดึงเฟรมจาก sequence ใน Premiere จริงเป็น PNG (ตรวจสี/กรอบ/ข้อความตามที่ editor เห็น) ไม่เกิน 300 เฟรมต่อครั้ง ลงโฟลเดอร์ใหม่ใน review/premiere-frames · PNG frames rendered by Premiere',
    input: {
      project: projectArg, sequence: seqArg, frames: z.array(frameOrTc).max(300).optional(),
      from: frameOrTc.optional(), to: frameOrTc.optional(), step: z.number().int().min(1).optional(), timeoutSec: timeoutArg,
    },
    handler: async (a, state) => {
      if (!a.frames?.length && a.from === undefined) throw new ToolError('ระบุ frames หรือ from/to / pass frames or from + to');
      const { project } = await ensureProject(state, a.project);
      const c = client(state);
      const stage = (await stagePath(c, '')).replace(/[\\/][^\\/]*$/, (m) => `${m}-frames`);
      await mkdir(stage, { recursive: true });
      try {
        const r = await c.call<{ sequence: PremiereSequenceRef; frames: Array<{ frame: number; tc: string; file: string }> }>('frames', {
          expectProject: project.path, sequence: a.sequence, dir: stage.replace(/\\/g, '/'), prefix: 'f', frames: a.frames, from: a.from, to: a.to, step: a.step,
        }, { timeoutMs: (a.timeoutSec ?? 300) * 1000 });
        const dir = outDirFor(state, 'premiere-frames', r.sequence.name);
        await mkdir(dir, { recursive: true });
        const frames = [];
        for (const f of r.frames) {
          const dest = join(dir, `${String(f.frame).padStart(6, '0')}_${f.tc.replace(/:/g, '-')}.png`);
          await copyFile(f.file, dest, constants.COPYFILE_EXCL);
          frames.push({ ...f, file: dest });
        }
        return { ok: true, sequence: r.sequence, dir, frames };
      } finally { await rm(stage, { recursive: true, force: true }); }
    },
  }),

  tool({
    name: 'premiere_export_range',
    description: 'export ช่วงสั้นจาก sequence ใน Premiere (ค่าเริ่มต้น preset H.264 Match Source ของ Premiere) ไว้เช็กก่อน export เต็ม; ไม่เขียนทับ · Export a short range from Premiere for checking',
    input: {
      project: projectArg, sequence: seqArg, from: frameOrTc, to: frameOrTc,
      preset: z.string().optional().describe('.epr preset (default: Premiere\'s "Match Source - Adaptive High Bitrate")'),
      out: z.string().optional().describe('output file (default: review/premiere-exports/…mp4)'), timeoutSec: timeoutArg,
    },
    handler: async (a, state) => {
      const preset = a.preset ? resolve(a.preset) : await defaultPreset(state.env.tools.premiereExe);
      if (!preset || !existsSync(preset)) throw new ToolError('ไม่พบ preset — ส่ง preset: "<ไฟล์ .epr>" / no export preset found');
      const { project } = await ensureProject(state, a.project);
      const c = client(state);
      const staged = await stagePath(c, '.mp4');
      try {
        const r = await c.call<{ sequence: PremiereSequenceRef; from: number; to: number }>('exportRange', {
          expectProject: project.path, sequence: a.sequence, from: a.from, to: a.to, preset, path: staged,
        }, { timeoutMs: (a.timeoutSec ?? 900) * 1000 });
        const dest = a.out ? uniqueOutputPath(resolve(a.out)) : uniqueOutputPath(join(outDirFor(state, 'premiere-exports', r.sequence.name), `${r.from}-${r.to}.mp4`));
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(staged, dest, constants.COPYFILE_EXCL);
        return { ok: true, sequence: r.sequence, from: r.from, to: r.to, path: dest, bytes: (await stat(dest)).size, preset };
      } finally { await rm(staged, { force: true }); }
    },
  }),

  tool({
    name: 'ae_live_run',
    description: 'ทางสำรอง: รันสคริปต์ JSX ใน After Effects ที่ผู้ใช้เปิดอยู่ (ผ่าน Premiere/BridgeTalk) และเปิด .aep ที่ระบุให้ถ้ายังไม่ได้เปิด. ใช้เฉพาะเมื่อผู้ใช้สั่งให้ใช้ AE ที่เปิดอยู่ — ปกติใช้ ae_create/ae_edit แบบไม่มีหน้าต่าง · Run a JSX in the open After Effects (only when the user asked)',
    input: {
      jsxPath: z.string(), aep: z.string().optional().describe('project AE must have open (opened when it is not)'),
      userAsked: z.literal(true).describe('true only when the user asked to use the open After Effects'),
      timeoutSec: z.number().int().min(10).max(3600).optional().describe('default 120'),
    },
    handler: async (a, state) => {
      const st = await client(state).status();
      if (!st.connected) throw new ToolError('ae_live_run ส่งผ่าน Premiere: เปิด Premiere ก่อน (premiere_open) / needs the Premiere bridge');
      const t = a.timeoutSec ?? 120;
      return client(state).call('aeRun', { file: resolve(a.jsxPath), ...(a.aep ? { aep: resolve(a.aep) } : {}), timeoutSec: t }, { timeoutMs: (t + 30) * 1000 });
    },
  }),
];
