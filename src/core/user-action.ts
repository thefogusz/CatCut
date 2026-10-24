/**
 * User Action Cards (DESIGN.md §14.2): one catalog of the things only the person can do, each with
 * steps, why, how often, and when the app may be closed. Engines throw `UserActionError`; the MCP
 * layer puts the card into the tool result; agents relay `say` as is.
 */
import type { UserAction } from './types.js';

export class UserActionError extends Error {
  constructor(message: string, public readonly userAction: UserAction) {
    super(message);
  }
}

const FREQ: Record<UserAction['frequency'], string> = {
  once: 'ทำครั้งเดียว (ครั้งต่อไปไม่ต้องทำอีก)',
  'after-update': 'ทำครั้งเดียวหลังอัปเดต',
  'each-time': 'ทำเมื่อเกิดขึ้นเท่านั้น',
};

const APP: Record<UserAction['app'], string> = {
  'after-effects': 'After Effects', premiere: 'Premiere Pro', ffmpeg: 'ffmpeg', disk: 'ดิสก์', catcut: 'CatCut',
};

/** Plain Thai text of a card, ready for the agent to show unchanged. */
export function userActionText(a: UserAction): string {
  return [
    `【${APP[a.app]}】 ${a.title}`,
    ...a.steps.map((s, i) => `${i + 1}. ${s}`),
    `ทำไม: ${a.why}`,
    `${FREQ[a.frequency]} · ${a.needsProject ? 'ต้องเปิดโปรเจกต์' : 'ไม่ต้องสร้างหรือเปิดโปรเจกต์'} · ${a.keepOpen ? 'ต้องเปิดโปรแกรมค้างไว้' : 'ไม่ต้องเปิดค้าง'}`,
    `ปิดได้เมื่อ: ${a.closeAfter}`,
  ].join('\n');
}

/** Card + its text, the shape tools return under `userAction`. */
export function card(a: UserAction): UserAction & { say: string } {
  return { ...a, say: userActionText(a) };
}

type Opts = Record<string, string | number | undefined>;

export const ACTIONS = {
  aeNotFound: (): UserAction => ({
    code: 'ae-not-found', app: 'after-effects', title: 'ไม่พบ After Effects ในเครื่อง',
    steps: ['ติดตั้ง After Effects จาก Creative Cloud', 'หรือถ้าติดตั้งไว้ที่อื่น ตั้งค่า EDITMCP_AE_DIR เป็นโฟลเดอร์ของ AE'],
    why: 'งานกราฟิกและข้อความ (ae_*) ใช้ After Effects ทำเบื้องหลัง',
    frequency: 'once', keepOpen: false, closeAfter: 'ไม่ต้องเปิด AE เลย', needsProject: false,
  }),
  aeFirstRun: (o: Opts = {}): UserAction => ({
    code: 'ae-first-run', app: 'after-effects', title: 'เปิด After Effects หนึ่งครั้งเพื่อ Sign in',
    steps: [
      'เปิด After Effects ตามปกติ',
      "ถ้ามีหน้า Sign in / License / What's New / Crash report ให้ผ่านจนเห็นหน้าจอหลัก",
      'ปิด After Effects (ไม่ต้องสร้างหรือ Save โปรเจกต์)',
      'บอก AI ว่า "เปิด AE แล้ว" แล้ว CatCut จะลองใหม่เอง',
    ],
    why: `CatCut สั่ง AE แบบไม่มีหน้าต่าง แต่ AE ปิดตัวก่อนรันงาน${o['detail'] ? ` (${o['detail']})` : ''} — มักเกิดเมื่อยังไม่ได้ Sign in หรือหลังอัปเดต AE แล้วมีหน้าต่างแรกค้าง`,
    frequency: 'after-update', keepOpen: false, closeAfter: 'ทันทีที่เห็นหน้าจอหลักของ AE', needsProject: false,
  }),
  aeAllowScripts: (): UserAction => ({
    code: 'ae-allow-scripts', app: 'after-effects', title: 'อนุญาตให้สคริปต์เขียนไฟล์ใน After Effects',
    steps: [
      'เปิด After Effects',
      process.platform === 'darwin' ? 'After Effects > Settings > Scripting & Expressions' : 'Edit > Preferences > Scripting & Expressions',
      'ติ๊ก "Allow Scripts to Write Files and Access Network" แล้วกด OK',
      'ปิด After Effects (ไม่ต้องสร้างหรือ Save โปรเจกต์)',
    ],
    why: 'CatCut ส่งผลงานจาก AE กลับมาเป็นไฟล์ ถ้าไม่ติ๊ก งาน AE ทุกงานจะล้มด้วย "cannot write"',
    frequency: 'once', keepOpen: false, closeAfter: 'ทันทีที่กด OK', needsProject: false,
  }),
  aeCloseMac: (): UserAction => ({
    code: 'ae-close-mac', app: 'after-effects', title: 'ปิด After Effects ก่อน',
    steps: ['Save งานใน After Effects ถ้ามี', 'ปิด After Effects (Cmd+Q)', 'บอก AI ว่า "ปิด AE แล้ว" แล้ว CatCut จะลองใหม่เอง'],
    why: 'บน Mac เปิด AE ได้ทีละตัว CatCut จึงต้องเปิด AE ของตัวเองแล้วปิดเมื่อเสร็จ ถ้าใช้ตัวที่คุณเปิดอยู่ งานของคุณอาจถูกปิดไปด้วย',
    frequency: 'each-time', keepOpen: false, closeAfter: 'CatCut ปิด AE ให้เองเมื่องานเสร็จ', needsProject: false,
  }),
  macAutomation: (): UserAction => ({
    code: 'mac-automation', app: 'after-effects', title: 'อนุญาตให้สั่งงาน After Effects (macOS)',
    steps: [
      'เปิด System Settings > Privacy & Security > Automation',
      'หาแอปที่รัน CatCut (Claude, Terminal หรือ Codex) แล้วเปิดสวิตช์ "Adobe After Effects"',
      'บอก AI ว่า "อนุญาตแล้ว" แล้ว CatCut จะลองใหม่เอง',
    ],
    why: 'บน Mac CatCut สั่ง AE ผ่าน AppleScript ซึ่ง macOS ต้องให้คุณอนุญาตก่อน',
    frequency: 'once', keepOpen: false, closeAfter: 'ไม่ต้องเปิด AE', needsProject: false,
  }),
  ffmpegMissing: (o: Opts = {}): UserAction => ({
    code: 'ffmpeg-missing', app: 'ffmpeg', title: 'ไม่พบ ffmpeg',
    steps: [
      process.platform === 'darwin' ? 'ติดตั้งด้วย Homebrew: `brew install ffmpeg` (หรือรัน install.sh ของ CatCut)' : 'ติดตั้งใหม่ด้วย install.cmd ของ CatCut (มี ffmpeg มาด้วย)',
      'หรือตั้ง EDITMCP_FFMPEG ให้ชี้ไปที่โฟลเดอร์ของ ffmpeg',
    ],
    why: `ทุกการตัดต่อ ประกอบไฟล์ และส่งออกใช้ ffmpeg${o['detail'] ? ` (${o['detail']})` : ''}`,
    frequency: 'once', keepOpen: false, closeAfter: '-', needsProject: false,
  }),
  premiereNotFound: (): UserAction => ({
    code: 'premiere-not-found', app: 'premiere', title: 'ไม่พบ Premiere Pro ในเครื่อง',
    steps: ['ติดตั้ง Premiere Pro จาก Creative Cloud (ถ้าจะใช้ Premiere)', 'ไม่ใช้ Premiere ก็ได้: CatCut ส่งงานเป็นไฟล์ XML ให้เปิดภายหลังได้'],
    why: 'คำสั่ง premiere_* ทำงานในโปรแกรม Premiere',
    frequency: 'once', keepOpen: false, closeAfter: '-', needsProject: false,
  }),
  bridgeNotInstalled: (): UserAction => ({
    code: 'bridge-not-installed', app: 'premiere', title: 'ติดตั้ง CatCut Bridge ใน Premiere',
    steps: [
      'Save งานใน Premiere แล้วปิด Premiere (ถ้าเปิดอยู่)',
      'ให้ AI รันคำสั่ง `catcut premiere-bridge install` (หรือพิมพ์เองใน Terminal)',
      'ไม่ต้องเปิด Premiere เอง: CatCut เปิดให้พร้อมโปรเจกต์เมื่อต้องใช้',
    ],
    why: 'Premiere ไม่มีโหมดสั่งงานเบื้องหลัง CatCut จึงต้องมีตัวรับคำสั่งเล็ก ๆ (bridge) อยู่ใน Premiere',
    frequency: 'once', keepOpen: false, closeAfter: 'ไม่ต้องเปิด Premiere ระหว่างติดตั้ง', needsProject: false,
  }),
  bridgeUpdate: (o: Opts = {}): UserAction => ({
    code: 'bridge-update', app: 'premiere', title: 'อัปเดต CatCut Bridge ใน Premiere',
    steps: [
      'ให้ AI รันคำสั่ง `catcut premiere-bridge install` (เปิด Premiere ค้างไว้ได้ ไม่ต้องปิด)',
      'ถ้าหลังจากนั้น CatCut ขอให้ปิด–เปิด Premiere ค่อยทำตอนนั้น (Save ก่อน)',
    ],
    why: `bridge ที่ติดตั้งในเครื่องเป็นรุ่น ${o['installed'] ?? '?'} แต่ CatCut รุ่นนี้ใช้รุ่น ${o['wanted'] ?? '?'}`,
    frequency: 'after-update', keepOpen: false, closeAfter: 'ไม่ต้องเปิดหรือปิด Premiere เพื่อการนี้', needsProject: false,
  }),
  bridgeOutdated: (o: Opts = {}): UserAction => ({
    code: 'bridge-outdated', app: 'premiere', title: 'ปิด–เปิด Premiere หนึ่งครั้งเพื่อโหลด bridge รุ่นใหม่',
    steps: ['Save งานใน Premiere', 'ปิด Premiere', 'บอก AI ว่า "ปิดแล้ว" — CatCut จะเปิด Premiere พร้อมโปรเจกต์ให้เอง'],
    why: `Premiere โหลด bridge รุ่น ${o['running'] ?? '?'} อยู่ แต่ CatCut ต้องการรุ่น ${o['wanted'] ?? '?'} (ส่วนนี้โหลดใหม่ระหว่างเปิดอยู่ไม่ได้)`,
    frequency: 'after-update', keepOpen: false, closeAfter: 'ปิดได้ทันทีหลัง Save', needsProject: false,
  }),
  bridgeNotStarted: (): UserAction => ({
    code: 'bridge-not-started', app: 'premiere', title: 'เปิด panel CatCut Bridge ใน Premiere',
    steps: ['ใน Premiere: Window > Extensions > CatCut Bridge', 'รอจน panel ขึ้น connected (ปิด panel ได้ แต่ห้ามปิด Premiere ระหว่าง CatCut ทำงาน)'],
    why: 'Premiere เปิดอยู่แต่ bridge ไม่เริ่มทำงานเอง (บาง Premiere ไม่ส่งสัญญาณเริ่มให้ extension ที่ซ่อนอยู่)',
    frequency: 'each-time', keepOpen: true, closeAfter: 'เมื่อ CatCut แจ้งว่า Save แล้ว', needsProject: false,
  }),
  premiereDialog: (o: Opts = {}): UserAction => ({
    code: 'premiere-dialog', app: 'premiere', title: 'Premiere มีหน้าต่างรอให้กดอยู่',
    steps: [
      'สลับไปที่ Premiere ดูหน้าต่างที่เด้งขึ้น (เช่น Import Files, Link Media, คำเตือน)',
      'ถ้าเป็นแถบโหลดที่ไม่ขยับเกิน 1 นาที กด Cancel; ถ้าเป็นคำถาม ตอบตามที่ต้องการ',
      'บอก AI ว่ากดอะไรไป — CatCut จะทำต่อจากจุดเดิม',
    ],
    why: `Premiere ค้างที่คำสั่ง ${o['action'] ?? '?'} มา ${o['seconds'] ?? '?'} วินาที ระหว่างมีหน้าต่างค้าง Premiere รับคำสั่งอื่นไม่ได้`,
    frequency: 'each-time', keepOpen: true, closeAfter: 'เมื่อ CatCut แจ้งว่า Save แล้ว', needsProject: false,
  }),
  premiereNeedsProject: (o: Opts = {}): UserAction => ({
    code: 'premiere-needs-project', app: 'premiere', title: 'บอก CatCut ว่าจะใช้โปรเจกต์ Premiere ไฟล์ไหน',
    steps: ['ส่ง path ของไฟล์ .prproj ให้ AI (เช่น C:\\งาน\\PROJECT\\งาน.prproj) — CatCut จะเปิดให้เอง'],
    why: `CatCut ไม่เดาโปรเจกต์เอง กันงานลงผิดโปรเจกต์${o['open'] ? ` (ตอนนี้ Premiere เปิด ${o['open']} อยู่)` : ''}`,
    frequency: 'each-time', keepOpen: false, closeAfter: '-', needsProject: false,
  }),
  premiereStartTimeout: (o: Opts = {}): UserAction => ({
    code: 'premiere-start-timeout', app: 'premiere', title: 'Premiere เปิดช้าหรือมีหน้าต่างค้างตอนเปิด',
    steps: [
      'สลับไปที่ Premiere ดูว่ามีหน้าต่างค้างไหม (Sign in, อัปเดต, Recover, Locate Media)',
      'ผ่านหน้าต่างนั้นให้ถึงหน้าโปรเจกต์',
      'ถ้า Premiere เปิดแล้วแต่ยังไม่ต่อ: Window > Extensions > CatCut Bridge',
      'บอก AI ว่าเสร็จแล้ว',
    ],
    why: `CatCut สั่งเปิด Premiere แล้วรอ ${o['seconds'] ?? '?'} วินาทียังไม่มีสัญญาณจาก bridge`,
    frequency: 'each-time', keepOpen: true, closeAfter: 'เมื่อ CatCut แจ้งว่า Save แล้ว', needsProject: false,
  }),
  diskLow: (o: Opts = {}): UserAction => ({
    code: 'disk-low', app: 'disk', title: `พื้นที่ไดรฟ์ ${o['drive'] ?? ''} เหลือน้อย`,
    steps: ['ให้ AI เรียก disk_report เพื่อดูว่าอะไรกินพื้นที่', 'ให้ AI ทำ cache_gc_plan แล้วอนุมัติการลบเฉพาะที่ตกลง', 'หรือย้ายไฟล์ที่ไม่ใช้ออกจากไดรฟ์นี้เอง'],
    why: `เหลือ ${o['freeGb'] ?? '?'} GB — render/build ต้องใช้พื้นที่ และ CatCut หยุดเองเมื่อเหลือน้อยกว่า 5 GB`,
    frequency: 'each-time', keepOpen: false, closeAfter: '-', needsProject: false,
  }),
};
