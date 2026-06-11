/* Проявка — логика одной страницы. Без зависимостей. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var frame = $("frame"), stage = $("stage");
  var fileInput = $("file");
  var imgBefore = $("imgBefore"), imgAfter = $("imgAfter");
  var divider = $("divider");
  var chips = document.querySelectorAll(".chip");
  var progressline = $("progressline"), bar = $("bar");
  var statusEl = $("status");
  var controls = $("controls");
  var actions = $("actions");
  var downloadBtn = $("downloadBtn"), downloadHint = $("downloadHint");
  var retryBtn = $("retryBtn"), retryHint = $("retryHint"), resetBtn = $("resetBtn");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  var API = window.Proyavka;
  var DOWNLOAD_LABEL = API.mode === "desktop" ? "Save image"
    : (isTouch ? "Save photo" : "Download full size");

  var PHRASES = [
    "Looking into the details…",
    "Drawing in light and shadow…",
    "Sharpening up…",
    "Smoothing things out…",
    "Final touches…"
  ];
  var PATIENCE = "Large photos take a little longer — almost there…";

  var state = {
    scale: 2,
    models: ["soft"],
    modelIdx: 0,
    maxUploadMb: 30,
    blob: null,          // что отправляем (ужатое или оригинал)
    previewUrl: null,
    jobId: null,
    pollTimer: null,
    pollFails: 0,
    phraseTimer: null,
    patienceTimer: null,
    visualP: 0,          // плавный прогресс 0..100
    targetP: 0,
    raf: 0,
    wakeLock: null,
    sliderPos: 50,
    chipTimer: null,
    resultUrl: null
  };

  downloadBtn.textContent = DOWNLOAD_LABEL;

  API.meta().then(function (m) {
    if (m.models && m.models.length) state.models = m.models;
    if (m.maxUploadMb) state.maxUploadMb = m.maxUploadMb;
    if (state.models.length < 2) {
      retryBtn.hidden = true;
      retryHint.hidden = true;
    }
  }).catch(function () {});

  /* ---------- выбор файла ---------- */

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  ["dragover", "dragenter"].forEach(function (ev) {
    frame.addEventListener(ev, function (e) {
      e.preventDefault();
      frame.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    frame.addEventListener(ev, function (e) {
      e.preventDefault();
      frame.classList.remove("dragover");
    });
  });
  frame.addEventListener("drop", function (e) {
    if (frame.dataset.state !== "idle") return;
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  function handleFile(file) {
    setStatus("Getting your photo ready…");
    show(statusEl);
    shrink(file).then(function (blob) {
      var send = blob || file;
      if (send.size > state.maxUploadMb * 1048576) {
        permanentFail("File is larger than " + state.maxUploadMb + " MB — try a smaller photo");
        return;
      }
      state.blob = send;
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = URL.createObjectURL(state.blob);
      state.modelIdx = 0;
      submit();
    });
  }

  /* Ужимаем до 2048px по длинной стороне — CPU-серверу легче, для глаза то же.
     PNG остаётся PNG (важно для рисунков), остальное → JPEG 0.9 на белом фоне.
     Если браузер не смог раскодировать (HEIC на десктопе) — шлём оригинал. */
  function shrink(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var long = Math.max(w, h);
        var needResize = long > 2048;
        var isJpeg = /jpe?g$/i.test(file.type);
        if (!needResize && (isJpeg || /png|webp/i.test(file.type)) && file.size < 4 * 1048576) {
          URL.revokeObjectURL(url);
          resolve(null); // оригинал и так лёгкий
          return;
        }
        var isPng = /png$/i.test(file.type);
        var k = needResize ? 2048 / long : 1;
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w * k);
        canvas.height = Math.round(h * k);
        var ctx = canvas.getContext("2d");
        if (!isPng) { // прозрачность под JPEG кладём на белый, не на чёрный
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          resolve(blob);
        }, isPng ? "image/png" : "image/jpeg", 0.9);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  /* ---------- отправка и ожидание ---------- */

  function submit() {
    var rawName = (fileInput.files[0] && fileInput.files[0].name) || "photo.jpg";
    var name = state.blob.type === "image/jpeg"
      ? rawName.replace(/\.\w+$/, ".jpg") : rawName;

    setProcessingUI();

    API.createJob(state.blob, name, state.scale, state.models[state.modelIdx])
      .then(function (body) {
        state.jobId = body.id;
        state.pollFails = 0;
        poll();
      })
      .catch(function (e) {
        if (e && e.status === 400) {
          // permanent error (not a photo / too big) — don't loop the retry
          permanentFail(e.friendly ? e.message : "Couldn’t open the file — is it a photo?");
        } else {
          fail(e && e.friendly ? e.message
            : "Couldn’t send the photo — check your connection and try again");
        }
      });
  }

  function setProcessingUI() {
    frame.dataset.state = "processing";
    stage.hidden = false;
    divider.hidden = true;
    chips.forEach(function (c) { c.hidden = true; });
    imgAfter.removeAttribute("src");
    if (state.previewUrl) imgBefore.src = state.previewUrl;
    hide(controls);
    hide(actions);
    downloadHint.hidden = true;
    show(progressline);
    show(statusEl);
    statusEl.classList.remove("error");
    setStatus("Enhancing… this takes a moment. Keep this window open");

    state.visualP = 0;
    state.targetP = 6;
    startRaf();
    startPhrases();
    keepAwake();
  }

  function poll() {
    state.pollTimer = setTimeout(function () {
      API.getJob(state.jobId)
        .then(function (b) {
          state.pollFails = 0;
          if (b.status === "done") {
            state.targetP = 100;
            finish();
          } else if (b.status === "error") {
            fail(b.error || "Something went wrong. The photo’s fine — just try again");
          } else {
            if (b.status === "queued" && b.position > 0) {
              setStatus(b.position + " photo" + (b.position > 1 ? "s" : "") + " ahead of you — starting soon…");
            }
            state.targetP = 8 + (b.progress || 0) * 0.9;
            poll();
          }
        })
        .catch(function (e) {
          if (e && e.status === 404) {
            fail(e.message || "This job is no longer available — upload the photo again");
          } else if (++state.pollFails < 25) {
            poll(); // network blip — keep trying
          } else {
            fail("Connection dropped — check your internet and try again");
          }
        });
    }, 1200);
  }

  /* ---------- прогресс-проявка ---------- */

  function startRaf() {
    cancelAnimationFrame(state.raf);
    function step() {
      state.visualP += (state.targetP - state.visualP) * 0.06;
      bar.style.width = state.visualP.toFixed(1) + "%";
      if (!reducedMotion && frame.dataset.state === "processing" && imgBefore.src) {
        var left = 1 - state.visualP / 100;
        imgBefore.style.filter =
          "blur(" + (22 * left).toFixed(1) + "px)" +
          " brightness(" + (1 + 0.35 * left).toFixed(3) + ")" +
          " saturate(" + (1 - 0.4 * left).toFixed(3) + ")";
      }
      if (state.visualP < 99.8) state.raf = requestAnimationFrame(step);
    }
    state.raf = requestAnimationFrame(step);
  }

  function startPhrases() {
    var i = 0;
    clearInterval(state.phraseTimer);
    clearTimeout(state.patienceTimer);
    state.phraseTimer = setInterval(function () {
      setStatusSoft(PHRASES[i % PHRASES.length]);
      i++;
    }, 9000);
    state.patienceTimer = setTimeout(function () {
      clearInterval(state.phraseTimer); // чтобы ротация не затёрла фразу терпения
      setStatusSoft(PATIENCE);
    }, 62000);
  }

  function setStatus(text) { statusEl.textContent = text; }

  function setStatusSoft(text) {
    if (frame.dataset.state !== "processing") return;
    statusEl.classList.add("swap");
    setTimeout(function () {
      statusEl.textContent = text;
      statusEl.classList.remove("swap");
    }, 450);
  }

  /* ---------- результат ---------- */

  function finish() {
    var before = API.originalURL(state.jobId);
    var after = API.resultURL(state.jobId);
    state.resultUrl = after;

    var b = new Image(), a = new Image();
    var loaded = 0;
    function ready() {
      if (++loaded < 2) return;
      stopWaiting();
      imgBefore.style.filter = "";
      imgBefore.src = before;
      imgAfter.src = after;
      frame.dataset.state = "done";
      divider.hidden = false;
      chips.forEach(function (c) { c.hidden = false; });
      showChips();

      if (state.models[state.modelIdx] === "art") {
        setStatus("Done! This is the illustration look — drag the line to compare");
      } else {
        setStatus("Done! Drag the line — see before and after");
      }

      show(actions);
      hide(progressline);
      scheduleChipFade();

      if (reducedMotion) {
        setSlider(50);
      } else {
        var band = imageBand();
        var span = band[1] - band[0];
        // «после» справа: едем от тонкой полоски справа к середине — результат раскрывается
        sweep(band[0] + 0.85 * span, band[0] + 0.45 * span, 1200);
      }
    }
    b.onload = ready; a.onload = ready;
    b.onerror = a.onerror = function () {
      fail("Couldn’t show the result — but it’s ready, try refreshing");
    };
    b.src = before; a.src = after;
  }

  function stopWaiting() {
    clearTimeout(state.pollTimer);
    clearInterval(state.phraseTimer);
    clearTimeout(state.patienceTimer);
    cancelAnimationFrame(state.raf);
    bar.style.width = "100%";
    releaseWake();
  }

  function fail(message) {
    stopWaiting();
    frame.dataset.state = state.previewUrl ? "processing" : "idle";
    if (state.previewUrl) imgBefore.style.filter = "";
    hide(progressline);
    statusEl.classList.add("error");
    setStatus(message);
    show(statusEl);
    retryBtn.textContent = "Try again";
    retryHint.hidden = true;
    show(actions);
    downloadBtn.parentElement.style.display = "none";
  }

  // Постоянная ошибка: возвращаемся в исходный экран и показываем причину без ретрая.
  function permanentFail(message) {
    resetUI();
    statusEl.classList.add("error");
    setStatus(message);
    show(statusEl);
  }

  function resetUI() {
    stopWaiting();
    frame.dataset.state = "idle";
    stage.hidden = true;
    hide(actions);
    hide(progressline);
    hide(statusEl);
    show(controls);
    statusEl.classList.remove("error");
    imgBefore.removeAttribute("src");
    imgBefore.style.filter = "";
    imgAfter.removeAttribute("src");
    fileInput.value = "";
    if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
    state.blob = null;
    state.jobId = null;
    state.resultUrl = null;
    downloadBtn.parentElement.style.display = "";
    downloadBtn.textContent = DOWNLOAD_LABEL;
    retryBtn.textContent = "Try another look";
  }

  /* ---------- before/after slider ("before" left, "after" right) ---------- */

  // Полоса, реально занятая фото в раме (object-fit: contain): за её краями
  // только нейтральный паддинг — туда ручку не пускаем.
  function imageBand() {
    var nw = imgBefore.naturalWidth, nh = imgBefore.naturalHeight;
    if (!nw || !nh) return [0, 100];
    var frac = Math.min(1, (nw / nh) / (stage.clientWidth / stage.clientHeight));
    var leftPct = (1 - frac) / 2 * 100;
    return [leftPct, 100 - leftPct];
  }

  function setSlider(p) {
    var band = imageBand();
    state.sliderPos = Math.max(band[0], Math.min(band[1], p));
    imgAfter.style.clipPath = "inset(0 0 0 " + state.sliderPos + "%)";
    divider.style.left = state.sliderPos + "%";
  }

  function sweep(from, to, ms) {
    var t0 = performance.now();
    function tick(t) {
      var k = Math.min(1, (t - t0) / ms);
      var e = 1 - Math.pow(1 - k, 3); // ease-out
      setSlider(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  var dragging = false;
  stage.addEventListener("pointerdown", function (e) {
    if (frame.dataset.state !== "done") return;
    dragging = true;
    stage.setPointerCapture(e.pointerId);
    moveSlider(e);
    showChips();
  });
  stage.addEventListener("pointermove", function (e) {
    if (dragging) moveSlider(e);
  });
  ["pointerup", "pointercancel"].forEach(function (ev) {
    stage.addEventListener(ev, function () {
      dragging = false;
      scheduleChipFade();
    });
  });

  function moveSlider(e) {
    var rect = stage.getBoundingClientRect();
    setSlider((e.clientX - rect.left) / rect.width * 100);
  }

  function showChips() {
    clearTimeout(state.chipTimer);
    chips.forEach(function (c) { c.classList.remove("faded"); });
  }

  function scheduleChipFade() {
    clearTimeout(state.chipTimer);
    state.chipTimer = setTimeout(function () {
      chips.forEach(function (c) { c.classList.add("faded"); });
    }, 4000);
  }

  /* ---------- кнопки ---------- */

  document.querySelectorAll(".seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".seg-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.scale = parseInt(btn.dataset.scale, 10);
    });
  });

  downloadBtn.addEventListener("click", function () {
    if (!state.jobId) return;
    downloadBtn.textContent = "One sec…";
    API.downloadResult(state.jobId)
      .then(function (blob) {
        if (!blob) return; // desktop already showed "Save as…"
        var ext = blob.type === "image/png" ? ".png" : ".jpg";
        if (isTouch && navigator.canShare) {
          var file = new File([blob], "upscaled" + ext, { type: blob.type });
          if (navigator.canShare({ files: [file] })) {
            return navigator.share({ files: [file] }).catch(function (e) {
              if (e.name !== "AbortError") plainDownload(blob);
            });
          }
        }
        plainDownload(blob);
      })
      .catch(function () { plainDownload(null); })
      .then(function () {
        downloadBtn.textContent = DOWNLOAD_LABEL;
        if (isTouch && API.mode === "web") downloadHint.hidden = false;
      });
  });

  function plainDownload(blob) {
    var a = document.createElement("a");
    if (blob) {
      a.href = URL.createObjectURL(blob);
      a.download = "upscaled" + (blob.type === "image/png" ? ".png" : ".jpg");
    } else {
      // the server sets the name via Content-Disposition
      a.href = state.resultUrl + "?download=1";
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (blob) setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
  }

  retryBtn.addEventListener("click", function () {
    if (!state.blob) return;
    if (retryBtn.textContent.indexOf("again") === -1) {
      state.modelIdx = (state.modelIdx + 1) % state.models.length;
    }
    retryBtn.textContent = "Try another look";
    retryHint.hidden = state.models.length < 2;
    downloadBtn.parentElement.style.display = "";
    submit();
  });

  resetBtn.addEventListener("click", resetUI);

  /* ---------- не дать экрану погаснуть (где разрешено: HTTPS/localhost) ---------- */

  function keepAwake() {
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        state.wakeLock = lock;
      }).catch(function () {});
    } catch (e) { /* не поддерживается — фото всё равно доделается на сервере */ }
  }

  function releaseWake() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(function () {});
      state.wakeLock = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" &&
        frame.dataset.state === "processing") {
      keepAwake();
    }
  });

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
})();
