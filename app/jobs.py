from __future__ import annotations

import io
import queue
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps, UnidentifiedImageError

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:  # необязательная зависимость
    pass

from . import settings
from .engines import get_engine
from .engines.base import EngineError

# Жёсткий потолок входа: клиент и так ужимает до 2048px по длинной стороне,
# это страховка от прямых заливок через API.
MAX_INPUT_MP = 4.6


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | processing | done | error
    progress: int = 0
    error: Optional[str] = None
    scale: int = 2
    model: str = "soft"
    created: float = field(default_factory=time.time)
    src_name: str = "photo"
    out_ext: str = ".jpg"
    out_size: Optional[tuple] = None


class JobManager:
    def __init__(self):
        self.jobs = {}
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.engine = get_engine()
        self._started = False

    def start(self):
        if self._started:
            return
        self._started = True
        (settings.DATA_DIR / "jobs").mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._worker, daemon=True).start()
        threading.Thread(target=self._cleaner, daemon=True).start()

    def job_dir(self, jid: str) -> Path:
        return settings.DATA_DIR / "jobs" / jid

    # -- приём файла -----------------------------------------------------

    def submit(self, data: bytes, filename: str, scale: int, model: str) -> Job:
        if len(data) > settings.MAX_UPLOAD_MB * 1024 * 1024:
            raise ValueError(
                f"File is larger than {settings.MAX_UPLOAD_MB} MB — send a smaller photo")
        with self.lock:
            queued = sum(1 for j in self.jobs.values()
                         if j.status in ("queued", "processing"))
        if queued >= settings.QUEUE_MAX:
            raise RuntimeError("Lots of photos in the queue right now — try again in a minute")

        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except (UnidentifiedImageError, OSError):
            raise ValueError("Couldn’t open the file — is it a photo?")

        out_ext = ".png" if img.format == "PNG" else ".jpg"
        img = ImageOps.exif_transpose(img)
        # прозрачность кладём на белый, а не на чёрный (логотипы/стикеры)
        if img.mode != "RGB":
            rgba = img.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.getchannel("A"))
            img = bg

        mp = img.width * img.height / 1e6
        if mp > MAX_INPUT_MP:
            k = (MAX_INPUT_MP / mp) ** 0.5
            img = img.resize((int(img.width * k), int(img.height * k)),
                             Image.LANCZOS)

        jid = uuid.uuid4().hex[:12]
        d = self.job_dir(jid)
        d.mkdir(parents=True)
        img.save(d / "input.png")  # вход для движка
        # лёгкая копия для слайдера «до» (input.png бывает в 8× тяжелее JPEG)
        img.save(d / "orig.jpg", quality=90)

        job = Job(id=jid, scale=scale, model=model,
                  src_name=(Path(filename).stem or "photo")[:60], out_ext=out_ext)
        with self.lock:
            self.jobs[jid] = job
        self.q.put(jid)
        return job

    # -- статус ----------------------------------------------------------

    def get(self, jid: str) -> Optional[Job]:
        with self.lock:
            return self.jobs.get(jid)

    def queue_position(self, job: Job) -> int:
        if job.status != "queued":
            return 0
        with self.lock:
            ahead = sum(1 for j in self.jobs.values()
                        if j.status == "processing"
                        or (j.status == "queued" and j.created < job.created))
        return ahead

    def result_path(self, job: Job) -> Path:
        return self.job_dir(job.id) / ("result" + job.out_ext)

    # -- обработка -------------------------------------------------------

    def _worker(self):
        while True:
            jid = self.q.get()
            job = self.get(jid)
            if job is None:
                continue
            job.status = "processing"
            try:
                dst = self.result_path(job)

                def cb(p, _job=job):
                    _job.progress = max(_job.progress, min(99, int(p)))

                self.engine.upscale(self.job_dir(jid) / "input.png", dst,
                                    scale=job.scale, model=job.model,
                                    progress=cb)
                with Image.open(dst) as im:
                    job.out_size = im.size
                job.progress = 100
                job.status = "done"
            except EngineError as e:
                job.status = "error"
                job.error = str(e)
            except Exception:
                job.status = "error"
                job.error = "Something went wrong. The photo’s fine — just try again"

    def _cleaner(self):
        while True:
            cutoff = time.time() - settings.JOB_TTL_HOURS * 3600
            with self.lock:
                old = [j.id for j in self.jobs.values()
                       if j.created < cutoff and j.status in ("done", "error")]
                for jid in old:
                    self.jobs.pop(jid, None)
            for jid in old:
                shutil.rmtree(self.job_dir(jid), ignore_errors=True)

            # Второй проход: каталоги, осиротевшие после рестарта (dict пуст,
            # а data/jobs/<id>/ остались). Свежий mtime защищает от гонки с submit().
            with self.lock:
                live = set(self.jobs)
            try:
                for d in (settings.DATA_DIR / "jobs").iterdir():
                    try:
                        if d.name not in live and d.stat().st_mtime < cutoff:
                            shutil.rmtree(d, ignore_errors=True)
                    except OSError:
                        continue
            except OSError:
                pass
            time.sleep(600)
