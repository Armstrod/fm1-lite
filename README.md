# FM-1 Lite

Play M-VAVE FM-1 community firmwares on a phone. FM-1 Lite runs each firmware's own browser build (WebAssembly),
fetched from its author's GitHub Pages site, on a light touch panel. It doesn't emulate the FM-1's chip, so it
needs very little CPU.

**Open it:** https://armstrod.github.io/fm1-lite/ — then Chrome's menu → *Install app* (or *Add to Home screen*).

- Tap the firmware's name to pick another; ⚡ marks firmwares that are heavy on phones.
- Drag a knob up/down (or left/right) to turn it. Slide across the keys.
- Settings (⋯): audio buffer size, vibration, keep screen on, USB MIDI input, full screen.
- Each firmware's saves stay on the phone (IndexedDB). Firmwares you've played once work offline.
- *Add a firmware by URL* takes any Felucca- or X0X-style browser build's `.wasm`.

`catalog.json` lists the firmwares known to work (29 as of the last update), found by checking the FM-1 Firmware
Hub's list for repositories with a browser build and testing each one headless.

Firmwares belong to their authors, under their own licences (see each one's repository). This app is GPL-3.0; its
worklet and panel follow Felucca's (Leo Kuroshita, Hügelton Instruments) and X0X's (charlesvestal) browser emulators.
M-VAVE and FM-1 are trademarks of their owners; this project isn't affiliated with them.
