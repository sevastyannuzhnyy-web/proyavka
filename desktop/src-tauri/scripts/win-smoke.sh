#!/usr/bin/env bash
# Дымовой тест движка на Windows БЕЗ железной видеокарты: ставим софтверный
# Vulkan (Mesa lavapipe) и реально прогоняем realesrgan-ncnn-vulkan.exe.
# Доказывает, что движок запускается и считает на Windows. Запускается в CI.
set -e
TRIPLE="${1:?нужен triple}"
cd "$(dirname "$0")/.."   # src-tauri
BIN="binaries/realesrgan-ncnn-vulkan-$TRIPLE.exe"
PY="$(command -v python || command -v python3)"

echo "::group::Ставим софтверный Vulkan (Mesa lavapipe)"
url=$(curl -s "https://api.github.com/repos/pal1000/mesa-dist-win/releases/latest" \
  | "$PY" -c "import json,sys;[print(a['browser_download_url']) for a in json.load(sys.stdin)['assets'] if a['name'].endswith('release-msvc.7z')]" | head -1)
echo "mesa: $url"
curl -fL --retry 3 -o mesa.7z "$url"
7z x -y mesa.7z -omesa >/dev/null
ICD="$(find mesa -name 'lvp_icd.x86_64.json' | head -1)"
ICDDIR="$(cd "$(dirname "$ICD")" && pwd -W 2>/dev/null || cd "$(dirname "$ICD")" && pwd)"
export VK_ICD_FILENAMES="$(pwd)/$ICD"
# каталог с vulkan_lvp.dll — в PATH, иначе его зависимые DLL не загрузятся (-9)
export PATH="$ICDDIR:$PATH"
echo "ICD: $VK_ICD_FILENAMES"; echo "ICDDIR: $ICDDIR"
echo "::endgroup::"

echo "::group::Тестовое фото + прогон движка"
"$PY" -m pip install --quiet pillow
"$PY" -c "from PIL import Image; Image.new('RGB',(256,256),(150,100,80)).save('t.png')"
./"$BIN" -i t.png -o out.png -n realesrgan-x4plus -s 4 -m resources/models 2>&1 | tail -6
echo "::endgroup::"

if [ -f out.png ]; then
  echo "WIN-SMOKE OK: движок выдал результат на Windows (софтверный Vulkan)"
else
  echo "WIN-SMOKE FAIL: out.png не создан"; exit 1
fi
