---
description: ตัดคลิปสไตล์ Reels / TikTok / Shorts: ตัดช่วงเงียบ ซูมกระแทก ซับอัตโนมัติ ฮุก เสียงเอฟเฟกต์ · Talking-head Reel: jump cuts, punch-ins, auto captions, hook, SFX
argument-hint: "[footage path] [hook text] [vert | yt]"
---
Use the catcut-editor skill (section "Reels / TikTok / Shorts") and the CatCut MCP tools. Arguments: $ARGUMENTS

1. `doctor`: the `captions` line must say burn-in ok and name a whisper model. If not, tell the user what it says (macOS: `brew install ffmpeg-full` + a ggml model in the models folder) and stop.
2. Project 1080x1920 (`project_new {width:1080, height:1920, targets:["vert"]}`) unless the user wants 16:9. `asset_add` the footage; put the clips on the timeline in speaking order.
3. `jumpcut` (dry run) → show how much it removes per clip → `jumpcut {apply:true}`. Noisy room: raise `noiseDb` to -30; clipped words: raise `padMs`.
4. `punch_in` (dry run, then apply): alternates 100% / 115% on the jump-cut pieces.
5. `transcribe` (language from the user, e.g. `lang:"th"`), then `captions_set {enabled:true, lang}` and `captions_plan`. Read every caption: fix brand names and misheard words with `captions_set {fixes:[{from,to}]}` and check again.
6. Hook: `text_add {text, dur: 75}` with the user's hook (or propose 2-3 short hooks from the transcript and let the user pick).
7. SFX: only with an SFX file the user gives (`asset_add`), `sfx_on_cuts {srcs, cuts:"source-change"}`; never invent sounds.
8. `build`, `job_wait`, then `deliver {targets:["vert"]}` (captions are burned only into deliverables). Give the user the file path and offer `/catcut:review`.
