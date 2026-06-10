#!/bin/bash
# Скачивает веса моделей (официальные релизы xinntao/Real-ESRGAN, BSD-3).
set -e
cd "$(dirname "$0")/../models"

fetch() {
  local url="$1" out="$2"
  if [ -s "$out" ] && [ "$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out")" -gt 100000 ]; then
    echo "✓ $out уже есть"; return
  fi
  echo "↓ $out"
  curl -fL --retry 3 -o "$out" "$url"
}

fetch https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth realesr-general-x4v3.pth
fetch https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth RealESRGAN_x4plus.pth
fetch https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth RealESRGAN_x4plus_anime_6B.pth
echo "Готово."
