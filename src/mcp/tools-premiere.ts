/**
 * Premiere Pro without computer use: CatCut ⇄ the CatCut bridge extension inside Premiere.
 * premiere_open starts Premiere with the project when needed; every tool says whether the project
 * is saved and when Premiere may be closed (DESIGN.md §14).
 * push = export_premiere_xml + import into the open Premiere project (new bin + sequence, not saved);
 * pull = Premiere exports a sequence as FCP7 XML + import_premiere_xml (dry run unless apply);
 * import_media / set_speed work natively on the original files (no new media is written).
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  createPremiereClient, diagnosePremiere, openPremiere, premiereHost, stagePath,
  type PremiereClient, type PremiereHost, type PremiereProjectRef, type PremiereSequenceRef,
} from '../engine/premiere.js';
import { uniqueOutputPath } from '../engine/aerender.js';
import { card } from '../core/user-action.js';
import { requireProject, type AppState } from './state.js';
import { needsUser, RELAY, tool, ToolError, type ToolDef } from './tooldef.js';

export function client(state: AppState): PremiereClient {
  state.premiere ??= createPremiereClient({ host: host(state) });
  return state.premiere;
}

function host(state: AppState): PremiereHost {
  state.premiereHost ??= premiereHost();
  return state.premiereHost;
}

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** The open Premiere project must be the one the caller named (file name or full path). */
function assertProject(open: PremiereProjectRef | null | undefined, wanted: string): PremiereProjectRef {
  if (!open) throw new ToolError('Premiere ไม่ได้เปิดโปรเจกต์ไว้ / no project is open in Premiere: call premiere_open {project}');
  const w = wanted.trim();
  const hit = /[\\/]/.test(w) ? same(open.path, w) : [open.name, basename(open.path)].some((n) => n.toLowerCase() === w.toLowerCase() || n.toLowerCase() === `${w.toLowerCase()}.prproj`);
  if (!hit) throw new ToolError(`โปรเจกต์ที่เปิดใน Premiere ไม่ตรงกับที่ระบุ / Premiere has a different project open: call premiere_open with the full path`, { open, wanted: w });
  return open;
}

/**
 * A full .prproj path is opened when needed (Premiere started or the project opened); a bare name
 * must already be the active project.
 */
export async function ensureProject(state: AppState, wanted: string): Promise<{ project: PremiereProjectRef; launched: boolean }> {
  const c = client(state);
  if (/[\\/]/.test(wanted) && /\.prproj$/i.test(wanted.trim())) {
    const now = await c.status();
    if (now.connected && now.project && same(now.project.path, wanted.trim()) && !(now.busy && now.busy.seconds >= 45)) return { project: now.project, launched: false };
    const r = await openPremiere(c, host(state), { project: wanted.trim(), ...(state.env.tools.premiereExe ? { premiereExe: state.env.tools.premiereExe } : {}) });
    if (r.launched) state.premiereLaunched = { project: r.project.path, ...(r.pid !== undefined ? { pid: r.pid } : {}) };
    return { project: r.project, launched: r.launched };
  }
  const st = await c.status();
  if (!st.connected) {
    const d = await diagnosePremiere(c, host(state), state.env.tools.premiereExe ? { premiereExe: state.env.tools.premiereExe } : {});
    if (d.userAction) throw needsUser(d.note, d.userAction);
    throw new ToolError('Premiere ยังไม่เปิด: ส่ง path เต็มของไฟล์ .prproj แล้ว CatCut จะเปิดให้ / pass the full .prproj path and CatCut opens Premiere', { wanted });
  }
  return { project: assertProject(st.project, wanted), launched: false };
}

/** Told after every Premiere tool: is it saved, may Premiere be closed. */
export function closeHint(state: AppState, saved: boolean): string {
  const ours = !!state.premiereLaunched;
  if (!saved) return 'ยังไม่ได้ Save ใน Premiere: ถ้าจะปิด ให้ premiere_save ก่อน (หรือ premiere_close ซึ่ง Save ให้) / not saved yet';
  return ours
    ? 'Save แล้ว — ปิด Premiere ได้ หรือให้ CatCut ปิดให้ด้วย premiere_close / saved: Premiere may be closed'
    : 'Save แล้ว — ปิด Premiere ได้ถ้าไม่ได้ใช้ต่อ / saved: Premiere may be closed';
}

async function callCatCut(state: AppState, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { callTool, toolResultData } = await import('./tools.js'); // tools.ts aggregates this module
  const r = await callTool(state, name, args);
  const data = toolResultData(r);
  if (r.isError) throw new ToolError(String(data['error'] ?? `${name} failed`), data);
  return data;
}

const slug = (s: string): string => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'sequence';

// ---------- import_media helpers ----------

const MEDIA = new Set(['.mp4', '.mov', '.mxf', '.mts', '.m2ts', '.avi', '.mkv', '.r3d', '.braw', '.crm', '.wav', '.mp3', '.aif', '.aiff', '.m4a', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd']);
/** Camera card structure folders: not worth a bin of their own. */
const CARD_DIRS = /^(PRIVATE|M4ROOT|CLIP|SUB|THMBNL|AVCHD|BDMV|STREAM|XDROOT|Clip|DCIM|CONTENTS|VIDEO|\d{3}[A-Z_]+)$/i;
const isProxyName = (f: string): boolean => /_proxy$/i.test(basename(f, extname(f)));

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && MEDIA.has(extname(e.name).toLowerCase())) out.push(full);
  }
}

/** Bin for a file: the source folder's name, plus the first meaningful sub folder (camera structure skipped). */
function binFor(file: string, root: string | undefined): string {
  if (!root) return basename(dirname(file));
  const parts = relative(root, dirname(file)).split(sep).filter((p) => p && p !== '.' && !CARD_DIRS.test(p));
  return [basename(root), ...parts.slice(0, 1)].join('/');
}

export const PREMIERE_TOOLS: ToolDef[] = [
  tool({
    name: 'premiere_status',
    description: 'สถานะ Premiere ผ่าน CatCut bridge (ไม่ใช้ computer use): พร้อมไหม ถ้าไม่พร้อมบอกเหตุผลและสิ่งที่ผู้ใช้ต้องทำ (userAction) · Premiere bridge status with the reason and the user action when not ready',
    input: {},
    handler: async (_a, state) => {
      const c = client(state);
      const d = await diagnosePremiere(c, host(state), state.env.tools.premiereExe ? { premiereExe: state.env.tools.premiereExe } : {});
      const base = { ...d.status, ready: d.ready, running: d.running, versions: d.versions, note: d.note, ...(d.userAction ? { userAction: card(d.userAction), relay: RELAY } : {}) };
      if (!d.ready) return { ...base, ...(!d.running && !d.userAction ? { hint: 'Premiere ปิดอยู่ ไม่เป็นไร: premiere_open {project: "…\\งาน.prproj"} เปิดให้เอง' } : {}) };
      const live = await c.call<{ premiere: string; project: PremiereProjectRef | null; sequences: PremiereSequenceRef[] }>('status', {}, { timeoutMs: 30_000 });
      return { ...base, ...live };
    },
  }),

  tool({
    name: 'premiere_open',
    description: 'เปิด Premiere พร้อมโปรเจกต์ให้เอง (ถ้าปิดอยู่) หรือเปิดโปรเจกต์นี้ใน Premiere ที่เปิดอยู่ แล้วรอจน bridge พร้อม — ผู้ใช้ไม่ต้องเปิดค้างไว้เอง ไม่ปิดหรือ Save อะไร · Start Premiere with the project (or open it in the running Premiere) and wait for the bridge',
    input: {
      project: z.string().describe('full path of the .prproj'),
      waitSec: z.number().int().min(10).max(900).optional().describe('how long to wait for a freshly started Premiere (default 240)'),
    },
    handler: async (a, state) => {
      const r = await openPremiere(client(state), host(state), {
        project: a.project, ...(a.waitSec ? { waitMs: a.waitSec * 1000 } : {}), ...(state.env.tools.premiereExe ? { premiereExe: state.env.tools.premiereExe } : {}),
      });
      if (r.launched) state.premiereLaunched = { project: r.project.path, ...(r.pid !== undefined ? { pid: r.pid } : {}) };
      return {
        ok: true, ...r,
        hint: r.launched
          ? 'CatCut เปิด Premiere ให้แล้ว ย่อหน้าต่างได้ ทำงานอื่นได้ อย่าปิดจนกว่า CatCut จะบอกว่า Save แล้ว / Premiere started by CatCut'
          : 'โปรเจกต์พร้อมใน Premiere / project is active',
      };
    },
  }),

  tool({
    name: 'premiere_save',
    description: 'Save โปรเจกต์ Premiere ที่ระบุ (ต้องเป็นโปรเจกต์ที่เปิดอยู่) · Save the named open Premiere project',
    input: { project: z.string().describe('the open Premiere project: file name or full path') },
    handler: async (a, state) => {
      const { project } = await ensureProject(state, a.project);
      const r = await client(state).call<{ project: PremiereProjectRef; saved: boolean }>('save', { expectProject: project.path }, { timeoutMs: 180_000 });
      return { ok: true, ...r, closeHint: closeHint(state, true) };
    },
  }),

  tool({
    name: 'premiere_close',
    description: 'Save แล้วปิด Premiere ให้ (ค่าเริ่มต้นปิดเฉพาะเมื่อ CatCut เป็นคนเปิด Premiere เอง; ผู้ใช้สั่งปิดเองให้ใส่ force) · Save and quit Premiere (only when CatCut started it, unless force)',
    input: {
      project: z.string().describe('the open Premiere project: file name or full path'),
      save: z.boolean().optional().describe('save before quitting (default true)'),
      force: z.boolean().optional().describe('quit even though the user opened Premiere (only when the user asked)'),
    },
    handler: async (a, state) => {
      if (!state.premiereLaunched && a.force !== true) {
        throw new ToolError('CatCut ไม่ได้เปิด Premiere เอง จึงไม่ปิดให้ (ผู้ใช้อาจใช้อยู่) — ถ้าผู้ใช้สั่งให้ปิด ส่ง force: true / Premiere was not started by CatCut');
      }
      const { project } = await ensureProject(state, a.project);
      const r = await client(state).call<{ project: PremiereProjectRef; saved: boolean }>('quit', { expectProject: project.path, save: a.save !== false }, { timeoutMs: 180_000 });
      delete state.premiereLaunched;
      return { ok: true, ...r, closed: true, hint: r.saved ? 'Save แล้วและสั่งปิด Premiere แล้ว' : 'สั่งปิด Premiere โดยไม่ Save (Premiere อาจถามก่อนปิด)' };
    },
  }),

  tool({
    name: 'premiere_import_media',
    description: 'นำเข้าไฟล์ต้นฉบับ (ชื่อเดิม ไม่สร้างไฟล์ใหม่) เข้า bin ตามชื่อโฟลเดอร์/การ์ด แล้วแนบ proxy `<ชื่อเดิม>_Proxy.*` ให้ (ทำต่อจากเดิมได้ถ้าเคยค้าง) · Import original media into bins named after their card folders and attach `<name>_Proxy.*` proxies; resumable',
    input: {
      project: z.string().describe('full path of the .prproj (opened when needed) or the open project name'),
      sources: z.array(z.string()).min(1).describe('files or folders (folders are scanned; each folder becomes a bin, e.g. "CARD 1")'),
      proxyDir: z.string().optional().describe('folder holding the proxies (searched recursively for <name>_Proxy.<ext>)'),
      save: z.boolean().optional().describe('save the project when done (default true)'),
      batch: z.number().int().min(1).max(200).optional().describe('files per Premiere request (default 25: a stuck import is found sooner and the next call resumes)'),
    },
    handler: async (a, state) => {
      const files: Array<{ source: string; bin: string }> = [];
      for (const s of a.sources.map((x) => resolve(x))) {
        const st = await stat(s).catch(() => undefined);
        if (!st) throw new ToolError(`ไม่พบ ${s} / not found`);
        if (st.isDirectory()) { const found: string[] = []; await walk(s, found); for (const f of found.sort()) if (!isProxyName(f)) files.push({ source: f, bin: binFor(f, s) }); }
        else files.push({ source: s, bin: binFor(s, undefined) });
      }
      if (!files.length) throw new ToolError('ไม่พบไฟล์สื่อในที่ระบุ / no media files found');
      const proxies = new Map<string, string>();
      if (a.proxyDir) {
        const found: string[] = [];
        await walk(resolve(a.proxyDir), found);
        for (const f of found) if (isProxyName(f)) proxies.set(basename(f, extname(f)).replace(/_proxy$/i, '').toLowerCase(), f);
      }
      const items = files.map((f) => {
        const proxy = proxies.get(basename(f.source, extname(f.source)).toLowerCase());
        return { ...f, ...(proxy ? { proxy } : {}) };
      });
      const { project } = await ensureProject(state, a.project);
      const c = client(state);
      const size = a.batch ?? 25;
      const rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < items.length; i += size) {
        const r = await c.call<{ items: Array<Record<string, unknown>> }>('importMedia', { expectProject: project.path, items: items.slice(i, i + size), enableProxies: !!a.proxyDir }, { timeoutMs: 300_000 });
        rows.push(...r.items);
      }
      let saved = false;
      if (a.save !== false) { await c.call('save', { expectProject: project.path }, { timeoutMs: 180_000 }); saved = true; }
      const count = (k: string, v: unknown) => rows.filter((r) => r[k] === v).length;
      const errors = rows.filter((r) => r['error']);
      return {
        ok: errors.length === 0, project, files: items.length, imported: count('imported', true),
        proxies: { attached: count('proxy', 'attached'), already: count('proxy', 'already'), none: items.filter((x) => !('proxy' in x)).length, failed: count('proxy', 'failed') + count('proxy', 'different') },
        bins: [...new Set(items.map((x) => x.bin))], errors, saved, closeHint: closeHint(state, saved),
        ...(a.proxyDir && items.some((x) => !('proxy' in x)) ? { withoutProxy: items.filter((x) => !('proxy' in x)).map((x) => x.source).slice(0, 50) } : {}),
      };
    },
  }),

  tool({
    name: 'premiere_set_speed',
    description: 'ปรับ speed คลิปใน sequence แบบ native ของ Premiere (เช่น 60% + Optical Flow) โดยไม่ export ไฟล์ใหม่ ตำแหน่งและความยาวคลิปบนไทม์ไลน์คงเดิม · Native clip speed + interpolation in Premiere; the clip keeps its place and length',
    input: {
      project: z.string().describe('the open Premiere project: file name or full path'),
      sequence: z.string().optional().describe('sequence name or id (default: active)'),
      track: z.number().int().min(1).optional().describe('video track number (default 1 = V1)'),
      clips: z.array(z.object({
        at: z.union([z.number().int().min(0), z.string().regex(/^\d{1,2}:\d{2}:\d{2}[:;]\d{2}$/)]).describe('a frame (sequence fps) or timecode HH:MM:SS:FF inside the clip'),
        speed: z.number().positive().max(10000).describe('percent, e.g. 60'),
        interpolation: z.enum(['optical-flow', 'frame-blend', 'frame-sampling']).optional().describe('default optical-flow'),
      })).min(1),
      save: z.boolean().optional().describe('save when every clip applied (default true)'),
    },
    handler: async (a, state) => {
      const { project } = await ensureProject(state, a.project);
      const c = client(state);
      const r = await c.call<{ sequence: PremiereSequenceRef; clips: unknown[] }>('setSpeed', {
        expectProject: project.path, sequence: a.sequence, track: a.track ?? 1,
        clips: a.clips.map((x) => ({ at: x.at, speed: x.speed / 100, interpolation: x.interpolation ?? 'optical-flow' })),
      }, { timeoutMs: 180_000 });
      let saved = false;
      if (a.save !== false) { await c.call('save', { expectProject: project.path }, { timeoutMs: 180_000 }); saved = true; }
      return { ok: true, ...r, saved, closeHint: closeHint(state, saved) };
    },
  }),

  tool({
    name: 'premiere_push',
    description: 'ส่งไทม์ไลน์ CatCut เข้าโปรเจกต์ Premiere เป็น sequence ใหม่ใน bin "CatCut" แล้วเปิดให้ (ส่ง path เต็มของ .prproj แล้ว CatCut เปิด Premiere ให้เองถ้าปิดอยู่; ไม่ save เว้นแต่ save: true) · Hand the CatCut timeline to Premiere as a new sequence. '
      + '`project` must name the Premiere project so a cut never lands in the wrong job.',
    input: {
      project: z.string().describe('full path of the .prproj (opened when needed) or the open project name'),
      version: z.string().optional().describe('CatCut version to hand off (default: latest)'),
      sequenceName: z.string().optional(),
      bin: z.string().optional().describe('Premiere bin for the import (default "CatCut")'),
      open: z.boolean().optional().describe('open the new sequence in the timeline (default true)'),
      save: z.boolean().optional().describe('save the Premiere project after the import (default false)'),
    },
    writesProject: true,
    handler: async (a, state) => {
      requireProject(state);
      const { project: target } = await ensureProject(state, a.project);
      const c = client(state);
      const exported = await callCatCut(state, 'export_premiere_xml', { version: a.version, sequenceName: a.sequenceName });
      const xml = String(exported['path']);
      const staged = await stagePath(c, '.xml');
      await copyFile(xml, staged, constants.COPYFILE_EXCL);
      try {
        const res = await c.call<{ project: PremiereProjectRef; bin: string; sequences: PremiereSequenceRef[]; opened: PremiereSequenceRef | null }>(
          'importXml', { path: staged, bin: a.bin ?? 'CatCut', open: a.open !== false, expectProject: target.path }, { timeoutMs: 180_000 },
        );
        if (a.save === true) await c.call('save', { expectProject: target.path }, { timeoutMs: 180_000 });
        return {
          ok: true, xml, version: exported['version'], ...res,
          ...(exported['warnings'] ? { warnings: exported['warnings'] } : {}), ...(exported['unrendered'] ? { unrendered: exported['unrendered'] } : {}),
          saved: a.save === true, closeHint: closeHint(state, a.save === true),
          hint: 'ตัดต่อใน Premiere ได้เลย เสร็จแล้วใช้ premiere_pull เพื่อดึงกลับ / edit in Premiere, then premiere_pull',
        };
      } finally { await rm(staged, { force: true }); }
    },
  }),

  tool({
    name: 'premiere_pull',
    description: 'ดึง sequence จาก Premiere กลับเข้า CatCut: Premiere export FCP XML (ไม่แก้โปรเจกต์ Premiere) → import_premiere_xml; ค่าเริ่มต้นแค่สรุปความต่าง, apply: true เพื่อใช้ · Pull a Premiere sequence back into CatCut (dry run by default)',
    input: {
      sequence: z.string().optional().describe('sequence name or id (default: the active sequence)'),
      project: z.string().optional().describe('Premiere project (full .prproj path opens it when needed)'),
      apply: z.boolean().optional().describe('commit the imported timeline (default false = summary, diff and warnings only)'),
    },
    writesProject: true,
    mutating: true,
    handler: async (a, state) => {
      const p = requireProject(state);
      if (a.project) await ensureProject(state, a.project);
      const c = client(state);
      const staged = await stagePath(c, '.xml');
      try {
        const res = await c.call<{ project: PremiereProjectRef; sequence: PremiereSequenceRef; path: string }>('exportXml', { sequence: a.sequence, path: staged }, { timeoutMs: 180_000 });
        const dir = join(state.api.project.projectPaths(p).out, 'premiere');
        await mkdir(dir, { recursive: true });
        const xml = uniqueOutputPath(join(dir, `${slug(res.sequence.name)}.xml`));
        await copyFile(staged, xml, constants.COPYFILE_EXCL);
        const imported = await callCatCut(state, 'import_premiere_xml', { path: xml, apply: a.apply === true });
        return { ...imported, pulledFrom: { project: res.project, sequence: res.sequence }, xml };
      } finally { await rm(staged, { force: true }); }
    },
  }),
];

/** Exposed for tests: the bin a file lands in. */
export const _binFor = (file: string, root?: string): string => binFor(file, root);
