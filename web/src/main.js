import "./style.css";

(function () {
  const W = 1920,
    H = 1080;
  const canvas = document.getElementById("kvm");
  const banner = document.getElementById("kvm-banner");
  const st = document.getElementById("st");
  const fpsDisplay = document.getElementById("fps-display");
  const btnSendEsc = document.getElementById("btn-send-esc");
  const btnPasteClip = document.getElementById("btn-paste-clip");
  const ptrSensInput = document.getElementById("ptr-sens");
  const ptrSensVal = document.getElementById("ptr-sens-val");
  const jpegQInput = document.getElementById("jpeg-q");
  const btnJpegQ = document.getElementById("btn-jpeg-q");
  const showFpsInput = document.getElementById("show-fps");
  const PTR_SENS_KEY = "p4kvm_pointer_sensitivity_pct";
  const SHOW_FPS_KEY = "p4kvm_show_fps";

  function loadPointerSensitivityPct() {
    let v = 100;
    try {
      const s = localStorage.getItem(PTR_SENS_KEY);
      if (s !== null) {
        const n = parseInt(s, 10);
        if (!isNaN(n)) v = Math.max(25, Math.min(300, n));
      }
    } catch (e) {
      /* ignore */
    }
    return v;
  }

  function savePointerSensitivityPct(pct) {
    try {
      localStorage.setItem(PTR_SENS_KEY, String(pct));
    } catch (e) {
      /* ignore */
    }
  }

  function loadShowFps() {
    try {
      const s = localStorage.getItem(SHOW_FPS_KEY);
      return s === "true";
    } catch (e) {
      return false;
    }
  }

  function saveShowFps(enabled) {
    try {
      localStorage.setItem(SHOW_FPS_KEY, String(enabled));
    } catch (e) {
      /* ignore */
    }
  }

  (function initPointerSensUi() {
    const pct = loadPointerSensitivityPct();
    ptrSensInput.value = String(pct);
    ptrSensVal.textContent = pct + "%";
    ptrSensInput.addEventListener("input", function () {
      const p = parseInt(ptrSensInput.value, 10);
      ptrSensVal.textContent = p + "%";
    });
    ptrSensInput.addEventListener("change", function () {
      const p = parseInt(ptrSensInput.value, 10);
      savePointerSensitivityPct(p);
    });
  })();

  // FPS counter for MJPEG stream
  let showFps = loadShowFps();
  let fpsFrameCount = 0;
  let fpsLastTime = performance.now();
  let fpsDisplayValue = 0;

  (function initShowFpsUi() {
    const enabled = loadShowFps();
    showFpsInput.checked = enabled;
    fpsDisplay.classList.toggle("hidden", !enabled);
    showFps = enabled;
    showFpsInput.addEventListener("change", function () {
      const on = showFpsInput.checked;
      saveShowFps(on);
      fpsDisplay.classList.toggle("hidden", !on);
      showFps = on;
      if (on) {
        fpsFrameCount = 0;
        fpsLastTime = performance.now();
      } else {
        fpsDisplay.textContent = "FPS: --";
      }
    });
  })();

  const canvasCtx = canvas.getContext("2d");
  let streamAbortController = null;

  function findBytes(haystack, needle) {
    const nlen = needle.length;
    for (let i = 0; i <= haystack.length - nlen; i++) {
      let j = 0;
      while (j < nlen && haystack[i + j] === needle[j]) j++;
      if (j === nlen) return i;
    }
    return -1;
  }

  const BOUNDARY = new TextEncoder().encode("--frame\r\n");
  const HEADER_END = new TextEncoder().encode("\r\n\r\n");

  async function startMjpegStream() {
    if (streamAbortController) {
      streamAbortController.abort();
    }
    streamAbortController = new AbortController();

    while (true) {
      try {
        const response = await fetch("/stream", {
          signal: streamAbortController.signal,
        });
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value && value.length) {
            const tmp = new Uint8Array(buffer.length + value.length);
            tmp.set(buffer);
            tmp.set(value, buffer.length);
            buffer = tmp;
          }

          while (buffer.length > 0) {
            const bIdx = findBytes(buffer, BOUNDARY);
            if (bIdx < 0) break;

            const afterBoundary = buffer.slice(bIdx + BOUNDARY.length);
            const hEnd = findBytes(afterBoundary, HEADER_END);
            if (hEnd < 0) break;

            const hText = new TextDecoder().decode(
              afterBoundary.slice(0, hEnd),
            );
            const clMatch = hText.match(/Content-Length:\s*(\d+)/i);
            if (!clMatch) {
              buffer = buffer.slice(bIdx + BOUNDARY.length);
              break;
            }

            const jpegLen = parseInt(clMatch[1], 10);
            const jpegStart =
              bIdx + BOUNDARY.length + hEnd + HEADER_END.length;
            const jpegEnd = jpegStart + jpegLen + 2;

            if (buffer.length < jpegEnd) break;

            const jpegData = buffer.slice(jpegStart, jpegStart + jpegLen);
            try {
              const bmp = await createImageBitmap(
                new Blob([jpegData], { type: "image/jpeg" }),
              );
              canvasCtx.drawImage(bmp, 0, 0, W, H);
              bmp.close();

              fpsFrameCount++;
              if (performance.now() - fpsLastTime >= 1000) {
                if (showFps) {
                  fpsDisplayValue = fpsFrameCount;
                  fpsDisplay.textContent = "FPS: " + fpsDisplayValue;
                }
                fpsFrameCount = 0;
                fpsLastTime = performance.now();
              }
            } catch (e) {
              /* corrupt frame, skip */
            }

            buffer = buffer.slice(jpegEnd);
          }
        }
      } catch (e) {
        if (
          streamAbortController &&
          streamAbortController.signal.aborted
        )
          return;
      }
      await sleep(1000);
    }
  }

  startMjpegStream();

  function parseJpegQualityText(t) {
    const n = parseInt(String(t).trim(), 10);
    if (isNaN(n) || n < 1 || n > 100) return null;
    return n;
  }

  async function syncJpegQualityFromDevice() {
    try {
      const r = await fetch("/jpeg-quality", { cache: "no-store" });
      if (!r.ok) return;
      const n = parseJpegQualityText(await r.text());
      if (n !== null) jpegQInput.value = String(n);
    } catch (e) {
      /* device may still be starting */
    }
  }

  async function applyJpegQuality() {
    let q = parseInt(jpegQInput.value, 10);
    if (isNaN(q)) return;
    q = Math.max(1, Math.min(100, q));
    jpegQInput.value = String(q);
    try {
      const r = await fetch("/jpeg-quality?q=" + encodeURIComponent(q), {
        cache: "no-store",
      });
      if (r.ok) {
        const n = parseJpegQualityText(await r.text());
        if (n !== null) jpegQInput.value = String(n);
      }
    } catch (e) {
      /* ignore */
    }
  }

  btnJpegQ.addEventListener("click", applyJpegQuality);
  jpegQInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      applyJpegQuality();
    }
  });
  syncJpegQualityFromDevice();

  function pointerSensitivityMult() {
    return parseInt(ptrSensInput.value, 10) / 100;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null;
  let reconnectTimer = null;

  const CODE_TO_HID = (function () {
    const m = {};
    for (let i = 0; i < 26; i++) {
      m["Key" + String.fromCharCode(65 + i)] = 0x04 + i;
    }
    const digits = [
      ["Digit1", 0x1e],
      ["Digit2", 0x1f],
      ["Digit3", 0x20],
      ["Digit4", 0x21],
      ["Digit5", 0x22],
      ["Digit6", 0x23],
      ["Digit7", 0x24],
      ["Digit8", 0x25],
      ["Digit9", 0x26],
      ["Digit0", 0x27],
    ];
    for (const [c, v] of digits) m[c] = v;
    const extra = [
      ["Enter", 0x28],
      ["Escape", 0x29],
      ["Backspace", 0x2a],
      ["Tab", 0x2b],
      ["Space", 0x2c],
      ["Minus", 0x2d],
      ["Equal", 0x2e],
      ["BracketLeft", 0x2f],
      ["BracketRight", 0x30],
      ["Backslash", 0x31],
      ["Semicolon", 0x33],
      ["Quote", 0x34],
      ["Backquote", 0x35],
      ["Comma", 0x36],
      ["Period", 0x37],
      ["Slash", 0x38],
      ["CapsLock", 0x39],
      ["F1", 0x3a],
      ["F2", 0x3b],
      ["F3", 0x3c],
      ["F4", 0x3d],
      ["F5", 0x3e],
      ["F6", 0x3f],
      ["F7", 0x40],
      ["F8", 0x41],
      ["F9", 0x42],
      ["F10", 0x43],
      ["F11", 0x44],
      ["F12", 0x45],
      ["Insert", 0x49],
      ["Home", 0x4a],
      ["PageUp", 0x4b],
      ["Delete", 0x4c],
      ["End", 0x4d],
      ["PageDown", 0x4e],
      ["ArrowRight", 0x4f],
      ["ArrowLeft", 0x50],
      ["ArrowDown", 0x51],
      ["ArrowUp", 0x52],
    ];
    for (const [c, v] of extra) m[c] = v;
    return m;
  })();

  const HELD = new Map();

  function hidModifierMask(ev) {
    let mod = 0;
    if (ev.ctrlKey) mod |= 0x01;
    if (ev.shiftKey) mod |= 0x02;
    if (ev.altKey) mod |= 0x04;
    if (ev.metaKey) mod |= 0x08;
    return mod;
  }

  function syncKeyboard(ev) {
    if (!ws || ws.readyState !== 1) return;
    const mod = hidModifierMask(ev);
    const keys = [];
    for (const k of HELD.keys()) {
      if (keys.length >= 6) break;
      keys.push(k);
    }
    while (keys.length < 6) keys.push(0);
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint8(0, 2);
    dv.setUint8(1, mod);
    for (let i = 0; i < 6; i++) dv.setUint8(2 + i, keys[i]);
    ws.send(buf);
  }

  const MOD_ONLY = new Set([
    "ControlLeft",
    "ControlRight",
    "ShiftLeft",
    "ShiftRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
  ]);

  const HID_SHIFT = 0x02;

  function sendRawKeyboard(mod, keycodes) {
    if (!ws || ws.readyState !== 1) return;
    const k = keycodes.slice(0, 6);
    while (k.length < 6) k.push(0);
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint8(0, 2);
    dv.setUint8(1, mod & 0xff);
    for (let i = 0; i < 6; i++) dv.setUint8(2 + i, k[i]);
    ws.send(buf);
  }

  function tapKey(mod, hid) {
    sendRawKeyboard(mod, [hid]);
    setTimeout(function () {
      sendRawKeyboard(0, []);
    }, 28);
  }

  /** US QWERTY: printable ASCII → { mod, hid } for paste (unknown chars skipped). */
  const PASTE_CHAR_TO_HID = (function () {
    const m = {};
    const SH = HID_SHIFT;
    function add(ch, mod, hid) {
      m[ch] = { mod: mod, hid: hid };
    }
    for (let i = 0; i < 26; i++) {
      add(String.fromCharCode(97 + i), 0, 0x04 + i);
      add(String.fromCharCode(65 + i), SH, 0x04 + i);
    }
    const dk = [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27];
    const digs = "1234567890";
    for (let i = 0; i < 10; i++) add(digs[i], 0, dk[i]);
    const shifted = ")!@#$%^&*(";
    for (let i = 0; i < 10; i++) add(shifted[i], SH, dk[i]);
    add(" ", 0, 0x2c);
    add("\n", 0, 0x28);
    add("\r", 0, 0x28);
    add("\t", 0, 0x2b);
    add("-", 0, 0x2d);
    add("_", SH, 0x2d);
    add("=", 0, 0x2e);
    add("+", SH, 0x2e);
    add("[", 0, 0x2f);
    add("{", SH, 0x2f);
    add("]", 0, 0x30);
    add("}", SH, 0x30);
    add("\\", 0, 0x31);
    add("|", SH, 0x31);
    add(";", 0, 0x33);
    add(":", SH, 0x33);
    add("'", 0, 0x34);
    add('"', SH, 0x34);
    add("`", 0, 0x35);
    add("~", SH, 0x35);
    add(",", 0, 0x36);
    add("<", SH, 0x36);
    add(".", 0, 0x37);
    add(">", SH, 0x37);
    add("/", 0, 0x38);
    add("?", SH, 0x38);
    return m;
  })();

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function typeStringAsHid(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch === "\r" && text.charAt(i + 1) === "\n") {
        continue;
      }
      const row = PASTE_CHAR_TO_HID[ch];
      if (!row) continue;
      sendRawKeyboard(row.mod, [row.hid]);
      await sleep(28);
      sendRawKeyboard(0, []);
      await sleep(18);
    }
  }

  function updateHidToolButtons() {
    const ok = ws && ws.readyState === 1;
    btnSendEsc.disabled = !ok;
    btnPasteClip.disabled = !ok;
  }

  btnSendEsc.addEventListener("click", function () {
    if (!ws || ws.readyState !== 1) return;
    tapKey(0, 0x29);
  });

  btnPasteClip.addEventListener("click", function () {
    if (!ws || ws.readyState !== 1) return;
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      st.textContent = "Clipboard API unavailable (use HTTPS or localhost)";
      return;
    }
    btnPasteClip.disabled = true;
    navigator.clipboard
      .readText()
      .then(function (text) {
        return typeStringAsHid(text);
      })
      .then(function () {
        updateHidToolButtons();
        updatePointerLockUi();
      })
      .catch(function () {
        st.textContent =
          "Clipboard read denied or failed (grant permission / use HTTPS)";
        updateHidToolButtons();
      });
  });

  function onKeyDown(ev) {
    if (!pointerLockActive()) return;
    if (MOD_ONLY.has(ev.code)) {
      syncKeyboard(ev);
      return;
    }
    const h = CODE_TO_HID[ev.code];
    if (h === undefined) return;
    ev.preventDefault();
    HELD.set(h, true);
    syncKeyboard(ev);
  }

  function onKeyUp(ev) {
    if (!pointerLockActive()) return;
    if (MOD_ONLY.has(ev.code)) {
      syncKeyboard(ev);
      return;
    }
    const h = CODE_TO_HID[ev.code];
    if (h === undefined) return;
    ev.preventDefault();
    HELD.delete(h);
    syncKeyboard(ev);
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", function () {
    if (!pointerLockActive()) return;
    if (HELD.size === 0) return;
    HELD.clear();
    if (ws && ws.readyState === 1) {
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setUint8(0, 2);
      dv.setUint8(1, 0);
      for (let i = 0; i < 6; i++) dv.setUint8(2 + i, 0);
      ws.send(buf);
    }
  });

  function pointerOverKvm(ev) {
    const r = canvas.getBoundingClientRect();
    return (
      ev.clientX >= r.left &&
      ev.clientX <= r.right &&
      ev.clientY >= r.top &&
      ev.clientY <= r.bottom
    );
  }

  /** Last pointer position mapped to frame pixels (for button release outside the image). */
  let lastX = 0,
    lastY = 0;

  function pointerLockActive() {
    return document.pointerLockElement === canvas;
  }

  function scaleMovementToFrame() {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      return { sx: 1, sy: 1 };
    }
    return { sx: (W - 1) / r.width, sy: (H - 1) / r.height };
  }

  /** Update lastX/lastY from pointer-lock mickeys (matches scaled deltas sent over WS). */
  function applyRelativeFromEvent(ev) {
    const mx = ev.movementX || 0;
    const my = ev.movementY || 0;
    const { sx, sy } = scaleMovementToFrame();
    const sens = pointerSensitivityMult();
    const rdx = Math.round(mx * sx * sens);
    const rdy = Math.round(my * sy * sens);
    let x = lastX + rdx;
    let y = lastY + rdy;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= W) x = W - 1;
    if (y >= H) y = H - 1;
    lastX = x;
    lastY = y;
    return { rdx, rdy };
  }

  let wasPointerLocked = false;

  function updatePointerLockUi() {
    const locked = pointerLockActive();
    if (wasPointerLocked && !locked) {
      HELD.clear();
      if (ws && ws.readyState === 1) {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setUint8(0, 2);
        dv.setUint8(1, 0);
        for (let i = 0; i < 6; i++) dv.setUint8(2 + i, 0);
        ws.send(buf);
      }
    }
    wasPointerLocked = locked;

    if (locked) {
      banner.classList.add("hidden");
      canvas.classList.add("pointer-locked");
      if (ws && ws.readyState === 1) {
        st.textContent = "Locked";
        /* Absolute sync so firmware/host alignment matches the video frame. */
        queueMouseAbs(0, lastX, lastY, 0, true);
      }
    } else {
      banner.classList.remove("hidden");
      canvas.classList.remove("pointer-locked");
      if (ws && ws.readyState === 1) {
        st.textContent = "Ready";
      }
    }
  }

  document.addEventListener("pointerlockchange", updatePointerLockUi);
  document.addEventListener("pointerlockerror", function () {
    banner.classList.remove("hidden");
    st.textContent = "HID: pointer lock failed (try HTTPS, or another browser)";
  });

  let pending = null;
  let raf = 0;

  function flushPendingIfOtherMode(mode) {
    if (!pending || pending.mode === mode) return;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    flushMouse();
  }

  function flushMouse() {
    raf = 0;
    if (!pending || !ws || ws.readyState !== 1) return;
    const p = pending;
    pending = null;
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);
    dv.setUint8(1, p.buttons);
    if (p.mode === "rel") {
      const clamp16 = function (v) {
        return Math.max(-32768, Math.min(32767, v));
      };
      dv.setInt16(2, clamp16(p.dx), true);
      dv.setInt16(4, clamp16(p.dy), true);
      dv.setUint8(7, 1);
    } else {
      dv.setUint16(2, p.x, true);
      dv.setUint16(4, p.y, true);
      dv.setUint8(7, 0);
    }
    dv.setInt8(6, p.wheel);
    ws.send(buf);
  }
  /**
   * Coalesce moves to one WebSocket frame per animation frame (reduces load).
   * Always flush immediately for wheel or any button transition so clicks are not merged away.
   */
  function queueMouseAbs(buttons, x, y, wheel, forceImmediate) {
    flushPendingIfOtherMode("abs");
    const prev = pending;
    const btnChanged =
      prev !== null && prev.mode === "abs" && prev.buttons !== buttons;
    pending = { mode: "abs", buttons: buttons, x: x, y: y, wheel: wheel };
    if (forceImmediate || wheel !== 0 || btnChanged) {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flushMouse();
      return;
    }
    if (!raf) raf = requestAnimationFrame(flushMouse);
  }

  function queueMouseRel(buttons, dx, dy, wheel, forceImmediate) {
    flushPendingIfOtherMode("rel");
    const prev = pending;
    const btnChanged =
      prev !== null && prev.mode === "rel" && prev.buttons !== buttons;
    if (!pending || pending.mode !== "rel") {
      pending = {
        mode: "rel",
        buttons: buttons,
        dx: dx,
        dy: dy,
        wheel: wheel,
      };
    } else {
      pending.buttons = buttons;
      pending.dx += dx;
      pending.dy += dy;
      let w = pending.wheel + wheel;
      if (w > 127) w = 127;
      else if (w < -127) w = -127;
      pending.wheel = w;
    }
    if (forceImmediate || wheel !== 0 || btnChanged) {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flushMouse();
      return;
    }
    if (!raf) raf = requestAnimationFrame(flushMouse);
  }

  function mapXY(ev) {
    const r = canvas.getBoundingClientRect();
    let x = ev.clientX - r.left;
    let y = ev.clientY - r.top;
    if (r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    x = Math.round((x / r.width) * (W - 1));
    y = Math.round((y / r.height) * (H - 1));
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= W) x = W - 1;
    if (y >= H) y = H - 1;
    return { x, y };
  }

  function mouseButtons(ev) {
    let b = 0;
    if (ev.buttons & 1) b |= 1;
    if (ev.buttons & 2) b |= 2;
    if (ev.buttons & 4) b |= 4;
    /* mousedown: some engines lag updating `buttons`; use `button` for the activating click. */
    if (
      (ev.type === "pointerdown" || ev.type === "mousedown") &&
      b === 0 &&
      typeof ev.button === "number"
    ) {
      if (ev.button === 0) b |= 1;
      else if (ev.button === 1) b |= 4;
      else if (ev.button === 2) b |= 2;
    }
    return b;
  }

  function onPointerDown(ev) {
    if (pointerLockActive()) return;
    if (
      ev.pointerType &&
      ev.pointerType !== "mouse" &&
      ev.pointerType !== "pen"
    )
      return;
    if (!pointerOverKvm(ev)) return;
    const { x, y } = mapXY(ev);
    lastX = x;
    lastY = y;
    if (
      ev.button === 0 &&
      document.pointerLockElement !== canvas &&
      typeof canvas.requestPointerLock === "function"
    ) {
      ev.preventDefault();
      const req = canvas.requestPointerLock();
      if (req && typeof req.catch === "function") {
        req.catch(function () {
          /* insecure context or user gesture policy */
        });
      }
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
  });

  /** While pointer is locked, movement and buttons are delivered on the document. */
  function onDocumentMouseMoveLock(ev) {
    if (document.pointerLockElement !== canvas) return;
    const { rdx, rdy } = applyRelativeFromEvent(ev);
    queueMouseRel(mouseButtons(ev), rdx, rdy, 0, false);
  }
  function onDocumentMouseDownLock(ev) {
    if (document.pointerLockElement !== canvas) return;
    queueMouseAbs(mouseButtons(ev), lastX, lastY, 0, true);
  }
  function onDocumentMouseUpLock(ev) {
    if (document.pointerLockElement !== canvas) return;
    queueMouseAbs(mouseButtons(ev), lastX, lastY, 0, true);
  }
  function onDocumentWheelLock(ev) {
    if (document.pointerLockElement !== canvas) return;
    ev.preventDefault();
    const w = Math.max(-127, Math.min(127, Math.round(-ev.deltaY / 16)));
    queueMouseAbs(mouseButtons(ev), lastX, lastY, w, true);
  }
  document.addEventListener("mousemove", onDocumentMouseMoveLock);
  document.addEventListener("mousedown", onDocumentMouseDownLock);
  document.addEventListener("mouseup", onDocumentMouseUpLock);
  document.addEventListener("wheel", onDocumentWheelLock, {
    passive: false,
  });

  function connectWs() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws = new WebSocket(proto + "://" + location.host + "/ws");
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      updatePointerLockUi();
      updateHidToolButtons();
    };
    ws.onclose = function () {
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
      st.textContent = "Disconnected: retrying…";
      updateHidToolButtons();
      reconnectTimer = setTimeout(connectWs, 2000);
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  let initialWsTimer = null;
  if (import.meta.hot) {
    import.meta.hot.dispose(function () {
      if (streamAbortController) {
        streamAbortController.abort();
        streamAbortController = null;
      }
      if (initialWsTimer) {
        clearTimeout(initialWsTimer);
        initialWsTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
    });
  }

  /* Let /stream canvas fetch and /jpeg-quality complete first; tight lwIP + httpd was seeing ECONNRESET when all three raced. */
  initialWsTimer = setTimeout(function () {
    initialWsTimer = null;
    connectWs();
  }, 400);
})();
