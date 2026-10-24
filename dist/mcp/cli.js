#!/usr/bin/env node
/**
 * catcut CLI (alias: editmcp): doctor | serve [projectDir] | build <projectDir> [--force] [--force-assets id,id] [--skip-qc] [--skip-deliver]
 *              | deliver <projectDir> <version> <targets...> | xml-export <projectDir> [--version v001]
 *              | xml-import <projectDir> <xml> [--apply]
 */
import { parseArgs } from 'node:util';
import { isMain, serveStdio } from './server.js';
import { createAppState } from './state.js';
import { callTool, toolResultData } from './tools.js';
const USAGE = `CatCut 🐾 — headless video editing MCP (After Effects headless + aerender + ffmpeg)

  editmcp ready                                    เครื่องพร้อมไหม ต้องเปิดอะไรค้างไหม ต้องทำอะไร / what is ready, what you must do
  editmcp doctor                                   ตรวจเครื่องมือ / check tools, encoders, RAM, compat notes
  editmcp serve [projectDir]                       MCP stdio server (ใช้กับ Claude Code / Codex)
  editmcp build <projectDir> [--force] [--force-assets C_a,C_b] [--skip-qc] [--skip-deliver]
  editmcp deliver <projectDir> <version> <targets...>   e.g. v001 yt th_tv
  editmcp xml-export <projectDir> [--version v001] [--name SeqName]
  editmcp xml-import <projectDir> <file.xml> [--apply]   ค่าเริ่มต้นแค่สรุปความต่าง; --apply เพื่อใช้ (สำรองไทม์ไลน์ใน history/)
  editmcp review <projectDir> [--version v001]        เปิดหน้ารีวิวในเครื่อง (Ctrl+C เพื่อปิด server)
  editmcp premiere-bridge install|status|uninstall  bridge ใน Premiere สำหรับ premiere_push / premiere_pull (ติดตั้งครั้งเดียว แล้วรีสตาร์ต Premiere)

  EDITMCP_ALLOW_AE=1   doctor may launch After Effects to read its version (off by default)
  EDITMCP_PROTECTED_PATHS=D:/job1;E:/job2   folders EDITMCP must never write into
`;
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');
function pretty(v) {
    return JSON.stringify(v, null, 2);
}
/** Print the tool result; returns the data, or null on failure (already printed). */
function report(r) {
    const data = toolResultData(r);
    if (r.isError) {
        const ua = data['userAction'];
        if (ua?.say)
            err(`${ua.say}
`);
        err(pretty(data));
        return null;
    }
    return data;
}
/** Poll a job, printing new log lines to stderr, until it ends. */
async function tailJob(state, id) {
    let printed = 0;
    for (;;) {
        const j = state.jobs.get(id);
        if (!j) {
            err(`job ${id} vanished`);
            return null;
        }
        for (const line of j.log.slice(printed))
            err(`  ${line}`);
        printed = j.log.length;
        if (j.status === 'done')
            return j.result ?? {};
        if (j.status === 'failed' || j.status === 'cancelled') {
            err(`${j.name} ${j.status}: ${j.error ?? ''}`);
            return null;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
}
function printDoctor(d) {
    const tools = d['tools'];
    const enc = d['encoders'];
    const ram = d['ram'];
    out(`CatCut doctor ${d['ok'] ? 'OK' : 'PROBLEMS'}`);
    out('');
    out('tools');
    for (const k of ['ffmpeg', 'ffprobe', 'afterfx', 'aerender', 'aeVersionDir', 'premiereExe', 'mediaEncoderExe', 'filmcraftCli', 'effectcraftCli'])
        out(`  ${k.padEnd(16)} ${tools[k] ?? '-'}`);
    out(`  ffmpeg version   ${d['ffmpegVersion'] ?? '-'}`);
    out(`  AE version       ${d['aeVersion']}`);
    out(`  Premiere bridge  ${d['premiereBridge'] ?? '-'}`);
    out(`  captions         ${d['captions'] ?? '-'}`);
    out('');
    out(`encoders  ${Object.entries(enc).map(([k, v]) => `${v ? '+' : '-'}${k}`).join('  ')}`);
    out(`gpu       ${d['gpu']}`);
    out(`ram       ${ram.totalGb} GB total, ${ram.freeGb} GB free${ram.low ? '  (LOW — render one thing at a time)' : ''}`);
    out(`cpu       ${d['cpuThreads']} threads`);
    const problems = d['problems'];
    if (problems.length) {
        out('');
        out('problems');
        for (const p of problems)
            out(`  ! ${p}`);
    }
    out('');
    out('compat notes (docs/DESIGN.md)');
    for (const n of d['compat'])
        out(`  - ${n}`);
}
async function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            force: { type: 'boolean', default: false },
            'force-assets': { type: 'string' },
            apply: { type: 'boolean', default: false },
            'skip-qc': { type: 'boolean', default: false },
            'skip-deliver': { type: 'boolean', default: false },
            version: { type: 'string' },
            name: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    const [cmd, ...rest] = positionals;
    if (values.help) {
        out(USAGE);
        return 0;
    }
    if (!cmd) {
        out(USAGE);
        return 1;
    }
    const needDir = () => {
        const d = rest[0];
        if (!d) {
            err(USAGE);
            throw new Error(`${cmd}: projectDir required`);
        }
        return d;
    };
    switch (cmd) {
        case 'ready': {
            const state = await createAppState();
            const d = report(await callTool(state, 'ready_check'));
            if (!d)
                return 1;
            out(String(d['say']));
            return d['ready'] ? 0 : 2;
        }
        case 'doctor': {
            const state = await createAppState();
            const d = report(await callTool(state, 'doctor'));
            if (!d)
                return 1;
            printDoctor(d);
            return d['ok'] ? 0 : 2;
        }
        case 'serve':
            await serveStdio({ projectDir: rest[0] });
            return null; // keep running
        case 'review': {
            const state = await createAppState({ projectDir: needDir() });
            const started = report(await callTool(state, 'review_open', { version: values.version }));
            if (!started)
                return 1;
            const result = await tailJob(state, String(started['jobId']));
            if (!result)
                return 1;
            out(String(result['url']));
            err('Review server is running on this computer. Ctrl+C to close; notes stay on disk.');
            const close = () => { void Promise.all([...state.reviews?.values() ?? []].map(r => r.close())).then(() => { process.exitCode = 0; }); };
            process.once('SIGINT', close);
            process.once('SIGTERM', close);
            return null;
        }
        case 'build': {
            const state = await createAppState({ projectDir: needDir() });
            const started = report(await callTool(state, 'build', {
                force: values.force, skipQc: values['skip-qc'], skipDeliver: values['skip-deliver'],
                ...(values['force-assets'] ? { forceAssets: values['force-assets'].split(',').map((s) => s.trim()).filter(Boolean) } : {}),
            }));
            if (!started)
                return 1;
            const result = await tailJob(state, String(started['jobId']));
            if (!result)
                return 1;
            out(pretty(result));
            return 0;
        }
        case 'deliver': {
            const [, version, ...targets] = rest;
            const state = await createAppState({ projectDir: needDir() });
            const started = report(await callTool(state, 'deliver', { version, targets: targets.length ? targets : undefined }));
            if (!started)
                return 1;
            const result = await tailJob(state, String(started['jobId']));
            if (!result)
                return 1;
            out(pretty(result));
            return 0;
        }
        case 'xml-export': {
            const state = await createAppState({ projectDir: needDir() });
            const d = report(await callTool(state, 'export_premiere_xml', { version: values.version, sequenceName: values.name }));
            if (!d)
                return 1;
            out(String(d['path']));
            return 0;
        }
        case 'xml-import': {
            const dir = needDir();
            const xml = rest[1];
            if (!xml) {
                err(USAGE);
                return 1;
            }
            const state = await createAppState({ projectDir: dir });
            const d = report(await callTool(state, 'import_premiere_xml', { path: xml, apply: values.apply }));
            if (!d)
                return 1;
            for (const line of d['summary'] ?? [])
                out(line);
            for (const w of d['warnings'] ?? [])
                err(`  ! ${w}`);
            out(pretty({ applied: d['applied'], valid: d['valid'], errors: d['errors'], backup: d['backup'], unresolvedPaths: d['unresolvedPaths'] }));
            if (!values.apply)
                err('dry run: ไม่ได้แก้ไทม์ไลน์ — ใส่ --apply เพื่อใช้ / nothing applied, re-run with --apply');
            return d['valid'] === false ? 2 : 0;
        }
        case 'premiere-bridge': {
            const { createPremiereClient, installBridge, uninstallBridge } = await import('../engine/premiere.js');
            const sub = rest[0] ?? 'status';
            if (sub === 'install') {
                const r = await installBridge();
                out(`installed: ${r.installedTo}`);
                out(`PlayerDebugMode=1 (unsigned extensions allowed): ${r.debugModeKeys.join(', ')}`);
                if (r.backup)
                    out(`previous bridge kept at: ${r.backup}${r.keptUserActions ? ' (host.user.jsx carried over)' : ''} / เก็บ bridge เดิมไว้ที่นี่`);
                out('Premiere does not need to be open: CatCut starts it with the project when needed (premiere_open). If Premiere is open now, `catcut ready` says whether it needs one restart.');
                out('ติดตั้งแล้ว — ไม่ต้องเปิด Premiere เอง CatCut เปิดให้พร้อมโปรเจกต์เมื่อต้องใช้; ถ้าเปิดอยู่ตอนนี้ `catcut ready` จะบอกว่าต้องปิด–เปิดหนึ่งครั้งไหม');
                return 0;
            }
            if (sub === 'uninstall') {
                out(`removed: ${await uninstallBridge()}`);
                return 0;
            }
            if (sub === 'status') {
                const st = await createPremiereClient().status();
                out(pretty(st));
                return st.connected ? 0 : 2;
            }
            err(`premiere-bridge: unknown subcommand ${sub} (install | status | uninstall)`);
            return 1;
        }
        default:
            err(`unknown command: ${cmd}\n`);
            err(USAGE);
            return 1;
    }
}
if (isMain(import.meta.url)) {
    main().then((code) => { if (code !== null)
        process.exitCode = code; }, (e) => { err(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
//# sourceMappingURL=cli.js.map