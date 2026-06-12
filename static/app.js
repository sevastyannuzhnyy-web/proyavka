/* Upscaler — multi-photo flow. No dependencies.
   Drop one or many → staged previews → press Enhance → queue → review each. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var dropzone = $("dropzone"), fileInput = $("file");
  var grid = $("grid"), statusEl = $("status"), controls = $("controls");
  var modeSeg = $("modeSeg"), sizeSeg = $("sizeSeg"), modeHint = $("modeHint");
  var actions = $("actions"), primaryBtn = $("primaryBtn"), addBtn = $("addBtn"), clearBtn = $("clearBtn");
  var overlay = $("overlay"), overlayClose = $("overlayClose");
  var frame = $("frame"), stage = $("stage");
  var imgBefore = $("imgBefore"), imgAfter = $("imgAfter"), divider = $("divider");
  var chips = document.querySelectorAll(".chip");
  var saveBtn = $("saveBtn"), retryBtn = $("retryBtn"), retryHint = $("retryHint");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  var API = window.Proyavka;
  var SAVE_LABEL = API.mode === "desktop" ? "Save image"
    : (isTouch ? "Save photo" : "Download full size");

  var state = { scale: 2, model: "photo", models: ["photo"], maxUploadMb: 30, running: false, seq: 0, wakeLock: null };
  var items = [];          // {id,file,name,blob,previewUrl,status,progress,jobId,beforeUrl,resultUrl,model,degraded,thumbEl,fails}
  var current = null;      // item shown in overlay
  var sliderPos = 50, chipTimer = null;

  API.meta().then(function (m) {
    if (m.models && m.models.length) state.models = m.models;
    if (m.maxUploadMb) state.maxUploadMb = m.maxUploadMb;
  }).catch(function () {}).then(setupModes);

  /* ---------- choosing files ---------- */

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) onFiles(fileInput.files);
    fileInput.value = "";
  });
  addBtn.addEventListener("click", function () { fileInput.click(); });

  ["dragover", "dragenter"].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("dragover"); });
  });
  document.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files;
    if (f && f.length && !state.running) onFiles(f);
  });

  function onFiles(list) {
    Array.prototype.slice.call(list).forEach(function (file) {
      if (file.type && file.type.indexOf("image/") !== 0 && !/\.(jpe?g|png|heic|webp)$/i.test(file.name)) return;
      addItem(file);
    });
    refreshUI();
  }

  function addItem(file) {
    var item = { id: ++state.seq, file: file, name: file.name || "photo.jpg",
                 status: "loading", progress: 0, model: null };
    items.push(item);
    renderThumb(item);
    shrink(file).then(function (blob) {
      var send = blob || file;
      if (send.size > state.maxUploadMb * 1048576) {
        item.status = "error"; item.error = "Too large (max " + state.maxUploadMb + " MB)";
      } else {
        item.blob = send;
        item.previewUrl = URL.createObjectURL(send);
        item.status = "staged";
      }
      updateThumb(item);
      refreshUI();
    });
  }

  /* Shrink to 2048px long side before sending — lighter and faster.
     PNG stays PNG; others → JPEG on white. Undecodable (HEIC on desktop) → original. */
  function shrink(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, long = Math.max(w, h);
        var needResize = long > 2048;
        var isJpeg = /jpe?g$/i.test(file.type);
        if (!needResize && (isJpeg || /png|webp/i.test(file.type)) && file.size < 4 * 1048576) {
          URL.revokeObjectURL(url); resolve(null); return;
        }
        var isPng = /png$/i.test(file.type);
        var k = needResize ? 2048 / long : 1;
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
        var ctx = canvas.getContext("2d");
        if (!isPng) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (b) { URL.revokeObjectURL(url); resolve(b); },
          isPng ? "image/png" : "image/jpeg", 0.9);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* ---------- thumbnails ---------- */

  function renderThumb(item) {
    var el = document.createElement("button");
    el.className = "thumb"; el.type = "button";
    el.innerHTML =
      '<img alt="">' +
      '<span class="thumb-bar"><span></span></span>' +
      '<span class="thumb-badge"></span>' +
      '<span class="thumb-x" aria-label="remove">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg></span>';
    el.querySelector(".thumb-x").addEventListener("click", function (e) {
      e.stopPropagation(); removeItem(item);
    });
    el.addEventListener("click", function () { if (item.status === "done") openOverlay(item); });
    item.thumbEl = el;
    grid.appendChild(el);
    updateThumb(item);
  }

  function updateThumb(item) {
    var el = item.thumbEl; if (!el) return;
    el.dataset.status = item.status;
    var img = el.querySelector("img");
    if (item.previewUrl && img.getAttribute("src") !== item.previewUrl) img.src = item.previewUrl;
    el.querySelector(".thumb-bar").firstChild.style.width =
      (item.status === "processing" ? (item.progress || 0) : 0) + "%";
    var badge = el.querySelector(".thumb-badge");
    badge.textContent = item.status === "done" ? "✓"
      : item.status === "error" ? "!"
      : item.status === "queued" ? "…" : "";
    el.querySelector(".thumb-x").hidden =
      state.running || item.status === "processing" || item.status === "queued";
    el.title = item.status === "error" ? (item.error || "Error") : "";
  }

  function removeItem(item) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (item.thumbEl) item.thumbEl.remove();
    items = items.filter(function (i) { return i !== item; });
    refreshUI();
  }

  clearBtn.addEventListener("click", function () {
    if (state.running) return;
    items.forEach(function (i) { if (i.previewUrl) URL.revokeObjectURL(i.previewUrl); });
    items = []; grid.innerHTML = ""; refreshUI();
  });

  /* ---------- ui state ---------- */

  function refreshUI() {
    var has = items.length > 0;
    dropzone.hidden = has;
    grid.hidden = !has;
    controls.hidden = !has || state.running;
    actions.hidden = !has;
    updatePrimary();
  }

  function updatePrimary() {
    var staged = items.filter(function (i) { return i.status === "staged"; }).length;
    var busy = items.some(function (i) { return i.status === "processing" || i.status === "queued"; });
    var done = items.filter(function (i) { return i.status === "done"; }).length;
    primaryBtn.disabled = busy || (staged === 0 && done === 0);
    if (busy) {
      primaryBtn.textContent = "Enhancing… " + done + "/" + items.length;
    } else if (staged > 0) {
      primaryBtn.textContent = "Enhance " + items.length + (items.length > 1 ? " photos" : " photo");
    } else if (done > 0) {
      primaryBtn.textContent = done > 1 ? "Save all (" + done + ")" : "Save photo";
    } else {
      primaryBtn.textContent = "Enhance";
    }
    addBtn.hidden = busy;
    clearBtn.hidden = busy;
    if (busy) { setStatus("Keep this window open while photos are processed"); show(statusEl); }
    else if (done && done === items.length) { setStatus("Done! Tap a photo to compare before / after"); show(statusEl); }
    else hide(statusEl);
  }

  primaryBtn.addEventListener("click", function () {
    var staged = items.filter(function (i) { return i.status === "staged"; });
    if (staged.length) startProcessing();
    else saveAll();
  });

  /* ---------- processing queue (one at a time) ---------- */

  function startProcessing() {
    if (state.running) return;
    state.running = true;
    keepAwake();
    items.forEach(function (i) {
      if (i.status === "staged") { i.status = "queued"; i.model = state.model; updateThumb(i); }
    });
    refreshUI();
    pump();
  }

  function pump() {
    var next = items.find(function (i) { return i.status === "queued"; });
    if (!next) { state.running = false; releaseWake(); refreshUI(); return; }
    processItem(next, next.model || state.model).then(pump);
  }

  function processItem(item, model) {
    return new Promise(function (resolve) {
      item.status = "processing"; item.progress = 0; item.fails = 0; item.model = model;
      updateThumb(item); updatePrimary();
      // restore = лёгкая чистка зерна/шума на клиенте + обычная photo-модель
      var serverModel = model === "restore" ? "photo" : model;
      // Max всегда 4× — держим инвариант и на первом проходе, и в retry-цикле
      var effScale = model === "max" ? 4 : state.scale;
      var prep = model === "restore" ? cleanForRestore(item.blob) : Promise.resolve(item.blob);
      prep.then(function (blob) {
        var name = blob.type === "image/jpeg" ? item.name.replace(/\.\w+$/, ".jpg") : item.name;
        return API.createJob(blob, name, effScale, serverModel);
      }).then(function (body) { item.jobId = body.id; pollItem(item, resolve); })
        .catch(function (e) {
          item.status = "error";
          item.error = e && e.friendly ? e.message : "Couldn’t process this one";
          updateThumb(item); updatePrimary(); resolve();
        });
    });
  }

  /* лёгкое подавление зерна/шума перед апскейлом — одинаково в вебе и десктопе */
  function cleanForRestore(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        var ctx = c.getContext("2d");
        try { ctx.filter = "blur(0.6px)"; } catch (e) {}
        ctx.drawImage(img, 0, 0);
        ctx.filter = "none";
        var isPng = blob.type === "image/png";
        c.toBlob(function (b) { URL.revokeObjectURL(url); resolve(b || blob); },
          isPng ? "image/png" : "image/jpeg", 0.92);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }

  function pollItem(item, done) {
    setTimeout(function () {
      API.getJob(item.jobId).then(function (b) {
        if (b.status === "done") {
          item.status = "done"; item.progress = 100;
          item.degraded = !!b.degraded;   // десктоп без GPU: простое увеличение
          item.beforeUrl = API.originalURL(item.jobId);
          item.resultUrl = API.resultURL(item.jobId);
          updateThumb(item); updatePrimary();
          if (current === item) showResultInOverlay(item);
          done();
        } else if (b.status === "error") {
          item.status = "error"; item.error = b.error || "Failed"; updateThumb(item); updatePrimary(); done();
        } else {
          item.progress = b.progress || 0; updateThumb(item); pollItem(item, done);
        }
      }).catch(function (e) {
        if (e && e.status === 404) { item.status = "error"; item.error = "Job lost"; updateThumb(item); updatePrimary(); done(); }
        else if (++item.fails < 25) pollItem(item, done);
        else { item.status = "error"; item.error = "Connection lost"; updateThumb(item); updatePrimary(); done(); }
      });
    }, 700);
  }

  /* ---------- save ---------- */

  function saveAll() {
    var done = items.filter(function (i) { return i.status === "done"; });
    if (!done.length) return;
    if (API.saveAll) { API.saveAll(done.map(function (i) { return i.jobId; })); return; }
    done.forEach(function (it, idx) {
      setTimeout(function () {
        API.downloadResult(it.jobId).then(function (blob) {
          if (!blob) return;
          downloadBlob(blob, "upscaled-" + (idx + 1) + (blob.type === "image/png" ? ".png" : ".jpg"));
        });
      }, idx * 400);
    });
  }

  function downloadBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
  }

  /* ---------- detail overlay: before / after ---------- */

  function openOverlay(item) {
    current = item;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    retryHint.hidden = availableModes().length < 2;
    retryBtn.hidden = availableModes().length < 2;
    showResultInOverlay(item);
  }

  function showResultInOverlay(item) {
    saveBtn.disabled = false; saveBtn.textContent = SAVE_LABEL;
    retryBtn.disabled = false; retryBtn.textContent = "Try another look";
    if (item.degraded) {                  // честно: без GPU это не AI, а простое увеличение
      retryHint.textContent = "No GPU found — used a basic enlargement";
      retryHint.hidden = false;
    } else {
      retryHint.textContent = "same photo, different style";
    }
    var b = new Image(), a = new Image(), loaded = 0;
    function ready() {
      if (++loaded < 2) return;
      imgBefore.src = item.beforeUrl; imgAfter.src = item.resultUrl;
      chips.forEach(function (c) { c.hidden = false; });
      showChips(); scheduleChipFade();
      if (reducedMotion) setSlider(50);
      else { var band = imageBand(); var s = band[1] - band[0]; sweep(band[0] + 0.85 * s, band[0] + 0.45 * s, 1100); }
    }
    b.onload = ready; a.onload = ready;
    b.onerror = a.onerror = ready;
    b.src = item.beforeUrl; a.src = item.resultUrl;
  }

  overlayClose.addEventListener("click", closeOverlay);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeOverlay(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !overlay.hidden) closeOverlay(); });

  function closeOverlay() { overlay.hidden = true; current = null; document.body.style.overflow = ""; }

  saveBtn.addEventListener("click", function () {
    if (!current) return;
    saveBtn.textContent = "One sec…";
    API.downloadResult(current.jobId).then(function (blob) {
      if (!blob) return;
      var ext = blob.type === "image/png" ? ".png" : ".jpg";
      if (isTouch && navigator.canShare) {
        var file = new File([blob], "upscaled" + ext, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file] }).catch(function (er) {
            if (er.name !== "AbortError") downloadBlob(blob, "upscaled" + ext);
          });
        }
      }
      downloadBlob(blob, "upscaled" + ext);
    }).catch(function () {}).then(function () { saveBtn.textContent = SAVE_LABEL; });
  });

  retryBtn.addEventListener("click", function () {
    if (!current || state.running) return;
    var item = current;
    var modes = availableModes();
    var i = modes.indexOf(item.model);
    var nextModel = modes[(i + 1) % modes.length] || item.model;
    saveBtn.disabled = true; retryBtn.disabled = true; retryBtn.textContent = "Enhancing…";
    chips.forEach(function (c) { c.hidden = true; });
    state.running = true; refreshUI();
    processItem(item, nextModel).then(function () {
      state.running = false; refreshUI();
      if (item.status === "done" && current === item) showResultInOverlay(item);
      else { retryBtn.disabled = false; retryBtn.textContent = "Try another look"; saveBtn.disabled = false; }
    });
  });

  /* ---------- slider ("before" left, "after" right) ---------- */

  function imageBand() {
    var nw = imgBefore.naturalWidth, nh = imgBefore.naturalHeight;
    if (!nw || !nh) return [0, 100];
    var frac = Math.min(1, (nw / nh) / (stage.clientWidth / stage.clientHeight));
    var leftPct = (1 - frac) / 2 * 100;
    return [leftPct, 100 - leftPct];
  }

  function setSlider(p) {
    var band = imageBand();
    sliderPos = Math.max(band[0], Math.min(band[1], p));
    imgAfter.style.clipPath = "inset(0 0 0 " + sliderPos + "%)";
    divider.style.left = sliderPos + "%";
  }

  function sweep(from, to, ms) {
    var t0 = performance.now();
    function tick(t) {
      var k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      setSlider(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  var dragging = false;
  stage.addEventListener("pointerdown", function (e) {
    if (overlay.hidden) return;
    dragging = true; stage.setPointerCapture(e.pointerId); moveSlider(e); showChips();
  });
  stage.addEventListener("pointermove", function (e) { if (dragging) moveSlider(e); });
  ["pointerup", "pointercancel"].forEach(function (ev) {
    stage.addEventListener(ev, function () { dragging = false; scheduleChipFade(); });
  });
  function moveSlider(e) {
    var rect = stage.getBoundingClientRect();
    setSlider((e.clientX - rect.left) / rect.width * 100);
  }
  function showChips() { clearTimeout(chipTimer); chips.forEach(function (c) { c.classList.remove("faded"); }); }
  function scheduleChipFade() {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(function () { chips.forEach(function (c) { c.classList.add("faded"); }); }, 4000);
  }

  /* ---------- size control ---------- */

  document.querySelectorAll(".seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;               // залочено в режиме Max
      document.querySelectorAll(".seg-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.scale = parseInt(btn.dataset.scale, 10);
    });
  });

  /* ---------- mode control ---------- */

  var MODE_HINTS = {
    photo: "Best for everyday photos",
    art: "Drawings, anime & logos",
    restore: "Cleans up grain & noise",
    max: "Maximum quality for print — slower"
  };
  var MODE_ORDER = ["photo", "art", "restore", "max"];

  // restore = чистка + photo-модель, поэтому доступен, когда доступна photo
  function availableModes() {
    var m = state.models || [];
    return MODE_ORDER.filter(function (k) {
      return k === "restore" ? m.indexOf("photo") >= 0 : m.indexOf(k) >= 0;
    });
  }

  function applyModeHint() { modeHint.textContent = MODE_HINTS[state.model] || ""; }

  // Max всегда 4× — размер фиксируем и блокируем
  function applySizeLock() {
    var lock = state.model === "max";
    sizeSeg.classList.toggle("locked", lock);
    document.querySelectorAll(".seg-btn").forEach(function (b) {
      b.disabled = lock;
      if (lock) b.classList.toggle("active", b.dataset.scale === "4");
    });
    if (lock) state.scale = 4;
  }

  function setupModes() {
    var avail = availableModes();
    if (avail.indexOf(state.model) < 0) state.model = avail[0] || "photo";
    document.querySelectorAll(".mode-btn").forEach(function (b) {
      b.hidden = avail.indexOf(b.dataset.model) < 0;
      b.classList.toggle("active", b.dataset.model === state.model);
    });
    modeSeg.hidden = avail.length < 2;
    applyModeHint();
    applySizeLock();
  }

  document.querySelectorAll(".mode-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".mode-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.model = btn.dataset.model;
      applyModeHint();
      applySizeLock();
    });
  });

  /* ---------- keep screen awake while processing ---------- */

  function keepAwake() {
    try { navigator.wakeLock.request("screen").then(function (l) { state.wakeLock = l; }).catch(function () {}); }
    catch (e) {}
  }
  function releaseWake() {
    if (state.wakeLock) { state.wakeLock.release().catch(function () {}); state.wakeLock = null; }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.running) keepAwake();
  });

  function setStatus(t) { statusEl.textContent = t; }
  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
})();
