/**
 * ready_check (DESIGN.md §14): one card per app saying what is ready, what the person must do,
 * why, how often, and whether anything must stay open. Never starts an Adobe app: AE is checked
 * through its prefs file, Premiere through the bridge heartbeat, tasklist and the CSXS registry.
 */
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { parse } from 'node:path';
import type { UserAction } from '../core/types.js';
import { ACTIONS, card, userActionText } from '../core/user-action.js';
import { aeDiskCache, aeScriptingPref, type AeCacheInfo, type AeScriptingPref } from '../engine/housekeeping.js';
import { createPremiereClient, diagnosePremiere, premiereHost } from '../engine/premiere.js';
import type { AppState } from './state.js';
import { RELAY, tool, type ToolDef } from './tooldef.js';

export interface AppReadiness {
  app: UserAction['app'];
  /** ok: nothing to do · action: the person must do `userAction` · optional: not installed, only some tools need it */
  status: 'ok' | 'action' | 'optional';
  /** does the app have to be open while CatCut works */
  keepOpen: 'never' | 'catcut-opens-it' | 'while-working';
  note: string;
  userAction?: UserAction & { say: string };
}

export interface Readiness {
  ready: boolean;
  apps: AppReadiness[];
  /** Thai summary for the person */
  say: string;
}

export interface ReadinessDeps {
  aePref?: () => Promise<AeScriptingPref>;
  aeCache?: () => Promise<AeCacheInfo>;
  freeGb?: (path: string) => Promise<number | undefined>;
}

/** Below this the person must act (CatCut itself stops under 5 GB); up to WARN_DISK_GB it is only a note, work goes on. */
const LOW_DISK_GB = 8;
const WARN_DISK_GB = 20;
const AE_CACHE_WARN_GB = 10;

async function defaultFreeGb(path: string): Promise<number | undefined> {
  try { const s = await statfs(parse(path).root || path); return (Number(s.bavail) * Number(s.bsize)) / 2 ** 30; } catch { return undefined; }
}

export async function readiness(state: AppState, deps: ReadinessDeps = {}): Promise<Readiness> {
  const apps: AppReadiness[] = [];
  const act = (a: UserAction): UserAction & { say: string } => card(a);

  // ffmpeg: everything needs it
  if (state.env.tools.ffmpeg) apps.push({ app: 'ffmpeg', status: 'ok', keepOpen: 'never', note: 'พร้อม' });
  else apps.push({ app: 'ffmpeg', status: 'action', keepOpen: 'never', note: state.problems.join('; ') || 'not found', userAction: act(ACTIONS.ffmpegMissing({ detail: state.problems[0] })) });

  // After Effects: headless, never kept open
  if (!state.env.tools.afterfx) {
    apps.push({ app: 'after-effects', status: 'optional', keepOpen: 'never', note: 'ไม่พบ AE: ใช้ได้ทุกอย่างยกเว้นงานกราฟิก ae_*', userAction: act(ACTIONS.aeNotFound()) });
  } else {
    const pref = await (deps.aePref ?? (() => aeScriptingPref()))();
    if (!pref.prefsFile) apps.push({ app: 'after-effects', status: 'action', keepOpen: 'never', note: 'AE ยังไม่เคยเปิดในบัญชีนี้', userAction: act(ACTIONS.aeFirstRun({ detail: 'ยังไม่เคยเปิด AE' })) });
    else if (pref.allowed === false) apps.push({ app: 'after-effects', status: 'action', keepOpen: 'never', note: `Allow Scripts ปิดอยู่ (AE ${pref.aeVersion ?? '?'})`, userAction: act(ACTIONS.aeAllowScripts()) });
    else apps.push({ app: 'after-effects', status: 'ok', keepOpen: 'never', note: `พร้อม (AE ${pref.aeVersion ?? '?'}): CatCut เปิดแบบไม่มีหน้าต่างแล้วปิดเองทุกงาน ไม่ต้องเปิด AE` });
    // the disk cache grows quietly while AE renders: show it here, before it fills the drive
    const cache = await (deps.aeCache ?? (() => aeDiskCache()))();
    const ae = apps[apps.length - 1]!;
    if (cache.bytes !== undefined) {
      const gb = Math.round((cache.bytes / 2 ** 30) * 10) / 10;
      ae.note += ` · AE Disk Cache ${gb} GB${gb >= AE_CACHE_WARN_GB ? ' (ล้างได้ด้วย ae_purge_cache หรือ Edit > Purge > All Memory & Disk Cache)' : ''}`;
    }
  }

  // Premiere: CatCut opens it when a premiere_* tool needs it
  state.premiereHost ??= premiereHost();
  state.premiere ??= createPremiereClient({ host: state.premiereHost });
  const d = await diagnosePremiere(state.premiere, state.premiereHost, state.env.tools.premiereExe ? { premiereExe: state.env.tools.premiereExe } : {});
  if (d.userAction?.code === 'premiere-not-found') apps.push({ app: 'premiere', status: 'optional', keepOpen: 'never', note: 'ไม่พบ Premiere: ส่งงานเป็น XML ได้', userAction: act(d.userAction) });
  else if (d.userAction) apps.push({ app: 'premiere', status: 'action', keepOpen: d.userAction.keepOpen ? 'while-working' : 'catcut-opens-it', note: d.note, userAction: act(d.userAction) });
  else apps.push({ app: 'premiere', status: 'ok', keepOpen: 'catcut-opens-it', note: d.busy ? 'เชื่อมอยู่ กำลังทำงาน (มักเป็นการเรนเดอร์คอมป์ AE) ไม่มีหน้าต่างค้าง — รอได้ ไม่ต้องกดอะไร' : d.ready ? `เชื่อมอยู่: ${d.status.project?.name ?? 'ยังไม่มีโปรเจกต์'}` : 'ปิดอยู่ ไม่เป็นไร: CatCut เปิดให้พร้อมโปรเจกต์เมื่อต้องใช้ แล้วบอกเมื่อปิดได้' });

  // disk: the project drive and the temp drive
  const freeGb = deps.freeGb ?? defaultFreeGb;
  const paths = [...new Set([state.project?.dir, os.tmpdir()].filter((p): p is string => !!p).map((p) => parse(p).root.toUpperCase()))];
  for (const root of paths) {
    const gb = await freeGb(root);
    if (gb === undefined) continue;
    const r = Math.round(gb * 10) / 10;
    if (gb < LOW_DISK_GB) apps.push({ app: 'disk', status: 'action', keepOpen: 'never', note: `${root} เหลือ ${r} GB`, userAction: act(ACTIONS.diskLow({ drive: root, freeGb: r })) });
    else apps.push({ app: 'disk', status: 'ok', keepOpen: 'never', note: `${root} เหลือ ${r} GB${gb < WARN_DISK_GB ? ' (พอใช้ ทำงานต่อได้ — ล้างแคช AE เมื่อสะดวก ไม่ต้องหยุดรอ)' : ''}` });
  }

  const name: Record<UserAction['app'], string> = { ffmpeg: 'ffmpeg', 'after-effects': 'After Effects', premiere: 'Premiere Pro', disk: 'ดิสก์', catcut: 'CatCut' };
  const keep: Record<AppReadiness['keepOpen'], string> = { never: 'ไม่ต้องเปิด', 'catcut-opens-it': 'CatCut เปิดให้เองเมื่อใช้', 'while-working': 'เปิดไว้ระหว่าง CatCut ทำงาน' };
  const mark = { ok: '✓', action: '⚠', optional: '–' } as const;
  const lines = apps.map((a) => `${mark[a.status]} ${name[a.app]}: ${a.note}${a.app === 'disk' || a.app === 'ffmpeg' ? '' : ` · ${keep[a.keepOpen]}`}`);
  const todo = apps.filter((a) => a.status === 'action' && a.userAction);
  const say = [
    'ความพร้อมของเครื่อง',
    ...lines,
    ...(todo.length ? ['', 'ต้องทำ:', ...todo.map((a) => userActionText(a.userAction!))] : ['', 'พร้อมทั้งหมด ไม่ต้องเปิดโปรแกรมไหนค้างไว้']),
  ].join('\n');
  return { ready: todo.length === 0, apps, say };
}

export const READY_TOOLS: ToolDef[] = [
  tool({
    name: 'ready_check',
    description: 'ตรวจความพร้อมของเครื่องโดยไม่เปิดโปรแกรม Adobe: ffmpeg, After Effects, Premiere + bridge, ดิสก์ — แต่ละตัวบอกว่าพร้อมไหม ต้องเปิดค้างไหม และถ้าต้องทำอะไรบอกขั้นตอน/เหตุผล/ทำครั้งเดียวไหม/ปิดได้เมื่อไร (userAction) · Readiness without starting Adobe apps, with user action cards. Call first in a session and whenever an app seems "not connected".',
    input: {},
    handler: async (_a, state) => {
      const r = await readiness(state);
      return { ...r, relay: RELAY.replace('userAction.say', '`say`') };
    },
  }),
];
