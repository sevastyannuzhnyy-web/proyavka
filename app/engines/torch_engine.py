from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from PIL import Image

from .. import settings
from .base import Engine, EngineError, ProgressCb

# ключ модели -> (файл весов, размер тайла на CPU)
# photo — компактная realesr-general-x4v3: быстрая, мягкая, дефолт для CPU
# max   — RRDB x4plus: медленная, максимум деталей (на CPU прячется). NB: на
#         ncnn/GPU max = x4plus + TTA, а здесь TTA нет — просто более тяжёлая модель
# art   — x4plus-anime: для рисунков/иллюстраций
MODEL_FILES = {
    "photo": ("realesr-general-x4v3.pth", 512),
    "max": ("RealESRGAN_x4plus.pth", 192),
    "art": ("RealESRGAN_x4plus_anime_6B.pth", 256),
}
OVERLAP = 16


class TorchEngine(Engine):
    name = "torch"

    def __init__(self):
        import torch
        self.torch = torch
        threads = settings.TORCH_THREADS or (os.cpu_count() or 2)
        torch.set_num_threads(threads)
        self._cache = {}

    def available_models(self):
        return [k for k, (f, _) in MODEL_FILES.items()
                if k not in settings.MODELS_DISABLE
                and (settings.MODELS_DIR / f).exists()]

    def _net(self, key: str):
        if key not in self._cache:
            from spandrel import ModelLoader
            try:
                fname, tile = MODEL_FILES[key]
            except KeyError:
                raise EngineError("That option isn’t available")
            path = settings.MODELS_DIR / fname
            if not path.exists():
                raise EngineError("This option isn’t installed on the server yet")
            desc = ModelLoader().load_from_file(str(path))
            desc.model.eval()
            self._cache[key] = (desc.model, desc.scale, tile)
        return self._cache[key]

    def upscale(self, src: Path, dst: Path, *, scale: int, model: str,
                progress: ProgressCb) -> None:
        torch = self.torch
        net, net_scale, tile = self._net(model)
        img = Image.open(src).convert("RGB")
        w, h = img.size
        arr = np.asarray(img, dtype=np.float32) / 255.0
        x = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)

        s = net_scale
        out = torch.zeros((1, 3, h * s, w * s))
        xs = list(range(0, w, tile))
        ys = list(range(0, h, tile))
        total = len(xs) * len(ys)
        done = 0
        with torch.inference_mode():
            for y0 in ys:
                for x0 in xs:
                    x1, y1 = min(x0 + tile, w), min(y0 + tile, h)
                    # тайл с запасом по краям, чтобы не было швов
                    cx0, cy0 = max(0, x0 - OVERLAP), max(0, y0 - OVERLAP)
                    cx1, cy1 = min(w, x1 + OVERLAP), min(h, y1 + OVERLAP)
                    sr = net(x[:, :, cy0:cy1, cx0:cx1])
                    out[:, :, y0 * s:y1 * s, x0 * s:x1 * s] = sr[
                        :, :,
                        (y0 - cy0) * s:(y1 - cy0) * s,
                        (x0 - cx0) * s:(x1 - cx0) * s,
                    ]
                    done += 1
                    progress(int(done / total * 95))

        res = out.squeeze(0).permute(1, 2, 0).clamp_(0, 1).mul_(255).round_()
        result = Image.fromarray(res.byte().numpy())
        if scale != s:
            result = result.resize((w * scale, h * scale), Image.LANCZOS)
        if dst.suffix.lower() in (".jpg", ".jpeg"):
            result.save(dst, quality=95)
        else:
            result.save(dst)
        progress(100)
