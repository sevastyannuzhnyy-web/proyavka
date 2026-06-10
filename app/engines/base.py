from __future__ import annotations

from pathlib import Path
from typing import Callable, List

ProgressCb = Callable[[int], None]


class EngineError(Exception):
    """Ошибка обработки с текстом, который можно показать пользователю."""


class Engine:
    name = "base"

    def available_models(self) -> List[str]:
        raise NotImplementedError

    def upscale(self, src: Path, dst: Path, *, scale: int, model: str,
                progress: ProgressCb) -> None:
        """Читает src (RGB png), пишет результат в dst (png). scale: 2 или 4."""
        raise NotImplementedError
