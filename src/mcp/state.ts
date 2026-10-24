/**
 * AppState for the MCP server + CLI.
 *
 * The MCP layer codes against the agreed module signatures through the small
 * interfaces below. `createAppState()` loads and wires the real modules when called;
 * tests may inject in-memory fakes instead.
 */
import os from 'node:os';
import type { ReviewServer } from '../review/server.js';
import type { PremiereClient, PremiereHost } from '../engine/premiere.js';
import { getEnvironment } from '../core/tools.js';
import { freeRamBytes } from '../core/platform.js';
import type {
  AeBackend, AeCompAsset, Asset, BuildOptions, BuildResult, DeliveryTargetId, Environment, FileAsset, Frames,
  JobInfo, ProbeInfo, Progress, Project, Timeline, XmemlReadResult, XmemlWriteOptions,
} from '../core/types.js';

export interface ProjectApi {
  createProject(dir: string, meta: { name: string; fps?: number; width?: number; height?: number }): Promise<Project>;
  loadProject(dir: string): Promise<Project>;
  saveProject(p: Project): Promise<void>;
  projectPaths(p: Project): { cacheSegments: string; cacheRenders: string; cacheAudio: string; out: string; review: string; tmp: string };
  addFileAsset(p: Project, path: string, opts?: { id?: string; kind?: FileAsset['kind']; probe?: (path: string) => Promise<ProbeInfo> }): Promise<FileAsset>;
  addAeComp(p: Project, aep: string, comp: string, id?: string): AeCompAsset;
  setTimeline(p: Project, t: Timeline): void;
  validateTimeline(p: Project): string[];
  timelineFrames(p: Project): Frames;
  planHash(p: Project): string;
  nextVersionId(p: Project): string;
  clipStartFrames(p: Project): Map<string, Frames>;
}

export interface XmemlApi {
  writeXmeml(p: Project, opts: XmemlWriteOptions): string;
  /** `warnings` (dropped V2+ clips, gaps, speed changes, ambiguous audio roles...) when the reader provides them */
  readXmeml(xml: string, p?: Project): XmemlReadResult & { warnings?: string[] };
}

export interface AssemblerLike {
  build(p: Project, opts?: BuildOptions): Promise<BuildResult>;
  deliver(p: Project, versionId: string, targets: DeliveryTargetId[], opts?: { onProgress?: (p: Progress) => void; signal?: AbortSignal }): Promise<Record<string, string>>;
  reviewProxy(p: Project, versionId: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

export interface JobContext {
  log(line: string): void;
  progress(p: Progress): void;
  signal: AbortSignal;
}

export interface JobManagerLike {
  start(name: string, fn: (ctx: JobContext) => Promise<unknown>): JobInfo;
  get(id: string): JobInfo | undefined;
  list(): JobInfo[];
  cancel(id: string): boolean;
  wait(id: string): Promise<JobInfo>;
}

export interface AppState {
  reviews?: Map<string, ReviewServer>;
  /** Premiere handoff bridge client (created on first use; tests inject a fake) */
  premiere?: PremiereClient;
  /** process checks + launcher for Premiere (tests inject a fake) */
  premiereHost?: PremiereHost;
  /** set when CatCut started Premiere itself: only then premiere_close may quit it without force */
  premiereLaunched?: { project: string; pid?: number };
  project?: Project;
  env: Environment;
  ae: AeBackend;
  assembler: AssemblerLike;
  jobs: JobManagerLike;
  api: {
    project: ProjectApi;
    xmeml: XmemlApi;
    probe: (path: string) => Promise<ProbeInfo>;
  };
  /** environment problems found at startup (doctor reports them; tools that need ffmpeg refuse) */
  problems: string[];
}

/** Environment that never throws: missing ffmpeg becomes a `problems` entry instead. */
export async function safeEnvironment(): Promise<{ env: Environment; problems: string[] }> {
  try {
    return { env: await getEnvironment(), problems: [] };
  } catch (err) {
    const env: Environment = {
      tools: { ffmpeg: '', ffprobe: '' },
      encoders: { h264_nvenc: false, h264_qsv: false, hevc_nvenc: false, libx264: false, prores_ks: false, dnxhd: false, mpeg2video: false },
      totalRamGb: os.totalmem() / 2 ** 30,
      freeRamGb: freeRamBytes() / 2 ** 30,
      cpuThreads: os.cpus().length,
    };
    return { env, problems: [err instanceof Error ? err.message : String(err)] };
  }
}

/** Wire the real modules. AE is never launched here (the backend spawns per call). */
export async function createAppState(opts: { projectDir?: string } = {}): Promise<AppState> {
  const [{ env, problems }, projectMod, xmemlMod, ffmpegMod, qcMod, aeMod, jobsMod] = await Promise.all([
    safeEnvironment(),
    import('../core/project.js'),
    import('../io/xmeml.js'),
    import('../engine/ffmpeg.js'),
    import('../engine/qc.js'),
    import('../engine/ae.js'),
    import('../core/jobs.js'),
  ]);
  const { createEffectCraftBackend, createMotionBackend } = await import('../engine/effectcraft.js');
  // .ecproj comps go to EffectCraft, everything else to After Effects
  const ae = createMotionBackend(aeMod.createAeBackend(env.tools), createEffectCraftBackend(env.tools));
  const assembler = new ffmpegMod.Assembler({ tools: env.tools, env, ae, qc: qcMod.runQc });
  const state: AppState = {
    env,
    ae,
    assembler,
    jobs: new jobsMod.JobManager(),
    api: {
      project: projectMod,
      xmeml: xmemlMod,
      probe: (path) => ffmpegMod.probe(env.tools, path, { fps: state.project?.meta.fps ?? 25 }),
    },
    problems,
  };
  if (opts.projectDir) state.project = await projectMod.loadProject(opts.projectDir);
  return state;
}

export function requireProject(state: AppState): Project {
  if (!state.project) throw new Error('ยังไม่ได้เปิดโปรเจกต์ — เรียก project_new หรือ project_open ก่อน / no project open: call project_new or project_open first');
  return state.project;
}

export function requireFfmpeg(state: AppState): void {
  if (!state.env.tools.ffmpeg) throw new Error(`ffmpeg not available: ${state.problems.join('; ') || 'unknown reason'}`);
}

export function isAeComp(a: Asset): a is AeCompAsset {
  return a.kind === 'aecomp';
}

/** aecomp assets whose render is missing or stale (fingerprint changed since the render). */
export function compsNeedingRender(p: Project): string[] {
  return Object.values(p.assets)
    .filter(isAeComp)
    .filter((a) => !a.render || (a.fingerprint !== undefined && a.render.fingerprint !== a.fingerprint))
    .map((a) => a.id);
}
