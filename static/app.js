/* Проявка — логика одной страницы. Без зависимостей. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var frame = $("frame"), stage = $("stage"), dropzone = $("dropzone");
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

  var PHRASES = [
    "Вглядываюсь в детали…",
    "Дорисовываю свет и тени…",
    "Навожу резкость…",
    "Разглаживаю шероховатости…",
    "Последние штрихи…"
  ];
  var PATIENCE = "Большие фото проявляются чуть дольше — ещё минутку…";

  var state = {
    scale: 2,
    models: ["soft"],
    modelIdx: 0,
    blob: null,          // что отправляем (ужатое или оригинал)
    previewUrl: null,
    jobId: null,
    pollTimer: null,
    phraseTimer: null,
    patienceTimer: null,
    startedAt: 0,
    visualP: 0,          // плавный прогресс 0..100
    targetP: 0,
    raf: 0,
    wakeLock: null,
    sliderPos: 50,
    chipTimer: null,
    resultUrl: null
  };

  fetch("/api/meta").then(function (r) { return r.json(); }).then(function (m) {
    if (m.models && m.models.length) state.models = m.models;
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
    setStatus("Готовлю фото…");
    show(statusEl);
    shrink(file).then(function (blob) {
      state.blob = blob || file;
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = URL.createObjectURL(state.blob);
      state.modelIdx = 0;
      submit();
    });
  }

  /* Ужимаем до 2048px по длинной стороне (JPEG 0.9) — CPU-серверу легче,
     а итог для глаза тот же. Если браузер не смог раскодировать (HEIC на
     десктопе) — отправляем оригинал, сервер разберётся. */
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
        var k = needResize ? 2048 / long : 1;
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w * k);
        canvas.height = Math.round(h * k);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          resolve(blob);
        }, "image/jpeg", 0.9);
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
    var fd = new FormData();
    var name = (fileInput.files[0] && fileInput.files[0].name) || "photo.jpg";
    fd.append("photo", state.blob, state.blob.type === "image/jpeg" ? name.replace(/\.\w+$/, ".jpg") : name);
    fd.append("scale", state.scale);
    fd.append("model", state.models[state.modelIdx]);

    setProcessingUI();

    fetch("/api/jobs", { method: "POST", body: fd })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.detail || "Не получилось отправить фото");
          return body;
        });
      })
      .then(function (body) {
        state.jobId = body.id;
        poll();
      })
      .catch(function (e) { fail(e.message); });
  }

  function setProcessingUI() {
    frame.dataset.state = "processing";
    stage.hidden = false;
    divider.hidden = true;
    chips.forEach(function (c) { c.hidden = true; });
    imgAfter.removeAttribute("src");
    if (state.previewUrl) {
      imgBefore.src = state.previewUrl;
    }
    hide(controls);
    hide(actions);
    downloadHint.hidden = true;
    show(progressline);
    show(statusEl);
    statusEl.classList.remove("error");
    setStatus("Проявляю… магия занимает минутку-другую, не закрывай страницу");

    state.startedAt = Date.now();
    state.visualP = 0;
    state.targetP = 6;
    startRaf();
    startPhrases();
    keepAwake();
  }

  function poll() {
    state.pollTimer = setTimeout(function () {
      fetch("/api/jobs/" + state.jobId)
        .then(function (r) {
          return r.json().then(function (b) {
            if (!r.ok) throw new Error(b.detail || "Связь прервалась — попробуй ещё раз");
            return b;
          });
        })
        .then(function (b) {
          if (b.status === "done") {
            state.targetP = 100;
            finish();
          } else if (b.status === "error") {
            fail(b.error || "Ой, что-то заело. Фото целое — просто попробуй ещё раз");
          } else {
            if (b.status === "queued" && b.position > 0) {
              setStatus("Перед твоим фото в очереди ещё " + b.position + " — скоро начну…");
            }
            state.targetP = 8 + (b.progress || 0) * 0.9;
            poll();
          }
        })
        .catch(function () { poll(); /* сеть мигнула — пробуем дальше */ });
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
    var before = "/api/jobs/" + state.jobId + "/original";
    var after = "/api/jobs/" + state.jobId + "/result";
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
      scheduleChipFade();
      setStatus("Готово! Потяни линию — посмотри, как было и как стало");
      show(actions);
      hide(progressline);
      if (reducedMotion) {
        setSlider(50);
      } else {
        sweep(15, 55, 1200);
      }
    }
    b.onload = ready; a.onload = ready;
    b.onerror = a.onerror = function () { fail("Не получилось показать результат — но он готов, попробуй обновить страницу"); };
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
    retryBtn.textContent = "Попробовать ещё раз";
    retryHint.hidden = true;
    show(actions);
    downloadBtn.parentElement.style.display = "none";
  }

  /* ---------- слайдер до/после ---------- */

  function setSlider(p) {
    state.sliderPos = Math.max(0, Math.min(100, p));
    imgAfter.style.clipPath = "inset(0 " + (100 - state.sliderPos) + "% 0 0)";
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
    if (!state.resultUrl) return;
    downloadBtn.textContent = "Секунду…";
    fetch(state.resultUrl + "?download=1")
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        var file = new File([blob], "проявка.jpg", { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file] }).catch(function (e) {
            if (e.name !== "AbortError") plainDownload(blob);
          });
        }
        plainDownload(blob);
      })
      .catch(function () { plainDownload(null); })
      .then(function () {
        downloadBtn.textContent = "Скачать в полном размере";
        if ("ontouchstart" in window) downloadHint.hidden = false;
      });
  });

  function plainDownload(blob) {
    var a = document.createElement("a");
    a.href = blob ? URL.createObjectURL(blob) : state.resultUrl + "?download=1";
    a.download = "проявка.jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (blob) setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
  }

  retryBtn.addEventListener("click", function () {
    if (!state.blob) return;
    if (retryBtn.textContent.indexOf("ещё раз") === -1) {
      state.modelIdx = (state.modelIdx + 1) % state.models.length;
    }
    retryBtn.textContent = "Попробовать по-другому";
    retryHint.hidden = state.models.length < 2;
    downloadBtn.parentElement.style.display = "";
    submit();
  });

  resetBtn.addEventListener("click", function () {
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
    retryBtn.textContent = "Попробовать по-другому";
  });

  /* ---------- не дать экрану погаснуть ---------- */

  function keepAwake() {
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        state.wakeLock = lock;
      }).catch(function () {});
    } catch (e) { /* не поддерживается — не страшно */ }
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
