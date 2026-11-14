// SPDX-License-Identifier: GPL-3.0-only
// FM-1 Lite's AudioWorklet: runs one FM-1 firmware's browser build (WebAssembly) against its simulated FM-1.
// Follows Felucca's web/emu/worklet.js (Leo Kuroshita, Hügelton Instruments, GPL-3.0) and fm1-x0x's
// (charlesvestal, GPL-3.0). Handles both families of browser build:
//   Felucca family: web_screen + web_screen_draws, flash in web_nor, MASTER 0..1023
//   X0X family:     web_fb + web_blits, saves in web_store objects, MASTER 0..4095
//   emu family:     emu_* (sabliran/sloop-web-emu, GPL-3.0: SLOOP and Felucca), the flash one image, MASTER an ADC 0..1023
const HOLD_MS = 24;
const clock = () => (globalThis.performance ? performance.now() : Date.now());
const noop = () => 0;

class FM1 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ex = null; this.sentDraws = -1; this.sentWrites = -1; this.sentLeds = "";
    this.last = 0; this.period = 1 / 20; this.busy = 0; this.frames = 0;
    this.queue = []; this.nextOk = 0; this.ms = 0;
    this.mq = [];                                   /* timed MIDI from the app's file player: [frame, status, d1, d2] */
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async onMessage(m) {
    if (m.type === "load") {
      try {
        const self = this;
        const wasi = {
          fd_write: (fd, iov, n, out) => { try { new DataView(self.ex.memory.buffer).setUint32(out, 0, true); } catch {} return 0; },
        };
        const mod = (t) => new Proxy(t, { get: (o, k) => (k in o ? o[k] : noop) });
        const imports = new Proxy({ wasi_snapshot_preview1: mod(wasi) }, { get: (o, k) => (k in o ? o[k] : mod({})) });
        const { instance } = await WebAssembly.instantiate(m.wasm, imports);
        const ex = instance.exports;
        this.ex = ex;
        if (ex._initialize) ex._initialize();
        if (ex.emu_init) { this.loadEmu(ex, m); return; }
        this.screen = ex.web_screen || ex.web_fb;
        this.counter = ex.web_screen_draws || ex.web_blits || ex.web_fb_gen || null;
        this.kind = ex.web_nor ? "nor" : ex.web_store ? "store" : "none";
        if (this.kind === "nor") {
          if (ex.web_nor_erase) ex.web_nor_erase();
          const nor = new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size ? ex.web_nor_size() : 0x100000);
          for (const [off, b] of Object.entries(m.save || {})) {
            const o = +off;
            if (o % 4096 === 0 && o + 4096 <= nor.length && b.length === 4096) nor.set(b, o);
          }
          this.sentWrites = ex.web_flash_writes_count ? ex.web_flash_writes_count() : -1;
        } else if (this.kind === "store") {
          const max = ex.web_store_max ? ex.web_store_max() : 65536;
          for (const [obj, bytes] of Object.entries(m.save || {})) {
            if (obj === "data") continue;
            const b = bytes.subarray(0, max);
            new Uint8Array(ex.memory.buffer, ex.web_store(+obj), b.length).set(b);
            ex.web_store_set_len(+obj, b.length);
          }
          this.sentWrites = ex.web_store_writes ? ex.web_store_writes() : -1;
        }
        if (ex.web_data && m.save && m.save.data instanceof Uint8Array) {   /* the data area (TOUGE's songs): what was kept */
          const area = new Uint8Array(ex.memory.buffer, ex.web_data(), ex.web_data_len());
          if (m.save.data.length === area.length) area.set(m.save.data);
        }
        this.dataDirty = false;
        this.masterMax = this.kind === "store" ? 4095 : 1023;
        ex.web_master(Math.round(this.masterMax * m.master));
        ex.web_boot();
        const seed = m.seed >>> 0;
        if (ex.web_tuna_seed) ex.web_tuna_seed(seed); else if (ex.web_seed) ex.web_seed(seed); else if (ex.web_set_seed) ex.web_set_seed(seed);
        this.port.postMessage({ type: "ready", rate: ex.web_sample_rate ? ex.web_sample_rate() : 44100, kind: this.kind });
      } catch (err) {
        this.ex = null;
        this.port.postMessage({ type: "error", message: String(err && err.message || err) });
      }
      return;
    }
    const ex = this.ex;
    if (!ex) return;
    if (this.kind === "emu") { try { this.emuMessage(ex, m); } catch (err) { this.fail(err); } return; }
    try {
      if (m.type === "buttons" || m.type === "keys") this.queue.push(m);
      else if (m.type === "enc") ex.web_enc(m.role, m.n | 0);
      else if (m.type === "master") ex.web_master(Math.round(this.masterMax * m.value));
      else if (m.type === "midi") this.midi(m.data[0] | 0, m.data[1] | 0, m.data[2] | 0);
      else if (m.type === "midis") { for (const e of m.events) this.mq.push(e); this.mq.sort((a, b) => a[0] - b[0]); }
      else if (m.type === "midiclear") {            /* stop: what was scheduled goes, every note held lets go */
        this.mq = [];
        for (let ch = 0; ch < 16; ch++) { this.midi(0xB0 | ch, 123, 0); for (const n of m.held || []) if ((n >> 8) === ch) this.midi(0x80 | ch, n & 127, 0); }
      }
      else if (m.type === "sysex") {                /* SysEx frames to the firmware (a song), its answer back */
        let reply = [];
        if (ex.web_sx_in) {
          for (const f of m.frames) {
            if (f.length > ex.web_sx_in_max()) continue;
            new Uint8Array(ex.memory.buffer, ex.web_sx_in_buf(), f.length).set(f);
            ex.web_sx_in(f.length);
          }
          if (ex.web_sx_out_len && ex.web_sx_out_len()) {
            reply = Array.from(new Uint8Array(ex.memory.buffer, ex.web_sx_out_buf(), ex.web_sx_out_len()));
            ex.web_sx_out_clear();
          }
          this.dataDirty = true;
        }
        this.port.postMessage({ type: "sysexdone", reply });
      }
      else if (m.type === "visible") this.period = m.on ? 1 / 20 : 1 / 2;
    } catch (err) { this.fail(err); }
  }

  /* ------------------------------------------------------------ the emu family (sabliran/sloop-web-emu) */
  loadEmu(ex, m) {
    this.kind = "emu";
    const size = ex.emu_flash_size(), fl = new Uint8Array(ex.memory.buffer, ex.emu_flash_ptr(), size);
    if (m.save && m.save.flash instanceof Uint8Array) fl.set(m.save.flash.subarray(0, size));
    ex.emu_init();
    this.flashGen = ex.emu_flash_gen();             /* (boot's own writes need no save) */
    this.notes = 0; this.btns = 0; this.blocks = 0; this.started = false; this.startAt = currentTime + 0.9;   /* the splash */
    ex.emu_adc_set(4, Math.round(1023 * m.master));
    this.port.postMessage({ type: "ready", rate: 44100, kind: "emu" });
  }
  emuMessage(ex, m) {
    /* the panel's bits (FX..REC, OCT-, OCT+) to the emulator's (OCT-, OCT+, FX..REC); its encoders (SELECT, ALGORITHM,
     * PRESETS, KNOB 1..4) to the emulator's (SELECT, ALGORITHM, KNOB 1..4, PRESETS) */
    if (m.type === "buttons") {
      const b = m.mask >>> 0;
      this.btns = ((b & 0xFFF) << 2) | ((b >> 12) & 3);
      ex.emu_input(this.notes, this.btns);
    } else if (m.type === "keys") { this.notes = m.mask >>> 0; ex.emu_input(this.notes, this.btns); }
    else if (m.type === "enc") ex.emu_enc([0, 1, 6, 2, 3, 4, 5][m.role] ?? 0, m.n | 0);
    else if (m.type === "master") ex.emu_adc_set(4, Math.round(1023 * m.value));
    else if (m.type === "midi") this.midi(m.data[0] | 0, m.data[1] | 0, m.data[2] | 0);
    else if (m.type === "midis") { for (const e of m.events) this.mq.push(e); this.mq.sort((a, b) => a[0] - b[0]); }
    else if (m.type === "midiclear") {
      this.mq = [];
      for (let ch = 0; ch < 16; ch++) { this.midi(0xB0 | ch, 123, 0); for (const n of m.held || []) if ((n >> 8) === ch) this.midi(0x80 | ch, n & 127, 0); }
    } else if (m.type === "sysex") this.port.postMessage({ type: "sysexdone", reply: [] });
    else if (m.type === "visible") this.period = m.on ? 1 / 20 : 1 / 2;
  }
  emuPublish(ex) {
    /* the LEDs: the key matrix (11 columns, rows 1..4) to the panel's buttons and keys */
    const MAP = [[5, 11, 4, 10, 3, 9, 2, 8, -1, -1, -1], [34, 35, 36, 37, 38, 40, 39, 13, 7, 6, 12],
                 [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33], [0, 1, 15, 14, 17, 16, 19, 18, 20, 21, 22]];
    const led = new Uint8Array(ex.memory.buffer, ex.emu_led_ptr(), 11), dim = new Uint8Array(ex.memory.buffer, ex.emu_led_dim_ptr(), 11);
    const L = [0, 0, 0, 0], bit = (id) => id < 2 ? [0, 12 + id] : id < 14 ? [0, id - 2] : [1, id - 14];
    for (let p = 0; p < 11; p++) for (let r = 1; r < 5; r++) {
      const id = MAP[r - 1][p];
      if (id < 0) continue;
      const [w, b] = bit(id);
      if (led[p] >> r & 1) L[w] |= 1 << b; else if (dim[p] >> r & 1) L[2 + w] |= 1 << b;
    }
    const msg = { type: "frame" }, tr = [], key = L.join(",");
    if (key !== this.sentLeds) { this.sentLeds = key; msg.leds = L.map((x) => x >>> 0); }
    if (this.frames >= 22050) { msg.load = this.busy / (this.frames / sampleRate * 1000); this.busy = this.frames = 0; }
    const gen = ex.emu_fb_gen();
    if (gen !== this.sentDraws) {                   /* (the page wants the panel's byte order: swapped) */
      this.sentDraws = gen;
      const fb = new Uint16Array(ex.memory.buffer, ex.emu_fb_ptr(), 57600).slice();
      for (let i = 0; i < 57600; i++) { const v = fb[i]; fb[i] = ((v >> 8) | (v << 8)) & 0xFFFF; }
      msg.fb = fb; tr.push(fb.buffer);
    }
    const fg = ex.emu_flash_gen();
    if (fg !== this.flashGen) {
      this.flashGen = fg;
      msg.save = { flash: new Uint8Array(ex.memory.buffer, ex.emu_flash_ptr(), ex.emu_flash_size()).slice() };
    }
    if (msg.leds || msg.fb || msg.save || msg.load !== undefined) this.port.postMessage(msg, tr);
  }
  emuProcess(ex, outputs) {
    if (!this.started && currentTime >= this.startAt) { this.started = true; ex.emu_start(); }
    if (this.mq.length) {
      const end = currentFrame + outputs[0][0].length;
      while (this.mq.length && this.mq[0][0] < end) { const e = this.mq.shift(); this.midi(e[1], e[2], e[3]); }
    }
    const out = outputs[0], n = out[0].length, t0 = clock();
    ex.emu_render(n);
    if (++this.blocks % 6 === 0) ex.emu_frame();    /* the firmware's main loop, about every 17 ms */
    this.busy += clock() - t0;
    this.frames += n;
    const a = new Float32Array(ex.memory.buffer, ex.emu_audio_ptr(), 2 * n);
    for (let i = 0; i < n; i++) { out[0][i] = a[2 * i]; if (out[1]) out[1][i] = a[2 * i + 1]; }
    if (currentTime - this.last >= this.period) { this.last = currentTime; this.emuPublish(ex); }
  }

  /* a channel message into the firmware: Felucca's family takes the bytes (web_midi), fm1-base's (X0X, Polly, LOOM-8,
   * TOUGE next) a USB-MIDI packet with its port (web_midi_in(port, cin | status << 8 | d1 << 16 | d2 << 24)) */
  midi(st, d1, d2) {
    const ex = this.ex;
    if (!ex) return;
    if (ex.emu_midi) ex.emu_midi((((st >> 4) & 15) | (st << 8) | (d1 << 16) | (d2 << 24)) >>> 0);
    else if (ex.web_midi) ex.web_midi(st, d1, d2);
    else if (ex.web_midi_in) ex.web_midi_in(0, ((st >> 4) & 15) | (st << 8) | (d1 << 16) | (d2 << 24));
  }

  fail(err) {
    this.ex = null;
    this.port.postMessage({ type: "crash", message: String(err && err.message || err) });
  }

  collectSave() {
    const ex = this.ex, out = {};
    if (this.kind === "nor") {
      const nor = new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size ? ex.web_nor_size() : 0x100000);
      for (let off = 0; off + 4096 <= nor.length; off += 4096) {
        const s = nor.subarray(off, off + 4096);
        for (let i = 0; i < 4096; i++) if (s[i] !== 0xFF) { out[off] = s.slice(); break; }
      }
    } else if (this.kind === "store") {
      for (let o = 0; o < ex.web_nobj(); o++) {
        const n = ex.web_store_len(o);
        if (n >= 0) out[o] = new Uint8Array(ex.memory.buffer, ex.web_store(o), n).slice();
      }
      if (ex.web_data) out.data = new Uint8Array(ex.memory.buffer, ex.web_data(), ex.web_data_len()).slice();
    }
    return out;
  }

  publish() {
    const ex = this.ex, msg = { type: "frame" }, tr = [];
    const leds = [ex.web_lit_buttons ? ex.web_lit_buttons() >>> 0 : 0, ex.web_lit_keys ? ex.web_lit_keys() >>> 0 : 0,
                  ex.web_dim_buttons ? ex.web_dim_buttons() >>> 0 : 0, ex.web_dim_keys ? ex.web_dim_keys() >>> 0 : 0];
    const key = leds.join(",");
    if (key !== this.sentLeds) { this.sentLeds = key; msg.leds = leds; }
    if (this.frames >= 22050) { msg.load = this.busy / (this.frames / sampleRate * 1000); this.busy = this.frames = 0; }
    if (this.screen) {
      const draws = this.counter ? this.counter() : -2;
      if (draws !== this.sentDraws) {
        this.sentDraws = draws;
        msg.fb = new Uint16Array(ex.memory.buffer, this.screen(), 57600).slice();
        tr.push(msg.fb.buffer);
      }
    }
    const writes = this.kind === "nor" ? (ex.web_flash_writes_count ? ex.web_flash_writes_count() : -1)
                 : this.kind === "store" ? (ex.web_store_writes ? ex.web_store_writes() : -1) : -1;
    if (writes !== this.sentWrites || this.dataDirty) { this.sentWrites = writes; this.dataDirty = false; msg.save = this.collectSave(); }
    if (msg.leds || msg.fb || msg.save || msg.load !== undefined) this.port.postMessage(msg, tr);
  }

  process(inputs, outputs) {
    const ex = this.ex;
    if (!ex) return true;
    if (this.kind === "emu") { try { this.emuProcess(ex, outputs); } catch (err) { this.fail(err); } return true; }
    try {
      if (this.queue.length) {
        const now = ex.web_now_ms ? ex.web_now_ms() : this.ms;
        while (this.queue.length && now - this.nextOk >= 0) {
          const m = this.queue.shift();
          if (m.type === "buttons") ex.web_buttons(m.mask >>> 0); else ex.web_keys(m.mask >>> 0);
          this.nextOk = now + HOLD_MS;
        }
      }
      if (this.mq.length) {                         /* the file player's notes due in this quantum (2.9 ms steps) */
        const end = currentFrame + outputs[0][0].length;
        while (this.mq.length && this.mq[0][0] < end) { const e = this.mq.shift(); this.midi(e[1], e[2], e[3]); }
      }
      const out = outputs[0], n = out[0].length, t0 = clock();
      ex.web_render(n);
      this.busy += clock() - t0;
      this.frames += n;
      this.ms += n * 1000 / sampleRate;
      out[0].set(new Float32Array(ex.memory.buffer, ex.web_out_l(), n));
      if (out[1]) out[1].set(new Float32Array(ex.memory.buffer, ex.web_out_r(), n));
      if (currentTime - this.last >= this.period) { this.last = currentTime; this.publish(); }
    } catch (err) { this.fail(err); }
    return true;
  }
}
registerProcessor("fm1", FM1);
