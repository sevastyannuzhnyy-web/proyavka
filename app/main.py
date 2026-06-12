from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import settings
from .jobs import JobManager

app = FastAPI(title="Photo Enhancer", docs_url=None, redoc_url=None, openapi_url=None)
manager = JobManager()

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.on_event("startup")
def _startup():
    manager.start()


@app.get("/api/meta")
def meta():
    return {
        "engine": manager.engine.name,
        "models": manager.engine.available_models(),
        "maxUploadMb": settings.MAX_UPLOAD_MB,
    }


@app.post("/api/jobs")
async def create_job(photo: UploadFile = File(...),
                     scale: int = Form(2),
                     model: str = Form("photo")):
    if scale not in (2, 4):
        raise HTTPException(400, "Scale must be 2× or 4×")
    if model not in manager.engine.available_models():
        raise HTTPException(400, "That option isn’t available")
    # Max — всегда максимальный размер; держим инвариант на сервере,
    # чтобы он не зависел от клиента (десктоп форсит то же самое)
    if model == "max":
        scale = 4
    # reject a giant body before reading into RAM (Starlette spools to disk, .size is set)
    if photo.size and photo.size > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(400, f"File is larger than {settings.MAX_UPLOAD_MB} MB — send a smaller photo")
    data = await photo.read()
    try:
        # декод/ресайз — синхронный и тяжёлый: уводим из event loop,
        # иначе поллинг и аплоад второго пользователя замирают
        job = await run_in_threadpool(
            manager.submit, data, photo.filename or "photo", scale, model)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"id": job.id}


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = manager.get(jid)
    if job is None:
        raise HTTPException(404, "This job is no longer available — upload the photo again")
    body = {"status": job.status, "progress": job.progress}
    if job.status == "queued":
        body["position"] = manager.queue_position(job)
    if job.status == "error":
        body["error"] = job.error
    if job.status == "done" and job.out_size:
        body["width"], body["height"] = job.out_size
    return body


@app.get("/api/jobs/{jid}/original")
def job_original(jid: str):
    job = manager.get(jid)
    if job is None:
        raise HTTPException(404)
    # лёгкая JPEG-копия для слайдера «до»; input.png — фолбэк для старых джоб
    jpg = manager.job_dir(jid) / "orig.jpg"
    if jpg.exists():
        return FileResponse(jpg, media_type="image/jpeg")
    png = manager.job_dir(jid) / "input.png"
    if not png.exists():
        raise HTTPException(404)
    return FileResponse(png, media_type="image/png")


@app.get("/api/jobs/{jid}/result")
def job_result(jid: str, download: int = 0):
    job = manager.get(jid)
    if job is None or job.status != "done":
        raise HTTPException(404)
    path = manager.result_path(job)
    if not path.exists():
        raise HTTPException(404)
    media = "image/png" if job.out_ext == ".png" else "image/jpeg"
    kwargs = {"media_type": media}
    if download:
        kwargs["filename"] = f"{job.src_name}-proyavka{job.out_ext}"
    return FileResponse(path, **kwargs)


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
