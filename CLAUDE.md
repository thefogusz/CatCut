# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# CatCut (EDITMCP) — project conventions

Headless video-editing MCP: After Effects (no UI) + aerender + ffmpeg assembly, FCP7 XML for Premiere, plus a Premiere CEP bridge and an EffectCraft (ArtCraft) motion backend.
Design doc: `docs/DESIGN.md` (read the section you work on); verified state and known limits: `docs/STATUS.md`. TypeScript, ESM, Node ≥ 22, Windows-first, macOS supported.
Renamed from EDITMCP: env vars keep the `EDITMCP_*` prefix and the CLI answers to both `catcut` and `editmcp`.

## Hard rules
- **Frames, never seconds**, in all models and math. Project fps lives in `project.meta.fps` (default 25).
- **Never overwrite** an existing output. Renders, masters, deliverables get a new versioned path. Overwriting is a bug.
- **Never run After Effects / aerender from tests or module code during this build** unless explicitly told; another session may be using AE. AE code must be unit-tested with mocked process spawns. ffmpeg/ffprobe may be run freely on small synthetic media (`testsrc`, `sine`) written under `tmp/` or the OS temp dir.
- **Never touch** `D:\261009_STB50Y_THAI-WORLD_CSR` (a live production job).
- **Thai / non-ASCII paths**: AE render outputs go to an ASCII temp path, then are renamed. ffmpeg gets paths only as `-i` arguments or via UTF-8 list/graph files, never inside filter strings. Everything written to disk is UTF-8.
- **ProRes master is stitched, not re-encoded**: segments are ProRes 422 HQ MOV (video-only, all-intra); the master video is `concat -c copy` of segments. Any re-encode of an unchanged segment is a bug.
- Audio is rendered whole each build (cheap), then muxed.
- Dissolve of N frames at cut C: a = floor(N/2) before, b = N − a after; covers [C−a, C+b); total length unchanged.
- Processes: always spawn with timeouts and kill the whole tree on timeout. Never `shell: true` with user paths.
- Memory-aware: check free RAM (`freeRamBytes()`, not `os.freemem()`, which is near zero on macOS) before launching aerender/AE; default one AE render at a time.
- **Cross-platform**: OS-specific paths and process handling live in `src/core/platform.ts` (Program Files / %LOCALAPPDATA% vs /Applications / ~/Library, `exe()`, `ps`-based process trees). Windows-style paths (`D:\\job`) are compared the Windows way on every OS and never resolved against cwd. On macOS, `afterfx`/`premiereExe` are `.app` bundles: AE scripts run via `osascript` DoScriptFile (no `-noui`; refuses while the person's AE is open), Premiere starts via `open -a`.

## Commands
```bash
npm test                                   # vitest, test/**/*.test.ts; files run one at a time, 120 s timeout
npx vitest run test/engine/qc.test.ts      # one file
npx vitest run -t "<test name>"            # one test by name
npm run typecheck
npm run build                              # tsc → dist/, then scripts/bundle.mjs → dist/bundle/catcut.mjs
npm run dev                                # MCP server on stdio via tsx
npm run doctor                             # ffmpeg / NVENC / AE / RAM check via tsx (does not launch AE)
node tests/stdio_smoke.mjs                 # after build: compiled CLI over real MCP stdio, no Adobe
```
- `test/` is the vitest suite (synthetic media only). `tests/` holds standalone scripts that need a build first.
- `test/setup-home.ts` points `HOME` at a temp folder on macOS/Linux so tests never write into the real `~/Library`; tests that need per-user folders set `HOME` / `LOCALAPPDATA` themselves. Fixtures with Windows paths use `path.win32` helpers so they pass on every OS.
- Opt-in, launches real Adobe — ask the user first: `EDITMCP_TEST_ADOBE=1 node tests/adobe_smoke.mjs` (evidence under `tmp/adobe-test/`). `test/engine/effectcraft.real.test.ts` runs only with `CATCUT_EFFECTCRAFT_IT=1`.
- `node tests/review_demo.mjs` (after build) opens the review UI on a synthetic project under `tmp/review-demo/`.

## Release / dist
- `dist/` is committed: the plugin and the installers (`install.ps1` Windows, `install.sh` macOS) run `dist/bundle/catcut.mjs` directly. After changing `src/`, `jsx/` or `web/`, run `npm run build` and commit `dist/` too, or users do not get the change.
- The version lives in three places that must match: `package.json`, `.claude-plugin/plugin.json`, `SERVER_INFO` in `src/mcp/server.ts`. The Premiere bridge (`premiere/catcut-bridge/package.json`) is versioned separately.

## Layout
```
src/core      types.ts (the contract everyone codes against), project.ts (load/save, lock, protected paths), platform.ts (OS paths/processes), timecode.ts, tools.ts, hash.ts, jobs.ts, rules.ts, user-action.ts
src/engine    ffmpeg.ts (probe/segments/concat/audio/mux), presets.ts (delivery targets), qc.ts, ae.ts (AeBackend), aerender.ts,
              premiere.ts (bridge client), effectcraft.ts, proxy.ts, joins.ts, shots.ts, *-lint.ts, scan.ts, housekeeping.ts,
              transcribe.ts (whisper.cpp → timed words, cached), captions.ts (words → timeline → ASS), jumpcut.ts (silencedetect → clip pieces)
src/io        xmeml.ts (FCP7 XML write + read, Premiere and FilmCraft flavors), board.ts (storyboard/brief, incl. PDF)
src/review    local review server (127.0.0.1 only), sessions/notes, A/B compare; UI in web/review/
src/mcp       server.ts (MCP stdio + INSTRUCTIONS text), cli.ts (ready/doctor/serve/review/build/deliver/xml-export/xml-import/premiere-bridge),
              state.ts, tooldef.ts, tools.ts (core tools), tools-*.ts (feature tools; tools-reels.ts = jumpcut/punch_in/captions/text/sfx)
jsx/          runner.jsx (AfterFX -m -noui) and ec-runner.jsx (EffectCraft)
premiere/catcut-bridge/   CEP extension (host.jsx, bridge-core.js) installed by `catcut premiere-bridge install`
test/         vitest; synthetic media only
.claude-plugin/, commands/, agents/editor.md, skills/catcut-editor/SKILL.md   the Claude Code plugin (/catcut:* commands, @agent-catcut:editor); the skill is also copied for Codex
```
- Tool paths come from `src/core/tools.ts` (`discoverTools()`), never hardcoded elsewhere.
- Keep modules independent: import from `../core/types.js` and `../core/*`, not from sibling engines, unless the contract says so.
- Lint-level cleanliness: no unused exports, no `any` leaks in public signatures.
- Comments: brief, only where the why is non-obvious. Thai is fine in user-facing strings.

## MCP tools
- New tools: define them with `tool()` from `src/mcp/tooldef.ts` in a `tools-*.ts` module that exports a `ToolDef[]`, and add that array to `EXTRA_TOOLS` in `tools-extra.ts` (`TOOLS` = core tools in `tools.ts` + `EXTRA_TOOLS`).
- Set `mutating: true` if the tool changes the project (refused while a build/deliver/review job runs) and `writesProject: true` if it writes into the project folder (refused under protected paths). Core tools in `tools.ts` use the `MUTATING` / `WRITES_PROJECT` name sets instead.
- When the person must act (sign in, click a dialog, install the bridge), throw `needsUser()` so the agent gets the standard user-action card (DESIGN.md §14).
- If you change the intended agent flow, update the `INSTRUCTIONS` text in `server.ts` and the matching `commands/*.md` / `skills/catcut-editor/SKILL.md`.
- Heavy work (`build`, `deliver`, `ae_*`, `transcribe`) runs as jobs (`src/core/jobs.ts`): tools return a job id and agents wait with `job_wait`.

## Cross-cutting behavior
- `project.json` is the single source of truth. Saves are atomic and happen under `project.lock`; a save re-reads the file and merges non-conflicting changes from other processes (MCP server + CLI may share a project). A real conflict raises `ProjectConflictError` and reloads.
- Protected paths: built-in live production folders + `EDITMCP_PROTECTED_PATHS` (`;`-separated), enforced by `isProtected()` in `core/project.ts` and `assertWritable()` in `mcp/tools.ts`.
- `ae_edit` edits a temp copy, then saves back with a `<name>_backup_<timestamp>.aep` beside the source; `saveAs` refuses existing names.
- Timeline edits from Premiere XML are dry-run by default; `apply` first backs the timeline up under `history/` (undo: `timeline_restore`). The Reels tools (`jumpcut`, `punch_in`, `sfx_on_cuts`) follow the same rule.
- Captions (`project.captions`) are burned into deliverables in `Assembler.deliver` via an ASS file + libass `subtitles` filter (ASCII temp path; never into the master or broadcast targets by default). Word times come from cached transcripts (`cache/transcripts/<key>.json`, key = file hash + model + lang + `TIMING_VERSION`); bump `TIMING_VERSION` in `transcribe.ts` when timing logic changes. Tests never run whisper: they write the cache file (see `test/mcp/reels.test.ts`).
