# EDITMCP — แบบดีไซน์ (ร่าง 1)

> สถานะ: core และหน้ารีวิวในเครื่องสร้างแล้ว; ดูผลตรวจและส่วนที่ยังไม่ยืนยันใน [STATUS.md](STATUS.md) รายการที่เหลือในเอกสารนี้เป็นแผน ไม่ใช่ฟีเจอร์ที่ทำครบแล้ว
> วันที่: 2026-10-11 · เขียนโดย Fable 5.1 จากรีเสิร์ช 3 ส่วน + การคุยกับผู้ใช้

---

## 1. เป้าหมาย (จากคำพูดของผู้ใช้)

| ต้องการ | ความหมายในเชิงระบบ |
|---|---|
| ตัดต่อวิดีโอกับ After Effects ได้ง่ายที่สุด | โยนบรีฟ/เรฟ/ฟุตเทจ/เสียง → ได้งานกลับมา; ชุดคำสั่งน้อย อ่านรู้เรื่อง |
| render/export เร็ว | ไม่ผ่าน Dynamic Link; aerender ขนาน + ffmpeg/NVENC |
| **แก้จุดเล็ก ๆ ไม่ต้อง render ใหม่หมด แต่คุณภาพคงเดิม** | render เป็นท่อน (segment) แล้วต่อแบบไม่ encode ซ้ำ |
| ไม่อยากยุ่งกับ Premiere… | pipeline หลักไม่ต้องเปิดโปรแกรม Adobe เลย |
| …แต่เปิดใน Premiere แล้วขยับไทม์มิ่งเองได้ | ส่งออก FCP7 XML ที่ลิงก์ไฟล์ที่ render แล้ว (ไม่ใช่ Dynamic Link) และ **รับ XML กลับ** มา render ต่อได้ |
| ใช้กับ Claude และ Codex ได้ | MCP มาตรฐาน + skill แบบ `SKILL.md` (ทั้งสองรองรับ) |
| ใช้เครื่องมือในโปรแกรมได้หมด | AE ผ่าน ExtendScript เต็มรูปแบบ (มีข้อยกเว้นที่ต้องใช้ UI ดูข้อ 11) |
| มีสกิล/เทคนิคจากทั่วโลก + agent หาเพิ่มเองได้ | Technique Library ที่ขยายได้ + skill ตามแนวงาน + โหมดให้คำแนะนำ |
| ระดับโปรดักชั่น (online / broadcast / master ProRes, 1080p25) | master ProRes 422 HQ + deliverable presets + QC + loudness |

---

## 2. สิ่งที่รีเสิร์ชพบ (สรุป)

### 2.1 After Effects แบบไม่เปิดหน้าโปรแกรม
- `AfterFX.exe -m -noui -r script.jsx` = เปิด AE ตัวใหม่แบบไม่มี UI รันสคริปต์แล้วปิด
  - `-m` สำคัญมาก: ถ้าไม่ใส่ สคริปต์จะถูกส่งไปรันใน AE ตัวที่ผู้ใช้เปิดอยู่
  - `app.exitCode` ส่งรหัสกลับ shell ได้; `AfterFX.com` คือตัว console
  - ใช้จริงในโปรดักชั่นโดย Templater (Dataclay) แต่ **ยังไม่มีใครยืนยันกับ AE 26.5 → ต้องทดสอบ**
  - ไม่รองรับสิ่งที่ต้องใช้ UI: `app.executeCommand()`, viewer, ScriptUI
- **aerender** เร็ว ใช้หลายคอร์ (`-mfr ON 90`), รันขนานหลายตัวได้ (พิสูจน์แล้วในงาน CSR: 16 comps ≈ 10 นาที)
- **ไม่ใช้** เทคนิค nexrender ที่แก้ `commandLineRenderer.jsx` (ต้อง admin, ไม่ยืนยันกับ 2026, อัปเดต AE แล้วหาย, และไฟล์ `ae_render_only_node.txt` ทำให้ AE กลายเป็นโหมด render-only)
- บั๊ก AE 25.2.2+ ถึง 26.3: **ตั้งชื่อไฟล์ output เป็นภาษาไทยผ่านสคริปต์ → ตัวอักษรไทยกลายเป็นขีด** → render ชื่ออังกฤษแล้วค่อย rename
- `saveFrameToPng` เป็น async/ไม่เสถียร → ใช้ aerender render 1 เฟรมแทน
- `OutputModule.setSettings` เปลี่ยน Format ไม่ได้ (read-only) → ต้องมี OM template ProRes อยู่ก่อน หรือใช้ "Lossless" แล้วให้ ffmpeg แปลง

### 2.2 Premiere
- ไม่มีโหมด headless; UXP/CEP ต้องเปิดโปรแกรม; AME ใช้ `PProHeadless.exe` แต่ API ยังเบต้าและต้องเปิด AME
- **FCP7 XML (xmeml)** คือไฟล์กลางที่ Premiere 2026 import/export ได้ดีที่สุด (clip, in/out, dissolve, marker, scale, audio) — FCPXML ของ Final Cut เปิดไม่ได้, OTIO ใน Premiere ยังเบต้าและไม่รองรับทรานซิชัน
- Premiere ยัง export "Final Cut Pro XML" ได้ ([Adobe](https://helpx.adobe.com/sg/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html)) → ทำรอบ "แก้ใน Premiere แล้วส่งกลับ" ได้
- ยังไม่มี MCP ไหนทำครบ (headless + AE + ไทม์ไลน์ + XML) — ตัวที่มีทุกตัวต้องเปิดโปรแกรม

### 2.3 ffmpeg ในเครื่องนี้ (9.0.1)
- decode/encode: ProRes (รวม 4444/alpha), DNxHD/HR, CineForm, H.264/HEVC 10-bit, EXR/DPX/PNG, PCM 24-bit
- GPU: `h264_nvenc`, `hevc_nvenc`, `h264_qsv`
- filter: `xfade`, `acrossfade`, `lut3d`, `zscale`, `tonemap`, `loudnorm`, `freezedetect`, `blackdetect`, `silencedetect`
- ไม่อ่าน camera RAW (R3D/BRAW/ARRIRAW) — ผู้ใช้ไม่ใช้ จึงไม่กระทบ

### 2.4 ความเข้ากันได้
- MCP (stdio) ใช้ได้กับ Claude Code/Desktop, Codex (`config.toml`), Cursor, Gemini CLI ฯลฯ
- Skill รูปแบบ `SKILL.md` ใช้ได้ทั้ง Claude (`~/.claude/skills`) และ Codex (`~/.codex/skills`, รองรับ symlink)

---

## 3. สถาปัตยกรรม

```
                 ┌──────────────────────────────────────────────┐
  Claude / Codex │  Skills (SKILL.md)      Technique Library     │  ← สมอง + รสนิยม + วิธีทำ
  (agent)        │  genre: csr / ad / reels / recap / ...        │
                 └───────────────────┬──────────────────────────┘
                                     │ MCP (stdio)
                 ┌───────────────────▼──────────────────────────┐
                 │  editmcp server (TypeScript)                  │  ← มือ
                 │  project.json = single source of truth        │
                 ├───────────┬────────────┬───────────┬──────────┤
                 │ ae-engine │ assembly   │ audio     │ xml-io   │
                 │ -noui job │ segment    │ mix/duck/ │ xmeml    │
                 │ runner +  │ cache +    │ loudness  │ write +  │
                 │ aerender  │ concat     │           │ read     │
                 ├───────────┴────────────┴───────────┴──────────┤
                 │ qc (blackdetect/freezedetect/silence/loudness/spec) │
                 └───────────────────────────────────────────────┘
                          │                      │
                 AfterFX.exe -m -noui       ffmpeg / ffprobe
                 aerender.exe -mfr          (NVENC)
```

**หลักการ 4 ข้อ**
1. `project.json` เป็นความจริงเดียว — ทุกเครื่องมืออ่าน/เขียนที่นี่ (เก็บเป็น **เฟรม** ไม่ใช่วินาที)
2. **ทุกอย่างเป็น cache ที่มีลายนิ้วมือ (fingerprint)** — comp, segment, dissolve, audio mix, deliverable
3. **ไม่เขียนทับไฟล์** — ทุก output เป็นเวอร์ชันใหม่ + log ว่ามาจากแผนไหน/คำสั่งอะไร
4. Premiere/AE GUI เป็น **ทางเลือก** ไม่ใช่ทางบังคับ — pipeline หลักไม่ต้องเปิดโปรแกรม Adobe

---

## 4. โมเดลข้อมูล `project.json` (ย่อ)

```jsonc
{
  "fps": 25, "size": [1920, 1080],
  "assets": {
    "A01": { "path": "footage/คลิป01.mp4", "hash": "...", "kind": "camera" },
    "C_title01": { "kind": "aecomp", "aep": "ae/STB_CSR_Titles.aep", "comp": "Title_01",
                   "fingerprint": "…", "render": { "path": "cache/renders/C_title01_v3.mov", "frames": 150 } }
  },
  "timeline": {
    "video": [
      { "id": "s1", "src": "C_title01", "in": 0,  "dur": 125, "scale": 100, "marker": "เปิดเรื่อง" },
      { "id": "s2", "src": "A01",       "in": 312, "dur": 88 }
    ],
    "cuts": [ { "between": ["s1","s2"], "dissolve": 10 } ],      // เฟรม; 0 = คัตตรง
    "audio": {
      "vo":    [ { "src": "VO01", "at": 0 } ],
      "music": [ { "src": "M01", "at": 0, "duck": { "under": "vo", "db": -12 } } ],
      "sfx":   [ { "src": "SFX_whoosh_03", "at": 124 } ]
    }
  },
  "delivery": { "master": "prores422hq", "targets": ["online_h264", "broadcast_xdcam"] },
  "cache": { "segments": {}, "dissolves": {}, "audio": {} }
}
```

---

## 5. กลไกหลัก

### 5.1 AE engine (headless)
- **Job runner:** MCP เขียน `job.json` (UTF-8) → spawn `AfterFX.com -m -noui -r runner.jsx` พร้อม timeout + kill process tree
  - `runner.jsx`: `beginSuppressDialogs()`, `saveProjectOnCrash=false`, เปิด **สำเนา** ของ .aep, ทำงานตามคำสั่ง, `save()`, เขียน `result.json`, `app.exitCode`, `app.quit()`
  - ข้อมูลไทยส่งผ่านไฟล์ JSON เท่านั้น (ไม่ผ่าน argv)
- **คำสั่งมาตรฐาน:** list comps/layers, set text/media/color, shift layer timing, add effect/preset (`.ffx`), set keyframe/expression, duplicate comp from template, run arbitrary JSX (escape hatch = ใช้เครื่องมือ AE ได้หมด)
- **Fingerprint ต่อ comp:** hash ของ layer tree + property values/keyframes + expressions + source names → รู้ว่า comp ไหนเปลี่ยน (รวมถึงกรณีผู้ใช้ไปแก้ใน AE GUI เองแล้ว save)
- **Render:** `aerender -project copy.aep -comp X -mfr ON 90 -RStemplate "Best Settings" -OMtemplate "<ProRes>" -output cache/tmp/ascii_name.mov` → rename ไปชื่อจริง
  - render **ทั้ง comp** (ไม่ใช่เฉพาะช่วงที่ใช้) เพื่อให้ slip/ยืดใน Premiere ได้ภายหลัง และ render ใหม่เฉพาะ comp ที่ fingerprint เปลี่ยน
  - รันขนาน N ตัว (ค่าเริ่มต้น 2; ปรับตามผลวัดจริง)
  - OM template ProRes: ให้ผู้ใช้สร้างใน GUI ครั้งเดียว (หรือ fallback "Lossless" → ffmpeg แปลงเป็น ProRes)
- **Preview เฟรม:** aerender `-s N -e N` เป็น PNG (แทน `saveFrameToPng`)

### 5.2 Assembly engine — "แก้นิดเดียวไม่ต้อง render ใหม่หมด"
หัวใจของระบบ: **master = การต่อท่อนที่ encode ไว้แล้ว**

1. **Segment** = ท่อนภาพล้วน (ไม่มีเสียง) ใน ProRes 422 HQ เฟรมตรงเป๊ะ
   - จาก AE render (ProRes, all-intra) → ตัดด้วย `-c copy` ไม่ encode ซ้ำ
   - จากกล้อง (H.264) → transcode เป็น ProRes ครั้งเดียวแล้ว cache
   - จากภาพนิ่ง/สไลด์ → สร้างครั้งเดียว
   - key = hash(source hash, in, out, scale, codec params)
2. **Dissolve segment** = ท่อนสั้น N เฟรมที่ `xfade` จากสองข้าง (ใช้ handle ที่มีใน render เต็ม comp)
   - key = hash(segA, segB, N, curve)
   - คณิตศาสตร์: cut ที่เฟรม C, a = floor(N/2), b = N − a → ครอบ [C−a, C+b) ความยาวรวมไม่เปลี่ยน (ตรงกับ Premiere)
3. **Concat** ทุกท่อนตามลำดับด้วย concat demuxer `-c copy` → **วิดีโอ master ไม่ encode ซ้ำเลย** ใช้เวลาไม่กี่วินาที
4. **Audio** render ใหม่ทั้งเรื่องทุกครั้ง (เร็ว, วินาทีเดียว): VO + music (ducking) + SFX → loudnorm ตามปลายทาง → PCM 24-bit
5. **Mux** video + audio → `master_vNN.mov`
6. **Deliverables** จาก master: online H.264 (NVENC, high bitrate, −14 LUFS), broadcast (เช่น XDCAM HD422 50 Mbps MXF, −24 LKFS/−23 LUFS ตามสถานี), ProRes master ให้ลูกค้า — encode ครั้งเดียวต่อปลายทาง

**ผลลัพธ์ (ประเมิน ยังไม่ได้วัด):** แก้ข้อความ 1 comp → render comp นั้น 1–2 นาที → ต่อ + เสียง + mux < 1 นาที → deliverable H.264 3 นาทีด้วย NVENC < 1 นาที — เทียบกับ 30+ นาทีตอนนี้ และ **คุณภาพเท่า export ตรงจาก AE** เพราะไม่มี generation loss

**ทางเลือกขั้นต่อไป (ไม่อยู่ใน MVP):** render title/overlay เป็น ProRes 4444 alpha แยกจากฟุตเทจ แล้ว composite ด้วย ffmpeg → เปลี่ยนฟุตเทจไม่ต้อง render title ใหม่ และกลับกัน

### 5.3 Premiere hand-tweak loop
```
project.json ──export_premiere_xml──▶ seq.xml ──เปิดใน Premiere──▶ ขยับ/slip/trim เอง
     ▲                                                                   │
     └──import_premiere_xml◀── File > Export > Final Cut Pro XML ◀───────┘
                │
        diff → render เฉพาะ dissolve/segment ที่กระทบ → master ใหม่ (วินาที–นาที)
```
- XML ลิงก์ไปที่ **render เต็ม comp** และไฟล์กล้องต้นฉบับ (ไม่ใช่ท่อน cache) → ใน Premiere ยืด/slip ได้ตาม handle
- ไม่มี Dynamic Link → Premiere เบา และถ้าผู้ใช้อยาก export จาก Premiere เองก็เร็วเช่นกัน
- เขียน xmeml เอง (ไม่ผ่าน otio-fcp-adapter เพราะตัวนั้นไม่เขียน audio crossfade/scale): clipitem, transitionitem (video+audio), marker, Basic Motion scale, sequence 1080p25
- Reader: map `pathurl` → asset id → timeline ใหม่ → diff กับของเดิม
- **ต้องทดสอบจริง:** Premiere 2026 กับ dissolve เลขคี่, ค่า Motion ตอน import (เคยมีบั๊ก), ไฟล์ path ไทยใน `pathurl`

### 5.3.0 Premiere handoff ไม่ใช้ computer use (CatCut bridge)
- Premiere ไม่มีโหมด headless/command-line → ต้องมีตัวรับคำสั่งอยู่ใน Premiere: `premiere/catcut-bridge` (CEP) มี 2 ตัวในชุดเดียว
  - `com.catcut.bridge.auto` ไม่มีหน้าต่าง เริ่มเองเมื่อ Premiere เปิด (`StartOn ApplicationActivate`) → ไม่ต้องเปิด panel / กด connect
  - `com.catcut.bridge.panel` (Window > Extensions > CatCut Bridge) ดูสถานะ + สำรองถ้า auto-start ไม่ทำงานในบางเวอร์ชัน; มีตัวเดียวที่รับงาน (lock ด้วย heartbeat)
- คิวเป็นไฟล์ใน `%TEMP%\catcut-premiere-bridge` (ASCII): `<id>.req.json` → `<id>.res.json`, `bridge.json` = heartbeat ทุก 2 วิ; ไฟล์ที่ Premiere อ่าน/เขียนผ่านโฟลเดอร์นี้เสมอ (path ไทยไม่ถึง Premiere)
- host.jsx ทำได้แค่ ping/status/importXml/exportXml — ไม่มี save/close/open โปรเจกต์ Premiere
- `premiere_push {project}`: export_premiere_xml → import เข้า bin "CatCut" ของโปรเจกต์ที่เปิด (ต้องระบุชื่อโปรเจกต์ให้ตรง ป้องกันใส่ผิดงาน; host เช็คซ้ำอีกชั้น) แล้วเปิด sequence
- `premiere_pull {sequence?, apply?}`: Premiere `exportAsFinalCutProXML` → `out/premiere/<seq>.xml` (ไม่เขียนทับ) → import_premiere_xml (dry run เว้นแต่ apply)
- ติดตั้งครั้งเดียว: `catcut premiere-bridge install` (ก๊อปไป `%APPDATA%\Adobe\CEP\extensions\com.catcut.bridge` + `PlayerDebugMode=1` ใน HKCU CSXS.9–12) แล้วรีสตาร์ต Premiere; จอดับ/ล็อกจอได้ แต่ห้าม sleep/log off
- ยังต้องลองกับ Premiere จริง: auto-start event ใน Premiere 2026, import XML ที่มีสื่อหาย (dialog อาจค้าง → request timeout แล้วถอนคิว)

### 5.3.1 FilmCraft (ArtCraft) — รอบเดียวกัน คนละสำนวน XML
- `export_premiere_xml {target: "filmcraft"}`: ทุกขอบคลิปเป็นตัวเลขที่จุดตัด, in/out เฉพาะตัวคลิป (ไม่รวมครึ่ง dissolve), transitionitem เหมือนเดิม ([C−a, C+b))
  - เหตุผล: FilmCraft 0.6.0 อ่าน `-1` แบบ Premiere ผิด — คลิปถัดจาก dissolve ถูกย้ายไป V2 / คลิประหว่าง dissolve สองอันหายไป
  - ทดสอบจริงกับ `filmcraft-cli` แล้ว: คลิป/dissolve 10 และ 13 เฟรม/marker/scale/เสียงกลับมาครบทุกเฟรม ไม่มีคำเตือน
- Reader รับได้ทั้งสองแบบ: ขอบคลิปที่ระบุเลขและพบกันในช่วง dissolve = จุดตัดจริง (FilmCraft สร้าง dissolve เลขคี่แบบ 7/6 → คงจุดตัดไว้ เตือน แล้วจัดกึ่งกลางตามกฎเราตอน export ครั้งถัดไป)
- FilmCraft ไม่เก็บชื่อแทร็ก (`MZ.TrackName`) → ถ้าแทร็กไม่มีชื่อ เลน vo/music/sfx ใช้ id คลิปที่โปรเจกต์มีอยู่ (ต้อง src ตรงกันด้วย) ก่อนเดาจากตำแหน่ง
- `doctor` หา `filmcraft-cli.exe` / `effectcraft-cli.exe` (Program Files หรือ `EDITMCP_FILMCRAFT_DIR` / `EDITMCP_EFFECTCRAFT_DIR`)
- ถัดไป (ยังไม่ทำ): สั่ง FilmCraft ผ่าน MCP/CLI ตรง ๆ แทนไฟล์ XML

### 5.3.2 EffectCraft (ArtCraft) — motion backend คู่กับ AE
- `createMotionBackend` (src/engine/effectcraft.ts) ส่งงานตามนามสกุล: `.ecproj` → EffectCraft, อื่น ๆ → After Effects → build / fingerprint / render / `ae_*` ไม่ต้องรู้ว่าเป็นโปรแกรมไหน; asset ยังเป็น `aecomp` (field `aep` เก็บ path `.ecproj` ได้)
- รายชื่อ comp, ความยาว, fingerprint: อ่าน JSON ของ `.ecproj` ตรง ๆ ไม่เปิดโปรแกรม; fingerprint = comp + item ที่ layer อ้างถึง (precomp/solid/footage) + comp ที่ expression `comp("…")` อ้างถึง + project settings + hash เนื้อไฟล์ footage
- inspect / edit / create: `effectcraft-cli script` + `jsx/ec-runner.jsx` (object model แบบ AE แต่ **ต้องใช้ match name** — `property("Position")` ได้ null; text ใหม่ใช้ `new TextDocument`)
- render: `effectcraft-cli render --comp <name> --format prores --prores hq` ลง temp ASCII แล้วย้าย (CLI เขียนทับเงียบ ๆ); ช่วงเฟรมส่งเป็นวินาทีกว้างครึ่งเฟรม (`[start, end)` และ snap ที่เวลาเฟรม); preview: `render-frame --comp <id>`
- ProRes ของ EffectCraft (apch, timebase 1/25, vendor 0000, แท็ก bt709) ต่อ `concat -c copy` ได้ bit-exact เพราะ segment ทุกตัวผ่าน `-video_track_timescale` อยู่แล้ว — ทดสอบจริงทั้ง loop: ae_create → build → แก้ข้อความ → build ใหม่ render แค่ comp + segment/dissolve ที่โดน
- AE-only (ยังไม่มีใน EffectCraft): `template_scan`, `comp_lint`, `font_audit`, `applyPreset` (.ffx), เตือน GUI เปิดค้าง
- เทสต์จริง (opt-in): `CATCUT_EFFECTCRAFT_IT=1 npm test -- effectcraft`

### 5.4 QC อัตโนมัติ (ทุก build)
- ภาพ: จำนวนเฟรม = แผน, `blackdetect`, `freezedetect` (จับอาการ "ค้าง" แบบที่ 00:00:34:23) → รายงานว่าช็อตไหน/comp ไหน
- เสียง: `silencedetect`, integrated loudness + true peak ตาม preset, เช็ก phase/clipping
- ไฟล์: codec/bitrate/fps/size ตรง spec ปลายทาง
- สร้าง contact sheet + พรีวิวไฟล์เล็กทุกเวอร์ชันให้ดูเร็ว

---

## 6. ชุดคำสั่ง MCP (ตั้งใจให้น้อยและอ่านรู้เรื่อง)

| กลุ่ม | tool | ทำอะไร |
|---|---|---|
| project | `project_new` / `project_open` / `project_status` | สร้าง/เปิด/ดูสถานะ (comp ไหนต้อง render, cache hit) |
| assets | `scan_footage` | ทำดัชนีฟุตเทจ: thumbnail, ความยาว, ถอดเสียงพูด, คุณภาพ (สั่น/เบลอ/ดำ) |
| ae | `ae_list_comps` / `ae_inspect_comp` | ดูโครง comp/layer |
| ae | `ae_edit` | แก้ comp ด้วยคำสั่งระดับสูง (text, media, color, timing shift, preset) |
| ae | `ae_script` | รัน JSX ใด ๆ (escape hatch — ใช้ทุกเครื่องมือของ AE) |
| ae | `ae_preview_frame` | ภาพเฟรมเดียวจาก comp |
| timeline | `timeline_set` / `timeline_edit` | วางแผนทั้งเรื่อง / แก้เฉพาะจุด (insert, move, trim, dissolve, marker) |
| audio | `audio_add` / `audio_find_sfx` / `audio_music_fit` | ใส่ VO/เพลง/SFX, ค้น SFX จากคลังที่มีสิทธิ์, ตัดเพลงให้พอดี/ตามบีต |
| build | `build` | render ส่วนที่เปลี่ยน → assemble → QC → master (incremental เสมอ) |
| build | `preview` | พรีวิวไฟล์เล็กเร็ว ๆ |
| build | `deliver` | สร้าง deliverable ตาม preset |
| premiere | `export_premiere_xml` / `import_premiere_xml` | รอบแก้มือใน Premiere หรือ FilmCraft (`target: "filmcraft"`) |
| review | `review_cut` | สรุปสถิติ pacing/loudness/contact sheet ให้ agent วิจารณ์และแนะนำ |
| library | `technique_search` / `technique_apply` / `technique_save` | ใช้/บันทึกเทคนิค (ดูข้อ 7) |

---

## 7. Skills & Technique Library (เทคนิคจากทั่วโลก + ขยายเองได้)

### 7.1 สองชั้น
- **Skill (SKILL.md)** = *วิธีคิด* ต่อแนวงาน: เช่น `edit-csr`, `edit-ad-30s`, `edit-reels-916`, `edit-event-recap`, `edit-interview` — บอกโครงเรื่อง, pacing, สูตร dissolve, แนวเสียง, checklist ส่งงาน; ใช้ได้ทั้ง Claude และ Codex
- **Technique** = *ของที่ใช้ได้จริง* 1 โฟลเดอร์/เทคนิค:
  ```
  techniques/<slug>/
    TECHNIQUE.md     # ทำอะไร เมื่อไรควรใช้ พารามิเตอร์ ที่มา ลิขสิทธิ์
    preset.ffx       # animation preset ของ AE (ถ้ามี)
    apply.jsx        # สคริปต์ AE (ถ้ามี)
    recipe.ffmpeg    # filter graph (ถ้ามี)
    template.aep     # (ถ้ามี)
    test/            # input เล็ก + เฟรมอ้างอิง สำหรับ test headless
  ```
  ตัวอย่าง: kinetic text, lower third, speed ramp, whip-pan transition, J/L cut, beat-sync cut, film-grain look, LUT-based grade, audio ducking curve

### 7.2 Agent หาเทคนิคเพิ่มเอง (`technique_research`)
web search / ดูคลิปสอน (skill `watch`) → สกัดเป็นสูตร (พารามิเตอร์, ลำดับขั้น) → เขียนเป็น technique → **ทดสอบ headless** บนโปรเจกต์ตัวอย่างใน sandbox → ให้ผู้ใช้ดูผล → บันทึกเข้าคลังพร้อมที่มา

### 7.3 โหมดให้คำแนะนำ
`review_cut` + ภาพ contact sheet → agent วิจารณ์ pacing, จังหวะเพลง, ความดัง, สี, ความสม่ำเสมอของกราฟิก และเสนอเทคนิคจากคลัง (หรือไปหามาให้) โดยไม่ต้องแก้งานเอง

### 7.4 ความปลอดภัย (ต้องพูดตรง ๆ)
- สคริปต์ AE จากอินเทอร์เน็ตรันได้เต็มสิทธิ์ของผู้ใช้ (อ่าน/เขียนไฟล์, เครือข่าย) → ทุก technique ที่ดึงมาต้อง **ผ่านการอ่านโค้ด + รันบนสำเนาใน sandbox ก่อน** และบันทึก provenance
- preset/template/เพลง/SFX ต้องมีไลเซนส์ที่ใช้ทางการค้าได้ (เก็บ license ในแต่ละ technique/asset)

---

## 7.5 Smart Edit mode — รีวิวแล้วสั่งแก้ด้วยการวงปากกา

### ปัญหาที่แก้
ตอนนี้ผู้ใช้ต้องดูไฟล์ export, จดไทม์โค้ด (เช่น 00:00:18:11–00:00:24:02) มาวาง, แคปเฟรม แล้วพิมพ์อธิบายยาว ๆ ว่าตำแหน่งไหนต้องแก้อะไร

### หน้าตา (เว็บแอปในเครื่อง เปิดจาก MCP: `review_open`)
- **เครื่องเล่น** ไฟล์รีวิวของเวอร์ชันล่าสุด: เดินทีละเฟรม (←/→), J/K/L, แสดงไทม์โค้ด `HH:MM:SS:FF` ตลอด
- **เลือกช่วงง่าย**: กด `I`/`O` ตั้งจุดเข้า/ออก, ลากบนแถบไทม์ไลน์, หรือ **คลิกช็อต** (ระบบรู้ขอบเขตทุกช็อต/comp จาก `project.json` จึง snap ให้อัตโนมัติ) — ไม่ต้องพิมพ์ไทม์โค้ดเลย
- **ปากกาบนเฟรม**: วงกลม/ลูกศร/กรอบ บนเฟรมที่หยุดอยู่ **สีปากกา = ประเภทการแก้** (ตั้งค่าได้) เช่น
  - แดง = ตัดออก/สั้นลง · เหลือง = ไทม์มิ่ง/ขยับ · น้ำเงิน = ข้อความ/กราฟิก · เขียว = สี/แสง · ม่วง = เสียง
- **โน้ตต่อจุด**: พิมพ์สั้น ๆ หรืออัดเสียงแล้วถอดเป็นข้อความ; แต่ละโน้ตผูกกับ {ช่วงเวลา, เฟรม, พื้นที่ที่วง, สี/ประเภท, ช็อต/comp ที่ระบบจับคู่ให้}
- **มินิเซสชัน**: เพิ่มได้หลายจุด เลื่อนไปจุดอื่นต่อได้ บันทึกอัตโนมัติ กลับมาทำต่อได้ ส่งเมื่อพร้อม (`review_submit`)
- **หลังแก้**: เวอร์ชันใหม่เปิดพร้อมโน้ตเดิมในสถานะ "แก้แล้ว" เทียบก่อน/หลังที่เฟรมเดียวกันได้ทันที

### ระบบตีความ "วงตรงนี้" เป็นคำสั่งจริงได้อย่างไร
1. เฟรม + ช่วง → ช็อต/segment และ comp ต้นทาง (จาก `project.json`)
2. พื้นที่ที่วง (พิกัดปกติ 0–1) → **hit-test กับ layer ของ comp ที่เฟรมนั้น** (ขอบเขต layer ดึงจาก AE headless ครั้งเดียวต่อ render แล้ว cache เป็น `layermap.json`) → รู้ว่าวงโดน text layer "Title_01" หรือฟุตเทจ "A07"
3. สี/ประเภท + โน้ต → agent แปลงเป็นคำสั่ง (`timeline_edit` / `ae_edit` / `audio_*`) แสดง **แผนการแก้ให้ยืนยัน** ก่อน build (ไม่ลงมือเอง)
4. build แบบ incremental → เฉพาะช็อตที่ถูกแตะ render ใหม่ → QC → เวอร์ชันใหม่

### ข้อมูลที่เก็บ (`review/<version>/session.json`)
```jsonc
{ "version": "v12", "notes": [
  { "id": "n3", "tcIn": "00:00:18:11", "tcOut": "00:00:24:02", "frame": 461,
    "shot": "s7", "comp": "C_title03", "layerHit": ["Title_03/Text"],
    "intent": "text", "color": "#2d6cdf", "region": { "kind": "circle", "cx": .62, "cy": .41, "r": .09 },
    "text": "ชื่อสะกดผิด ใช้ 'ธนาคาร'", "status": "open" } ] }
```

### ทำไมเป็นเว็บแอปในเครื่อง ไม่ใช่ artifact บน claude.ai
- ไฟล์รีวิว 3 นาทีแม้ย่อเป็น 720p ก็เกินขีดจำกัดของ artifact; ในเครื่องเล่นได้ทันทีจากดิสก์ ไม่ต้องอัปโหลด
- ใช้ได้กับทั้ง Claude และ Codex (MCP แค่ชี้ไฟล์ session ให้ agent อ่าน)
- ทางเลือกเพิ่มทีหลัง: ให้ลูกค้ารีวิวจากข้างนอกผ่าน artifact ด้วยพร็อกซีสั้น ๆ หรือดึงคอมเมนต์จาก Frame.io (มี API ที่ส่งทั้งไทม์โค้ดและรูปวาด) เข้าระบบเดียวกัน

### อยู่ในเฟสไหน
เฟส 2 (หลัง Core): เครื่องเล่น + เลือกช่วง + ปากกา + session → เฟส 3: hit-test layer, voice note, เทียบก่อน/หลัง

## 7.6 Creative Director mode — เมื่อผู้ใช้คิดไม่ออก

### สถานการณ์
"ช่วงนี้ประมาณ 10 วิ ใช้เอฟเฟกต์อะไรดี ตัดแบบไหนดี" / "ไม่มีไอเดียเลย" / วงปากกาในรีวิวแล้วเลือก "ช่วยคิด" — agent ต้องเสนอทางเลือกระดับมืออาชีพ พร้อมเรฟจริงที่ถูกใช้อยู่ และให้ผู้ใช้ **เลือกด้วยตา** ไม่ใช่อ่านคำอธิบายยาว

### หลักสำคัญ (ป้องกันเรฟมั่ว)
- agent **ห้ามอ้างเรฟที่ยังไม่ได้เปิดดูจริง** ทุกเรฟต้องผ่านการค้น + ดึง + วิเคราะห์ (skill `watch` / scene detect) ก่อนเสนอ ชื่อคลิปที่จำได้จากความจำถือเป็นแค่ "คำค้น"
- เรฟใช้เพื่อ "อ้างอิงสไตล์" ไม่ใช่คัดลอกฟุตเทจ/กราฟิก/เพลงของเขา
- ทุกข้อเสนอมาเป็น **ตัวอย่างที่ดูได้** (เฟรมของเรฟ + พรีวิว 2–3 วิ ที่ระบบ render ด้วยเทคนิคนั้นบนฟุตเทจของผู้ใช้จริง) ให้เลือก A/B/C

### 4 แหล่งความฉลาด
| ชั้น | คืออะไร | มาจากไหน |
|---|---|---|
| **1. Craft knowledge** (ติดมากับ harness) | หลักตัดต่อที่ใช้ได้ทุกแนว: โครงเรื่อง (CSR: hook→ปัญหา→การลงมือ→ผลลัพธ์→CTA; โฆษณา 30 วิ: hook 3 วิแรก/จังหวะเผยสินค้า; Reels: pattern interrupt ทุก 2–3 วิ), ไวยากรณ์การตัด (J/L cut, match cut, จังหวะตามบีต), เมื่อไรใช้ dissolve/whip/cut, sound design, motion graphic style families, typography, สี | เขียนเป็น reference files ของ skill `edit-core` พร้อมที่มา (industry playbooks, YouTube/Meta/TikTok creative guides) |
| **2. Reference finder** (สด) | ค้นเรฟใกล้เคียงตามบริบท {แนว, อารมณ์, หน้าที่ของช่วงนั้น, ความยาว, เพลง} จาก YouTube/Vimeo Staff Picks/Motionographer/Behance/Ads of the World/คลังโฆษณาไทย (Adman, B.A.D) และเทรนด์ปัจจุบัน (TikTok Creative Center ฯลฯ) → ดึงมาดู → สกัดสไตล์ (ความยาวช็อตเฉลี่ย, ทรานซิชัน, สี, ฟอนต์, จังหวะเพลง) | web search + `watch` + scene detect; ผลลัพธ์ cache ลง `refs/` |
| **3. Reference memory** (โตขึ้นเรื่อย ๆ) | เรฟที่เคยใช้/ชอบ พร้อมผลวิเคราะห์ ติดแท็กแนว/อารมณ์/เทคนิค; ค้น "ที่เคยชอบ" ก่อนไปหาใหม่ | `refs/<id>/` (เฟรม, analysis.json, ที่มา) |
| **4. Taste profile** | เรียนจากสิ่งที่ผู้ใช้เลือก/ไม่เลือก/สั่งแก้ (เช่น ชอบ cut แห้งมากกว่า dissolve, ชอบ kinetic type หนา ๆ) เพื่อจัดลำดับข้อเสนอครั้งต่อไป; ดูและแก้ได้ โปร่งใส | `taste.json` อัปเดตหลังทุกรอบรีวิว |

### การทำงาน (`suggest` tool)
1. รับบริบท: ช่วงเวลา/ช็อต (จาก Smart Edit หรือแชท), บรีฟ, เพลง, สิ่งที่อยู่ก่อน-หลังช่วงนั้น
2. ค้นเรฟ 3–5 ตัว (memory ก่อน แล้วเว็บ) → ดูจริง → สกัดสไตล์
3. จับคู่กับ Technique Library (ข้อ 7.1) → เลือก 2–3 ทางที่ทำได้จริงกับฟุตเทจที่มี
4. render พรีวิวสั้น ๆ ของแต่ละทาง (headless, ไม่กี่วินาที–นาที) + เฟรมเรฟ + เหตุผล 1 บรรทัด ("ทำไมเหมาะกับช่วงนี้")
5. ผู้ใช้เลือก A/B/C (หรือ "ผสม A กับ B") → apply → บันทึกเข้า taste profile และ reference memory

### โหมดเชิงรุก
- ตอนวางแผนครั้งแรกจากบรีฟ: agent เสนอ "ภาพรวมสไตล์" 2–3 แบบ พร้อม moodboard จากเรฟจริง ก่อนเริ่มตัด
- ตอน review: ถ้า agent เห็นจุดที่ "แก้ได้ดีกว่านี้" (pacing ตก, กราฟิกไม่สม่ำเสมอ, เสียงเบา) เสนอเป็นโน้ตแยก ไม่แก้เอง

### ข้อจำกัดที่ต้องพูดตรง ๆ
- รสนิยมสุดท้ายเป็นของผู้ใช้ ระบบเสนอให้เลือก ไม่ตัดสินแทน
- การดึงเรฟบางแหล่งต้องมีสิทธิ์เข้าถึง (เช่น คลังที่ต้อง login) และควรเคารพเงื่อนไขของแต่ละเว็บ
- เทรนด์เปลี่ยนเร็ว: ความรู้ชั้น 1 ให้หลักการ ส่วน "ตอนนี้ฮิตอะไร" ต้องค้นสด

## 8. ความเข้ากันได้ (Claude / Codex / อื่น ๆ)
- ตัว MCP เป็น stdio server มาตรฐาน → ตั้งค่าใน Claude Code (`.mcp.json`), Claude Desktop, Codex (`~/.codex/config.toml [mcp_servers]`), Cursor ได้
- Skills เป็น `SKILL.md` → วางที่ `~/.claude/skills` และ symlink ไป `~/.codex/skills`
- Technique Library และ `project.json` ไม่ผูกกับ agent ตัวไหน → เปลี่ยน agent ได้โดยงานไม่หาย

---

## 9. แผนทำเป็นเฟส

| เฟส | ได้อะไร | เงื่อนไข |
|---|---|---|
| **0. Validate** (ทำใน `D:\EDITMCP` เท่านั้น หลังงาน CSR ส่งแล้ว) | ยืนยันสมมติฐานทั้งหมดบน AE 26.5 / Premiere 2026 / ffmpeg 9 | ดูข้อ 10 |
| **1. Core** | AE headless job runner + aerender + fingerprint cache + segment assembly + master ProRes + XML export + QC พื้นฐาน | = แทน workflow CSR ปัจจุบันได้ โดยไม่เปิด Adobe |
| **2. Loop & Deliver** | import XML กลับ, deliverable presets + loudness, contact sheet/preview, `review_cut` | |
| **3. Audio & Index** | คลัง SFX/เพลง ค้นได้, beat-sync, ducking, `scan_footage` ถอดเสียง/คุณภาพ | ต้องรู้คลังเสียงของผู้ใช้ |
| **4. Skills & Library** | skill แนวงานแรก (แนวที่ทำบ่อยสุด), technique library + `technique_research` | |
| 5+. | alpha-layer cache, AE worker ค้างไว้เบื้องหลัง (เร็วขึ้นแต่ต้องพิสูจน์), แนวงานเพิ่ม | |

ภาษา: **TypeScript** (ecosystem MCP/AE เดิมเป็น TS, spawn process ง่าย) — เปลี่ยนเป็น Python ได้ถ้าผู้ใช้ต้องการ

---

## 10. สิ่งที่ต้องทดสอบก่อนเขียนจริง (Phase 0 — ลำดับตามความเสี่ยง)

1. `AfterFX.com -m -noui -r smoke.jsx` บน AE 26.5: รันได้ไหม, exit code กลับมาไหม, **ไม่แตะ AE GUI ที่เปิดอยู่** (ทดสอบทั้งตอน GUI ปิดและเปิด), เวลา startup ต่อ job
2. aerender ProRes: มี OM template ProRes ให้ใช้ไหม / สร้างครั้งเดียวใน GUI / fallback Lossless; เวลา render กับ `-mfr ON`; ขนาน 2 vs 1
3. ffmpeg: ตัด ProRes `-c copy` ตรงเฟรม, concat `-c copy` รอยต่อไม่สะดุด (ตรวจ frame count + ดูเฟรมรอบรอยต่อ), xfade segment ตรงสูตร, mux เสียง
4. Premiere 2026: import xmeml ที่สร้างเอง (clip + dissolve คี่/คู่ + marker + scale + path ไทย) → อ่าน translation report → export FCP XML กลับ → parser อ่านได้
5. ไทย: ข้อความไทยใน AE (วรรณยุกต์) ตรวจจากเฟรม, ชื่อไฟล์ไทยทั้ง AE และ ffmpeg
6. fingerprint comp: เวลาและความแม่น (แก้ 1 keyframe ต้องเปลี่ยน, เปิด-ปิดเฉย ๆ ต้องไม่เปลี่ยน)

ไฟล์ทดสอบที่มีอยู่: `tests/noui_smoke.jsx`, `tests/run_noui_smoke.ps1` — ต้องแก้ให้ใช้ `-m` และ `AfterFX.com` ก่อนรัน

---

## 10.5 อัปเดตตัวเองตามเวอร์ชันของโปรแกรม (self-maintaining)

### สิ่งที่ทำอัตโนมัติ
1. **ค้นหาโปรแกรมเอง ไม่ hardcode path**: สแกน `C:\Program Files\Adobe\Adobe After Effects *`, Premiere, Media Encoder, ffmpeg ทุกครั้งที่เริ่ม; อ่านเวอร์ชันจริง (`app.version` ผ่าน job headless, `ffmpeg -version`)
2. **ตารางความเข้ากันได้ `compat.json`**: เก็บว่าเวอร์ชันไหน "ผ่านการทดสอบแล้ว" พร้อมผล (noui ใช้ได้?, OM template ProRes มี?, บั๊ก path ไทยยังอยู่?, XML import ผ่าน?)
3. **เจอเวอร์ชันใหม่ → รันชุดทดสอบ Phase 0 เอง** (ใน sandbox ของ EDITMCP ไม่แตะโปรเจกต์ผู้ใช้) แล้วสรุปให้ผู้ใช้: ผ่านทั้งหมด / ผ่านบางส่วนพร้อม fallback ที่เปิดใช้ / ต้องรอแก้
4. **ติดตั้งของที่ต้องมีซ้ำให้เวอร์ชันใหม่**: OM template ProRes, seed project, ฟอนต์เช็กลิสต์
5. **fallback อัตโนมัติ**: ถ้าข้อใดล้ม ระบบสลับไปทางสำรองที่พิสูจน์แล้ว (เช่น Lossless → ffmpeg, ขนาน → ทีละตัว) และบอกผู้ใช้สั้น ๆ ไม่หยุดงาน
6. **อัปเดตตัว MCP**: เช็กเวอร์ชันใหม่จาก release channel (GitHub/npm) → `editmcp update` พร้อม changelog; เปิดอัปเดตอัตโนมัติได้ แต่ **ไม่อัปเดตกลางคัน** ระหว่างมี job ค้าง
7. **อัปเดตความรู้**: เมื่อ Adobe ออกเวอร์ชันใหม่ agent ค้น release notes/API changes → เพิ่มลง compat notes และ technique library (ผ่านรีวิวเหมือน technique อื่น)

### ออกแบบเผื่ออนาคตของ Adobe
- Adobe กำลังย้ายจาก ExtendScript ไป UXP (Premiere ก่อน, AE ตามมา) → AE engine อยู่หลัง interface เดียว (`AeBackend`: ExtendScript-headless วันนี้, UXP/อื่นในอนาคต) เปลี่ยน backend ได้โดยคำสั่ง MCP ไม่เปลี่ยน
- ทุกอย่างที่ผูกเวอร์ชัน (ชื่อ template, pref key, ไฟล์ startup) อยู่ในไฟล์ config เดียว ไม่กระจายในโค้ด

### สิ่งที่รับประกันไม่ได้
- เวอร์ชันที่ยังไม่ออกอาจเปลี่ยนพฤติกรรมจนทดสอบไม่ผ่าน → ระบบจะบอกชัดว่าอะไรยังใช้ได้/ไม่ได้ และเสนอให้ใช้เวอร์ชันเดิมคู่กันไปก่อน (Creative Cloud ติดตั้งหลายเวอร์ชันพร้อมกันได้)

## 11. ข้อจำกัดที่ต้องยอมรับ
- AE headless เสียเวลาเปิดโปรแกรมทุก job (หลายวินาที–หลายสิบวินาที) — ลดได้ด้วยการรวมหลายคำสั่งเป็น job เดียว; ตัว worker ค้างไว้ยังไม่พิสูจน์
- ฟีเจอร์ AE ที่ต้องใช้ UI (Roto Brush, Content-Aware Fill, dialog ของปลั๊กอินบางตัว, `executeCommand`) ทำ headless ไม่ได้ → ทำใน GUI แล้ว save, ระบบจับการเปลี่ยนด้วย fingerprint
- เอฟเฟกต์/ทรานซิชันเฉพาะของ Premiere ไม่มีใน ffmpeg → Premiere เป็นที่ "ขยับไทม์มิ่ง" ไม่ใช่ที่ใส่เอฟเฟกต์ (ลูกเล่นอยู่ใน AE หรือ technique library)
- รอบแรกได้ rough cut ที่ดี งานส่งลูกค้ายังต้องผ่านตาผู้ใช้ 1–3 รอบ
- ลิขสิทธิ์เพลง/SFX/preset เป็นความรับผิดชอบที่ระบบช่วยบันทึก แต่ตัดสินแทนไม่ได้

---

## 12. คำตอบจากผู้ใช้ (2026-10-11) และผลต่อดีไซน์
| คำถาม | คำตอบ | ผลต่อดีไซน์ |
|---|---|---|
| แนวงาน | **ใช้ได้กับทุกแนว** | skill แกนกลาง `edit-core` (โครงเรื่อง/pacing/เสียงทั่วไป) + โมดูลแนวงานเพิ่มทีหลัง; ไม่ผูก workflow กับแนวใดแนวหนึ่ง |
| คลังเสียง | **ยืดหยุ่น** | รองรับหลายแหล่งพร้อมกัน: โฟลเดอร์ในเครื่อง (สแกน+ทำดัชนี), โฟลเดอร์ดาวน์โหลดจาก Artlist/Epidemic, AI สร้าง SFX/เพลง (เช่น ElevenLabs ที่ต่ออยู่); ทุกไฟล์มีแท็กแหล่งที่มา+ไลเซนส์ |
| รูปแบบบรีฟ | **ทุกแบบ: วิดีโอเรฟ, PDF, ข้อความ** | ตัวรับบรีฟ: PDF → ข้อความ+ภาพ, วิดีโอเรฟ → วิเคราะห์จังหวะคัท/เพลง/สี (skill `watch` + scene detect), ข้อความ → ใช้ตรง; รวมเป็น `brief.json` ก่อนวางแผน |
| spec broadcast | **ให้เลือกจากสเปกยอดนิยม** | ทำหน้าเลือก preset: https://claude.ai/artifact/KsW47o7dvvQvU496q6hhgz (ค่าที่เลือกถูกอ่านไปตั้ง `deliver` preset) |
| OM template ProRes | **เอาที่เร็วที่สุด** | ตัวติดตั้งสร้าง template อัตโนมัติ: เปิด seed .aep (มี RQ item ProRes 422 HQ) แบบ headless แล้ว `outputModule.saveAsTemplate("EDITMCP ProRes 422 HQ")` ครั้งเดียว; ถ้าล้มเหลว fallback "Lossless" → ffmpeg แปลงเป็น ProRes อัตโนมัติ (ทดสอบใน Phase 0) |
| ภาษา | ผู้ใช้มอบให้ตัดสิน → **TypeScript** | คำสั่งจะเปลี่ยนบ่อยช่วงแรก; งานหนักอยู่ใน AE/ffmpeg อยู่แล้ว; แยกแกน (data model + process runner) ให้ port เป็น Rust ได้ถ้าต้องการไฟล์เดียวแจกทีหลัง |
| UI | ผู้ใช้: "minimal ง่ายไว้ก่อน" | **ข้อบังคับ UI:** ทุกหน้า/คำสั่งที่ผู้ใช้เจอเป็นแบบ เลือก/ติ๊ก/วง/ดูแล้วเลือก เท่านั้น; ตัวเลขและรายละเอียดเป็นหน้าที่ของ agent (ปรับได้ผ่านแชท) |

### 12.1 ยืนยันสองข้อที่ผู้ใช้ถาม
- **แก้เฉพาะจุดได้** (ข้อ 5.2): ระดับช็อต/comp — เปลี่ยน comp เดียว render แค่ comp นั้น; เปลี่ยนลำดับ/ความยาว/dissolve แทบไม่ render; ขั้นต่อไปทำ "render เฉพาะช่วงเฟรมของ comp แล้ว splice" ได้เพราะ ProRes เป็น all-intra
- **เปิดแก้เองใน Premiere ได้** (ข้อ 5.3): สิ่งที่ส่งกลับมาได้ = trim/slip/ย้าย/ความยาว dissolve/marker/scale-position-opacity; สิ่งที่ไม่กลับ = เอฟเฟกต์เฉพาะ Premiere (Lumetri, Warp Stabilizer) → ถ้าใช้ ให้ export จาก Premiere เอง (เร็วแล้วเพราะไม่มี Dynamic Link) หรือย้ายลูกเล่นนั้นไปทำใน AE/technique

### 12.2 ผลต่อ memory/ความลื่น (เครื่อง 16 GB, RTX 2070 SUPER 4 GB)
- ตัวจัดคิวที่เช็ค RAM ว่างก่อนเปิด aerender, ค่าเริ่มต้น render ทีละตัว, `-mem_usage` และ MFR % ตาม RAM ที่เหลือ
- ทุกงานหนักเป็น background job (ตอบ job id ทันที, `job_status`), โหมด low-priority เมื่อผู้ใช้กำลังใช้เครื่อง, watchdog
- orchestrator ไม่โหลดวิดีโอเข้า RAM; cache อยู่บนดิสก์
- แนะนำอัป RAM เป็น 32–64 GB — ช่วย AE มากกว่าการเลือกภาษาใด ๆ

---

## 13. บทเรียนจากงานจริง STB50Y CSR (อ่านประวัติเซสชัน 2026-10-10) → backlog

ที่มา: ประวัติเซสชัน "MCP ติดตั้งสำหรับ Premier Pro" (ข้อความผู้ใช้ 268 ข้อความ, 07:20–21:22) งานนี้คือเหตุผลที่ EDITMCP เกิดขึ้น

### 13.1 สิ่งที่ยืนยันว่าแผนเดิมถูก
- export ผ่าน Dynamic Link ~0.1× realtime (30–35 นาที / 3 นาที) vs aerender ขนาน + ประกอบ ~10 นาที → §5.2 ถูกทาง
- ~15 เวอร์ชัน export เต็ม (3 GB) และผู้ใช้บอก "ไม่ต้อง export… แก้ลงมาในไทม์ไลน์ก็พอ" → incremental + cache
- bridge panel หลุด, AE ค้างหลัง dialog ที่มองไม่เห็น, Premiere ปิดกลาง export, render ทับไฟล์ที่ถูกล็อก, comp ที่ลบแล้วสร้างใหม่กลายเป็น Media Offline → headless + never-overwrite
- ผู้ใช้ส่งโน้ต ~20 ครั้งเป็น "ไทม์โค้ด + แคปจอ + ข้อความยาว" → Smart Edit (§7.5)
- multi-agent (director / art director / motion / QA) วางแผนแต่ละท่อนแล้วผู้ใช้ "ลุย" ได้ผลดี → ใช้เป็นรูปแบบของ Creative Director

### 13.2 สิ่งที่ยังไม่มีในแผน/โค้ด (เรียงตามผลกระทบ)
| # | ปัญหาที่เกิดจริง (หลักฐาน) | สิ่งที่จะเพิ่ม |
|---|---|---|
| 1 | ทำตามบอร์ดผิดฉบับ ~1.5 ชม.; บอร์ดขัดกันเอง; ช็อตหลุดจากบอร์ด ("ช็อต 4 สวยๆ ก็หายไป", "ในบอร์ดไม่มีบอกให้รวม element อื่น"); chapter เลื่อน ~20 วิ | **`board_import`** → `board.json` {slot, chapter, boardTime, sourceFile, sourceTC, onScreenText, thumb} + ตรวจความขัดแย้งในบอร์ด + ตรวจว่าโฟลเดอร์ฟุตเทจตรงกับ slot; clip ผูก `slot`; **รายงานบอร์ด-vs-คัท** แบบภาพคู่ + chapter timing diff; **fit-to-duration** กระจาย slack |
| 2 | เฟรมหลุด/ช็อตข้างเคียงแวบ 1–3 เฟรม, ตัดกลางโลโก้, เนื้อหาซ้ำที่รอยต่อ (00:00:18:23, 00:00:19:02) | **shot index ต่อไฟล์ต้นทาง** (`scdet`, cache) → `timeline_edit` snap/เตือนเมื่อ in/out ห่างรอยตัดต้นทาง < k เฟรม; QC: flash frame (< N เฟรม), "ท้ายคลิปข้ามรอยตัด", ช่วงต้นทางซ้ำกันระหว่างช็อตติดกัน |
| 3 | กลุ่ม "ค้าง/กระตุก" ~7 ครั้ง: handle เป็นภาพนิ่ง, แอนิเมชันจบก่อนการ์ดยาวขึ้น (00:00:34:23), slow-mo มีเฟรมซ้ำ (00:02:38:22), speed ramp กระโดด 50→100% (00:00:11:22), ฟุตเทจนิ่งเกิน (18:11–24:02) | QC: **duplicate-frame/cadence** (mpdecimate), "นิ่งเกิน N วิ" (advisory); `Clip.speed` + ramp ease + interpolation (blend / minterpolate); **comp lint**: keyframe สุดท้าย/layer/precomp จบก่อน out point หลังยืด, พื้นหลังหมดก่อน comp จบ |
| 4 | รสนิยมแกว่ง (เทาเรียบ = สไลด์โชว์ ↔ particle = รก ↔ light streak น่ารำคาญ); กฎที่ผู้ใช้สั่งถูกลืม/ใช้เกินขอบเขต (ปิด CC Lens ที่เป็นไฮไลต์) | **`constraints.json` ต่อโปรเจกต์** (เช่น ใช้เฉพาะ element ในบอร์ด, ห้ามบังภาพ, minimal, โลโก้นิ่ง, ไม่ใช้ลูกเล่นซ้ำ) agent ตรวจทุก build; taste profile ผูก **effect + บริบท** ไม่ใช่ global; พรีวิว A/B/C 3–5 วิ ก่อน render เต็ม |
| 5 | "จะมนก็มนให้หมด" — แก้ 1 จุดแต่รายงานว่าแก้ครบ 4 จุด | **`styleRules`** ใน project.json (radius, safe margin 5%, palette, ความยาว dissolve ตามชนิดรอยต่อ) + lint ทุก comp; **ต้องแนบเฟรมของทุก instance ก่อนรายงานว่าแก้แล้ว** |
| 6 | ใช้ template ที่ซื้อมาไม่ถูก (สร้างแอนิเมชันเอง, ปิดส่วนที่สวย), template เป็น luma matte, text ผูก expression ที่ Controls layer, Square animator ทำคำเด้ง | **`template_scan`**: scene/placeholder/ฟอนต์/ความยาว, ชนิด (precomp ขยับตามกรอบ vs matte นิ่ง), property ที่ถูก expression ล็อก, preview strip; ตาราง "ช็อตไหนมาจาก template ไหน"; slot→placeholder mapper; cover-crop/fit-into-card helper + ตรวจ pillarbox (cropdetect) |
| 7 | ข้อความไทย: animator รายคำทำบรรทัดไทยแตก, เส้นใต้ชนสระล่าง (+12 px), ซับไทยบางเกิน; ชื่อไฟล์ไทยจาก zip เป็น mojibake | **Thai typography lint** (ขนาด/น้ำหนักขั้นต่ำ ≥60% cap height semibold, ระยะสระล่าง, animate ทีละบรรทัด); `scan_footage` แก้ mojibake (cp437→utf8) + **font audit** (ดึงชื่อฟอนต์จาก .aep เทียบที่ติดตั้ง) |
| 8 | AE disk cache 37.7 GB ทำ C: เต็ม; aerender crash ตอนเริ่ม | `doctor`/`build`: เช็คพื้นที่ว่าง + ขนาด cache, purge cache AE หลังแต่ละ batch, retry aerender 1 ครั้งเมื่อ crash ตอนเริ่ม, watchdog AE ค้างตอนเปิด; รายงาน/ล้าง cache เก่า (ลบเมื่อผู้ใช้อนุมัติเท่านั้น) |
| 9 | "อันก่อนสวยกว่าอีก", "ยังไม่ต้องแก้" | ย้อนเฉพาะช็อต (เก็บ comp params + render รายช็อตต่อเวอร์ชัน); โน้ตสถานะ "พักไว้"; A/B before-after |
| 10 | รอยต่อ: blue→blue dissolve 0.3–0.5 วิ, footage↔การ์ด 0.4 วิ, footage→footage คัตตรง | **join policy ตามชนิดขอบ** ใน skill `edit-csr` + รายงานรอยต่อทุก build |
| 11 | ผู้ใช้ถามว่าเครื่องมือเสียเงินไหม, ไม่อยากให้ยึดหน้าจอ | แสดงค่าใช้จ่ายก่อนเรียกบริการที่เสียเงิน; headless เป็นค่าเริ่มต้น (ทำแล้ว) |

### 13.2.1 หลักสูงสุด (ผู้ใช้ 2026-10-11): **โจทย์/บรีฟเป็นตัวตัดสิน**
- ไม่มีกฎสไตล์ตายตัวระดับระบบ: การใช้เทมเพลตเดิม vs สร้างแอนิเมชันเอง, กฎตัวอักษรไทย, รอยต่อ, ฯลฯ **ขึ้นกับโจทย์ของแต่ละงาน**
- `template_scan`, Thai lint, join policy = **เครื่องมือให้ข้อมูล/advisory** เปิดใช้เมื่อบรีฟหรือผู้ใช้ต้องการ ค่าเริ่มต้นไม่บังคับ
- `constraints` / `styleRules` เก็บ **ต่อโปรเจกต์** และมาจากบรีฟหรือคำสั่งผู้ใช้เท่านั้น (บันทึกที่มาไว้ในแต่ละกฎ); ถ้ากฎขัดกับบรีฟ บรีฟชนะและ agent ต้องถามผู้ใช้
- ลำดับความสำคัญ: บรีฟ/บอร์ด → คำสั่งผู้ใช้ในโปรเจกต์นั้น → ค่าแนะนำทั่วไป

### 13.3 ลำดับที่จะทำต่อ (หลังชุดแก้บั๊กปัจจุบัน)
1. `board_import` + slot model + board-vs-cut report
2. shot index + snap + QC flash/duplicate/cadence + comp lint
3. `constraints.json` + `styleRules` + lint ทุก instance
4. disk/cache preflight + purge + retry
5. `scan_footage` (mojibake, font audit, pillarbox) + `template_scan`
6. speed/ramp, ย้อนรายช็อต, A/B compare

## 14. บทเรียนงานจริง Thai Agri Foods reshoot (Codex ใช้ CatCut, 2026-10-12) → ดีไซน์ "ง่ายและไม่ต้องเปิดค้าง"

ที่มา: ประวัติเซสชัน Codex (186 คลิป 4K50, ตัดใน Premiere ผ่าน CatCut Bridge) — ผู้ใช้สรุปว่า "ยุ่งยากจัง", "ช่างมันเหอะ"

### 14.1 ปัญหาที่เกิดจริง → สาเหตุในระบบ
| # | สิ่งที่ผู้ใช้เจอ | สาเหตุในระบบ (ไม่ใช่แค่ agent) |
|---|---|---|
| 1 | ต้องเปิด Premiere/AE/panel ค้างไว้ ไม่รู้ว่าต้องทำอะไร ทำไม ครั้งเดียวหรือทุกครั้ง ปิดได้เมื่อไร | ไม่มีที่ไหนบอก; error บอกแค่ "not running"; ข้อกำหนดครั้งเดียวของ AE (Sign in, Allow Scripts…) อยู่ใน jsx/README เท่านั้น |
| 2 | bridge ต่อยาก, ต้องปิด–เปิด Premiere ซ้ำหลายรอบ | host.jsx โหลดครั้งเดียว; ระหว่าง Premiere มีหน้าต่างค้าง heartbeat หยุด → ดูเหมือน "หลุด"; ไม่บอกว่าเป็นเพราะติดตั้ง/รีจิสทรี/ไม่เริ่มเอง/หน้าต่างค้าง/โปรเจกต์ผิด |
| 3 | AE "ต้องกดเปิด" | AE headless ปิดตัวเมื่อยังไม่ Sign in หรือยังไม่เปิด Allow Scripts; agent เลยเลี่ยงไปใช้ AE GUI |
| 4 | พื้นที่เต็ม: โฟลเดอร์ PROJECT ~100 GB + AE cache 7.3 GB | agent สร้างไฟล์กลาง (สโลว์ export, เฟรมตรวจ, กราฟิก) นอกการดูแลของ CatCut; ไม่มีงบพื้นที่/รายงานหลังงาน |
| 5 | export คลิปสโลว์มาแปะแทนปรับ speed ใน Premiere; ใช้ภาพนิ่งแทนสโลว์ | ไม่มีคำสั่ง native speed + Optical Flow ใน bridge; lint ไม่เตือนสโลว์ฟุต fps ต่ำ |
| 6 | ชื่อไฟล์ใหม่ (b46_1) หาที่มาไม่ได้ | ไม่มีหลัก "ใช้ไฟล์ต้นฉบับชื่อเดิม"; ไม่มีคำสั่ง import ต้นฉบับ + แนบ proxy |
| 7 | ไม่ยึดชื่อไฟล์/take ที่บอร์ดระบุ, ไม่ให้น้ำหนัก reshoot | skill ไม่บังคับ; board_vs_cut ไม่เทียบชื่อไฟล์ที่บอร์ดเขียน |
| 8 | ต้องขออนุญาตใช้ ffmpeg ทำ proxy เพราะ CatCut ไม่มีคำสั่ง | ไม่มี `proxy_make` |
| 9 | โมชั่นแบบเจนภาพดู "AI หัดวาด" | skill ไม่ห้าม; โมชั่น/ข้อความต้องเป็น layer AE |

### 14.2 หลักดีไซน์
1. **บอกคนใช้เสมอ (User Action Card):** ทุกครั้งที่ต้องให้คนกดอะไร CatCut คืนการ์ดเดียวกัน: *ทำอะไร (ขั้นตอน) · ทำไม · ครั้งเดียว/ทุกครั้ง · ต้องเปิดค้างไหม · ปิดได้เมื่อไร* — agent ส่งต่อตามนั้น ห้ามแต่งขั้นตอนเอง
2. **ไม่ต้องเปิดค้าง:** AE = ไม่ต้องเปิดเลย (ครั้งแรกเปิดครั้งเดียวเพื่อ Sign in + ติ๊ก Allow Scripts แล้วปิด); Premiere = CatCut เปิดให้เองพร้อมโปรเจกต์ที่ถูก ทำงาน แล้วบอกว่า "ปิดได้แล้ว" (ปิดให้ถ้า CatCut เป็นคนเปิดและสั่งปิด)
3. **bridge ไม่ต้องรีสตาร์ท:** host.jsx โหลดใหม่เองเมื่อไฟล์เปลี่ยน; heartbeat เดินต่อแม้ Premiere กำลังทำงาน/มีหน้าต่างค้าง และบอกว่า "ค้างที่คำสั่งไหน กี่วินาที"
4. **แก้ใน Premiere แบบ native:** speed + Optical Flow, import ต้นฉบับชื่อเดิม + แนบ proxy — ไม่ export ไฟล์ใหม่มาแปะ
5. **พื้นที่ดิสก์เป็นงบที่มองเห็น:** ทุกงานที่สร้างไฟล์รายงานขนาดที่เพิ่ม; `disk_report` แยกขนาดโฟลเดอร์ที่ไม่ใช่ของ CatCut ให้เห็น; ไฟล์ชั่วคราวของคำสั่งลบเองเมื่อจบ
6. **บอร์ดก่อน ภาพทีหลัง:** ชื่อไฟล์/take ที่บอร์ดเขียนชนะการเทียบภาพ; ฟุต reshoot ก่อนฟุตเก่าเมื่อโปรเจกต์ตั้งไว้

### 14.3 สิ่งที่ทำ (รอบนี้)
- `ready_check` (+ `catcut ready`): การ์ดต่อโปรแกรม ffmpeg / After Effects / Premiere + bridge / ดิสก์ — ตรวจโดยไม่เปิด Adobe (อ่าน prefs ของ AE, รีจิสทรี CSXS, tasklist, heartbeat)
- ToolError มี `userAction` (การ์ด) — AE: "cannot write" → การ์ด Allow Scripts; AE ปิดตัวก่อนรันสคริปต์ → การ์ด Sign in ครั้งเดียว; Premiere: การ์ดแยกตามสาเหตุ
- bridge 0.2.0: heartbeat ไม่หยุดระหว่างทำงาน (`busy {action, sinceMs}`), ไม่ ping ซ้อน, hot-reload host.jsx, รายงานเวอร์ชันให้ CatCut เทียบ
- `premiere_open` (เปิด Premiere + โปรเจกต์ให้เอง แล้วรอ bridge), `premiere_save`, `premiere_close` (ปิดเฉพาะเมื่อสั่ง; ถ้า CatCut ไม่ได้เปิดเองต้อง `force`)
- `premiere_import_media` (ไฟล์ต้นฉบับชื่อเดิม, bin ตามโฟลเดอร์การ์ด, แนบ proxy `<ชื่อเดิม>_Proxy.*`, ไม่สร้างไฟล์ใหม่) และ `premiere_set_speed` (speed + Optical Flow แบบ native, ตรวจตำแหน่งคลิปหลังตั้ง)
- `proxy_make`: proxy MP4 H.264 (เฟรม/ความยาว/timecode/ช่องเสียงเท่าต้นฉบับ), ชื่อ `<ชื่อเดิม>_Proxy.mp4`, ไม่เขียนทับ, ประเมินพื้นที่ก่อน
- `timeline_lint` เพิ่ม `slowmo`: สโลว์ฟุตที่ fps ต้นทาง ≤ fps โปรเจกต์โดยไม่มี motion interpolation; `board_vs_cut` เพิ่มเช็กชื่อไฟล์ที่บอร์ดระบุ
- `disk_report` เพิ่มขนาดโฟลเดอร์อื่นในโปรเจกต์ (ไฟล์ที่ไม่ใช่ของ CatCut) + คำเตือนเมื่อโปรเจกต์เกินงบ
- skill / agent: กฎจากข้อ 14.1 ทั้งหมด

### 14.4 ยังต้องลองกับโปรแกรมจริง (ทดสอบแบบจำลองแล้วเท่านั้น)
- Premiere 2026: เปิดโปรเจกต์จาก command line แล้ว bridge auto-start, `app.quit()`, QE `setSpeed` + `setTimeInterpolationType(2)` (Codex ใช้ได้จริงในงานนี้), hot-reload `$.evalFile`
- AE 26.5: ข้อความ error ตอนยังไม่ Sign in (ใช้ "ไม่มี result + ปิดเร็ว" เป็นสัญญาณ)

## 15. ฟีดแบครอบ 2 (ทรานสคริปต์ Codex 13–15 ต.ค. 2026: CSR v36, Thai Agri Foods D2, company final)

### 15.1 ปัญหา → สาเหตุ → ที่แก้ (รอบนี้ ข้อ 1–4)
| # | ที่ผู้ใช้เจอ | สาเหตุ | แก้ |
|---|---|---|---|
| 1 | CatCut ไม่ยอมเขียนในโฟลเดอร์งาน CSR ("protected path") | `BUILTIN_PROTECTED` ฝังโฟลเดอร์งานไว้ในโค้ด — กฎตอนพัฒนาหลุดเข้าตัวโปรแกรม | ตัวโปรแกรมไม่ล็อกอะไรเอง ใช้ `EDITMCP_PROTECTED_PATHS` เท่านั้น; ตอนรันเทสต์ vitest ตั้งค่านี้ให้ (กฎ CLAUDE.md ยังอยู่) |
| 2 | การ์ด "Premiere มีหน้าต่างรอให้กด" ขึ้นราว 10 ครั้ง ทั้งที่ไม่มีหน้าต่าง | busy ≥ 45 วินาที = การ์ดเสมอ แต่ที่จริง Premiere กำลังเรนเดอร์คอมป์ AE ผ่าน Dynamic Link | อ่านหน้าต่างของ Premiere (Win32: main window ถูก disable = มี modal) — มีหน้าต่าง: การ์ดพร้อมชื่อหน้าต่าง; ไม่มี: รอต่อ / error ธรรมดา "กำลังทำงาน ไม่ต้องกดอะไร"; อ่านไม่ได้: การ์ดแบบบอกว่าแยกไม่ออก |
| 3 | ต้องเปิด Window > Extensions > CatCut Bridge แทบทุกครั้งที่เปิด Premiere | bridge แบบซ่อนเริ่มตอน ApplicationActivate ซึ่งไม่เกิดถ้า Premiere ไม่ได้อยู่หน้าสุด (CatCut เปิดจากเบื้องหลัง) และการ์ดเดิมบอกให้ "ปิด panel ได้" | `openPremiere` เรียกหน้าต่าง Premiere ขึ้นหน้า (SetForegroundWindow, ไม่จำลองการกด) สูงสุด 2 ครั้งก่อนขอให้คนทำ; การ์ดบอกให้วาง panel ทิ้งไว้ใน workspace ไม่ต้องปิด (ทำครั้งเดียว) |
| 4 | ลบช็อตแล้วเวลารวมไม่ลด / AI ยืดช็อตอื่นมาเติม / ท้ายดำตอน export | `premiere_edit` ไม่มี ripple | `remove {ripple: true}` และ `ripple_delete {from, to, keepTracks}`: ลบในช่วง, ตัดขอบ, เลื่อนทุกแทร็กที่เหลือมาชิด (เรียงจากต้นไปท้ายข้ามแทร็ก กันคลิป linked ที่ Premiere ลากไปด้วยชนกัน), ปฏิเสธถ้าจะตัดกลางคลิปที่คร่อมทั้งช่วง (เช่นเพลง) เว้นแต่อยู่ใน keepTracks, รายงาน `tail` เมื่อเสียงยาวเกินภาพ; host.jsx เก่าที่ไม่รู้จัก op ได้การ์ด bridge-update (ไม่ต้องรีสตาร์ท) |

### 15.2 ค้างไว้รอบถัดไป (จาก §15 ในทรานสคริปต์)
คอมป์ AE ใน Premiere พรีวิวไม่ขึ้น (รวม AEP ต่อ sequence / เรนเดอร์ alpha แล้วเก็บ AEP), การ์ดแยก "ต้องรอคน" กับ "แค่แจ้ง", ตัววัดสีก่อน–หลัง, รีวิว + กฎของงานที่อยู่ใน Premiere อย่างเดียว, ย้ายไฟล์ไม่ใช้ไปโฟลเดอร์ `_READY_TO_DELETE`

### 15.3 ยังต้องลองกับโปรแกรมจริง
- Premiere 2026: SetForegroundWindow/SwitchToThisWindow จาก process เบื้องหลังทำให้เกิด ApplicationActivate จริงไหม; panel ที่ค้างใน workspace เปิดเองตอนเริ่มโปรแกรมไหม
- main window ถูก disable ระหว่าง modal (Link Media, Import progress) และไม่ถูก disable ระหว่างเรนเดอร์ Dynamic Link
- `TrackItem.move` ลากเสียง linked ไปด้วยหรือไม่ (โค้ดรับได้ทั้งสองแบบ)

## 16. ฟีดแบครอบ 3 (ทรานสคริปต์ 5 ชุดของ Codex + เซสชัน Claude Code "วิดีโอล่าสุด", 16–22 ต.ค. 2026: CSR D4/D5, Thai Agri Foods D4/D5) → CatCut 0.5.0

### 16.1 ปัญหา → สาเหตุ → ที่แก้ (0.5.0)
| # | ที่ผู้ใช้เจอ | สาเหตุ | แก้ |
|---|---|---|---|
| 1 | AE แบบไม่มีหน้าต่างล้มซ้ำ (`GPU3 failed sanity test`, `InitializeFileLogging failed`) แต่การ์ดบอกให้ "Sign in" | `noResult` แยกแค่ Allow Scripts กับ first-run | การ์ด `ae-headless-failed` (ดูจาก stderr+stdout ของ AE; Allow Scripts ปิดยังชนะ) บอกให้เปิด AE ปกติหนึ่งครั้งแล้วค่อยใช้ `ae_live_run` เมื่อผู้ใช้สั่ง |
| 2 | "Cannot run a script while a modal dialog…" ต้องไล่ให้ผู้ใช้ปิดกล่อง AE 15+ ครั้ง | error ดิบจาก BridgeTalk | `ae_live_run` แปลงเป็นการ์ด `ae-modal-open` (ขอข้อความในกล่อง อย่าส่งสคริปต์ซ้ำ) |
| 3 | เอเจนต์หยุดรอทุกครั้งที่ ready_check เตือนดิสก์ C: 12–19 GB | ทุกค่าต่ำกว่า 20 GB เป็น `userAction` | ต่ำกว่า 8 GB เท่านั้นที่เป็นการ์ด; 8–20 GB เป็นแค่หมายเหตุ ("ทำงานต่อได้") ; build ยังหยุดที่ 5 GB |
| 4 | `premiere_frames` ดึงทุกเฟรมของช่วง 2 วินาทีค้าง 600 วินาที คิว bridge ถูกบล็อกต่อเป็นสิบนาที | ส่งทั้งช่วงในคำสั่งเดียว รอรวดเดียว | ดึงทีละ 40 เฟรม (`skip`/`take` ใน host.jsx, `total` ในผลลัพธ์) แต่ละชุดมี timeout 120 วินาทีของตัวเอง; bridge เก่าที่ไม่รู้จัก skip/take ตอบรวดเดียวก็ยังใช้ได้ |
| 5 | ไม่มีเครื่องมือลบมาร์กเกอร์แดงเก่า + ใส่ชุดใหม่พร้อมโน้ตสั้น (ขอ 3 รอบ ต้องเขียนสคริปต์เอง) | ไม่มี action markers | `premiere_markers`: dry run → `apply`; `clear` ด้วยสี/ข้อความ/ทั้งหมด (ไม่ระบุ = ไม่ลบอะไร), `add` เป็นชุดเดียว, ไม่แตะคลิปและมาร์กเกอร์สีอื่น; bridge 0.4.0 |
| 6 | แก้เกินคอมเมนต์, "คืนเหมือนเดิม" ไม่ครบ (ครอปกลับแต่ช่วงฟุตไม่กลับ), "เพิ่ม" แต่เวลารวมเท่าเดิม, ปนคอมเมนต์เก่า, อ้างว่า "สมูธ/ชัด" จากภาพนิ่ง | ไม่มีกติกาใน skill | หัวข้อใหม่ "Client comments" ใน `skills/catcut-editor/SKILL.md` |

### 16.2 ค้างไว้รอบถัดไป
ย้าย transition / วาง export ไว้บน V2 เป็นเลเยอร์เทียบ / export คอมป์ AE เดี่ยวเป็นเครื่องมือเดียว / ตัวตรวจเฟรมซ้ำ (Time Remap) และความคมจริงของการ์ดที่ขยาย (`comp-lint`) / ยกเลิกคำสั่งที่ค้างใน bridge (ExtendScript ฆ่า evalScript ที่รันอยู่ไม่ได้ ต้องปิด Premiere) / ล้างแคช AE ตอนดิสก์ใกล้เต็มโดยขอ OK ครั้งเดียว

### 16.3 ยังต้องลองกับโปรแกรมจริง
- `Marker.setColorByIndex` / `getColorByIndex` / `deleteMarker` ใน Premiere 2026 (ทดสอบกับ object จำลองเท่านั้น)
- ข้อความ stderr/stdout จริงของ `AfterFX -m -noui` ตอน GPU sanity test ล้ม (regex ตั้งจากข้อความในทรานสคริปต์)

### 16.4 รีเสิร์ช 23 ต.ค. 2026 → ข้อสรุป
- AE ล้มตอนเริ่ม (GPU sanity test): CatCut ลองใหม่อัตโนมัติหนึ่งรอบก่อนขึ้นการ์ด `ae-headless-failed` (0.5.1) ทั้งนี้รายงานปี 2026 ชี้ว่า VRAM ไม่ถูกปล่อยหลังเรนเดอร์ — การ์ด/ปิด AE ทุกงานจึงเป็นแนวที่ถูก; ยังไม่ทดลองบังคับ renderer แบบซอฟต์แวร์ (ต้องลองกับเครื่องจริง)
- ffmpeg 9.0.1 (Gyan essentials) บนเครื่องนี้ **ไม่มี filter whisper** — ถอดเสียง/หาจังหวะพูดด้วย ffmpeg ต้องใช้ build ที่คอมไพล์ whisper.cpp + ไฟล์โมเดล (ดาวน์โหลดเพิ่ม ต้องขอผู้ใช้ก่อน)
- OTIO: Premiere มี import/export ใน Beta (ต.ค. 2024) รองรับ marker, speed, หลายแทร็ก; ยังไม่ยืนยันว่าออกรุ่นเสถียรและอ่านจากโปรแกรมจริงไม่ได้ในรอบนี้ → ค้างไว้ทดสอบกับ Premiere 2026
- CEP→UXP: วันที่ (ปิด CEP โดยปริยาย ธ.ค. 2028) มาจากแหล่งรองแหล่งเดียว รอยืนยันจาก Adobe ก่อนย้าย bridge
