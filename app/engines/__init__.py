from __future__ import annotations

from .. import settings
from .base import Engine


def get_engine() -> Engine:
    if settings.ENGINE == "fake":
        from .fake import FakeEngine
        return FakeEngine()
    if settings.ENGINE == "ncnn":
        from .ncnn import NcnnEngine
        return NcnnEngine()
    if settings.ENGINE == "torch":
        from .torch_engine import TorchEngine
        return TorchEngine()
    # auto: ncnn при живом GPU, иначе torch на CPU
    from .ncnn import NcnnEngine
    if NcnnEngine.usable():
        return NcnnEngine()
    from .torch_engine import TorchEngine
    return TorchEngine()
