// CatCut bridge, ExtendScript side (ES3, Premiere Pro). bridge-core.js calls catcut_dispatch(job)
// and gets a JSON string back. Every action that changes a project names it (expectProject) and
// refuses when another one is active; only save/quit/edit-with-save save. XML paths arrive staged in
// the bridge's ASCII folder; media and proxy paths are the original files (never copies).
// Extra per-job actions belong in host.user.jsx next to this file (kept across bridge updates):
//   catcut_user_actions = { myAction: function (args, h) { ... } };   h = helpers below
// Times crossing the bridge are frames at the sequence frame rate.
var catcut_user_actions = typeof catcut_user_actions === "object" && catcut_user_actions ? catcut_user_actions : {};
var catcut_dispatch = (function () {
    function stringify(v) {
        if (v === null || v === undefined) return "null";
        if (typeof v === "string") return '"' + v.replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (c) {
            if (c === '"' || c === "\\") return "\\" + c;
            return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
        if (typeof v === "number") return isFinite(v) ? String(v) : "null";
        if (typeof v === "boolean") return String(v);
        var parts = [], i, k;
        if (Object.prototype.toString.call(v) === "[object Array]") {
            for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
            return "[" + parts.join(",") + "]";
        }
        for (k in v) if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(stringify(k) + ":" + stringify(v[k]));
        return "{" + parts.join(",") + "}";
    }
    function norm(p) { return String(p).replace(/\//g, "\\").toLowerCase(); }
    function project() {
        var p = app.project;
        return p ? { name: p.name, path: p.path } : null;
    }
    function sequences() {
        var out = [], seqs = app.project.sequences, active = app.project.activeSequence;
        for (var i = 0; i < seqs.numSequences; i++) {
            var s = seqs[i];
            out.push({ name: s.name, id: s.sequenceID, active: !!(active && active.sequenceID === s.sequenceID) });
        }
        return out;
    }
    function findSequence(ref) {
        var seqs = app.project.sequences, hits = [];
        if (ref === undefined || ref === null || ref === "") {
            if (!app.project.activeSequence) throw new Error("no active sequence: open one or pass sequence");
            return app.project.activeSequence;
        }
        for (var i = 0; i < seqs.numSequences; i++) if (seqs[i].sequenceID === ref || seqs[i].name === ref) hits.push(seqs[i]);
        if (hits.length === 0) throw new Error("sequence not found: " + ref);
        if (hits.length > 1) throw new Error("ambiguous sequence name: " + ref + " (pass its id)");
        return hits[0];
    }
    function binNamed(name) {
        var root = app.project.rootItem;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === 2 && c.name === name) return c; // ProjectItemType.BIN
        }
        root.createBin(name);
        for (i = 0; i < root.children.numItems; i++) if (root.children[i].type === 2 && root.children[i].name === name) return root.children[i];
        throw new Error("cannot create bin: " + name);
    }
    function requireProject(a) {
        if (!app.project) throw new Error("no project open in Premiere");
        if (a.expectProject && norm(app.project.path) !== norm(a.expectProject)) throw new Error("the active Premiere project is " + app.project.path + ", not " + a.expectProject + "; nothing changed");
    }
    function saveProject() {
        var r = app.project.save();
        if (r === false) throw new Error("Premiere could not save " + app.project.path);
    }
    /** Nested bin by "A/B" path under the project root, created when missing. */
    function binAt(pathText) {
        var parts = String(pathText || "").split("/"), cur = app.project.rootItem, i, j, hit;
        for (i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            hit = null;
            for (j = 0; j < cur.children.numItems; j++) if (cur.children[j].type === 2 && cur.children[j].name === parts[i]) hit = cur.children[j];
            if (!hit) {
                cur.createBin(parts[i]);
                for (j = 0; j < cur.children.numItems; j++) if (cur.children[j].type === 2 && cur.children[j].name === parts[i]) hit = cur.children[j];
            }
            if (!hit) throw new Error("cannot create bin: " + parts[i]);
            cur = hit;
        }
        return cur;
    }
    /** The project item whose media is path, searching root and its bins. */
    function findMedia(root, path) {
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === 2) { var hit = findMedia(c, path); if (hit) return hit; } else if (c.getMediaPath && norm(c.getMediaPath()) === norm(path)) return c;
        }
        return null;
    }
    /** The project item named exactly name (AE comps imported by name). */
    function findNamed(root, name) {
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === 2) { var hit = findNamed(c, name); if (hit) return hit; } else if (String(c.name) === name) return c;
        }
        return null;
    }

    // ---------- sequence clips as frames ----------

    function seqFps(s) { return 1 / s.getSettings().videoFrameRate.seconds; }
    function fr(t, fps) { return Math.round(t.seconds * fps); }
    function time(frames, fps) { var t = new Time(); t.seconds = frames / fps; return t; }
    function tcFrames(tc, fps) {
        var p = String(tc).split(/[:;]/), r = Math.round(fps);
        return ((Number(p[0]) * 60 + Number(p[1])) * 60 + Number(p[2])) * r + Number(p[3]);
    }
    function frameArg(v, fps) { return typeof v === "string" ? tcFrames(v, fps) : v; }
    function tcOf(frame, fps) {
        var r = Math.round(fps), f = frame % r, sec = Math.floor(frame / r);
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor(sec / 60) % 60) + ":" + pad(sec % 60) + ":" + pad(f);
    }
    function parseTrack(t) {
        var m = /^([VA])(\d+)$/i.exec(String(t));
        if (!m) throw new Error("track must look like V1 or A2: " + t);
        return { kind: m[1].toUpperCase(), index: Number(m[2]) - 1 };
    }
    function trackOf(s, ref) {
        var p = parseTrack(ref), tracks = p.kind === "A" ? s.audioTracks : s.videoTracks;
        if (p.index < 0 || p.index >= tracks.numTracks) throw new Error("no track " + ref);
        return { kind: p.kind, index: p.index, name: p.kind + (p.index + 1), track: tracks[p.index] };
    }
    function mediaOf(c) { try { return c.projectItem ? String(c.projectItem.getMediaPath()) : null; } catch (e) { return null; } }
    function nodeOf(c) { try { return c.projectItem ? String(c.projectItem.nodeId) : null; } catch (e) { return null; } }
    function effectNames(c) { var out = []; for (var k = 0; k < c.components.numItems; k++) out.push(c.components[k].displayName); return out; }
    function clipInfo(c, trackName, n, fps) {
        var r = { track: trackName, index: n, name: c.name, start: fr(c.start, fps), end: fr(c.end, fps), "in": fr(c.inPoint, fps), out: fr(c.outPoint, fps), media: mediaOf(c), nodeId: nodeOf(c) };
        try { r.speed = c.getSpeed(); } catch (e1) { /* audio on old versions */ }
        try { if (c.projectItem && c.projectItem.hasProxy()) r.proxy = c.projectItem.getProxyPath(); } catch (e2) { /* no proxy api */ }
        try { if (c.disabled) r.disabled = true; } catch (e3) { /* old versions */ }
        try { r.effects = effectNames(c); } catch (e4) { r.effects = []; }
        return r;
    }
    function eachClip(s, fn) {
        var kinds = [["V", s.videoTracks], ["A", s.audioTracks]];
        for (var k = 0; k < kinds.length; k++) for (var t = 0; t < kinds[k][1].numTracks; t++) {
            var tr = kinds[k][1][t];
            for (var n = 0; n < tr.clips.numItems; n++) fn(tr.clips[n], kinds[k][0] + (t + 1), n);
        }
    }
    /** The one clip matching a selector {track, start, end, name?, media?}; anything else changes nothing. */
    function findClip(s, sel, fps) {
        if (!sel || sel.track === undefined || sel.start === undefined || sel.end === undefined) throw new Error("clip needs track, start and end (frames) so a moved clip is never edited by mistake");
        var tr = trackOf(s, sel.track), start = frameArg(sel.start, fps), end = frameArg(sel.end, fps), hits = [], near = [];
        for (var n = 0; n < tr.track.clips.numItems; n++) {
            var c = tr.track.clips[n], cs = fr(c.start, fps), ce = fr(c.end, fps);
            if (cs < end + fps && ce > start - fps) near.push(c.name + " " + cs + "-" + ce);
            if (cs !== start || ce !== end) continue;
            if (sel.name !== undefined && c.name !== sel.name) continue;
            if (sel.media !== undefined && norm(mediaOf(c)) !== norm(sel.media)) continue;
            hits.push({ clip: c, index: n });
        }
        if (hits.length !== 1) {
            throw new Error("precondition failed: " + hits.length + " clips match " + stringify(sel) + " on " + tr.name + (near.length ? " (there now: " + near.join(", ") + ")" : "") + "; nothing changed");
        }
        return { clip: hits[0].clip, index: hits[0].index, track: tr, fps: fps };
    }
    function propValue(p) {
        var r = { name: p.displayName };
        try {
            r.varying = p.isTimeVarying();
            if (r.varying) {
                r.keys = [];
                var ks = p.getKeys();
                if (ks) for (var z = 0; z < ks.length; z++) r.keys.push({ seconds: ks[z].seconds, value: p.getValueAtKey(ks[z]) });
            } else {
                r.value = p.getValue();
                // colour parameters come back as one big number: read them as [a, r, g, b] too
                if (typeof r.value === "number" && r.value > 4294967295 && p.getColorValue) r.color = p.getColorValue();
            }
        } catch (e) { r.error = String(e); }
        return r;
    }
    function effectsOf(c) {
        var out = [];
        for (var e = 0; e < c.components.numItems; e++) {
            var ec = c.components[e], ps = [];
            for (var p = 0; p < ec.properties.numItems; p++) { var q = propValue(ec.properties[p]); q.index = p; ps.push(q); }
            out.push({ index: e, name: ec.displayName, matchName: ec.matchName, properties: ps });
        }
        return out;
    }
    /** Every clip with its edges and effect values: what an edit must not change outside its targets. */
    function signature(s, fps) {
        var out = {};
        eachClip(s, function (c, track) {
            var key = track + "@" + fr(c.start, fps) + "-" + fr(c.end, fps) + "#" + nodeOf(c);
            var fx = [];
            try { fx = effectsOf(c); } catch (e) { fx = ["unreadable"]; }
            out[key] = stringify({ name: c.name, "in": fr(c.inPoint, fps), out: fr(c.outPoint, fps), speed: (function () { try { return c.getSpeed(); } catch (e2) { return null; } })(), fx: fx });
        });
        return out;
    }
    function keyOf(info) { return info.track + "@" + info.start + "-" + info.end + "#" + info.nodeId; }
    /** The QE item for the n-th clip of a video track (QE also lists gaps). */
    function qeClip(s, trackIndex, n, name) {
        app.project.openSequence(s.sequenceID);
        app.enableQE();
        var qt = qe.project.getActiveSequence().getVideoTrackAt(trackIndex), seen = 0;
        for (var j = 0; j < qt.numItems; j++) {
            var x = qt.getItemAt(j);
            if (x && x.type === "Clip") { if (seen === n) { if (x.name !== name) break; return x; } seen++; }
        }
        throw new Error("cannot match " + name + " in Premiere's QE track; nothing changed for it");
    }
    function findEffect(c, ref) {
        var hits = [];
        for (var k = 0; k < c.components.numItems; k++) if (k === ref || c.components[k].displayName === ref || c.components[k].matchName === ref) hits.push(k);
        if (hits.length !== 1) throw new Error("effect " + ref + " found " + hits.length + " times on " + c.name + " (stack: " + effectNames(c).join(" > ") + "); pass its index");
        return hits[0];
    }
    function findParam(comp, ref) {
        for (var p = 0; p < comp.properties.numItems; p++) if (p === ref || comp.properties[p].displayName === ref) return comp.properties[p];
        throw new Error("parameter " + ref + " not found in " + comp.displayName);
    }
    /** Project item for insert/replace: an existing item for media, else imported (AE comps by name). */
    function itemFor(op) {
        var item;
        if (op.aeComp) {
            item = findNamed(app.project.rootItem, op.aeComp.comp);
            if (!item) {
                if (!new File(op.aeComp.aep).exists) throw new Error("aep not found: " + op.aeComp.aep);
                app.project.importAEComps(op.aeComp.aep, [op.aeComp.comp], binNamed(op.bin || "CatCut AE"));
                item = findNamed(app.project.rootItem, op.aeComp.comp);
            }
            if (!item) throw new Error("After Effects comp did not import: " + op.aeComp.comp);
            return item;
        }
        if (!op.media) throw new Error(op.op + " needs media or aeComp");
        item = findMedia(app.project.rootItem, op.media);
        if (!item) {
            if (!new File(op.media).exists) throw new Error("media not found: " + op.media);
            if (!app.project.importFiles([op.media], true, binNamed(op.bin || "CatCut"), false)) throw new Error("Premiere refused to import " + op.media);
            item = findMedia(app.project.rootItem, op.media);
        }
        if (!item) throw new Error("media did not import: " + op.media);
        return item;
    }
    function occupants(tr, from, to, fps) {
        var out = [];
        for (var n = 0; n < tr.clips.numItems; n++) { var c = tr.clips[n]; if (fr(c.start, fps) < to && fr(c.end, fps) > from) out.push(c.name + " " + fr(c.start, fps) + "-" + fr(c.end, fps)); }
        return out;
    }
    /** Place item on a video track at frames [at, at+dur) from source frame "in"; returns the new clip. */
    function place(s, tr, item, op, fps) {
        var inF = op["in"] || 0;
        item.setInPoint(inF / fps, 4);
        item.setOutPoint((inF + op.dur) / fps, 4);
        if (op.op === "insert") tr.track.insertClip(item, op.at / fps); else tr.track.overwriteClip(item, op.at / fps);
        try { item.clearInPoint(); item.clearOutPoint(); } catch (e) { /* older versions keep the marks */ }
        var placed = null;
        for (var n = 0; n < tr.track.clips.numItems; n++) { var c = tr.track.clips[n]; if (nodeOf(c) === String(item.nodeId) && fr(c.start, fps) === op.at) placed = c; }
        if (!placed) throw new Error("placement on " + tr.name + " at " + op.at + " did not happen");
        if (fr(placed.end, fps) !== op.at + op.dur) placed.end = time(op.at + op.dur, fps);
        // AE comps and stills bring empty audio: drop it unless the op keeps it
        if (tr.kind === "V" && op.keepAudio !== true) {
            for (var t = 0; t < s.audioTracks.numTracks; t++) for (var j = s.audioTracks[t].clips.numItems - 1; j >= 0; j--) {
                var ac = s.audioTracks[t].clips[j];
                if (nodeOf(ac) === String(item.nodeId) && fr(ac.start, fps) === op.at) ac.remove(false, false);
            }
        }
        return placed;
    }
    function linkedAudio(s, c, fps) {
        var out = [], node = nodeOf(c), cs = fr(c.start, fps), ce = fr(c.end, fps);
        for (var t = 0; t < s.audioTracks.numTracks; t++) for (var j = 0; j < s.audioTracks[t].clips.numItems; j++) {
            var ac = s.audioTracks[t].clips[j];
            if (node && nodeOf(ac) === node && fr(ac.start, fps) === cs && fr(ac.end, fps) === ce) out.push({ clip: ac, track: "A" + (t + 1) });
        }
        return out;
    }

    function allTracks(s) {
        var out = [], kinds = [["V", s.videoTracks], ["A", s.audioTracks]];
        for (var k = 0; k < kinds.length; k++) for (var t = 0; t < kinds[k][1].numTracks; t++) out.push({ kind: kinds[k][0], index: t, name: kinds[k][0] + (t + 1), track: kinds[k][1][t] });
        return out;
    }
    /** The clip of node on track tr that starts and ends exactly there now, or null. */
    function clipAt(tr, node, start, end, fps) {
        for (var n = 0; n < tr.track.clips.numItems; n++) {
            var c = tr.track.clips[n];
            if (nodeOf(c) === node && fr(c.start, fps) === start && fr(c.end, fps) === end) return c;
        }
        return null;
    }
    /**
     * Ripple delete of frames [from, to): on every track not in keep, clips inside go, clips across an
     * edge are trimmed to it, later clips move left by to - from, so the cut gets shorter (an editor's
     * "take it out and close the gap"). A clip spanning the whole range would lose its middle: refused
     * unless its track is kept (a music bed usually is).
     */
    function ripple(s, from, to, keep, fps, apply, touched) {
        if (!(to > from)) throw new Error("ripple: to must be after from");
        var d = to - from, keepSet = {}, i, k, tracks = allTracks(s), items = [], spans = [], ends = { picture: 0, all: 0 };
        for (i = 0; i < (keep || []).length; i++) { var kp = parseTrack(keep[i]); keepSet[kp.kind + (kp.index + 1)] = true; }
        for (i = 0; i < tracks.length; i++) {
            var tr = tracks[i];
            for (var n = 0; n < tr.track.clips.numItems; n++) {
                var c = tr.track.clips[n], info = clipInfo(c, tr.name, n, fps), cs = info.start, ce = info.end, it = null;
                if (keepSet[tr.name] || ce <= from) it = null;
                else if (cs >= to) it = { kind: "shift", start: cs - d, end: ce - d };
                else if (cs >= from && ce <= to) it = { kind: "remove" };
                else if (cs < from && ce > to) { spans.push(info.name + " on " + tr.name + " " + cs + "-" + ce); continue; }
                else if (cs < from) it = { kind: "trim-end", start: cs, end: from };
                else it = { kind: "trim-head", start: from, end: ce - d, "in": info["in"] + Math.round((to - cs) * (info.speed || 1)) };
                var nowEnd = it ? (it.kind === "remove" ? 0 : it.end) : ce;
                if (nowEnd > ends.all) ends.all = nowEnd;
                if (tr.kind === "V" && nowEnd > ends.picture) ends.picture = nowEnd;
                if (it) { it.clip = info; it.tr = tr; items.push(it); }
            }
        }
        if (spans.length) throw new Error("ripple " + from + "-" + to + " would cut the middle out of " + spans.join(", ") + "; pass those tracks in keepTracks (they stay as they are) or trim them first; nothing changed");
        for (i = 0; i < items.length; i++) touched.push(keyOf(items[i].clip));
        var summary = function () {
            var out = { remove: [], trim: [], shift: 0 };
            for (var j = 0; j < items.length; j++) {
                var x = items[j], label = x.clip.track + " " + x.clip.name + " " + x.clip.start + "-" + x.clip.end;
                if (x.kind === "remove") out.remove.push(label); else if (x.kind === "shift") out.shift++; else out.trim.push(label + " -> " + x.start + "-" + (x.kind === "trim-head" ? x.end + d : x.end));
            }
            var tail = ends.all > ends.picture ? { tail: "sound runs " + (ends.all - ends.picture) + " frames past the last picture (black at the end of an export): trim it or set the export out point" } : {};
            var r = { from: from, to: to, removedFrames: d, removed: out.remove, trimmed: out.trim, shifted: out.shift, keptTracks: keep || [], pictureEnd: ends.picture, end: ends.all };
            for (var t in tail) if (tail.hasOwnProperty(t)) r[t] = tail[t];
            return r;
        };
        if (!apply) return summary();
        // 1. clips inside the range go; 2. edges are trimmed; 3. everything after moves left, earliest
        // first across all tracks, so a linked partner Premiere drags along never lands on a clip that
        // has not moved yet. A clip already where it belongs (moved with its partner) is left alone.
        for (i = 0; i < items.length; i++) {
            var x = items[i], c0 = clipAt(x.tr, x.clip.nodeId, x.clip.start, x.clip.end, fps);
            if (x.kind === "remove") { if (c0) c0.remove(false, false); continue; }
            if (x.kind === "trim-end") { if (c0) c0.end = time(from, fps); continue; }
            if (x.kind === "trim-head" && c0) { c0.inPoint = time(x["in"], fps); c0.start = time(to, fps); }
        }
        var moves = [];
        for (i = 0; i < items.length; i++) if (items[i].kind === "shift" || items[i].kind === "trim-head") moves.push(items[i]);
        var startNow = function (p) { return p.kind === "shift" ? p.clip.start : to; };
        moves.sort(function (p, q) { return startNow(p) - startNow(q); });
        for (i = 0; i < moves.length; i++) {
            var m = moves[i], curStart = startNow(m), curEnd = m.end + d;
            var cm = clipAt(m.tr, m.clip.nodeId, curStart, curEnd, fps);
            if (cm) cm.move(time(-d, fps));
            else if (!clipAt(m.tr, m.clip.nodeId, m.start, m.end, fps)) throw new Error("ripple lost " + m.clip.name + " on " + m.tr.name + " (expected at " + curStart + "-" + curEnd + ")");
        }
        // every planned clip is where the plan put it
        for (i = 0; i < items.length; i++) {
            var y = items[i];
            if (y.kind === "remove") { if (clipAt(y.tr, y.clip.nodeId, y.clip.start, y.clip.end, fps)) throw new Error("ripple did not remove " + y.clip.name + " on " + y.tr.name); continue; }
            var cy = clipAt(y.tr, y.clip.nodeId, y.start, y.end, fps);
            if (!cy) throw new Error("ripple left " + y.clip.name + " on " + y.tr.name + " away from " + y.start + "-" + y.end);
            touched.push(keyOf(clipInfo(cy, y.tr.name, 0, fps)));
        }
        return summary();
    }

    /** One edit op. Dry run: check preconditions, say what would happen. Apply: do it and verify. */
    function runOp(s, op, fps, apply, touched) {
        var t, c, hit, info, before, i;
        switch (op.op) {
            case "ripple_delete": {
                var r = ripple(s, frameArg(op.from, fps), frameArg(op.to, fps), op.keepTracks, fps, apply, touched);
                r.op = "ripple_delete";
                return r;
            }
            case "remove": {
                hit = findClip(s, op.clip, fps); c = hit.clip; info = clipInfo(c, hit.track.name, hit.index, fps);
                if (op.ripple === true) {
                    var rr = ripple(s, info.start, info.end, op.keepTracks, fps, apply, touched);
                    rr.op = "remove"; rr.clip = info; rr.ripple = true;
                    return rr;
                }
                var linked = hit.track.kind === "V" && op.linked !== false ? linkedAudio(s, c, fps) : [];
                touched.push(keyOf(info));
                for (i = 0; i < linked.length; i++) touched.push(keyOf(clipInfo(linked[i].clip, linked[i].track, 0, fps)));
                if (apply) { c.remove(false, false); for (i = 0; i < linked.length; i++) linked[i].clip.remove(false, false); }
                return { op: "remove", clip: info, linkedAudio: linked.length };
            }
            case "trim": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                var ns = op.start === undefined ? before.start : frameArg(op.start, fps), ne = op.end === undefined ? before.end : frameArg(op.end, fps);
                if (ne <= ns) throw new Error("trim leaves no frames on " + before.name);
                var rate = before.speed || 1, nin = before["in"] + Math.round((ns - before.start) * rate);
                if (nin < 0) throw new Error("trim reaches before the first source frame of " + before.name);
                touched.push(keyOf(before));
                if (apply) {
                    if (ne !== before.end) c.end = time(ne, fps);
                    if (ns !== before.start) { c.inPoint = time(nin, fps); c.start = time(ns, fps); }
                    c = hit.track.track.clips[hit.index];
                    if (fr(c.start, fps) !== ns || fr(c.end, fps) !== ne) throw new Error("trim on " + before.name + " ended at " + fr(c.start, fps) + "-" + fr(c.end, fps) + " instead of " + ns + "-" + ne);
                    touched.push(keyOf(clipInfo(c, hit.track.name, hit.index, fps)));
                }
                return { op: "trim", clip: before, to: { start: ns, end: ne, "in": nin } };
            }
            case "move": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                var to = frameArg(op.to, fps), len = before.end - before.start, others = [];
                for (i = 0; i < hit.track.track.clips.numItems; i++) if (i !== hit.index) { var o = hit.track.track.clips[i]; if (fr(o.start, fps) < to + len && fr(o.end, fps) > to) others.push(o.name); }
                if (others.length) throw new Error("move of " + before.name + " to " + to + " would overlap " + others.join(", ") + "; nothing changed");
                touched.push(keyOf(before));
                if (apply) {
                    c.move(time(to - before.start, fps));
                    var moved = null;
                    for (i = 0; i < hit.track.track.clips.numItems; i++) { var m = hit.track.track.clips[i]; if (nodeOf(m) === before.nodeId && fr(m.start, fps) === to) moved = m; }
                    if (!moved) throw new Error("move of " + before.name + " did not land at " + to);
                    touched.push(keyOf(clipInfo(moved, hit.track.name, 0, fps)));
                }
                return { op: "move", clip: before, to: to };
            }
            case "set_speed": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                if (hit.track.kind !== "V") throw new Error("set_speed works on video tracks");
                if (!(op.rate > 0)) throw new Error("rate must be > 0 (percent)");
                touched.push(keyOf(before));
                if (apply) {
                    var q = qeClip(s, hit.track.index, hit.index, before.name), settings = s.getSettings(), dur = time(before.end - before.start, fps);
                    q.setSpeed(op.rate / 100, dur.getFormatted(settings.videoFrameRate, settings.videoDisplayFormat), false, false, false);
                    q.setTimeInterpolationType(INTERP[op.interpolation || "optical-flow"]);
                    c = hit.track.track.clips[hit.index];
                    if (fr(c.start, fps) !== before.start || fr(c.end, fps) !== before.end) { c.start = time(before.start, fps); c.end = time(before.end, fps); c = hit.track.track.clips[hit.index]; }
                    if (fr(c.start, fps) !== before.start || fr(c.end, fps) !== before.end || Math.abs(c.getSpeed() - op.rate / 100) > 0.001) throw new Error("speed on " + before.name + " did not apply cleanly");
                    touched.push(keyOf(clipInfo(c, hit.track.name, hit.index, fps)));
                }
                return { op: "set_speed", clip: before, rate: op.rate, interpolation: op.interpolation || "optical-flow" };
            }
            case "insert":
            case "overwrite": {
                t = trackOf(s, op.track);
                op.at = frameArg(op.at, fps);
                if (!(op.dur > 0)) throw new Error(op.op + " needs dur (frames)");
                var busy = occupants(t.track, op.at, op.at + op.dur, fps);
                if (op.op === "overwrite" && busy.length && op.replaceExisting !== true) throw new Error("overwrite at " + op.at + " on " + t.name + " would cover " + busy.join(", ") + " (pass replaceExisting: true or remove them first); nothing changed");
                if (op.op === "insert") throw new Error("insert ripples every later clip on " + t.name + "; use overwrite on a free range");
                if (!apply) return { op: op.op, track: t.name, at: op.at, dur: op.dur, covers: busy, source: op.aeComp || op.media };
                var placed = place(s, t, itemFor(op), op, fps);
                if (op.name) placed.name = op.name;
                touched.push(keyOf(clipInfo(placed, t.name, 0, fps)));
                return { op: op.op, clip: clipInfo(placed, t.name, 0, fps) };
            }
            case "replace_media": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                if (hit.track.kind !== "V") throw new Error("replace_media works on video tracks");
                var lost = []; for (i = 2; i < before.effects.length; i++) lost.push(before.effects[i]); // 0/1 = Opacity/Motion
                touched.push(keyOf(before));
                if (!apply) return { op: "replace_media", clip: before, source: op.aeComp || op.media, effectsNotCarried: lost };
                var item = itemFor(op);
                c.remove(false, false);
                var rep = place(s, hit.track, item, { op: "overwrite", at: before.start, dur: before.end - before.start, "in": op["in"] === undefined ? before["in"] : op["in"], keepAudio: op.keepAudio }, fps);
                if (op.keepName !== false) rep.name = before.name;
                touched.push(keyOf(clipInfo(rep, hit.track.name, 0, fps)));
                return { op: "replace_media", clip: clipInfo(rep, hit.track.name, 0, fps), was: before, effectsNotCarried: lost };
            }
            case "relink": {
                var it = findMedia(app.project.rootItem, op.from);
                if (!it) throw new Error("no project item uses " + op.from);
                if (!new File(op.to).exists) throw new Error("new media not found: " + op.to);
                if (!it.canChangeMediaPath()) throw new Error("Premiere cannot relink " + it.name);
                // every clip of this item changes: mark them as touched
                eachClip(s, function (x, track) { if (norm(mediaOf(x)) === norm(op.from)) touched.push(track + "@" + fr(x.start, fps) + "-" + fr(x.end, fps) + "#" + nodeOf(x)); });
                if (apply && !it.changeMediaPath(op.to, true)) throw new Error("changeMediaPath failed for " + it.name);
                if (apply) eachClip(s, function (x, track) { if (nodeOf(x) === String(it.nodeId)) touched.push(track + "@" + fr(x.start, fps) + "-" + fr(x.end, fps) + "#" + nodeOf(x)); });
                return { op: "relink", item: it.name, from: op.from, to: op.to };
            }
            case "rename": {
                hit = findClip(s, op.clip, fps); before = clipInfo(hit.clip, hit.track.name, hit.index, fps);
                touched.push(keyOf(before));
                if (apply) hit.clip.name = op.name;
                return { op: "rename", clip: before, name: op.name };
            }
            case "set_motion": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                var motion = c.components[findEffect(c, "Motion")], opacity = null, setv = [];
                try { opacity = c.components[findEffect(c, "Opacity")]; } catch (e5) { opacity = null; }
                if (op.scale !== undefined) setv.push([findParam(motion, "Scale"), op.scale]);
                if (op.position !== undefined) setv.push([findParam(motion, "Position"), op.position]);
                if (op.rotation !== undefined) setv.push([findParam(motion, "Rotation"), op.rotation]);
                if (op.opacity !== undefined) { if (!opacity) throw new Error("no Opacity on " + before.name); setv.push([findParam(opacity, "Opacity"), op.opacity]); }
                for (i = 0; i < setv.length; i++) if (setv[i][0].isTimeVarying()) throw new Error(setv[i][0].displayName + " on " + before.name + " has keyframes; use set_effect_param with keys");
                touched.push(keyOf(before));
                if (apply) for (i = 0; i < setv.length; i++) setv[i][0].setValue(setv[i][1], true);
                return { op: "set_motion", clip: before, set: { scale: op.scale, position: op.position, rotation: op.rotation, opacity: op.opacity } };
            }
            case "add_effect": {
                hit = findClip(s, op.clip, fps); before = clipInfo(hit.clip, hit.track.name, hit.index, fps);
                if (hit.track.kind !== "V") throw new Error("add_effect works on video tracks");
                app.enableQE();
                var fx = qe.project.getVideoEffectByName(op.effect);
                if (!fx) throw new Error("Premiere has no video effect named " + op.effect);
                touched.push(keyOf(before));
                if (apply) {
                    qeClip(s, hit.track.index, hit.index, before.name).addVideoEffect(fx);
                    var after = effectNames(hit.track.track.clips[hit.index]);
                    if (after.length !== before.effects.length + 1) throw new Error("effect " + op.effect + " was not added to " + before.name);
                    return { op: "add_effect", clip: before, effects: after };
                }
                return { op: "add_effect", clip: before, effect: op.effect };
            }
            case "remove_effect": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                var ei = findEffect(c, op.effect);
                if (ei < 2) throw new Error("Motion and Opacity cannot be removed");
                touched.push(keyOf(before));
                if (apply) {
                    qeClip(s, hit.track.index, hit.index, before.name).getComponentAt(ei).remove();
                    var left = effectNames(hit.track.track.clips[hit.index]);
                    if (left.length !== before.effects.length - 1) throw new Error("effect " + op.effect + " was not removed from " + before.name);
                    return { op: "remove_effect", clip: before, effects: left };
                }
                return { op: "remove_effect", clip: before, effect: before.effects[ei] };
            }
            case "set_effect_param": {
                hit = findClip(s, op.clip, fps); c = hit.clip; before = clipInfo(c, hit.track.name, hit.index, fps);
                var prop = findParam(c.components[findEffect(c, op.effect)], op.param), old = propValue(prop);
                if (op.keys === undefined && prop.isTimeVarying()) throw new Error(prop.displayName + " has keyframes: pass keys to replace them");
                touched.push(keyOf(before));
                if (apply) {
                    if (op.color) prop.setColorValue(op.color[3] === undefined ? 255 : op.color[3], op.color[0], op.color[1], op.color[2], true);
                    else if (op.keys) {
                        prop.setTimeVarying(true);
                        for (i = 0; i < op.keys.length; i++) { var kt = new Time(); kt.seconds = op.keys[i].seconds; prop.addKey(kt); prop.setValueAtKey(kt, op.keys[i].value, true); }
                    } else prop.setValue(op.value, true);
                }
                return { op: "set_effect_param", clip: before, param: prop.displayName, from: old, to: op.color ? { color: op.color } : op.keys ? { keys: op.keys } : { value: op.value } };
            }
            default:
                throw new Error("unknown op: " + op.op);
        }
    }

    var INTERP = { "frame-sampling": 0, "frame-blend": 1, "optical-flow": 2 };
    var actions = {
        ping: function () { return { premiere: app.version, project: project() }; },
        openProject: function (a) {
            if (app.project && norm(app.project.path) === norm(a.path)) return { project: project(), opened: false };
            if (!new File(a.path).exists) throw new Error("project not found: " + a.path);
            // suppress conversion dialog, bypass locate-file and warning dialogs, keep the MRU list
            if (!app.openDocument(a.path, true, true, true, true)) throw new Error("Premiere refused to open " + a.path);
            if (!app.project || norm(app.project.path) !== norm(a.path)) throw new Error("opened " + a.path + " but the active project is " + (app.project ? app.project.path : "none"));
            return { project: project(), opened: true };
        },
        closeProject: function (a) {
            requireProject(a);
            var was = project();
            // (saveFirst, promptIfDirty): undo discards the edit on purpose
            app.project.closeDocument(a.save === true, false);
            return { closed: was };
        },
        save: function (a) {
            requireProject(a);
            saveProject();
            return { project: project(), saved: true };
        },
        quit: function (a) {
            requireProject(a);
            if (a.save !== false) saveProject();
            return { project: project(), saved: a.save !== false, quitting: true };
        },
        importMedia: function (a) {
            requireProject(a);
            var items = a.items || [], byBin = {}, order = [], out = [], i, it, bin, item;
            for (i = 0; i < items.length; i++) {
                it = items[i];
                if (!new File(it.source).exists) { out.push({ source: it.source, error: "source not found" }); continue; }
                if (it.proxy && !new File(it.proxy).exists) { out.push({ source: it.source, error: "proxy not found: " + it.proxy }); continue; }
                if (!byBin.hasOwnProperty(it.bin)) { byBin[it.bin] = []; order.push(it.bin); }
                byBin[it.bin].push(it);
            }
            // import only what the project does not have yet, so a retry after a cancelled import resumes
            for (i = 0; i < order.length; i++) {
                bin = binAt(order[i]);
                var missing = [];
                for (var k = 0; k < byBin[order[i]].length; k++) if (!findMedia(app.project.rootItem, byBin[order[i]][k].source)) missing.push(byBin[order[i]][k].source);
                if (missing.length && !app.project.importFiles(missing, true, bin, false)) throw new Error("Premiere refused to import into " + order[i]);
                for (k = 0; k < byBin[order[i]].length; k++) {
                    it = byBin[order[i]][k];
                    item = findMedia(app.project.rootItem, it.source);
                    var row = { source: it.source, bin: order[i], name: item ? item.name : null, imported: !!item, proxy: "none" };
                    if (!item) row.error = "not in the project after import";
                    else if (it.proxy) {
                        if (item.hasProxy() && norm(item.getProxyPath()) === norm(it.proxy)) row.proxy = "already";
                        else if (item.hasProxy()) { row.proxy = "different"; row.error = "another proxy is attached: " + item.getProxyPath(); }
                        else if (!item.canProxy()) { row.proxy = "failed"; row.error = "Premiere cannot attach a proxy to this item"; }
                        else {
                            item.attachProxy(new File(it.proxy).fsName, 0);
                            if (item.hasProxy() && norm(item.getProxyPath()) === norm(it.proxy)) row.proxy = "attached";
                            else { row.proxy = "failed"; row.error = "attachProxy did not take"; }
                        }
                    }
                    out.push(row);
                }
            }
            if (a.enableProxies) app.setEnableProxies(1);
            return { project: project(), items: out };
        },
        setSpeed: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), ti = (a.track || 1) - 1, track = s.videoTracks[ti], report = [], i;
            if (!track) throw new Error("no video track V" + (ti + 1));
            for (i = 0; i < a.clips.length; i++) {
                var want = a.clips[i], frame = frameArg(want.at, fps), n = -1;
                for (var k = 0; k < track.clips.numItems; k++) { var x = track.clips[k]; if (fr(x.start, fps) <= frame && frame < fr(x.end, fps)) n = k; }
                if (n < 0) throw new Error("no clip on V" + (ti + 1) + " at " + want.at);
                if (!(want.speed > 0)) throw new Error("speed must be > 0 at frame " + want.at);
                var c = track.clips[n];
                var r = runOp(s, { op: "set_speed", clip: { track: "V" + (ti + 1), start: fr(c.start, fps), end: fr(c.end, fps) }, rate: want.speed * 100, interpolation: want.interpolation }, fps, true, []);
                c = track.clips[n];
                report.push({ name: r.clip.name, at: frame, start: fr(c.start, fps), end: fr(c.end, fps), speed: c.getSpeed(), interpolation: r.interpolation });
            }
            return { project: project(), sequence: { name: s.name, id: s.sequenceID }, clips: report };
        },
        timeline: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), video = [], audio = [], settings = s.getSettings();
            eachClip(s, function (c, track, n) { (track.charAt(0) === "V" ? video : audio).push(clipInfo(c, track, n, fps)); });
            return {
                project: project(), sequence: { name: s.name, id: s.sequenceID }, fps: fps,
                width: settings.videoFrameWidth, height: settings.videoFrameHeight,
                end: fr(s.end !== undefined ? { seconds: Number(s.end) / 254016000000 } : { seconds: 0 }, fps),
                tracks: { video: s.videoTracks.numTracks, audio: s.audioTracks.numTracks }, video: video, audio: audio,
            };
        },
        clipEffects: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), hit = findClip(s, a.clip, fps);
            return { project: project(), sequence: { name: s.name, id: s.sequenceID }, clip: clipInfo(hit.clip, hit.track.name, hit.index, fps), effects: effectsOf(hit.clip) };
        },
        edit: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), ops = a.ops || [], results = [], touched = [], i;
            // dry run: every op checked against the sequence as it is now; nothing changes
            if (a.apply !== true) {
                var problems = [];
                for (i = 0; i < ops.length; i++) {
                    try { results.push(runOp(s, ops[i], fps, false, touched)); } catch (e) { problems.push({ op: i, error: String(e.message || e) }); results.push(null); }
                }
                return { project: project(), sequence: { name: s.name, id: s.sequenceID }, applied: false, plan: results, problems: problems };
            }
            var before = signature(s, fps), failed = null;
            for (i = 0; i < ops.length; i++) {
                try { results.push(runOp(s, ops[i], fps, true, touched)); } catch (e2) { failed = { op: i, error: String(e2.message || e2) }; break; }
            }
            var after = signature(s, fps), skip = {}, changed = [], k;
            for (i = 0; i < touched.length; i++) skip[touched[i]] = true;
            for (k in before) if (before.hasOwnProperty(k) && !skip[k] && before[k] !== after[k]) changed.push({ clip: k, was: before[k], now: after.hasOwnProperty(k) ? after[k] : null });
            for (k in after) if (after.hasOwnProperty(k) && !skip[k] && !before.hasOwnProperty(k)) changed.push({ clip: k, was: null, now: after[k] });
            var saved = false;
            if (a.save === true && !failed && !changed.length) { saveProject(); saved = true; }
            return { project: project(), sequence: { name: s.name, id: s.sequenceID }, applied: true, results: results, failed: failed, untouchedChanged: changed, saved: saved };
        },
        frames: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), list = a.frames || [], out = [], i;
            if (!list.length && a.from !== undefined) for (i = frameArg(a.from, fps); i < frameArg(a.to, fps); i += a.step || 1) list.push(i);
            var total = list.length;
            // skip/take: a long range is fetched in small batches so one stuck frame never holds the queue for minutes
            if (a.take) list = list.slice(a.skip || 0, (a.skip || 0) + a.take);
            if (!list.length || list.length > 300) throw new Error("frames: 1 to 300 frames per call");
            app.project.openSequence(s.sequenceID);
            app.enableQE();
            var qs = qe.project.getActiveSequence();
            for (i = 0; i < list.length; i++) {
                var f = frameArg(list[i], fps), base = a.dir + "/" + a.prefix + ("00000" + i).slice(-5);
                qs.exportFramePNG(tcOf(f, fps), new File(base).fsName);
                if (!new File(base + ".png").exists) throw new Error("Premiere wrote no frame for " + tcOf(f, fps));
                out.push({ frame: f, tc: tcOf(f, fps), file: base + ".png" });
            }
            return { sequence: { name: s.name, id: s.sequenceID }, frames: out, total: total };
        },
        exportRange: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), from = frameArg(a.from, fps), to = frameArg(a.to, fps);
            if (!(to > from)) throw new Error("exportRange: to must be after from");
            if (!new File(a.preset).exists) throw new Error("preset not found: " + a.preset);
            if (new File(a.path).exists) throw new Error("output exists: " + a.path);
            var oldIn = Number(s.getInPoint()), oldOut = Number(s.getOutPoint()), r;
            try { s.setInPoint(from / fps); s.setOutPoint(to / fps); r = s.exportAsMediaDirect(a.path, a.preset, 1); }
            finally { if (oldIn >= 0) s.setInPoint(oldIn); else s.clearInPoint(); if (oldOut >= 0) s.setOutPoint(oldOut); else s.clearOutPoint(); }
            if (!new File(a.path).exists) throw new Error("Premiere exported nothing (" + r + ")");
            return { sequence: { name: s.name, id: s.sequenceID }, path: a.path, from: from, to: to };
        },
        /**
         * Sequence markers: list them, clear some (by colour index / name text / all) and add new ones,
         * as one step. a.apply !== true is a dry run (what would go, what would come). Colour index:
         * 0 green, 1 red, 2 purple, 3 orange, 4 yellow, 5 white, 6 blue, 7 cyan.
         */
        markers: function (a) {
            requireProject(a);
            var s = findSequence(a.sequence), fps = seqFps(s), mk = s.markers, i, m, all = [], out = [], gone = [], keep = {};
            function colorOf(x) { try { return x.getColorByIndex(); } catch (e) { return null; } }
            function describe(x) { return { frame: fr(x.start, fps), end: fr(x.end, fps), name: String(x.name), comments: String(x.comments || ""), color: colorOf(x) }; }
            for (m = mk.getFirstMarker(); m; m = mk.getNextMarker(m)) all.push(m);
            var clear = a.clear || null;
            if (clear) {
                var colors = clear.colors || null, text = clear.nameContains ? String(clear.nameContains).toLowerCase() : null;
                if (clear.all !== true && !colors && !text) throw new Error("markers.clear needs all, colors or nameContains");
                for (i = 0; i < all.length; i++) {
                    var hit = clear.all === true, d = describe(all[i]), j;
                    if (!hit && colors) for (j = 0; j < colors.length; j++) if (d.color === colors[j]) hit = true;
                    if (!hit && text && (d.name.toLowerCase().split(text).length > 1 || d.comments.toLowerCase().split(text).length > 1)) hit = true;
                    if (hit) gone.push({ marker: all[i], info: d });
                }
            }
            var add = a.add || [], plan = [];
            for (i = 0; i < add.length; i++) {
                var at = frameArg(add[i].at, fps), dur = add[i].dur || 0, col = add[i].color === undefined ? 1 : add[i].color;
                if (!(at >= 0)) throw new Error("markers.add[" + i + "] needs at (frame or timecode)");
                if (!(col >= 0 && col <= 7)) throw new Error("markers.add[" + i + "].color is 0-7");
                plan.push({ frame: at, end: at + dur, name: String(add[i].name || ""), comments: String(add[i].comment || ""), color: col });
            }
            var removed = [];
            for (i = 0; i < gone.length; i++) removed.push(gone[i].info);
            if (a.apply !== true) {
                for (i = 0; i < all.length; i++) out.push(describe(all[i]));
                return { sequence: { name: s.name, id: s.sequenceID }, dryRun: true, existing: out.length, markers: out.slice(0, 300), willRemove: removed, willAdd: plan };
            }
            for (i = 0; i < gone.length; i++) if (!mk.deleteMarker(gone[i].marker)) throw new Error("Premiere refused to delete the marker at frame " + gone[i].info.frame);
            for (i = 0; i < plan.length; i++) {
                var nm = mk.createMarker(plan[i].frame / fps);
                nm.name = plan[i].name; nm.comments = plan[i].comments;
                if (plan[i].end > plan[i].frame) nm.end = time(plan[i].end, fps);
                try { nm.setColorByIndex(plan[i].color, 0); } catch (e2) { throw new Error("Premiere could not set the marker colour (needs a Premiere with Marker.setColorByIndex)"); }
            }
            var after = 0;
            for (m = mk.getFirstMarker(); m; m = mk.getNextMarker(m)) after++;
            if (a.save === true) saveProject();
            return { sequence: { name: s.name, id: s.sequenceID }, dryRun: false, removed: removed.length, added: plan.length, total: after, saved: a.save === true };
        },
        aeRun: function (a) {
            if (typeof BridgeTalk === "undefined") throw new Error("BridgeTalk is not available in this Premiere");
            if (!BridgeTalk.isRunning("aftereffects")) throw new Error("After Effects is not running");
            if (!new File(a.file).exists) throw new Error("script not found: " + a.file);
            var body = "(function(){";
            if (a.aep) body += "var want=new File(" + stringify(a.aep) + ");if(!app.project||!app.project.file||app.project.file.fsName.toLowerCase()!==want.fsName.toLowerCase()){if(!want.exists)return 'ERROR: aep not found';app.open(want);}";
            body += "try{var r=$.evalFile(new File(" + stringify(a.file) + "));return String(r);}catch(e){return 'ERROR: '+e.message+' (line '+e.line+')';}})()";
            var bt = new BridgeTalk(), reply = null, failed = null;
            bt.target = "aftereffects"; bt.body = body;
            bt.onResult = function (r) { reply = r.body; };
            bt.onError = function (e) { failed = e.body; };
            bt.send(a.timeoutSec || 120);
            if (failed) throw new Error("After Effects: " + failed);
            if (reply === null) throw new Error("After Effects did not answer within " + (a.timeoutSec || 120) + " s");
            if (/^ERROR:/.test(String(reply))) throw new Error("After Effects " + reply);
            return { reply: String(reply) };
        },
        status: function () { return { premiere: app.version, project: project(), sequences: app.project ? sequences() : [] }; },
        importXml: function (a) {
            if (!app.project) throw new Error("no project open in Premiere");
            if (a.expectProject && norm(app.project.path) !== norm(a.expectProject)) throw new Error("the open Premiere project changed to " + app.project.path + "; nothing imported");
            if (!new File(a.path).exists) throw new Error("xml not found: " + a.path);
            var before = {}, seqs = app.project.sequences, i;
            for (i = 0; i < seqs.numSequences; i++) before[seqs[i].sequenceID] = true;
            var bin = binNamed(a.bin || "CatCut");
            if (!app.project.importFiles([a.path], true, bin, false)) throw new Error("Premiere refused to import " + a.path);
            var added = [];
            seqs = app.project.sequences;
            for (i = 0; i < seqs.numSequences; i++) if (!before[seqs[i].sequenceID]) added.push({ name: seqs[i].name, id: seqs[i].sequenceID });
            if (added.length === 0) throw new Error("import finished but no new sequence appeared");
            if (a.open !== false) app.project.openSequence(added[0].id);
            return { project: project(), bin: bin.name, sequences: added, opened: a.open !== false ? added[0] : null };
        },
        exportXml: function (a) {
            if (!app.project) throw new Error("no project open in Premiere");
            var s = findSequence(a.sequence);
            if (!s.exportAsFinalCutProXML(a.path, 1)) throw new Error("Premiere could not export " + s.name);
            if (!new File(a.path).exists) throw new Error("Premiere reported success but wrote no file");
            return { project: project(), sequence: { name: s.name, id: s.sequenceID }, path: a.path };
        }
    };
    var helpers = {
        stringify: stringify, norm: norm, project: project, findSequence: findSequence, requireProject: requireProject, saveProject: saveProject,
        binNamed: binNamed, binAt: binAt, findMedia: findMedia, findNamed: findNamed, seqFps: seqFps, fr: fr, time: time, findClip: findClip,
        clipInfo: clipInfo, effectsOf: effectsOf, qeClip: qeClip, runOp: runOp
    };
    var list = [];
    for (var name in actions) if (actions.hasOwnProperty(name)) list.push(name);
    actions.ping = function () { return { premiere: app.version, project: project(), actions: list }; };
    return function (job) {
        try {
            var fn = actions[job.action], user = catcut_user_actions[job.action];
            if (!fn && typeof user === "function") return stringify({ ok: true, data: user(job.args || {}, helpers) });
            if (!fn) throw new Error("unknown action: " + job.action);
            return stringify({ ok: true, data: fn(job.args || {}) });
        } catch (e) {
            return stringify({ ok: false, error: String(e && e.message ? e.message : e) });
        }
    };
})();
// per-job actions, kept across bridge updates
(function () {
    try {
        var f = new File(new File($.fileName).parent.fsName + "/host.user.jsx");
        if (f.exists) $.evalFile(f);
    } catch (e) { /* no user file, or it failed: core actions still work */ }
})();
