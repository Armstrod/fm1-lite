// SPDX-License-Identifier: GPL-3.0-only
// FM-1 Lite's AudioWorklet: runs one FM-1 firmware's browser build (WebAssembly) against its simulated FM-1.
// Follows Felucca's web/emu/worklet.js (Leo Kuroshita, Hügelton Instruments, GPL-3.0) and fm1-x0x's
// (charlesvestal, GPL-3.0). Handles both families of browser build:
//   Felucca family: web_screen + web_screen_draws, flash in web_nor, MASTER 0..1023
//   X0X family:     web_fb + web_blits, saves in web_store objects, MASTER 0..4095
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
            const b = bytes.subarray(0, max);
            new Uint8Array(ex.memory.buffer, ex.web_store(+obj), b.length).set(b);
            ex.web_store_set_len(+obj, b.length);
          }
          this.sentWrites = ex.web_store_writes ? ex.web_store_writes() : -1;
        }
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
      else if (m.type === "visible") this.period = m.on ? 1 / 20 : 1 / 2;
    } catch (err) { this.fail(err); }
  }

  /* a channel message into the firmware: Felucca's family takes the bytes (web_midi), fm1-base's (X0X, Polly, LOOM-8,
   * TOUGE next) a USB-MIDI packet with its port (web_midi_in(port, cin | status << 8 | d1 << 16 | d2 << 24)) */
  midi(st, d1, d2) {
    const ex = this.ex;
    if (!ex) return;
    if (ex.web_midi) ex.web_midi(st, d1, d2);
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
    if (writes !== this.sentWrites) { this.sentWrites = writes; msg.save = this.collectSave(); }
    if (msg.leds || msg.fb || msg.save || msg.load !== undefined) this.port.postMessage(msg, tr);
  }

  process(inputs, outputs) {
    const ex = this.ex;
    if (!ex) return true;
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
