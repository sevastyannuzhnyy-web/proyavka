from __future__ import annotations

import os
import time
from pathlib import Path

from PIL import Image

from .base import Engine, ProgressCb


class FakeEngine(Engine):
    """Lanczos-ресайз вместо нейросети — для тестов и разработки UI."""

    name = "fake"

    def available_models(self):
        return ["soft", "detail", "art"]

    def upscale(self, src: Path, dst: Path, *, scale: int, model: str,
                progress: ProgressCb) -> None:
        delay = float(os.environ.get("FAKE_DELAY", "0.5"))
        for p in (10, 40, 70, 90):
            progress(p)
            time.sleep(delay / 4)
        img = Image.open(src)
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
        img.save(dst)
        progress(100)
