// SPDX-License-Identifier: GPL-3.0-only
// FM-1 Lite: a MIDI file made into a song a firmware keeps and plays itself (TOUGE NEXT's song slots: its song.h has
// the format). The split is the player's (midi.js: each file part's role and octave); the song goes in as SysEx, as it
// would over USB to a real FM-1. Pure functions: no page, so the tests run them too.
"use strict";

const SONG = { PPQ: 48, HDR: 64, EV: 6, SPAN: 0x10000, MAGIC: 0x31534754 };
SONG.MAXEV = Math.floor((SONG.SPAN - SONG.HDR) / SONG.EV);
const SONG_PARTS = ["lead", "bass", "chords", "keys", "guitar", "pad", "hits", "drums"];   // the firmware's parts, in order

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/* parts: [{ role, notes: [{ n, v, s0, s1 }], program, volume }], already voiced (midi.js voice()); bpm: the song's
 * tempo (the notes' seconds are laid on it); name: up to 24 characters. Returns { bytes, events, dropped } */
function packSong({ parts, bpm, name, id }) {
  const perSec = (bpm / 60) * SONG.PPQ;
  const ev = [], program = new Array(8).fill(255), volume = new Array(8).fill(100);
  for (const p of parts) {
    const idx = SONG_PARTS.indexOf(p.role);
    if (idx < 0) continue;
    if (program[idx] === 255 && idx !== 7 && p.program !== undefined) program[idx] = p.program & 127;
    if (p.volume !== undefined) volume[idx] = Math.max(0, Math.min(127, p.volume | 0));
    for (const n of p.notes) {
      const t = Math.max(0, Math.round(n.s0 * perSec));
      if (t >= 1 << 20) continue;
      const len = Math.max(1, Math.min(4095, Math.round((n.s1 - n.s0) * perSec)));
      ev.push([t, len, Math.max(0, Math.min(127, n.n)), idx, Math.max(1, Math.min(127, n.v | 0))]);
    }
  }
  ev.sort((a, b) => a[0] - b[0] || a[3] - b[3] || a[2] - b[2]);
  let dropped = 0;
  if (ev.length > SONG.MAXEV) { dropped = ev.length - SONG.MAXEV; ev.length = SONG.MAXEV; }
  const length = Math.max(SONG.PPQ * 4, ...ev.map((e) => e[0] + e[1]));
  // the song's length to the end of its last bar
  const bar = SONG.PPQ * 4, len = Math.min((1 << 20) - 1, Math.ceil(length / bar) * bar);
  const bytes = new Uint8Array(SONG.HDR + ev.length * SONG.EV), d = new DataView(bytes.buffer);
  ev.forEach(([t, l, n, part, v], i) => {
    const o = SONG.HDR + i * SONG.EV;
    d.setUint32(o, (t & 0xFFFFF) | (l << 20) >>> 0, true);
    bytes[o + 4] = n;
    bytes[o + 5] = (part << 5) | (v >> 2);
  });
  d.setUint32(0, SONG.MAGIC, true);
  d.setUint32(4, ev.length, true);
  d.setUint32(8, len, true);
  d.setUint16(12, Math.max(400, Math.min(2500, Math.round(bpm * 10))), true);
  bytes[14] = SONG.PPQ;
  bytes[15] = 0;
  bytes.set(program, 16);
  bytes.set(volume, 24);
  const nm = String(name || "SONG").toUpperCase().replace(/[^\x20-\x7e]/g, "").slice(0, 23);
  for (let i = 0; i < nm.length; i++) bytes[32 + i] = nm.charCodeAt(i);
  d.setUint32(56, crc32(bytes.subarray(SONG.HDR)), true);
  d.setUint32(60, (id >>> 0) || ((Math.random() * 0xFFFFFFFF) >>> 0) || 1, true);
  return { bytes, events: ev.length, dropped, length: len };
}

/* the SysEx that puts the song in slot (0..3): BEGIN, DATA 448 bytes a frame (7-bit packed), END */
function songSysex(bytes, slot) {
  const H = [0xF0, 0x7D, 0x54, 0x47], n = bytes.length, out = [];
  out.push(Uint8Array.from([...H, 1, slot, n & 127, (n >> 7) & 127, (n >> 14) & 127, (n >> 21) & 127, 0xF7]));
  for (let off = 0; off < n; off += 448) {
    const chunk = bytes.subarray(off, Math.min(n, off + 448)), f = [...H, 2, off & 127, (off >> 7) & 127, (off >> 14) & 127];
    for (let i = 0; i < chunk.length; i += 7) {
      let hi = 0;
      const g = chunk.subarray(i, i + 7);
      g.forEach((b, k) => { if (b & 128) hi |= 1 << k; });
      f.push(hi, ...Array.from(g, (b) => b & 127));
    }
    f.push(0xF7);
    out.push(Uint8Array.from(f));
  }
  out.push(Uint8Array.from([...H, 3, 0xF7]));
  return out;
}
const SONG_REPLY = { 0: "kept", 1: "the slot or the length was refused", 2: "the flash wouldn't take it",
                     3: "some of it went missing", 4: "it didn't add up", 5: "it arrived damaged" };

if (typeof module !== "undefined") module.exports = { SONG, SONG_PARTS, crc32, packSong, songSysex, SONG_REPLY };
