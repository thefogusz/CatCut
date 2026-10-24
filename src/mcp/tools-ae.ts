/**
 * AE analysis tools (DESIGN §13.2 rows 3, 5–8): template_scan, comp_lint, font_audit, ae_purge_cache.
 * All informational: the brief decides; thresholds come from the project's styleRules only.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isProtected } from '../core/project.js';
import type { TemplateComp } from '../core/types.js';
import { defaultAeCacheDir, freeDiskBytes, purgeIfLowCacheSpace, uniqueOutputPath } from '../engine/aerender.js';
import { auditFonts, compTargets, lintComps, listInstalledFonts, type CompLintTarget } from '../engine/comp-lint.js';
import type { FontUsage } from '../engine/ae.js';
import { requireProject, type AppState, type JobContext } from './state.js';
import { tool, ToolError, type ToolDef } from './tooldef.js';

const AE_WAIT_MS = 20_000;
const ADVISORY = 'ข้อมูลประกอบการตัดสินใจเท่านั้น บรีฟเป็นตัวตัดสิน / informational only: the brief decides';

/** Run as a job; wait up to 20 s for the result, else hand back the job id to poll with job_status. */
async function runAeJob(state: AppState, name: string, fn: (ctx: JobContext) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const job = state.jobs.start(name, fn);
  let timer: NodeJS.Timeout | undefined;
  const info = await Promise.race([
    state.jobs.wait(job.id),
    new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), AE_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (!info) {
    return {
      ok: true, jobId: job.id, status: state.jobs.get(job.id)?.status ?? job.status, pending: true,
      hint: 'After Effects กำลังทำงานหรือรอคิว — รอผลด้วย job_wait {id} / AE is busy or queued: call job_wait {id}',
    };
  }
  if (info.status === 'done') return { ...(info.result as Record<string, unknown>), jobId: job.id };
  throw new ToolError(info.error ?? `${name} ${info.status}`, { jobId: job.id, status: info.status });
}

function slug(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (out === s) return out;
  let h = 0; // non-ASCII (Thai) names: short stable hash keeps different names apart
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `${out || 'comp'}_${h.toString(16)}`;
}

/** Evenly spaced interior frames (avoids the usually empty first/last frame). */
function stripFrames(duration: number, n: number): number[] {
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.min(duration - 1, Math.floor(((i + 0.5) / n) * duration)));
  return [...out];
}

function requireAep(path: string): string {
  const aep = resolve(path);
  if (!existsSync(aep)) throw new ToolError(`ไม่พบไฟล์ .aep / project not found: ${aep}`);
  return aep;
}

export const AE_TOOLS: ToolDef[] = [
  tool({
    name: 'template_scan',
    description: 'สแกน template .aep: comp/ความยาว/ขนาด, placeholder (ขยับตามกรอบ vs อยู่หลัง matte นิ่ง), property ที่ถูก expression ล็อก, ฟอนต์, text animator (Based On); renderStrips = เฟรมตัวอย่างต่อ comp ลง review/templates/ (job, ข้อมูลประกอบเท่านั้น) · Scan an AE template (job, advisory)',
    input: {
      aep: z.string(),
      renderStrips: z.boolean().optional().describe('render a few preview frames per comp into <project>/review/templates/<slug>/'),
      comps: z.array(z.string()).optional().describe('comps to render strips for (default: comps with placeholders)'),
      framesPerComp: z.number().int().min(1).max(8).optional().describe('default 3'),
      maxComps: z.number().int().min(1).max(50).optional().describe('default 6; each frame is an aerender run'),
    },
    writesProject: true,
    handler: async (a, state) => {
      const aep = requireAep(a.aep);
      const ae = state.ae;
      if (!ae.scanTemplate) throw new ToolError('backend นี้สแกน template ไม่ได้ / this AE backend cannot scan templates');
      let outDir: string | undefined;
      if (a.renderStrips) {
        outDir = join(requireProject(state).dir, 'review', 'templates', slug(basename(aep, extname(aep))));
        if (isProtected(outDir)) throw new ToolError('ห้ามเขียนในโฟลเดอร์ที่ป้องกันไว้ / refusing to write inside a protected path', { path: outDir });
      }
      return runAeJob(state, 'template_scan', async (ctx) => {
        const scan = await ae.scanTemplate!(aep);
        if (!outDir) return { ...scan, advisory: ADVISORY };
        const wanted = a.comps ?? scan.comps.filter((c) => c.placeholders.length).map((c) => c.name);
        const chosen: TemplateComp[] = [];
        for (const name of wanted) {
          const c = scan.comps.find((x) => x.name === name);
          if (!c) throw new Error(`comp not found in template: ${name}`);
          if (c.durationFrames > 0) chosen.push(c);
        }
        const max = a.maxComps ?? 6;
        const skipped = chosen.slice(max).map((c) => c.name);
        const strips: Array<{ comp: string; frames: number[]; paths: string[]; error?: string }> = [];
        await mkdir(outDir, { recursive: true });
        const todo = chosen.slice(0, max);
        for (const [i, c] of todo.entries()) {
          ctx.signal.throwIfAborted();
          ctx.progress({ stage: 'template_strips', done: i, total: todo.length, message: c.name });
          const frames = stripFrames(c.durationFrames, a.framesPerComp ?? 3);
          const paths: string[] = [];
          try {
            for (const f of frames) {
              const target = uniqueOutputPath(join(outDir, `${slug(c.name)}_f${String(f).padStart(5, '0')}.png`));
              paths.push(await ae.previewFrame(aep, c.name, f, target));
            }
            strips.push({ comp: c.name, frames, paths });
          } catch (e) {
            ctx.log(`strip ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
            strips.push({ comp: c.name, frames, paths, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return { ...scan, strips, stripsDir: outDir, ...(skipped.length ? { skippedStrips: skipped } : {}), advisory: ADVISORY };
      });
    },
  }),

  tool({
    name: 'comp_lint',
    description: 'ตรวจ comp: แอนิเมชันหยุดก่อนจบ, layer/พื้นหลังหมดก่อน comp จบ, animator ไทยรายคำ/รายตัว, (ถ้าโปรเจกต์ตั้ง styleRules) ขนาดไทย/safe margin/ความมน → QcIssue ผูกกับ clip (job, advisory) · Lint AE comps used on the timeline (job)',
    input: {
      assetIds: z.array(z.string()).optional().describe('aecomp asset ids (default: every comp on the timeline)'),
      aep: z.string().optional(),
      comp: z.string().optional().describe('with aep: lint one comp directly'),
    },
    handler: async (a, state) => {
      if (!state.ae.lintComp) throw new ToolError('backend นี้ lint comp ไม่ได้ / this AE backend cannot lint comps');
      let targets: CompLintTarget[];
      if (a.aep !== undefined || a.comp !== undefined) {
        if (a.aep === undefined || a.comp === undefined) throw new ToolError('ต้องระบุทั้ง aep และ comp / give both aep and comp');
        targets = [{ aep: requireAep(a.aep), comp: a.comp }];
      } else {
        try { targets = compTargets(requireProject(state), a.assetIds); } catch (e) { throw new ToolError(e instanceof Error ? e.message : String(e)); }
        if (!targets.length) throw new ToolError('ไม่มี AE comp บนไทม์ไลน์ / no AE comps on the timeline; pass assetIds or aep+comp');
      }
      const project = state.project;
      return runAeJob(state, 'comp_lint', async (ctx) => {
        const report = await lintComps(state.ae, targets, project, { onProgress: (p) => ctx.progress(p), signal: ctx.signal });
        return { ...report, ok: report.failed.length === 0 };
      });
    },
  }),

  tool({
    name: 'font_audit',
    description: 'เทียบฟอนต์ที่ .aep ใช้กับฟอนต์ที่ติดตั้งใน Windows (registry HKLM/HKCU + โฟลเดอร์ Fonts) → ฟอนต์ที่ขาด (job) · Fonts used by an .aep vs installed fonts (job)',
    input: { aep: z.string() },
    handler: async (a, state) => {
      const aep = requireAep(a.aep);
      const ae = state.ae as AppState['ae'] & { listFontsDetailed?: (aep: string) => Promise<FontUsage> };
      if (!ae.listFontsDetailed && !ae.listFonts && !ae.scanTemplate) throw new ToolError('backend นี้อ่านฟอนต์ไม่ได้ / this AE backend cannot list fonts');
      return runAeJob(state, 'font_audit', async () => {
        let used: FontUsage;
        if (ae.listFontsDetailed) used = await ae.listFontsDetailed(aep);
        else if (ae.listFonts) used = { fonts: await ae.listFonts(aep), families: [], aeMissing: null };
        else used = { fonts: [...new Set((await ae.scanTemplate!(aep)).comps.flatMap((c) => c.fonts))], families: [], aeMissing: null };
        const audit = auditFonts(used, await listInstalledFonts());
        return { ...audit, ok: audit.missing.length === 0 };
      });
    },
  }),

  tool({
    name: 'ae_purge_cache',
    description: 'ล้าง cache ของ After Effects (app.purge ALL_CACHES ในอินสแตนซ์ headless); ifBelowGb = ล้างเฉพาะเมื่อไดรฟ์ cache เหลือน้อยกว่านี้ (job) · Purge AE caches (job)',
    input: {
      ifBelowGb: z.number().positive().optional().describe('only purge when the AE cache drive has less free space than this'),
      cacheDir: z.string().optional().describe('folder on the AE disk-cache drive (default EDITMCP_AE_CACHE_DIR, else %LOCALAPPDATA% / ~/Library/Caches)'),
    },
    handler: async (a, state) => {
      if (!state.ae.purgeCaches) throw new ToolError('backend นี้ล้าง cache ไม่ได้ / this AE backend cannot purge caches');
      const cacheDir = a.cacheDir ? resolve(a.cacheDir) : defaultAeCacheDir();
      return runAeJob(state, 'ae_purge_cache', async () => {
        const outcome = await purgeIfLowCacheSpace(state.ae, { cacheDir, belowGb: a.ifBelowGb ?? Infinity });
        let freeGb: number | undefined;
        try { freeGb = (await freeDiskBytes(cacheDir)) / 2 ** 30; } catch { /* unknown */ }
        return { ok: outcome.purged || a.ifBelowGb !== undefined, ...outcome, cacheDir, ...(freeGb !== undefined ? { freeGb: Math.round(freeGb * 10) / 10 } : {}) };
      });
    },
  }),
];
