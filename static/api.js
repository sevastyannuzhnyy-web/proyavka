/* Адаптер бэкенда: один и тот же UI работает как веб (REST к FastAPI)
   и как десктоп-приложение Tauri (invoke к Rust + локальный движок).
   app.js не знает, где он запущен — общается только через window.Proyavka. */
(function () {
  "use strict";

  var isTauri = !!(window.__TAURI__ && window.__TAURI__.core);

  /* ---------- ВЕБ: тонкие обёртки над fetch ---------- */
  var web = {
    mode: "web",
    meta: function () {
      return fetch("/api/meta").then(function (r) { return r.json(); });
    },
    createJob: function (blob, filename, scale, model) {
      var fd = new FormData();
      fd.append("photo", blob, filename);
      fd.append("scale", scale);
      fd.append("model", model);
      return fetch("/api/jobs", { method: "POST", body: fd }).then(jsonOrThrow);
    },
    getJob: function (id) {
      return fetch("/api/jobs/" + id).then(jsonOrThrow);
    },
    originalURL: function (id) { return "/api/jobs/" + id + "/original"; },
    resultURL: function (id) { return "/api/jobs/" + id + "/result"; },
    downloadResult: function (id) {
      return fetch("/api/jobs/" + id + "/result?download=1")
        .then(function (r) { return r.blob(); });
    }
  };

  function jsonOrThrow(r) {
    return r.json().catch(function () { return {}; }).then(function (body) {
      if (!r.ok) {
        var friendly = typeof body.detail === "string"; // FastAPI 422 даёт массив
        var err = new Error(friendly ? body.detail : "Что-то пошло не так");
        err.status = r.status;
        err.friendly = friendly;
        throw err;
      }
      return body;
    });
  }

  /* ---------- ДЕСКТОП: invoke к Rust-командам ---------- */
  var tauri = (function () {
    if (!isTauri) return null;
    var invoke = window.__TAURI__.core.invoke;

    function bytesOf(blob) {
      return blob.arrayBuffer().then(function (buf) {
        return Array.from(new Uint8Array(buf));
      });
    }
    function blobURL(arr, type) {
      return URL.createObjectURL(new Blob([new Uint8Array(arr)], { type: type }));
    }

    return {
      mode: "desktop",
      meta: function () { return invoke("meta"); },
      createJob: function (blob, filename, scale, model) {
        return bytesOf(blob).then(function (bytes) {
          return invoke("create_job", {
            bytes: bytes, filename: filename,
            scale: scale, model: model
          }).then(function (id) { return { id: id }; });
        });
      },
      getJob: function (id) {
        return invoke("job_status", { id: id }).then(function (s) {
          if (s.status === "done" && !tauri._urls[id]) {
            var png = s.resultPath && /\.png$/i.test(s.resultPath);
            return Promise.all([
              invoke("read_image", { id: id, which: "original" }),
              invoke("read_image", { id: id, which: "result" })
            ]).then(function (pair) {
              tauri._urls[id] = {
                original: blobURL(pair[0], "image/png"),
                result: blobURL(pair[1], png ? "image/png" : "image/jpeg")
              };
              return s;
            });
          }
          return s;
        });
      },
      originalURL: function (id) { return tauri._urls[id].original; },
      resultURL: function (id) { return tauri._urls[id].result; },
      downloadResult: function (id) {
        // на десктопе «скачать» = «Сохранить как…» через системный диалог
        return invoke("save_result", { id: id }).then(function () {
          return null; // app.js поймёт, что blob не нужен
        });
      },
      saveAll: function (ids) {
        // десктоп: выбрать папку и сложить все результаты туда
        return invoke("save_all", { ids: ids });
      },
      _urls: {}
    };
  })();

  window.Proyavka = tauri || web;
})();
