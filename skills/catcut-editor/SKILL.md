---
name: catcut-editor
description: Edit video with the CatCut MCP (headless After Effects + ffmpeg, FCP7 XML for Premiere). Use when cutting, revising or delivering a CatCut project: brief/board first, project rules re-read before every edit, edit → build → review → fix loop, evidence frames before claiming a fix, incremental builds, ask before paid services.
---

# CatCut editor

CatCut builds video headlessly: AE comps render with aerender, ffmpeg stitches cached ProRes segments into a master, and Premiere gets FCP7 XML. All times are **frames** at the project fps. Nothing is ever overwritten: each build is a new version (`v001`, `v002`, ...).

## Setup: the user never guesses what to open
- Start every session with `ready_check` and show its `say` text unchanged. It lists each app, whether it must stay open, and the steps the user must take.
- **After Effects never stays open.** CatCut runs it without a window and closes it after every job. When AE needs the user, a tool returns a `userAction` card, for example a one-time Sign in or ticking "Allow Scripts to Write Files". Show `userAction.say` **exactly as written**, then stop and wait. Never ask the user to "keep AE open", "open an empty project", or run scripts inside the AE GUI.
- **Premiere is opened by CatCut.** Call `premiere_open {project: "<full path>.prproj"}`. It starts Premiere with that project, or opens the project in the running Premiere, and waits for the bridge. Do not ask the user to open Premiere or the CatCut Bridge panel unless a `userAction` card says so.
- Any tool error that carries `userAction`: show `userAction.say` as is and wait. Do not invent steps, restarts or workarounds. Do not switch to computer use.
- After Premiere work, relay `closeHint`: say whether the project is saved and that Premiere may be closed. Close it with `premiere_close` only if CatCut opened it, or if the user asks (`force: true`).
- Never take over the screen (computer use) to do what a CatCut tool does. If a CatCut tool is missing for the job, say so and ask; do not script Premiere or AE yourself.

## Editing the editor's Premiere sequence in place
- Client notes on a sequence the editor works in ("cut this shot 1 s", "swap the footage", "regrade this shot", "remove the frame") go through `premiere_edit` in **that** sequence. Never push a new sequence (`premiere_push`) for a revision.
- Always read first with `premiere_timeline_get`, and use `premiere_clip_effects` for colour or effect values. Each op names its clip exactly as it is now: `{track, start, end, name}`.
- Run without `apply` first and show the user the plan. Fix any `problems`, because a clip the editor moved is refused on purpose. Then run `apply: true`. Add `save: true` only when the user wants it saved.
- If the result has `failed` or `untouchedChanged`, say so plainly and offer `premiere_undo_last`. The checkpoint was saved right before the edit.
- AE graphics in the sequence: `premiere_place_ae_comp`. It does a dry run first and drops the comp's empty audio.
- Check results with frames Premiere renders (`premiere_frames`) or a short `premiere_export_range`, not by guessing.
- Per-job helpers belong in `host.user.jsx` next to the installed bridge, never in `host.jsx`. An update keeps `host.user.jsx` and replaces `host.jsx`.
- `ae_live_run` (a script in the AE the user has open) only when the user asks for it. Otherwise AE stays headless.

## Files and disk: nothing the user cannot trace
- **Use the original files under their original names.** Never copy, rename or re-export footage to use it (no `b46_1.mov`). Bins are named after card folders (`premiere_import_media` does this). Board shot numbers go in CatCut's `slot`, not in file names.
- **Never export a clip to fake an edit.** Speed and slow motion: `premiere_set_speed` (native, e.g. 60% + Optical Flow) in Premiere, or `Clip.speed` with `interpolation: 'motion'` in CatCut. Colour and motion stay editable layers. If the user says "revert what you exported", put the originals back and remove the pasted files from the sequence.
- Proxies: `proxy_make` makes `<original name>_Proxy.mp4`. Then `premiere_import_media {project, sources, proxyDir}` imports the originals and attaches the proxies. Do not make proxies with your own ffmpeg commands.
- Before any job that writes many files, check `disk_report`. After the job, say how much it added. Evidence frames and previews are small; renders and proxies are not. Report the project size when `disk_report` warns about the budget.
- Never delete files without the user's OK. Use `cache_gc_plan`, show the plan, and wait for approval.

## The highest rule: the brief decides
- Priority: **brief / board → the user's instructions in this project → general defaults**.
- No style rule applies to every project. Template use, Thai typography, join lengths and similar choices depend on each brief. Advisory tools (template scan, Thai lint, join policy) are information, not law.
- Rules only come from the brief or from the user's explicit words. Record each one with its source and a short quote (`rules_add_constraint`, `rules_set_style`).
- If a rule or request conflicts with the brief, **stop and ask the user**. Pass `overrideBrief` / `userConfirmed` only after they answer.

## Stay inside CatCut
- Every render, encode and version goes through CatCut tools. Do not launch `AfterFX.com` / `aerender` / `ffmpeg` yourself and do not write into the project's `out/` (it belongs to `build`/`deliver`; a stray `out/v001` shifts version numbers). Your own scripts and helper files go in `ae/` or `review/`.
- **New effect / motion graphic from scratch:** write a JSX build script, then `ae_create {jsxPath, saveAs, asset: {comp, id}}`. The script runs in AE's empty startup project: create comps and layers only; never call `app.newProject()` (it kills headless AE), save or quit. `L("msg")` logs, errors come back with the line. For a revision, save the script change, run `ae_create` again with a **new** `saveAs` and the **same** asset id: the asset is repointed and the next `build` re-renders it.
  - **EffectCraft (ArtCraft) instead of AE:** same call with `saveAs: "….ecproj"` (doctor shows `effectcraft: found`). Write property paths with match names (`property("ADBE Transform Group").property("ADBE Position")`) and style text with `new TextDocument(...)`: EffectCraft ignores display names like `property("Position")`, and the same script then also runs in AE. `ae_edit`, `ae_preview_frame`, `ae_inspect_comp` and `build` work on `.ecproj` too; `template_scan`, `comp_lint`, `font_audit` and `applyPreset` stay AE-only.
- Check looks with `ae_preview_frame` (one frame), not full renders.
- Long jobs (`build`, `deliver`, AE jobs that return `pending`): call `job_wait {id}`. Never poll with sleep, `tasklist` or file watching.
- A quick H.264 file to show the user: `preview_range {from, to}` or `deliver`. Do not encode MP4s by hand.
- If a tool fails, report the exact error to the user and fix the cause; do not route around CatCut.

## Setup and export cards
Let the user click instead of typing settings. Use an inline widget when the host has one (for example `show_widget`, where a button calls `sendPrompt` with the choices); otherwise use `AskUserQuestion`. Keep each card to one screen. Prefill what the user already said and the defaults so a single click is enough. Never ask again for what is already decided.
- **New project** (before `project_new`): name, folder, fps (25 · 30 · 24 · 50 · 29.97), frame size (1920×1080 · 1080×1920 · 1080×1080 · 3840×2160), and delivery targets as checkboxes from `delivery_presets`. The button sends one line, e.g. `ตั้งค่า: name=heart-fx fps=30 size=1920x1080 targets=yt,vert`. Then call `project_new {..., targets}`.
- **Export** (before `deliver`): version (latest by default), targets pre-checked from `delivery_presets.projectTargets`, a "Premiere XML" checkbox, and the QC issues of that version (with timecodes) so the user decides with them in view.
- **Done** (after `deliver` / `export_premiere_xml`): one card listing each file (name, size, codec, loudness) as clickable links, plus anything QC flagged.
Cards only collect choices; the actual work still goes through CatCut tools.

## Workflow
1. **Brief/board first.** No brief (a one-off effect or test)? Skip the board; say so in one line. `board_import` the storyboard/brief, then `board_check`. Tie every clip to a board `slot`. If the board contradicts itself, ask before cutting.
   - **File names and take notes written on the board win over matching by eye.** Put them in the slot's `sourceHint`. `board_vs_cut` flags a slot that uses other files. Read the photo/real-shot reference before the block-shot drawing.
   - **Reshoot projects:** when the user says the new cards are a reshoot, use reshoot footage first for every process shot. Old/client footage only fills what the reshoot lacks. Record this with `rules_add_constraint` (source: the user's words).
   - When the board is unclear, use the footage closest to the board and mark the slot `substitute`. Never leave a slot on a still frame because footage is hard to find.
   - **Slow motion:** check the source fps first (`timeline_lint` → `slowmo`). Client footage at 25/30 fps slowed down stutters unless it uses Optical Flow. Never replace a stuttering slow-mo with a still.
   - **Motion graphics and text are AE layers** (`ae_create`), built to match the board's look: typography, frames, light. Never use image generation for titles, frames or motion. When the user picks an earlier version ("use Rev3's frames"), revert to that version's comps; do not rebuild a new look.
2. **Capture rules** the brief or user states: `rules_add_constraint` (checks: `board-only`, `logo-static`, `no-repeat-gimmick` are automatic; `no-cover-photo`, `manual` are checked by eye) and `rules_set_style` (radius, safe margin, palette, joins, thai, maxStaticSec).
3. **Before every edit and every build, call `rules_get`** and re-read the checklist.
4. **Edit**: use `timeline_edit` for small changes, `ae_edit` for existing comps and `ae_create` for new ones. To hand the cut to a human editor in Premiere, use `premiere_push` / `premiere_pull` (CatCut bridge), never screenshots or clicks.
5. **Build** incrementally (`build`). Only changed segments re-render. Never export full deliverables when an incremental build answers the question. Check `disk_report` if space is tight. Build refuses below 5 GB free and warns below 20 GB.
6. **Review**: run `qc_report`, then `rules_check` (machine checks → `style` issues plus a visual checklist). `review_open` returns the URL directly; give it to the user. QC on a clip without audio always reports silence/loudness: say so once, do not repeat it every round.
7. **Fix loop**: address each note, rebuild, and review again until clean.

## Reels / TikTok / Shorts (talking head)
- Order: `jumpcut` → `punch_in` → `transcribe` → `captions_set` + `captions_plan` → `text_add` (hook) → `sfx_on_cuts` (only with SFX files the user gave) → `build` → `deliver vert`. `/catcut:reel` walks through it.
- Timeline tools (`jumpcut`, `punch_in`, `sfx_on_cuts`) are dry runs first: show what changes, then `apply: true`. Each apply backs the timeline up (`timeline_restore` undoes it).
- Captions and hook text are **burned into deliverables only** (not the ProRes master); broadcast/master targets never get them unless named in `captions_set {targets}`.
- **Proofread `captions_plan` before delivering.** whisper mishears brand names and English words in Thai speech: fix them with `captions_set {fixes}`; never retype captions by hand.
- Transcription is local (whisper.cpp) and cached per file; nothing leaves the machine. If `doctor` says whisper or libass is missing, tell the user the exact fix instead of working around it.

## Report "fixed" only with evidence
Before saying a fix is done (for example "corners are round everywhere"), call `rules_evidence {assetId | clipIds, version}`. It grabs **one frame per timeline instance** from that version's master into `review/evidence/<version>/` and makes a contact sheet. For review notes pass `offsets` (each note's frame minus the clip start) so the sheet shows exactly the noted spots. Attach every frame. If an instance is missing or still wrong, the fix is not done.

## Review note colours
- red: cut / edit
- yellow: timing
- blue: text / graphic
- green: colour
- purple: audio

## Housekeeping
- `disk_report` shows free space per drive, AE disk cache size, and project `cache/` + `out/` per version.
- `version_keep {version}` protects a version from cleanup.
- `cache_gc_plan` only lists files and deletes nothing. Show the plan to the user. **Only after the user approves**, call `cache_gc_apply {planId, confirm: "ลบ"}` within 10 minutes. It deletes only planned files inside `cache/` and `out/` and logs each one to `history/`.

## Money and the screen
- Before calling any paid external service or connector (generation, stock, upscaling, TTS ...), tell the user it may cost money and ask: "<service> อาจมีค่าใช้จ่าย — ใช้ไหม? / may cost money — OK?".
- Stay headless. Never take over the user's screen. The only Adobe window CatCut opens is Premiere, through `premiere_open`.
