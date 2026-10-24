/**
 * AppState for the MCP server + CLI.
 *
 * The MCP layer codes against the agreed module signatures through the small
 * interfaces below. `createAppState()` loads and wires the real modules when called;
 * tests may inject in-memory fakes instead.
 */
import os from 'node:os';
import { getEnvironment } from '../core/tools.js';
import { freeRamBytes } from '../core/platform.js';
/** Environment that never throws: missing ffmpeg becomes a `problems` entry instead. */
export async function safeEnvironment() {
    try {
        return { env: await getEnvironment(), problems: [] };
    }
    catch (err) {
        const env = {
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
export async function createAppState(opts = {}) {
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
    const state = {
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
    if (opts.projectDir)
        state.project = await projectMod.loadProject(opts.projectDir);
    return state;
}
export function requireProject(state) {
    if (!state.project)
        throw new Error('ยังไม่ได้เปิดโปรเจกต์ — เรียก project_new หรือ project_open ก่อน / no project open: call project_new or project_open first');
    return state.project;
}
export function requireFfmpeg(state) {
    if (!state.env.tools.ffmpeg)
        throw new Error(`ffmpeg not available: ${state.problems.join('; ') || 'unknown reason'}`);
}
export function isAeComp(a) {
    return a.kind === 'aecomp';
}
/** aecomp assets whose render is missing or stale (fingerprint changed since the render). */
export function compsNeedingRender(p) {
    return Object.values(p.assets)
        .filter(isAeComp)
        .filter((a) => !a.render || (a.fingerprint !== undefined && a.render.fingerprint !== a.fingerprint))
        .map((a) => a.id);
}
//# sourceMappingURL=state.js.map