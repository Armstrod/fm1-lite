// SPDX-License-Identifier: GPL-3.0-only
// FM-1 Lite: a phone panel for M-VAVE FM-1 community firmwares' browser builds. The panel's bits and the encoder
// roles follow Felucca's web/emu/index.html (Leo Kuroshita, Hügelton Instruments, GPL-3.0).
"use strict";
const B = { FX: 0, SCL: 1, ENV: 2, LFO: 3, EDIT: 4, GLO: 5, HOME: 6, SAVE: 7, ARP: 8, SEQ: 9, PLAY: 10, REC: 11, "OCT-": 12, "OCT+": 13 };
const PLAY_GREEN = 14;
const ROW1 = ["FX", "SCL", "ENV", "LFO", "EDIT", "GLO"], ROW2 = ["HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"];
const WHITE = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
const BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25], BLACK_AFTER = [0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 14];
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ settings
const LS = {
  get(k, d) { try { const v = localStorage.getItem("fm1lite." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fm1lite." + k, JSON.stringify(v)); } catch {} },
};
const settings = Object.assign({ lat: "interactive", layout: "auto", haptic: true, wake: true, midi: false, master: 0.7 }, LS.get("settings", {}));
const saveSettings = () => LS.set("settings", settings);

// ------------------------------------------------------------------ saves per firmware (IndexedDB)
const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("fm1lite", 2);
    r.onupgradeneeded = () => {                   /* saves: per firmware; files: firmwares added from the phone */
      for (const n of ["saves", "files"]) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n);
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, mode), q = fn(t.objectStore(store)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return {
    get: (id) => tx("saves", "readonly", (s) => s.get(id)).catch(() => null),
    put: (id, v) => tx("saves", "readwrite", (s) => s.put(v, id)).catch(() => {}),
    del: (id) => tx("saves", "readwrite", (s) => s.delete(id)).catch(() => {}),
    fileGet: (id) => tx("files", "readonly", (s) => s.get(id)).catch(() => null),
    filePut: (id, v) => tx("files", "readwrite", (s) => s.put(v, id)),
    fileDel: (id) => tx("files", "readwrite", (s) => s.delete(id)).catch(() => {}),
  };
})();

// ------------------------------------------------------------------ catalogue
let catalog = { firmwares: [] }, current = null;
const custom = () => LS.get("custom", []);
const repoFws = () => LS.get("repoFw", []).map((f) => ({ ...f, file: true }));
const allFirmwares = () => [...repoFws(), ...catalog.firmwares, ...custom().map((f) => ({ ...f, custom: true }))];
const findFw = (id) => allFirmwares().find((f) => f.id === id);

// ------------------------------------------------------------------ the panel
let node = null, ac = null, workletReady = false, btnMask = 0, keyMask = 0, lastLeds = [0, 0, 0, 0];
const send = (m) => { if (node) node.port.postMessage(m); };
const buzz = () => { if (settings.haptic && navigator.vibrate) try { navigator.vibrate(8); } catch {} };

function knob(parent, label, role) {
  const d = document.createElement("div");
  d.className = "knob";
  d.innerHTML = `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="#444" stroke-width="3"/>` +
    `<path class="arc" fill="none" stroke="#7ab8ff" stroke-width="3" stroke-linecap="round"/>` +
    `<line class="ind" x1="16" y1="16" x2="16" y2="6" stroke="#ececee" stroke-width="2.5" stroke-linecap="round"/></svg><span>${label}</span>`;
  parent.appendChild(d);
  const ind = d.querySelector(".ind"), arc = d.querySelector(".arc");
  let angle = 0;
  const draw = () => {
    if (role === "master") {
      const a = -135 + 270 * settings.master;
      ind.setAttribute("transform", `rotate(${a} 16 16)`);
      const r = 12, s = (-225) * Math.PI / 180, e = (a - 90) * Math.PI / 180;
      const large = a + 135 > 180 ? 1 : 0;
      arc.setAttribute("d", `M ${16 + r * Math.cos(s)} ${16 + r * Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${16 + r * Math.cos(e)} ${16 + r * Math.sin(e)}`);
    } else ind.setAttribute("transform", `rotate(${angle} 16 16)`);
  };
  draw();
  let drag = null;
  /* a drag turns it: down or right = clockwise (more, the next, further down the screen), up or left = anticlockwise */
  d.addEventListener("pointerdown", (e) => {
    e.preventDefault(); try { d.setPointerCapture(e.pointerId); } catch {}; d.classList.add("active");
    drag = { x: e.clientX, y: e.clientY, acc: 0 };
  });
  d.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const sx = e.clientX - drag.x, sy = e.clientY - drag.y, t = turned();
    const dx = t === 1 ? sy : t === -1 ? -sy : sx, dy = t === 1 ? -sx : t === -1 ? sx : sy;   /* (the panel's own down and right) */
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    drag.acc += delta; drag.x = e.clientX; drag.y = e.clientY;
    const step = role === "master" ? 2 : 9, n = Math.trunc(drag.acc / step);
    if (!n) return;
    drag.acc -= n * step;
    if (role === "master") {
      settings.master = Math.max(0, Math.min(1, settings.master + n / 150));
      send({ type: "master", value: settings.master });
    } else {
      angle = (angle + n * 18) % 360;
      send({ type: "enc", role, n });
      if (settings.haptic && navigator.vibrate) try { navigator.vibrate(3); } catch {}
    }
    draw();
  });
  const end = () => { if (drag && role === "master") saveSettings(); drag = null; d.classList.remove("active"); };
  d.addEventListener("pointerup", end); d.addEventListener("pointercancel", end);
}
// the FM-1's left cluster, as on the machine: MASTER SELECT / PRESETS ALGORITHM
knob($("knobsA"), "MASTER", "master"); knob($("knobsA"), "SELECT", 0); knob($("knobsA"), "PRESETS", 2); knob($("knobsA"), "ALGORITHM", 1);
["KNOB 1", "KNOB 2", "KNOB 3", "KNOB 4"].forEach((n, i) => knob($("knobsB"), n, 3 + i));

const btnHeld = new Map(), keyHeld = new Map(), btnEls = [], keyEls = [];
function syncButtons() {
  let m = 0; for (const b of btnHeld.values()) m |= 1 << b;
  if (m !== btnMask) { btnMask = m; send({ type: "buttons", mask: m }); }
  for (const [el, bit] of btnEls) el.classList.toggle("held", !!(m & (1 << bit)));
}
function syncKeys() {
  let m = 0; for (const k of keyHeld.values()) m |= 1 << k;
  if (m !== keyMask) { keyMask = m; send({ type: "keys", mask: m }); }
  keyEls.forEach((el, i) => el.classList.toggle("held", !!(m & (1 << i))));
}
function button(parent, name, label) {
  const d = document.createElement("div");
  d.className = "btn" + (name === "REC" ? " rec" : "");
  d.textContent = label || name;
  parent.appendChild(d); btnEls.push([d, B[name]]);
  d.addEventListener("pointerdown", (e) => { e.preventDefault(); try { d.setPointerCapture(e.pointerId); } catch {}; btnHeld.set(e.pointerId, B[name]); syncButtons(); buzz(); });
}
ROW1.forEach((n) => button($("grid"), n)); ROW2.forEach((n) => button($("grid"), n));
button($("octs"), "OCT-", "OCT −"); button($("octs"), "OCT+", "OCT +");

const kb = $("keys"), pitch = 100 / 16;
WHITE.forEach((k, i) => { const d = document.createElement("div"); d.className = "key w"; d.style.left = (i * pitch + 0.35) + "%"; d.style.width = (pitch - 0.7) + "%"; keyEls[k] = d; kb.appendChild(d); });
BLACK.forEach((k, j) => { const d = document.createElement("div"); d.className = "key b"; d.style.left = ((BLACK_AFTER[j] + 0.57) * pitch) + "%"; d.style.width = (pitch * 0.86) + "%"; keyEls[k] = d; kb.appendChild(d); });
/* the panel turned a quarter (Settings → Layout, against the phone's own turn): a touch read in the panel's frame */
const turned = () => document.documentElement.classList.contains("rot-cw") ? 1 : document.documentElement.classList.contains("rot-ccw") ? -1 : 0;
function frac(el, x, y) {                    /* where (x, y) sits across and down el, 0..1, as the panel is drawn */
  const r = el.getBoundingClientRect(), t = turned();
  if (t === 1) return [(y - r.top) / r.height, (r.right - x) / r.width];
  if (t === -1) return [(r.bottom - y) / r.height, (x - r.left) / r.width];
  return [(x - r.left) / r.width, (y - r.top) / r.height];
}
function keyAt(x, y) {
  const [ax, fy] = frac(kb, x, y), fx = ax * 16;
  if (fx < 0 || fx >= 16 || fy < 0 || fy > 1) return -1;
  if (fy < 0.5) { const j = BLACK_AFTER.findIndex((a) => fx >= a + 0.57 && fx < a + 1.43); if (j >= 0) return BLACK[j]; }
  return WHITE[Math.floor(fx)];
}
kb.addEventListener("pointerdown", (e) => {
  e.preventDefault(); try { kb.setPointerCapture(e.pointerId); } catch {};
  const k = keyAt(e.clientX, e.clientY); if (k >= 0) { keyHeld.set(e.pointerId, k); syncKeys(); buzz(); }
});
kb.addEventListener("pointermove", (e) => {
  if (!keyHeld.has(e.pointerId)) return;
  const k = keyAt(e.clientX, e.clientY);
  if (k >= 0 && k !== keyHeld.get(e.pointerId)) { keyHeld.set(e.pointerId, k); syncKeys(); }
});
function release(e) { if (btnHeld.delete(e.pointerId)) syncButtons(); if (keyHeld.delete(e.pointerId)) syncKeys(); }
for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) { document.addEventListener(t, release, true); }
document.addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("blur", () => { btnHeld.clear(); keyHeld.clear(); syncButtons(); syncKeys(); });

// ------------------------------------------------------------------ screen, lights, meter
const ctx = $("screen").getContext("2d"), img = ctx.createImageData(240, 240);
const px = new Uint32Array(img.data.buffer), LUT = new Uint32Array(65536);
for (let v = 0; v < 65536; v++) {           // the panel's byte order -> RGB565 -> RGBA (little-endian)
  const p = ((v >> 8) | (v << 8)) & 0xFFFF;
  LUT[v] = (255 << 24) | ((((p & 31) * 255 / 31) | 0) << 16) | (((((p >> 5) & 63) * 255 / 63) | 0) << 8) | ((((p >> 11) & 31) * 255 / 31) | 0);
}
let pendingFb = null;
(function draw() {
  if (pendingFb) { const fb = pendingFb; pendingFb = null; for (let i = 0; i < 57600; i++) px[i] = LUT[fb[i]]; ctx.putImageData(img, 0, 0); }
  requestAnimationFrame(draw);
})();
function clearScreen() { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 240, 240); }
function lights([litB, litK, dimB, dimK]) {
  for (const [el, bit] of btnEls) {
    const green = bit === B.PLAY && (litB & (1 << PLAY_GREEN));
    el.classList.toggle("lit", !!(litB & (1 << bit)) && !green); el.classList.toggle("green", !!green); el.classList.toggle("dim", !!(dimB & (1 << bit)));
  }
  keyEls.forEach((el, i) => { el.classList.toggle("lit", !!(litK & (1 << i))); el.classList.toggle("dim", !!(dimK & (1 << i))); });
}
let peak = 0;
function showLoad(load) {
  const pct = Math.round(load * 100); peak = Math.max(peak, pct);
  $("cpu").textContent = `CPU ${pct}%`;
  $("cpu").title = `peak ${peak}%`;
  const bar = $("cpuBar"); bar.style.width = Math.min(100, pct) + "%";
  bar.style.background = pct < 60 ? "var(--green)" : pct < 85 ? "var(--amber)" : "var(--red)";
  if (ac) $("latNow").textContent = Math.round(((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000) + " ms";
}

// ------------------------------------------------------------------ power
const status = (t) => { $("status").textContent = t || ""; };
const showPower = (on, label = "Switch on") => { $("power").hidden = !on; $("go").disabled = false; $("go").textContent = label; };
let wakeLock = null, saveTimer = null, pendingSave = null;
async function keepAwake(on) {
  try {
    if (on && settings.wake && navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
function stop() {
  if (node) { try { node.port.onmessage = null; node.disconnect(); node.port.close(); } catch {} node = null; }
  if (pendingSave && current) { DB.put(current.id, pendingSave); pendingSave = null; }
  btnMask = keyMask = 0; peak = 0;
  $("cpu").textContent = "–"; $("cpuBar").style.width = 0;
  lights([0, 0, 0, 0]);
  keepAwake(false);
}
function makeContext() {
  if (ac && ac.state !== "closed") return ac;
  ac = new AudioContext({ sampleRate: 44100, latencyHint: settings.lat });
  ac.latencyHintUsed = settings.lat;
  workletReady = false;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  return ac;
}
async function fetchWasm(fw) {
  if (fw.file) {                                  /* added from the phone: kept in this browser */
    const b = await DB.fileGet(fw.id);
    if (!b) throw new Error("its file is gone from this browser: add it again");
    return b.slice(0);
  }
  const r = await fetch(fw.wasm, { cache: "no-cache" }).catch(() => null) || await caches.match(fw.wasm).catch(() => null);
  if (!r || !r.ok) throw new Error("couldn't download the firmware" + (navigator.onLine ? "" : " (offline, and not saved yet)"));
  const b = await r.arrayBuffer();
  if (new Uint32Array(b, 0, 1)[0] !== 0x6d736100) throw new Error("that file isn't a WebAssembly build");
  return b;
}
async function switchOn(fw) {
  stop();
  current = fw; LS.set("current", fw.id); showFw();
  showPower(true, "Starting…"); $("go").disabled = true; status("Downloading " + fw.name + "…");
  try {
    if (ac && ac.latencyHintUsed !== settings.lat) { try { await ac.close(); } catch {} ac = null; }
    makeContext();
    ac.resume().catch(() => {});
    const [wasm, save] = await Promise.all([fetchWasm(fw), DB.get(fw.id)]);
    if (!workletReady) { await ac.audioWorklet.addModule("worklet.js"); workletReady = true; }
    if (current !== fw) return;
    status("Starting " + fw.name + "…");
    const n = new AudioWorkletNode(ac, "fm1", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    n.connect(ac.destination);
    node = n;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("it didn't start within 15 s")), 15000);
      n.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { clearTimeout(t); res(); }
        else if (m.type === "error") { clearTimeout(t); rej(new Error(m.message)); }
        else if (m.type === "crash") { stop(); showPower(true, "Restart"); status(fw.name + " stopped: " + m.message); }
        else if (m.type === "sysexdone") { if (typeof songDone === "function") songDone(m.reply); }
        else if (m.type === "frame") {
          if (m.fb) pendingFb = m.fb;
          if (m.leds) lights(lastLeds = m.leds);
          if (m.load !== undefined) showLoad(m.load);
          if (m.save) { pendingSave = m.save; clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (pendingSave) { DB.put(fw.id, pendingSave); pendingSave = null; } }, 800); }
        }
      };
      const seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;
      n.port.postMessage({ type: "load", wasm, save: save || {}, master: settings.master, seed }, [wasm]);
    });
    await ac.resume();
    showPower(false); status("");
    send({ type: "visible", on: !document.hidden });
    keepAwake(true);
    if (settings.midi) midiOn();
  } catch (err) {
    stop();
    showPower(true, "Try again");
    status("Couldn't start " + fw.name + ": " + (err && err.message || err));
  }
}
$("go").addEventListener("click", () => { const fw = current || findFw(catalog.default) || allFirmwares()[0]; if (fw) switchOn(fw); });
$("powerOff").addEventListener("click", () => { stop(); clearScreen(); showPower(true); status(""); $("menu").close(); });
document.addEventListener("visibilitychange", () => {
  send({ type: "visible", on: !document.hidden });
  if (!document.hidden && node) keepAwake(true);
  if (document.hidden && pendingSave && current) { DB.put(current.id, pendingSave); pendingSave = null; }
});

// ------------------------------------------------------------------ MIDI in
let midiAccess = null;
async function midiOn() {
  if (!navigator.requestMIDIAccess || midiAccess) return;
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const bind = () => { for (const i of midiAccess.inputs.values()) i.onmidimessage = (e) => {
      if (!settings.midi) return;
      const d = e.data; if (d.length < 2 || d[0] < 0x80 || d[0] >= 0xF0) return;
      send({ type: "midi", data: [d[0], d[1], d[2] || 0] });
    }; };
    midiAccess.onstatechange = bind; bind();
  } catch { settings.midi = false; $("midiOn").checked = false; saveSettings(); }
}

// ------------------------------------------------------------------ picker and menu
function showFw() {
  $("fwName").textContent = current ? current.name : "Choose a firmware";
  $("fwBy").textContent = current ? current.author : "";
  $("about").textContent = current ? `${current.name} by ${current.author}${current.license ? " · " + current.license : ""}. ${current.repo ? "Source: " + current.repo : ""}` : "";
}
function renderList() {
  const q = $("search").value.trim().toLowerCase(), ul = $("fwList");
  ul.innerHTML = "";
  for (const f of allFirmwares()) {
    if (q && !(f.name + " " + f.author + " " + (f.about || "")).toLowerCase().includes(q)) continue;
    const li = document.createElement("li");
    if (current && f.id === current.id) li.className = "on";
    li.innerHTML = `${f.custom ? '<button class="x" type="button" aria-label="Remove">✕</button>' : ""}<b></b><small></small><p></p>`;
    li.querySelector("b").textContent = f.name + (f.heavy ? " ⚡" : "");
    li.querySelector("small").textContent = f.author + (f.quiet ? " · may need setup" : "");
    li.querySelector("p").textContent = f.about || (f.file ? "Added from a file on this phone." : f.custom ? f.wasm : "");
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("x")) { LS.set("custom", custom().filter((c) => c.id !== f.id)); if (f.file) DB.fileDel(f.id); renderList(); return; }
      $("picker").close(); switchOn(f);
    });
    ul.appendChild(li);
  }
}
$("fwBtn").addEventListener("click", () => { $("search").value = ""; renderList(); $("picker").showModal(); syncRepo(false); });
$("search").addEventListener("input", renderList);
$("addFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  const b = await file.arrayBuffer();
  if (b.byteLength < 8 || new Uint32Array(b, 0, 1)[0] !== 0x6d736100) { $("addMsg").textContent = "That isn't a .wasm firmware build."; return; }
  const name = $("addName").value.trim() || file.name.replace(/\.wasm$/i, "").toUpperCase();
  const id = "file:" + file.name;
  try { await DB.filePut(id, b); } catch { $("addMsg").textContent = "Couldn't keep it in this browser (storage full or private mode)."; return; }
  LS.set("custom", [...custom().filter((c) => c.id !== id), { id, name, author: "from your phone", file: true }]);
  $("addName").value = ""; $("addMsg").textContent = name + " added.";
  renderList();
});
$("addGo").addEventListener("click", () => {
  const url = $("addUrl").value.trim(), name = $("addName").value.trim() || url.split("/").slice(-1)[0];
  if (!/^https:\/\/.+\.wasm(\?.*)?$/.test(url)) { $("addUrl").focus(); return; }
  LS.set("custom", [...custom(), { id: "url:" + url, name, author: "added by you", wasm: url }]);
  $("addUrl").value = $("addName").value = ""; renderList();
});
$("menuBtn").addEventListener("click", () => $("menu").showModal());
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
}
$("lat").value = settings.lat; $("haptic").checked = settings.haptic; $("wake").checked = settings.wake; $("midiOn").checked = settings.midi;
$("lat").addEventListener("change", () => { settings.lat = $("lat").value; saveSettings(); });
/* the layout: the phone's turn, or the one chosen */
const sideways = matchMedia("(orientation: landscape)");
function applyLayout() {
  const side = settings.layout === "side" || (settings.layout === "auto" && sideways.matches);
  const h = document.documentElement;
  h.classList.toggle("lay-side", side);
  /* chosen against the phone (its auto-rotate off): the panel itself turned a quarter to suit */
  h.classList.toggle("rot-cw", side && !sideways.matches);
  h.classList.toggle("rot-ccw", !side && sideways.matches && settings.layout === "up");
}
sideways.addEventListener("change", applyLayout);
$("layout").value = settings.layout;
$("layout").addEventListener("change", () => { settings.layout = $("layout").value; saveSettings(); applyLayout(); });
applyLayout();
$("haptic").addEventListener("change", () => { settings.haptic = $("haptic").checked; saveSettings(); });
$("wake").addEventListener("change", () => { settings.wake = $("wake").checked; saveSettings(); keepAwake(settings.wake && !!node); });
$("midiOn").addEventListener("change", () => { settings.midi = $("midiOn").checked; saveSettings(); if (settings.midi) midiOn(); });
$("fullBtn").addEventListener("click", () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (el.requestFullscreen) el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
});
$("wipe").addEventListener("click", async () => {
  if (!current) return;
  $("wipe").textContent = "Erasing…"; pendingSave = null; await DB.del(current.id);
  $("wipe").textContent = "Erased: switch it off and on"; setTimeout(() => { $("wipe").textContent = "Erase this firmware's saves"; }, 2500);
});

// ------------------------------------------------------------------ your firmware repo: every .wasm in it, kept on the phone
const repoCfg = () => Object.assign({ name: "Armstrod/Touge", branch: "main", token: "" }, LS.get("repo", {}));
async function gh(cfg, path, raw) {
  const h = { Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (cfg.token) h.Authorization = "Bearer " + cfg.token;
  const r = await fetch("https://api.github.com" + path, { headers: h, cache: "no-store" });
  if (!r.ok) {
    const e = new Error(r.status === 404 ? "not found: check the name, or add a token if it's private"
      : r.status === 401 ? "the token was refused (expired, or mistyped)"
      : r.status === 403 ? "GitHub said no (the token can't read it, or too many checks: try later)" : "GitHub answered " + r.status);
    e.status = r.status; throw e;
  }
  return raw ? r.arrayBuffer() : r.json();
}
let syncing = false;
async function syncRepo(manual) {
  const cfg = repoCfg(), say = (t) => { $("repoMsg").textContent = t; };
  if (!cfg.name || syncing || !navigator.onLine) { if (manual && !navigator.onLine) say("Offline: the firmwares already here still work."); return; }
  if (!manual && Date.now() - LS.get("repoLast", 0) < 60000) return;
  syncing = true;
  if (manual) say("Checking " + cfg.name + "…");
  try {
    const [owner, repo] = cfg.name.split("/").map((x) => encodeURIComponent(x.trim()));
    const tree = await gh(cfg, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(cfg.branch || "main")}?recursive=1`);
    const blobs = (tree.tree || []).filter((t) => t.type === "blob");
    const wasms = blobs.filter((t) => /\.wasm$/i.test(t.path) && !/(^|\/)(build|node_modules|dist)\//.test(t.path));
    const meta = new Map(blobs.filter((t) => /(^|\/)firmware\.json$/.test(t.path)).map((t) => [t.path.replace(/firmware\.json$/, ""), t]));
    const old = new Map(LS.get("repoFw", []).map((f) => [f.id, f]));
    const metaCache = LS.get("repoMeta", {});
    const next = [];
    let added = 0, updated = 0;
    for (const t of wasms) {
      const id = "repo:" + cfg.name + ":" + t.path, dir = t.path.includes("/") ? t.path.replace(/[^/]+$/, "") : "";
      const folder = dir.split("/").filter(Boolean).pop() || "", file = t.path.split("/").pop().replace(/\.wasm$/i, "");
      let info = {};
      const m = meta.get(dir);
      if (m) {
        if (metaCache[m.sha]) info = metaCache[m.sha];
        else try { info = JSON.parse(new TextDecoder().decode(await gh(cfg, `/repos/${owner}/${repo}/git/blobs/${m.sha}`, true))); metaCache[m.sha] = info; } catch {}
      }
      const sameFolder = wasms.filter((w) => w.path.startsWith(dir) && !w.path.slice(dir.length).includes("/")).length;
      const name = (info.name && sameFolder === 1 ? info.name : sameFolder === 1 && folder ? folder : file).toString().toUpperCase();
      const was = old.get(id);
      if (!was || was.sha !== t.sha || !(await DB.fileGet(id))) {
        const b = await gh(cfg, `/repos/${owner}/${repo}/git/blobs/${t.sha}`, true);
        if (b.byteLength < 8 || new Uint32Array(b, 0, 1)[0] !== 0x6d736100) continue;
        await DB.filePut(id, b);
        if (was) updated++; else added++;
      }
      next.push({ id, name, author: cfg.name.split("/")[0], about: info.about || t.path, sha: t.sha, path: t.path, parts: info.parts || 4, songs: info.songs || 0,
                  repo: "https://github.com/" + cfg.name + "/tree/" + (cfg.branch || "main") + "/" + dir });
      old.delete(id);
    }
    for (const gone of old.values()) DB.fileDel(gone.id);
    LS.set("repoFw", next); LS.set("repoMeta", metaCache); LS.set("repoLast", Date.now());
    const what = `${next.length} firmware${next.length === 1 ? "" : "s"} in ${cfg.name}` + (added ? `, ${added} new` : "") + (updated ? `, ${updated} updated` : "");
    say(what + ".");
    if ((added || updated) && !manual) status(what + (node ? ". Switch off and on to load a new build." : "."));
    if ($("picker").open) renderList();
    if (current && current.id.startsWith("repo:")) current = findFw(current.id) || current;
  } catch (err) {
    say("Couldn't check " + cfg.name + ": " + (err && err.message || err));
  } finally { syncing = false; }
}
(() => {
  const c = repoCfg();
  $("repoName").value = c.name; $("repoBranch").value = c.branch === "main" ? "" : c.branch; $("repoToken").value = c.token;
  $("repoCheck").addEventListener("click", () => {
    const name = $("repoName").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (name !== repoCfg().name) { for (const f of LS.get("repoFw", [])) DB.fileDel(f.id); LS.set("repoFw", []); }
    LS.set("repo", { name, branch: $("repoBranch").value.trim() || "main", token: $("repoToken").value.trim() });
    syncRepo(true);
  });
})();

// ------------------------------------------------------------------ start up
(async () => {
  try { catalog = await (await fetch("catalog.json", { cache: "no-cache" })).json(); }
  catch { try { catalog = await (await caches.match("catalog.json")).json(); } catch {} }
  $("catDate").textContent = catalog.updated || "–";
  current = findFw(LS.get("current", catalog.default)) || findFw(catalog.default) || allFirmwares()[0] || null;
  syncRepo(false);
  showFw(); clearScreen();
  status(current ? "Tap to start " + current.name + ", or tap its name above to choose another." : "");
})();
// ------------------------------------------------------------------ updates: a bar when a new version is ready
if ("serviceWorker" in navigator) addEventListener("load", async () => {
  let reg;
  try { reg = await navigator.serviceWorker.register("sw.js"); } catch { return; }
  const ready = (w) => {
    if (!w || !navigator.serviceWorker.controller) return;   /* (the first install: nothing to replace) */
    $("updateBar").hidden = false;
    $("updateGo").onclick = () => { $("updateGo").disabled = true; w.postMessage("skip"); };
  };
  if (reg.waiting) ready(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    if (w) w.addEventListener("statechange", () => { if (w.state === "installed") ready(w); });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    if (pendingSave && current) DB.put(current.id, pendingSave);
    location.reload();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
});
