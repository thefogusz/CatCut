<p align="center"><img src="assets/brand/catcut-logo.svg" width="128" alt="CatCut"></p>

# CatCut 🐾

**CatCut** (ชื่อโค้ดเดิม EDITMCP) คือ MCP server สำหรับตัดต่อวิดีโอแบบ headless: แก้ comp ใน After Effects โดยไม่เปิดหน้าโปรแกรม (`AfterFX -m -noui`), render ด้วย `aerender`, แล้วให้ `ffmpeg` ประกอบเป็น master ProRes 422 HQ จาก "ท่อน" ที่ cache ไว้ — แก้จุดเดียว render ใหม่แค่จุดนั้น ส่วนที่ไม่เปลี่ยนไม่ถูก encode ซ้ำ จึง export เร็วและคุณภาพเท่า export ตรงจาก AE จากนั้นทำ QC (เฟรม, ภาพดำ/ค้าง, เสียงเงียบ, loudness), สร้าง deliverable ตาม preset (YouTube, Facebook, แนวตั้ง, XDCAM HD422 ออกอากาศ, ProRes) และส่งออก/รับกลับ FCP7 XML เพื่อไปขยับไทม์มิ่งเองใน Premiere ได้ ใช้ได้ทั้งกับ Claude Code และ Codex ทุกค่าเวลาเป็น **เฟรม** ไม่ใช่วินาที และ**ไม่เขียนทับไฟล์เดิม**เด็ดขาด (ทุก build ได้เวอร์ชันใหม่)

## ติดตั้งสำหรับมือใหม่ (ไม่ต้องรู้ git / โค้ด) / Beginner install (Windows)

**ทางที่ 1 — ให้ AI ติดตั้งให้:** เปิด Claude หรือ Codex แล้วพิมพ์

> ติดตั้ง CatCut ให้หน่อย ตามวิธีมือใหม่ใน https://github.com/thefogusz/CatCut

**ทางที่ 2 — ทำเอง (คัดลอกวางบรรทัดเดียว):**
1. กดปุ่ม Windows พิมพ์ `PowerShell` แล้วเปิด
2. วางบรรทัดนี้แล้วกด Enter

```powershell
irm https://raw.githubusercontent.com/thefogusz/CatCut/main/install.ps1 | iex
```

หรือดาวน์โหลด [`install.cmd`](install.cmd) แล้วดับเบิลคลิก

ตัวติดตั้งจะทำให้เองทั้งหมด: ติดตั้ง Node.js และ ffmpeg (ถ้ายังไม่มี), ดาวน์โหลด CatCut ไว้ที่ `%LOCALAPPDATA%\CatCut`, ต่อเข้ากับ **Codex** (ถ้ามี) และ **Claude Code** (ถ้ามีคำสั่ง `claude`), แล้วตรวจเครื่องให้ดู
- ถ้าใช้แอป Claude (แท็บ Code): พิมพ์ในแชทครั้งเดียว `/plugin marketplace add thefogusz/CatCut` แล้ว `/plugin install catcut@catcut`
- **อัปเดต:** รันคำสั่งเดิมอีกครั้ง (ปิด Claude / Codex ก่อน)
- After Effects ต้องติดตั้งเองจาก Adobe (ถ้าจะใช้งาน comp/เอฟเฟค)

> สำหรับ AI ที่ติดตั้งให้ผู้ใช้: รันคำสั่ง PowerShell ด้านบนให้ผู้ใช้ (Windows) แล้วบอกผลเป็นภาษาไทยสั้นๆ ไม่ต้อง clone repo หรือ `npm install`

## ติดตั้งบน Mac / Beginner install (macOS)

เปิดแอป Terminal แล้ววางบรรทัดนี้:

```bash
curl -fsSL https://raw.githubusercontent.com/thefogusz/CatCut/main/install.sh | bash
```

ตัวติดตั้งทำเหมือนบน Windows: ติดตั้ง Node.js และ ffmpeg ผ่าน [Homebrew](https://brew.sh) (ต้องมี Homebrew ก่อน), ดาวน์โหลด CatCut ไว้ที่ `~/Library/Application Support/CatCut`, ต่อเข้ากับ Claude Code / Codex แล้วรัน `doctor`

ความต่างบน Mac:
- **After Effects ไม่มีโหมดไม่มีหน้าต่าง (`-noui`) บน Mac** — CatCut สั่ง AE ผ่าน AppleScript (`DoScriptFile`) โดยเปิด AE ของตัวเองแล้วปิดเมื่อเสร็จ จึงต้อง**ปิด AE ที่เปิดอยู่ก่อน**ทุกครั้งที่ใช้คำสั่ง `ae_*` และครั้งแรก macOS จะถามสิทธิ์ Automation (System Settings > Privacy & Security > Automation) ให้กดอนุญาต
- ตั้งค่า AE ครั้งเดียว: After Effects > Settings > Scripting & Expressions > *Allow Scripts to Write Files and Access Network*
- Premiere bridge ติดตั้งที่ `~/Library/Application Support/Adobe/CEP/extensions` และตั้ง PlayerDebugMode ผ่าน `defaults write com.adobe.CSXS.<n>`
- ไฟล์ของ CatCut (bridge, backup) อยู่ที่ `~/Library/Application Support/CatCut`
- ส่วน Adobe บน Mac ทำตามเอกสารของ Adobe แต่ยังไม่ได้ทดสอบกับ AE / Premiere จริง; ส่วน ffmpeg (ตัดต่อ, build, QC, deliver, XML, review) ทดสอบบน macOS แล้ว

## ติดตั้งแบบ plugin (ง่ายสุด) / Install as a Claude Code plugin

ในเซสชัน Claude Code:

```
/plugin marketplace add thefogusz/CatCut
/plugin install catcut@catcut
```

หรือใน terminal: `claude plugin marketplace add thefogusz/CatCut` แล้ว `claude plugin install catcut@catcut`

จากนั้นเรียกใช้:

| คำสั่ง | ทำอะไร |
|---|---|
| `/catcut:new` | เริ่มงานจากบรีฟ/บอร์ด + ฟุตเทจ |
| `/catcut:build` | build เฉพาะที่เปลี่ยน + QC |
| `/catcut:review` | เปิดหน้ารีวิว วงปากกาสีสั่งแก้ |
| `/catcut:fix` | แก้ตามโน้ต (เสนอแผนก่อน) |
| `/catcut:check` | เทียบบอร์ด + หาเฟรมหลุด/กระตุก |
| `/catcut:deliver` | ส่งงาน YouTube/ทีวี/Master หรือ XML ไป Premiere |
| `/catcut:motion` | สร้างเอฟเฟค/โมชันกราฟิกใหม่ใน AE (สคริปต์ → `ae_create`) |
| `/catcut:reel` | คลิปสไตล์ Reels / TikTok: ตัดช่วงเงียบ, ซูมกระแทก, ซับอัตโนมัติ, ฮุก, SFX |
| `@agent-catcut:editor` | ให้ agent CatCut รับงานไปทำทั้งหมด |

ต้องมี Node ≥ 22 และ ffmpeg ในเครื่อง (After Effects ถ้าจะใช้ comp)

## ต้องเปิดโปรแกรมอะไรค้างไว้ไหม / What must stay open

`catcut ready` (หรือ tool `ready_check`) ตรวจทุกอย่างโดยไม่เปิดโปรแกรม Adobe แล้วบอกว่าต้องทำอะไร ทำไม ทำครั้งเดียวไหม และปิดได้เมื่อไร

| โปรแกรม | ต้องเปิดค้างไหม | ต้องทำเองครั้งเดียว |
|---|---|---|
| After Effects | **ไม่ต้องเปิดเลย** — CatCut เปิดแบบไม่มีหน้าต่างแล้วปิดเองทุกงาน | เปิด AE หนึ่งครั้งเพื่อ Sign in และติ๊ก Preferences > Scripting & Expressions > *Allow Scripts to Write Files and Access Network* แล้วปิด (ไม่ต้องสร้างโปรเจกต์) |
| Premiere Pro | **ไม่ต้องเปิดเอง** — `premiere_open` เปิดให้พร้อมโปรเจกต์ ทำงาน แล้วบอกว่า Save แล้ว ปิดได้ | `catcut premiere-bridge install` ครั้งเดียว (อัปเดต CatCut แล้วรันซ้ำ) |
| ffmpeg | ไม่ใช่โปรแกรมที่เปิดค้าง | มากับตัวติดตั้ง |

ถ้ามีอะไรต้องให้คุณกด (เช่น Premiere มีหน้าต่างค้าง) CatCut ตอบเป็นการ์ดเดียวกันทุกครั้ง: ทำอะไร · ทำไม · ครั้งเดียว/ทุกครั้ง · ต้องเปิดค้างไหม · ปิดได้เมื่อไร

แก้ sequence เดิมของ editor (ไม่สร้าง sequence ใหม่): `premiere_timeline_get` → `premiere_edit {ops, apply?}` (remove / trim / move / set_speed / overwrite ไฟล์หรือ AE comp / replace_media / relink / rename / set_motion / add·remove_effect / set_effect_param) — ทุก op ระบุคลิปตามตำแหน่งปัจจุบัน ถ้า editor ขยับไปแล้วจะไม่แก้, dry run ก่อน, Save จุดย้อนกลับก่อนแก้, ตรวจว่าคลิปอื่นไม่เปลี่ยน, ย้อนด้วย `premiere_undo_last`; ตรวจผลด้วย `premiere_frames` / `premiere_export_range`. คำสั่งเฉพาะงานใส่ `host.user.jsx` (อยู่รอดหลังอัปเดต); bridge เดิมถูกสำรองไว้ที่ `%LOCALAPPDATA%\CatCut\bridge-backups` ทุกครั้งที่ติดตั้งทับ

งานใน Premiere: `proxy_make` (proxy `<ชื่อเดิม>_Proxy.mp4`) → `premiere_import_media` (ไฟล์ต้นฉบับชื่อเดิม bin ตามการ์ด แนบ proxy) → `premiere_set_speed` (เช่น 60% + Optical Flow แบบ native ไม่ export ไฟล์ใหม่) → `premiere_save` / `premiere_close`

## ติดตั้งจากซอร์ส / Install from source

ต้องมี Node ≥ 22, ffmpeg/ffprobe (Windows: winget `Gyan.FFmpeg`, macOS: `brew install ffmpeg`, หรือกำหนด `EDITMCP_FFMPEG=<bin folder>`) และ After Effects (ถ้าจะใช้ `ae_*`)

```bash
npm i
npm run build                  # → dist/ + dist/bundle/catcut.mjs (ไฟล์เดียว ไม่ต้องมี node_modules)
node dist/mcp/cli.js doctor    # ตรวจว่าเจอ ffmpeg, encoders (NVENC), AE, RAM
```

ระหว่างพัฒนาใช้ `npm run doctor` (= `tsx src/mcp/cli.ts doctor`) ได้โดยไม่ต้อง build

## ตั้งค่ากับ Claude Code

`.mcp.json` ในโฟลเดอร์งาน (หรือ `~/.claude.json` สำหรับทุกโปรเจกต์):

```json
{
  "mcpServers": {
    "editmcp": {
      "command": "node",
      "args": ["D:/EDITMCP/dist/bundle/catcut.mjs", "serve"]
    }
  }
}
```

## ตั้งค่ากับ Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.editmcp]
command = "node"
args = ["D:/EDITMCP/dist/bundle/catcut.mjs", "serve"]
```

แล้วคัดลอก `skills/catcut-editor/SKILL.md` ไปไว้ที่ `~/.codex/skills/catcut-editor/SKILL.md` (ตัวติดตั้งทำสองอย่างนี้ให้อัตโนมัติ)

ใส่ `"D:/path/to/project"` ต่อท้าย `serve` ได้ถ้าอยากให้เปิดโปรเจกต์ทันที (ไม่งั้นเรียก `project_open` ทีหลัง)

## เริ่มใช้ / Quick start

ทุกเครื่องมือรับ JSON และตอบ JSON; งานหนัก (`build`, `deliver`) คืน **job id ทันที** แล้วรอผลด้วย `job_wait`

```text
doctor                                     → ffmpeg / NVENC / AE / RAM + ข้อควรระวังตามเวอร์ชัน
project_new   {dir, name, fps: 25}          → สร้าง project.json (1920x1080 โดยปริยาย)
asset_add     {path: "D:/footage/คลิป01.mp4", id: "A01"}
asset_add     {aep: "D:/ae/titles.aep", comp: "Title_01", id: "C_title"}
timeline_set  {timeline: {
                 video: [{id:"s1", src:"C_title", in:0, dur:125, marker:"เปิดเรื่อง"},
                         {id:"s2", src:"A01",     in:312, dur:88}],
                 cuts:  [{after:"s1", dissolve:10}],
                 audio: {vo:[], music:[{id:"m1", src:"M01", at:0}], sfx:[],
                         duck:{underDb:-12, attackMs:150, releaseMs:400}}}}
timeline_edit {ops: [{op:"trim", id:"s2", dur:100}, {op:"set_dissolve", after:"s1", frames:12}]}
audio_add     {track:"vo", src:"VO01", at:0}
build         {}                            → {jobId:"job-0001"}  … job_status {id:"job-0001"}
qc_report     {}                            → เฟรมครบไหม, ภาพดำ/ค้าง, loudness
deliver       {targets:["yt","th_tv"]}      → job → out/v001/<name>_v001_yt.mp4, …
export_premiere_xml {}                      → out/v001/<name>.xml
```

`build` ทำงานแบบ incremental: comp ที่ fingerprint เปลี่ยนเท่านั้นที่ถูก render ใหม่, ท่อนที่เคยทำแล้วถูกใช้ซ้ำจาก cache, master ต่อด้วย `concat -c copy` (ไม่ encode ซ้ำ), เสียงทำใหม่ทั้งเรื่อง (เร็ว) แล้ว mux — build ซ้ำโดยไม่แก้อะไรจะ render 0 ท่อน

Preset deliverable: `yt`, `fb`, `vert` (1080x1920 ครอปกลาง), `th_tv` (XDCAM HD422 MXF 1080i50, -24 LKFS), `th_prores`, `led` (H.264 50 Mbps CBR), `m422hq` (ProRes master -23 LUFS)

## Reels / TikTok / Shorts

สำหรับคลิปพูดหน้ากล้อง (talking head) แนวตั้ง — ไม่ต้องใช้ Adobe:

| เครื่องมือ | ทำอะไร |
|---|---|
| `jumpcut` | หาช่วงเงียบจากเสียงของคลิป (ffmpeg silencedetect) แล้วแบ่งคลิปเป็นท่อนที่มีเสียงพูด |
| `punch_in` | ท่อนต่อกันจากไฟล์เดียวกันสลับซูม 100% ↔ 115% (ใช้ `scale` ของคลิป) |
| `transcribe` | ถอดเสียงเป็นคำพร้อมเวลาด้วย whisper.cpp ในเครื่อง (ไทย/อังกฤษ) เก็บ cache ใน `cache/transcripts/` |
| `captions_set` / `captions_plan` | ซับอัตโนมัติ สไตล์ `pop` (ไฮไลต์คำที่กำลังพูด) หรือ `clean`; `fixes` แก้คำที่ถอดผิด; ดูซับทั้งหมดก่อนส่ง |
| `text_add` / `text_remove` | ข้อความบนภาพ: `hook` (ใหญ่ ด้านบน ช่วงต้น), `title`, `lower` |
| `sfx_on_cuts` | วาง whoosh/pop ที่รอยตัดจากไฟล์ SFX ที่ให้มา |

ซับและข้อความเผาลง**ไฟล์ส่งงาน**ตอน `deliver` เท่านั้น (master ProRes สะอาดเสมอ; `th_tv`, `th_prores`, `m422hq` ไม่ใส่ซับเว้นแต่ระบุ) — ต้องใช้ ffmpeg ที่มี libass และ whisper.cpp + โมเดล:

- macOS: `brew install ffmpeg-full` (มี libass และ `whisper-cli` มาด้วย; CatCut เลือก ffmpeg-full ให้เอง) แล้ววางโมเดล เช่น [`ggml-large-v3-turbo-q5_0.bin`](https://huggingface.co/ggerganov/whisper.cpp) (~570 MB, ไทยดี) ไว้ที่ `~/Library/Application Support/CatCut/models/`
- Windows: ffmpeg ที่มี libass (เช่น Gyan full build) + `whisper-cli` จาก whisper.cpp; โมเดลวางที่ `%LOCALAPPDATA%\CatCut\models\` หรือกำหนด `EDITMCP_WHISPER_CLI` / `EDITMCP_WHISPER_MODEL`
- `doctor` บอกในบรรทัด `captions` ว่าพร้อมไหม

ข้อจำกัด: เวลาของคำจาก whisper ปรับให้ตรงช่วงที่มีเสียงจริงแล้ว แต่ไฮไลต์ทีละคำภาษาไทยอาจเหลื่อม 1 ตัวอักษรเมื่อตัวตัดคำ (ICU) แบ่งคำผิด (เช่น "มาบ|อก") — ใช้ `style: "clean"` ถ้าไม่ต้องการไฮไลต์; footage แนวนอนใส่ในโปรเจกต์แนวตั้งจะมีขอบดำ (fit) ให้ตั้ง `scale` ของคลิปเพื่อครอปเต็มจอ

## รอบแก้มือใน Premiere / Premiere round-trip

1. `export_premiere_xml` → ได้ `out/<version>/<name>.xml` (xmeml v5) ที่ลิงก์ไป **render เต็ม comp** และไฟล์กล้องต้นฉบับ ไม่ใช่ Dynamic Link
2. ใน Premiere: File > Import ไฟล์ XML → ขยับ / slip / trim / เปลี่ยนความยาว dissolve / marker / scale ได้ตามใจ
3. File > Export > **Final Cut Pro XML** → บันทึกเป็นไฟล์ใหม่
4. `import_premiere_xml {path}` → **dry run**: ได้ `summary` (ทีละบรรทัด: คลิปไหนเปลี่ยน in/dur, dissolve ไหนเปลี่ยน), `diff`, `warnings` (คลิปบน V2+ ที่ถูกทิ้ง, ช่องว่าง, speed change, บทบาทแทร็กเสียงที่กำกวม) และ `valid/errors` โดยยังไม่แก้ไทม์ไลน์ (ไฟล์ที่จับคู่กับ asset ไม่ได้จะอยู่ใน `unresolvedPaths` — เพิ่มด้วย `asset_add` แล้ว import ใหม่)
5. ตรวจแล้ว `import_premiere_xml {path, apply: true}` → สำรองไทม์ไลน์เดิมไว้ที่ `history/timeline-<เวลา>-<n>.json` ก่อน แล้วจึงใช้; ย้อนกลับด้วย `timeline_restore {}` (ดูรายการ) / `timeline_restore {backup: "<ชื่อไฟล์>"}` (สำรองฉบับปัจจุบันก่อนเสมอ)
6. `build` → render เฉพาะ dissolve/ท่อนที่กระทบ → เวอร์ชันใหม่ในไม่กี่วินาที–นาที

เสียงทุกเลนเขียนเป็นคู่สเตอริโอแบบที่ Premiere export เอง (A1/A2 เสียงกล้อง, A3/A4 vo, A5/A6 music, A7/A8 sfx) รายละเอียดใน [`docs/xmeml-notes.md`](docs/xmeml-notes.md)

สิ่งที่กลับมาได้: trim, slip, ลำดับ, dissolve, marker, scale — เอฟเฟกต์เฉพาะ Premiere (Lumetri, Warp Stabilizer) ไม่กลับมา ให้ทำใน AE แทน

## CLI

```bash
editmcp doctor
editmcp serve [projectDir]
editmcp build D:/jobs/csr --force          # --skip-qc --skip-deliver --force-assets C_title,C_end
editmcp deliver D:/jobs/csr v001 yt th_tv
editmcp xml-export D:/jobs/csr --version v001
editmcp xml-import D:/jobs/csr D:/jobs/csr/from_premiere.xml          # dry run
editmcp xml-import D:/jobs/csr D:/jobs/csr/from_premiere.xml --apply  # ใช้จริง (สำรองไทม์ไลน์ก่อน)
editmcp review D:/jobs/csr --version v001 # เปิด URL ที่แสดง; Ctrl+C ปิด server
```

`doctor` ไม่เปิด After Effects (รายงาน `AE version: unknown (not launched)`) เว้นแต่ตั้ง `EDITMCP_ALLOW_AE=1`

`EDITMCP_PROTECTED_PATHS=D:/job1;E:/job2` (คั่นด้วย `;`) = โฟลเดอร์ที่ห้ามเขียนเด็ดขาด เพิ่มจากโฟลเดอร์งานผลิตที่ฝังไว้ในโค้ด: `project_new`/`project_open`, ทุกเครื่องมือที่เขียนลงโปรเจกต์, `ae_edit` และ `ae_preview_frame` จะปฏิเสธ; `ae_preview_frame.out` และ `ae_edit.saveAs` ต้องอยู่ในโฟลเดอร์โปรเจกต์หรือโฟลเดอร์ของ `.aep` ต้นทาง

## ใช้หลายโปรเซสพร้อมกัน

MCP server และ CLI (`build`/`review` ในอีกเทอร์มินัล) เปิดโปรเจกต์เดียวกันได้: ทุกการบันทึก `project.json` ทำภายใต้ `project.lock` (pid + เวลา; lock ของโปรเซสที่ตายแล้วหรือเก่ากว่า 2 นาทีถูกเอาคืนอัตโนมัติ) และเทียบกับฉบับที่โหลดมา — ถ้าอีกโปรเซสบันทึกไปก่อน จะรวมการเปลี่ยนที่ไม่ชนกัน (เวอร์ชันที่ build เพิ่ม, reviewProxy/reviewPlan, asset ใหม่, ไทม์ไลน์ถ้าแก้อยู่ฝั่งเดียว) ถ้าชนกันจริง (เช่นแก้ไทม์ไลน์ทั้งสองฝั่ง) เครื่องมือจะตอบ `โปรเจกต์ถูกแก้จากที่อื่น — โหลดใหม่แล้วลองอีกครั้ง` พร้อมโหลดฉบับบนดิสก์ใหม่ให้ แล้วสั่งแก้ซ้ำได้เลย ไม่มีงานฝั่งใดหาย

คำสั่ง `ae_list_comps`, `ae_inspect_comp`, `ae_edit`, `ae_preview_frame` ทำงานเป็น job: ถ้าคิวว่างจะรอผลไม่เกิน ~20 วินาที ถ้ามี build/render อยู่ในคิว (หรือส่ง `wait: false`) จะคืน `jobId` ทันที แล้วดูผลด้วย `job_status`

## โครงสร้างโปรเจกต์

```text
<project>/project.json        ความจริงเดียว: assets, timeline (เฟรม), delivery, versions
<project>/cache/renders/      render เต็ม comp (ProRes)      cache/segments/  ท่อนภาพ + manifest.json
<project>/out/v001/           master .mov, deliverables, .xml   review/        proxy, contact sheet
```

## พัฒนา

```bash
npm test                      # vitest (สื่อสังเคราะห์เท่านั้น ไม่เปิด AE)
npm run typecheck
npm run build
node tests/stdio_smoke.mjs     # ทดสอบ MCP stdio ของ CLI ที่ build แล้ว (ไม่เปิด AE)
```

กฎของโปรเจกต์อยู่ใน `CLAUDE.md`, แบบดีไซน์ใน `docs/DESIGN.md`

ผลตรวจล่าสุดและข้อจำกัดอยู่ใน [`docs/STATUS.md`](docs/STATUS.md): แกนระบบผ่าน ffmpeg จริง และ AE 26.5 ผ่านการอ่าน/แก้/เรนเดอร์/ใช้ cache กับโปรเจกต์ทดสอบแยก; plugin และงานผลิต รวมถึง XML import ใน Premiere ยังไม่ยืนยัน

เมื่อผู้ใช้อนุญาตให้เปิด Adobe สามารถทดสอบ integration แยกด้วย PowerShell หลัง build:

```powershell
$env:EDITMCP_TEST_ADOBE='1'
node tests/adobe_smoke.mjs
```

สคริปต์สร้าง fixture ด้วย AE อินสแตนซ์ใหม่แล้วปิด (AE 26.5 บนเครื่องนี้ล้มเมื่อ `newProject()` ใน `-noui`); การอ่าน/แก้ comp ใช้ `-m -noui` และเรนเดอร์ด้วย aerender เก็บหลักฐานไว้ในโฟลเดอร์ใหม่ใต้ `tmp/adobe-test/` ทดสอบนี้ไม่รวมอยู่ใน `npm test` และไม่เปิดงานผลิต ใช้แทน smoke script เก่าใน `tests/run_noui_smoke.ps1`

`ae_edit` แก้สำเนาชั่วคราวก่อน แล้วบันทึกกลับต้นฉบับพร้อมเก็บ `<name>_backup_<timestamp>.aep`; ถ้าใช้ `saveAs` จะสร้างไฟล์ใหม่และปฏิเสธชื่อที่มีอยู่แล้ว งาน build/deliver จะล็อกคำสั่งแก้โปรเจกต์ของ server นั้นจนจบ; การบันทึกจากหลายโปรเซสรวมกันได้ (ดูหัวข้อ "ใช้หลายโปรเซสพร้อมกัน") แต่ไม่ควรสั่ง build สองตัวพร้อมกันบนโปรเจกต์เดียว

ไฟล์ที่ fps ต่างจากโปรเจกต์ใช้ตำแหน่งและความยาวเป็นเฟรมของโปรเจกต์เสมอ การ encode ท่อนใหม่จะ decode ตั้งแต่ต้นไฟล์เพื่อคง sampling grid ให้ถูกต้อง จึงอาจช้าเมื่อ in-point อยู่ลึกในฟุตเทจยาว; build ที่ไม่เปลี่ยนภาพจะใช้ cache ตามเดิม

AE fingerprint ติดตาม property/keyframe/expression, precomp, proxy และ image sequence; comp ที่มี expression หรือค่า plugin ที่อ่านไม่ได้จะติดตามไฟล์ `.aep` ทั้งไฟล์แบบ conservative จึงอาจ render ใหม่มากกว่าหนึ่ง comp เมื่อแก้โปรเจกต์

ถ้า backend รายงาน comp เป็น `opaque` (ค่าใน Curves/Levels อ่านไม่ได้) `ae_inspect_comp`/`ae_edit` จะแนบ `opaqueHint`: การแก้เฉพาะในเอฟเฟกต์พวกนั้นอาจไม่เปลี่ยน fingerprint ให้ใช้ `build {force: true}` หรือ `build {forceAssets: ["C_title"]}` — อย่างหลังล้าง render record ของ asset นั้นและย้ายไฟล์ render เดิมไปเป็น `<ชื่อ>_forced.mov` (ไม่ลบ) เพื่อบังคับ render ใหม่

## รีวิวด้วยการวงบนภาพ

`review_open {version: "v001"}` → `job_status` → เปิด URL ในผลลัพธ์ (เว้น version เพื่อใช้ล่าสุด) ถ้ายังไม่มี preview ระบบสร้าง H.264 ขนาดเล็กก่อน โดยไม่เปิด Adobe

เลือกช็อตหรือเลื่อนเฟรม ใช้ `I` / `O` ตั้งช่วง กด **วงจุดแก้** แล้วลากบนภาพ เลือกประเภทและพิมพ์โน้ต กด **เพิ่มโน้ต** เพื่อบันทึกอัตโนมัติ; คลิกโน้ตเพื่อกลับไปเฟรมเดิมและแก้ได้ ใช้ `←` / `→` เดินทีละเฟรม และ `J` / `K` / `L` ถอยหลัง/หยุด/เล่น

เมื่อพร้อมกด **ส่งรีวิวให้ agent** แล้วให้ agent เรียก `review_notes {version}` เพื่ออ่านโน้ตและเสนอแผนแก้ก่อนลงมือ ระบบไม่แก้ไทม์ไลน์จากโน้ตเอง `review_submit {version, revision}` ส่งโน้ตผ่าน MCP ได้ และ `review_close {version}` ปิด server; `preview {version}` สร้าง preview ไฟล์ใหม่

โน้ตอยู่ที่ `<project>/review/<version>/session.json`; แต่ละครั้งที่ส่งเก็บสำเนาใหม่ `submitted-<uuid>.json` แผนช็อตเก็บกับเวอร์ชัน ไม่เปลี่ยนตามไทม์ไลน์ปัจจุบัน เวอร์ชันเก่าที่ไม่มี snapshot และแผนไม่ตรงกับปัจจุบันต้อง build ใหม่ก่อนรีวิว

Server เปิดเฉพาะ `127.0.0.1` ใช้ URL เฉพาะเซสชัน ไม่ส่งวิดีโอออกนอกเครื่อง หลายหน้าต่างบันทึกโน้ตใช้ revision และ lock ป้องกันทับกัน; ถ้าโปรเซส crash ระหว่างบันทึกจนค้าง `session.lock` ให้ปิดทุกโปรเซสรีวิวของโปรเจกต์ก่อนลบ lock นี้ โน้ตและสำเนาที่ส่งยังอยู่

หน้ารีวิวใช้ Noto Sans Thai ที่เก็บในโปรเจกต์ ไม่เรียกบริการฟอนต์ภายนอก; ฟอนต์จาก Google Fonts ภายใต้ SIL Open Font License ดู `web/review/fonts/OFL.txt`

ลองด้วยสื่อสังเคราะห์ (ไม่แตะงานผลิต): `npm run build` แล้ว `node tests/review_demo.mjs` จะสร้างโปรเจกต์ใหม่ใต้ `tmp/review-demo/` และแสดง URL; Ctrl+C เพื่อปิด server

เฟสนี้วงเป็นเส้นอิสระและจับคู่กับช็อต/comp ตามเฟรม บริเวณ dissolve มีภาพจากสองช็อต ต้องดูบริบท transition ในแผนประกอบ; การ hit-test layer ใน AE, voice note และเทียบก่อน/หลังยังเป็นเฟสถัดไป
