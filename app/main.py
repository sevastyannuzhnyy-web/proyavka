from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import settings
from .jobs import JobManager

app = FastAPI(title="Проявка", docs_url=None, redoc_url=None, openapi_url=None)
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
                     model: str = Form("soft")):
    if scale not in (2, 4):
        raise HTTPException(400, "Увеличение бывает 2× или 4×")
    if model not in manager.engine.available_models():
        raise HTTPException(400, "Такой обработки нет")
    data = await photo.read()
    try:
        job = manager.submit(data, photo.filename or "photo", scale, model)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(429, str(e))
    return {"id": job.id}


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = manager.get(jid)
    if job is None:
        raise HTTPException(404, "Эта проявка уже убрана с полки — загрузи фото заново")
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
    path = manager.job_dir(jid) / "input.png"
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")


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
