#!/usr/bin/env bash
# Реальный прогон вшитого Windows-движка на софтверном Vulkan (lavapipe).
# Доказывает, что x64-бинарь + модели реально СЧИТАЮТ на любой x64-Windows —
# даже на GPU-less GitHub-раннере (нет видеокарты → берём lavapipe).
# Запускается в CI (shell: bash → git-bash на windows-latest).
set -euo pipefail
cd "$(dirname "$0")/.."   # desktop/src-tauri

EXE="binaries/realesrgan-ncnn-vulkan-x86_64-pc-windows-msvc.exe"
MODELS="resources/models"
MESA_VER=26.1.1
[ -f "$EXE" ] || { echo "нет бинаря: $EXE"; ls -la binaries || true; exit 1; }

work="_smoke"; rm -rf "$work"; mkdir -p "$work/vk"

echo "↓ lavapipe (mesa $MESA_VER, софтверный Vulkan)"
curl -fsSL --retry 3 -o "$work/mesa.7z" \
  "https://github.com/pal1000/mesa-dist-win/releases/download/$MESA_VER/mesa3d-$MESA_VER-release-msvc.7z"
7z x -y -o"$work/mesa" "$work/mesa.7z" >/dev/null
# ICD-манифест ссылается на vulkan_lvp.dll относительно себя → кладём рядом
cp "$work/mesa/x64/vulkan_lvp.dll" "$work/mesa/x64/lvp_icd.x86_64.json" "$work/vk/"

echo "↓ vulkan loader (LunarG runtime)"
curl -fsSL --retry 3 -o "$work/vkrt.zip" \
  "https://sdk.lunarg.com/sdk/download/latest/windows/vulkan-runtime-components.zip"
7z x -y -o"$work/vkrt" "$work/vkrt.zip" >/dev/null
LOADER="$(find "$work/vkrt" -ipath '*/x64/vulkan-1.dll' | head -1)"
[ -n "$LOADER" ] || { echo "не нашёл vulkan-1.dll в рантайме"; exit 1; }
# рядом с exe — Windows ищет DLL в каталоге приложения
cp "$LOADER" "$(dirname "$EXE")/vulkan-1.dll"

echo "make test image"
python -m pip install --quiet pillow   # упадёт громко, если pip недоступен — так и надо
python - <<'PY'
from PIL import Image
Image.new("RGB", (64, 64), (120, 80, 60)).save("_smoke/in.png")
PY

ICD="$(cygpath -w "$PWD/$work/vk/lvp_icd.x86_64.json")"
echo "VK_ICD_FILENAMES=$ICD"
echo "=== реальный апскейл на софтверном Vulkan ==="
VK_ICD_FILENAMES="$ICD" VK_DRIVER_FILES="$ICD" \
  "./$EXE" -i "_smoke/in.png" -o "_smoke/out.png" \
  -n realesrgan-x4plus -s 4 -m "$MODELS" -g 0 2>&1 | tail -3 || true

python - <<'PY'
import os
from PIL import Image
p = "_smoke/out.png"
assert os.path.exists(p), "движок НЕ создал результат — софт-Vulkan не поднялся"
w, h = Image.open(p).size
print("OUT", w, h)
assert (w, h) == (256, 256), f"ожидали 256x256, получили {w}x{h}"
print("SMOKE OK: вшитый x64-движок реально посчитал апскейл на Windows")
PY
