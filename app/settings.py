import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# auto | fake | torch | ncnn
ENGINE = os.environ.get("ENGINE", "auto")

DATA_DIR = Path(os.environ.get("DATA_DIR", str(BASE_DIR / "data")))
MODELS_DIR = Path(os.environ.get("MODELS_DIR", str(BASE_DIR / "models")))
NCNN_BIN = os.environ.get("NCNN_BIN", str(BASE_DIR / "bin" / "realesrgan-ncnn-vulkan"))
NCNN_MODELS_DIR = os.environ.get("NCNN_MODELS_DIR", str(BASE_DIR / "bin" / "models"))

PORT = int(os.environ.get("PORT", "8000"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "30"))
# Бюджет на размер результата: вход даунскейлится так, чтобы выход не превысил.
MAX_OUTPUT_MP = float(os.environ.get("MAX_OUTPUT_MP", "64"))
QUEUE_MAX = int(os.environ.get("QUEUE_MAX", "6"))
JOB_TTL_HOURS = float(os.environ.get("JOB_TTL_HOURS", "24"))
TORCH_THREADS = int(os.environ.get("TORCH_THREADS", "0"))  # 0 = все ядра
