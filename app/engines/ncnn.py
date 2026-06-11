from __future__ import annotations

import re
import subprocess
import threading
from pathlib import Path

from PIL import Image

from .. import settings
from .base import Engine, EngineError, ProgressCb

# Бинарник realesrgan-ncnn-vulkan: быстрый путь, когда есть GPU (/dev/dri).
# В комплекте бинарника нет general-x4v3, поэтому soft на GPU = x4plus
# (на GPU он и так быстрый).
MODEL_MAP = {
    "soft": "realesrgan-x4plus",
    "detail": "realesrgan-x4plus",
    "art": "realesrgan-x4plus-anime",
}
PERCENT_RE = re.compile(r"(\d{1,3})[.,]\d+%")


class NcnnEngine(Engine):
    name = "ncnn"

    @staticmethod
    def usable() -> bool:
        return Path(settings.NCNN_BIN).exists() and Path("/dev/dri").exists()

    def available_models(self):
        have = {p.stem for p in Path(settings.NCNN_MODELS_DIR).glob("*.param")}
        return [k for k, v in MODEL_MAP.items() if v in have]

    def upscale(self, src: Path, dst: Path, *, scale: int, model: str,
                progress: ProgressCb) -> None:
        name = MODEL_MAP.get(model)
        if not name:
            raise EngineError("That option isn’t available")
        tmp = dst.with_suffix(".ncnn.png")
        cmd = [
            settings.NCNN_BIN,
            "-i", str(src), "-o", str(tmp),
            "-n", name, "-s", "4",
            "-m", settings.NCNN_MODELS_DIR,
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, text=True)

        # читаем прогресс в отдельном потоке, а в основном ждём с таймаутом —
        # иначе зависший GPU-процесс заблокировал бы единственный worker навсегда
        def pump():
            for line in proc.stderr:
                m = PERCENT_RE.search(line)
                if m:
                    progress(min(95, int(m.group(1))))

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            try:
                proc.wait(timeout=600)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                raise EngineError("Processing failed — please try again")
            if proc.returncode != 0 or not tmp.exists():
                raise EngineError("Processing failed — please try again")

            result = Image.open(tmp)
            if scale != 4:
                result = result.resize(
                    (result.width * scale // 4, result.height * scale // 4),
                    Image.LANCZOS)
            if dst.suffix.lower() in (".jpg", ".jpeg"):
                result = result.convert("RGB")
                result.save(dst, quality=95)
            else:
                result.save(dst)
        finally:
            tmp.unlink(missing_ok=True)
        progress(100)
