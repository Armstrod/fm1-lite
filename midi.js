// SPDX-License-Identifier: GPL-3.0-only
// FM-1 Lite's MIDI file player: open a .mid from the phone, split it onto the FM-1's four parts, and play it through
// the running firmware as live MIDI (Felucca-family firmwares route channels 1..4 to their tracks 1..4; TOUGE's are
// STABS, BASS, LEAD, DRUMS). The file is read here, on the phone; nothing is uploaded.
"use strict";

// ------------------------------------------------------------------ the Standard MIDI File (types 0 and 1)
function parseMidi(buf) {
  const d = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (str(0, 4) !== "MThd") throw new Error("not a MIDI file");
  const ntrk = d.getUint16(10), div = d.getUint16(12);
  if (div & 0x8000) throw new Error("SMPTE-timed MIDI files aren't supported");
  let o = 8 + d.getUint32(4);
  const tracks = [], tempos = [];
  for (let t = 0; t < ntrk && o < u8.length; t++) {
    if (str(o, 4) !== "MTrk") break;
    const len = d.getUint32(o + 4), end = o + 8 + len;
    let p = o + 8, tick = 0, run = 0;
    const tr = { name: "", notes: [], programs: new Set(), channels: new Set() };
    const open = new Map();                       /* "ch:note" -> [start tick, velocity] */
    const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 127); } while (b & 128 && p < end); return v; };
    while (p < end) {
      tick += vlq();
      let st = u8[p];
      if (st < 0x80) st = run; else { p++; if (st < 0xF0) run = st; }
      if (st === 0xFF) {                           /* meta */
        const type = u8[p++], l = vlq();
        if (type === 0x03 && !tr.name) tr.name = str(p, l).replace(/[^\x20-\x7e]/g, "").trim();
        if (type === 0x51) tempos.push([tick, (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2]]);
        p += l;
      } else if (st === 0xF0 || st === 0xF7) { p += vlq(); }
      else {
        const hi = st & 0xF0, ch = st & 15, a = u8[p++], b = hi === 0xC0 || hi === 0xD0 ? 0 : u8[p++];
        if (hi === 0x90 && b > 0) { open.set(ch + ":" + a, [tick, b]); tr.channels.add(ch); }
        else if (hi === 0x80 || (hi === 0x90 && b === 0)) {
          const k = ch + ":" + a, s = open.get(k);
          if (s) { tr.notes.push({ ch, n: a, t0: s[0], t1: Math.max(tick, s[0] + 1), v: s[1] }); open.delete(k); }
        } else if (hi === 0xC0) tr.programs.add(a);
      }
    }
    for (const [k, s] of open) { const [ch, n] = k.split(":").map(Number); tr.notes.push({ ch, n, t0: s[0], t1: tick, v: s[1] }); }
    tracks.push(tr);
    o = end;
  }
  // a type-0 file, or a track that holds several channels: one entry per channel
  const parts = [];
  for (const tr of tracks)
    for (const ch of tr.channels) {
      const notes = tr.notes.filter((n) => n.ch === ch);
      if (notes.length) parts.push({ name: tr.name || (ch === 9 ? "Drums" : "Channel " + (ch + 1)), ch, notes });
    }
  tempos.sort((a, b) => a[0] - b[0]);
  if (!tempos.length || tempos[0][0] > 0) tempos.unshift([0, 500000]);
  // ticks -> seconds through the tempo map
  const secs = (tick) => {
    let s = 0, lt = 0, us = tempos[0][1];
    for (const [t, v] of tempos) { if (t >= tick) break; s += (t - lt) * us / div / 1e6; lt = t; us = v; }
    return s + (tick - lt) * us / div / 1e6;
  };
  for (const p of parts) for (const n of p.notes) { n.s0 = secs(n.t0); n.s1 = secs(n.t1); }
  const bpm = Math.round(60e6 / tempos[0][1]);
  const length = Math.max(0, ...parts.flatMap((p) => p.notes.map((n) => n.s1)));
  return { parts, bpm, length };
}

// ------------------------------------------------------------------ the split: the FM-1's four parts
const ROLES = ["off", "lead", "bass", "chords", "drums"];
const ROLE_CH = { chords: 0, bass: 1, lead: 2, drums: 3 };     /* TOUGE: track 1 STABS, 2 BASS, 3 LEAD, 4 DRUMS */
function stats(p) {
  const ns = p.notes, avg = ns.reduce((a, n) => a + n.n, 0) / ns.length;
  let poly = 0;                                    /* how often notes overlap: chords */
  const sorted = [...ns].sort((a, b) => a.s0 - b.s0);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].s0 < sorted[i - 1].s1 - 0.02) poly++;
  return { avg, poly: poly / ns.length, count: ns.length };
}
function autoAssign(parts) {
  const st = parts.map(stats);
  const roles = parts.map((p) => (p.ch === 9 ? "drums" : "off"));
  const melodic = parts.map((p, i) => i).filter((i) => parts[i].ch !== 9 && st[i].count >= 8);
  if (!melodic.length) return roles;
  const bass = melodic.slice().sort((a, b) => st[a].avg - st[b].avg)[0];
  if (st[bass].avg < 55) roles[bass] = "bass";
  // the lead: high, busy, mostly one note at a time
  const leadScore = (i) => st[i].avg + Math.min(st[i].count, 400) / 40 - st[i].poly * 25;
  const rest = melodic.filter((i) => roles[i] === "off");
  if (rest.length) {
    const lead = rest.slice().sort((a, b) => leadScore(b) - leadScore(a))[0];
    roles[lead] = "lead";
    for (const i of rest) if (i !== lead) roles[i] = "chords";
  }
  return roles;
}
// one part's notes as played on the FM-1: the lead and the bass one at a time (the top / bottom note wins), the chords
// at most three at once, each moved into its register by octaves unless the player set an octave
const RANGE = { lead: [60, 91], bass: [28, 52], chords: [52, 79], drums: [0, 127] };
function voice(role, notes, octave) {
  let ns = notes.map((n) => ({ ...n }));
  if (role !== "drums") {
    const [lo, hi] = RANGE[role];
    if (octave === "auto") {
      const avg = ns.reduce((a, n) => a + n.n, 0) / ns.length, mid = (lo + hi) / 2;
      const shift = Math.round((mid - avg) / 12) * 12;
      for (const n of ns) n.n += shift;
    } else for (const n of ns) n.n += 12 * octave;
    for (const n of ns) { while (n.n < lo - 6) n.n += 12; while (n.n > hi + 6) n.n -= 12; }
  }
  ns.sort((a, b) => a.s0 - b.s0 || b.n - a.n);
  if (role === "lead" || role === "bass") {        /* mono: a note starting cuts the last; of a chord, the top (lead) / bottom (bass) */
    const out = [];
    for (const n of ns) {
      const last = out[out.length - 1];
      if (last && Math.abs(n.s0 - last.s0) < 0.015) {
        if (role === "lead" ? n.n > last.n : n.n < last.n) out[out.length - 1] = n;
        continue;
      }
      if (last && last.s1 > n.s0) last.s1 = Math.max(last.s0 + 0.01, n.s0 - 0.002);
      out.push(n);
    }
    ns = out;
  } else if (role === "chords") {                  /* three at a time: the newest three */
    const out = [];
    for (const n of ns) {
      const sounding = out.filter((m) => m.s1 > n.s0 && m.s0 <= n.s0);
      if (sounding.length >= 3) { const oldest = sounding.sort((a, b) => a.s0 - b.s0)[0]; oldest.s1 = Math.max(oldest.s0 + 0.01, n.s0 - 0.002); }
      out.push(n);
    }
    ns = out;
  }
  return ns;
}

// ------------------------------------------------------------------ the player
const MP = { file: null, roles: [], octs: [], speed: 1, transpose: 0, loop: true, playing: false, t0: 0, sentTo: 0,
             timer: null, events: [], held: [] };
function buildEvents() {
  const ev = [];
  MP.file.parts.forEach((p, i) => {
    const role = MP.roles[i];
    if (role === "off") return;
    const ch = ROLE_CH[role];
    for (const n of voice(role, p.notes, MP.octs[i])) {
      const note = role === "drums" ? n.n : Math.max(0, Math.min(127, n.n + MP.transpose));
      ev.push([n.s0 / MP.speed, 0x90 | ch, note, Math.max(1, n.v)]);
      ev.push([n.s1 / MP.speed - 0.001, 0x80 | ch, note, 0]);
    }
  });
  ev.sort((a, b) => a[0] - b[0] || (a[1] & 0xF0) - (b[1] & 0xF0));   /* (a note-off before a note-on at the same time) */
  MP.events = ev;
  MP.len = MP.file.length / MP.speed;
}
function pump() {                                   /* the next second's notes to the worklet, by sample frame */
  if (!MP.playing || !node || !ac) return;
  const now = ac.currentTime - MP.t0, until = now + 1.2, out = [], sr = ac.sampleRate;
  while (MP.sentTo < until) {
    const lap = Math.floor(MP.sentTo / MP.len), base = lap * MP.len;
    if (lap > 0 && !MP.loop) { if (now > MP.len + 0.5) midiStop(); break; }
    const from = MP.sentTo - base, to = Math.min(MP.len, until - base);
    for (const e of MP.events)
      if (e[0] >= from && e[0] < to) {
        out.push([Math.round((MP.t0 + base + e[0]) * sr), e[1], e[2], e[3]]);
        const key = ((e[1] & 15) << 8) | e[2];
        if ((e[1] & 0xF0) === 0x90) MP.held.push(key); else MP.held = MP.held.filter((k) => k !== key);
      }
    MP.sentTo = base + to + (to >= MP.len ? 0.000001 : 0);
  }
  if (out.length) node.port.postMessage({ type: "midis", events: out });
  const pos = Math.max(0, now % MP.len);
  $("midiPos").textContent = `${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, "0")} / ${Math.floor(MP.len / 60)}:${String(Math.floor(MP.len % 60)).padStart(2, "0")}`;
}
function midiPlay() {
  if (!node || !ac) { $("midiMsg").textContent = "Switch the firmware on first."; return; }
  midiStop();
  buildEvents();
  if (!MP.events.length) { $("midiMsg").textContent = "Nothing to play: give a part a role."; return; }
  MP.playing = true;
  MP.t0 = ac.currentTime + 0.15;
  MP.sentTo = 0;
  MP.held = [];
  pump();
  MP.timer = setInterval(pump, 250);
  $("midiPlay").textContent = "Stop";
  $("midiMsg").textContent = "";
}
function midiStop() {
  if (MP.timer) clearInterval(MP.timer);
  MP.timer = null;
  if (MP.playing && node) node.port.postMessage({ type: "midiclear", held: MP.held });
  MP.playing = false;
  MP.held = [];
  $("midiPlay").textContent = "Play";
}

// ------------------------------------------------------------------ the sheet
function renderParts() {
  const box = $("midiParts");
  box.innerHTML = "";
  if (!MP.file) return;
  MP.file.parts.forEach((p, i) => {
    const s = stats(p), row = document.createElement("div");
    row.className = "mrow";
    const lo = Math.min(...p.notes.map((n) => n.n)), hi = Math.max(...p.notes.map((n) => n.n));
    row.innerHTML = `<div class="mname"><b></b><small></small></div><select class="mrole"></select><select class="moct"></select>`;
    row.querySelector("b").textContent = p.name;
    row.querySelector("small").textContent = `${p.ch === 9 ? "drums" : "ch " + (p.ch + 1)} · ${s.count} notes · ${lo}–${hi}`;
    const r = row.querySelector(".mrole");
    for (const k of ROLES) r.add(new Option(k === "chords" ? "STABS" : k.toUpperCase(), k, false, MP.roles[i] === k));
    r.addEventListener("change", () => { MP.roles[i] = r.value; if (MP.playing) midiPlay(); });
    const o = row.querySelector(".moct");
    for (const k of ["auto", -2, -1, 0, 1, 2]) o.add(new Option(k === "auto" ? "oct auto" : (k > 0 ? "+" : "") + k + " oct", String(k), false, String(MP.octs[i]) === String(k)));
    o.disabled = p.ch === 9;
    o.addEventListener("change", () => { MP.octs[i] = o.value === "auto" ? "auto" : +o.value; if (MP.playing) midiPlay(); });
    box.appendChild(row);
  });
}
async function midiOpen(file) {
  midiStop();
  try {
    MP.file = parseMidi(await file.arrayBuffer());
  } catch (err) { MP.file = null; $("midiMsg").textContent = "Couldn't read it: " + (err && err.message || err); renderParts(); return; }
  MP.name = file.name.replace(/\.midi?$/i, "");
  MP.roles = autoAssign(MP.file.parts);
  MP.octs = MP.file.parts.map(() => "auto");
  MP.speed = 1; MP.transpose = 0;
  $("midiSpeed").value = "100"; $("midiTr").value = "0";
  $("midiTitle").textContent = `${MP.name} · ${MP.file.bpm} BPM · ${MP.file.parts.length} part${MP.file.parts.length === 1 ? "" : "s"}`;
  $("midiMsg").textContent = "Split automatically: change any part's role or octave.";
  renderParts();
}
$("midiBtn").addEventListener("click", () => $("midiSheet").showModal());
$("midiFile").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) midiOpen(f); });
$("midiPlay").addEventListener("click", () => (MP.playing ? midiStop() : midiPlay()));
$("midiLoop").addEventListener("change", () => { MP.loop = $("midiLoop").checked; });
$("midiSpeed").addEventListener("change", () => { MP.speed = Math.max(0.25, Math.min(2, (+$("midiSpeed").value || 100) / 100)); if (MP.playing) midiPlay(); });
$("midiTr").addEventListener("change", () => { MP.transpose = Math.max(-12, Math.min(12, Math.round(+$("midiTr").value || 0))); if (MP.playing) midiPlay(); });
