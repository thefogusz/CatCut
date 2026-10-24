/**
 * CatCut (EDITMCP) stdio server. `createServer()` is exported for tests (InMemoryTransport);
 * running this file directly (`tsx src/mcp/server.ts` / `node dist/mcp/server.js`) serves on stdio.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAppState, type AppState } from './state.js';
import { runTool, TOOLS } from './tools.js';

const SERVER_INFO = { name: 'catcut', version: '0.4.0' } as const;

const INSTRUCTIONS = [
  'CatCut 🐾: headless video editing (After Effects headless + aerender + ffmpeg). ทุกเวลาเป็นเฟรมที่ fps ของโปรเจกต์ (ไม่ใช่วินาที).',
  'Flow: doctor → project_new/project_open → asset_add → timeline_set (or timeline_edit / audio_add) → build (returns job id; call job_wait {id}) → deliver → export_premiere_xml.',
  'Premiere loop: export_premiere_xml → edit in Premiere → File > Export > Final Cut Pro XML → import_premiere_xml (dry run: show the summary to the user) → import_premiere_xml {apply: true} (backs up the timeline; undo with timeline_restore) → build.',
  'Premiere handoff without computer use (CatCut bridge installed once with `catcut premiere-bridge install`): premiere_status → premiere_push {project: <open .prproj>} → the editor works in Premiere → premiere_pull (dry run, show the summary) → premiere_pull {apply: true} → build. Never drive Premiere through screenshots or clicks.',
  'FilmCraft (ArtCraft) loop: same, with export_premiere_xml {target: "filmcraft"} (FilmCraft misreads the Premiere form around dissolves); its Final Cut Pro XML export comes back through import_premiere_xml.',
  'ae_* tools run as jobs: if the result has pending:true, call job_wait {id}. If a tool says the project was changed elsewhere, it has been reloaded: re-issue the edit.',
  'New AE comps: write a JSX build script and run ae_create (never launch AfterFX/aerender/ffmpeg yourself, never write into out/). Long jobs: job_wait {id}, never sleep-poll.',
  'EffectCraft (ArtCraft): ae_create with saveAs *.ecproj builds the comp in EffectCraft instead of After Effects; every ae_* tool and build accept .ecproj. Use match-name property paths and new TextDocument(...) so a script runs in both hosts.',
  'Review: review_open (returns the URL) → user selects shots/ranges and annotates → review_notes. Propose edits from submitted notes before applying them. Evidence for notes: rules_evidence {clipIds, offsets}.',
  'Reels / TikTok (talking head): jumpcut → punch_in → transcribe → captions_set + captions_plan (proofread, fix with captions_set {fixes}) → text_add (hook) → sfx_on_cuts → build → deliver vert. Timeline tools are dry runs until apply: true; captions/text burn into deliverables only.',
  'Builds are incremental: unchanged segments are never re-encoded; outputs are never overwritten (new version each build).',
].join('\n');

export async function createServer(state?: AppState): Promise<McpServer> {
  const st = state ?? (await createAppState());
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input }, (args) => runTool(t, args, st));
  }
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    onclose?.();
    for (const review of st.reviews?.values() ?? []) void review.close();
    st.reviews?.clear();
  };
  return server;
}

/** Serve on stdio. Logs go to stderr only (stdout is the protocol channel). */
export async function serveStdio(opts: { projectDir?: string } = {}): Promise<void> {
  const state = await createAppState();
  if (opts.projectDir) {
    // A bad path must not stop the server: the agent can project_open later.
    try {
      state.project = await state.api.project.loadProject(opts.projectDir);
    } catch (err) {
      state.problems.push(`project not opened: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const server = await createServer(state);
  await server.connect(new StdioServerTransport());
  const note = state.problems.length ? ` (problems: ${state.problems.join('; ')})` : '';
  process.stderr.write(`catcut ${SERVER_INFO.version} ready on stdio${note}\n`);
}

/** True when this module is the process entry point (works for both tsx and compiled dist). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const a = resolve(fileURLToPath(metaUrl));
    const b = resolve(entry);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

// In the single-file bundle import.meta.url is the bundle itself; only cli.ts is the entry there.
if (process.env['CATCUT_BUNDLED'] !== '1' && isMain(import.meta.url)) {
  serveStdio().catch((err: unknown) => {
    process.stderr.write(`catcut failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
