#!/usr/bin/env bash
# Качает платформенный бинарник realesrgan-ncnn-vulkan (MIT) + веса моделей
# (BSD-3) и раскладывает под Tauri-сборку. Вызывается локально и в CI.
#   fetch-assets.sh aarch64-apple-darwin | x86_64-pc-windows-msvc | x86_64-unknown-linux-gnu
set -e
TRIPLE="${1:?нужен rust target triple}"
cd "$(dirname "$0")/.."   # src-tauri
mkdir -p binaries resources/models
BASE=https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0

case "$TRIPLE" in
  *windows*) ZIP=realesrgan-ncnn-vulkan-20220424-windows.zip; BIN=realesrgan-ncnn-vulkan.exe; OUT="binaries/realesrgan-ncnn-vulkan-$TRIPLE.exe" ;;
  *darwin*)  ZIP=realesrgan-ncnn-vulkan-20220424-macos.zip;   BIN=realesrgan-ncnn-vulkan;     OUT="binaries/realesrgan-ncnn-vulkan-$TRIPLE" ;;
  *linux*)   ZIP=realesrgan-ncnn-vulkan-20220424-ubuntu.zip;  BIN=realesrgan-ncnn-vulkan;     OUT="binaries/realesrgan-ncnn-vulkan-$TRIPLE" ;;
  *) echo "неизвестный triple: $TRIPLE"; exit 1 ;;
esac

tmp="$(mktemp -d)"
curl -fL --retry 3 -o "$tmp/re.zip" "$BASE/$ZIP"
python3 -c "import zipfile; zipfile.ZipFile('$tmp/re.zip').extractall('$tmp/re')"
cp "$tmp/re/$BIN" "$OUT"
chmod +x "$OUT" 2>/dev/null || true
cp "$tmp/re/models/realesrgan-x4plus."* "$tmp/re/models/realesrgan-x4plus-anime."* resources/models/
rm -rf "$tmp"
echo "✓ assets для $TRIPLE → $OUT + resources/models/"
