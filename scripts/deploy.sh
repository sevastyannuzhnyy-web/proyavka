#!/bin/bash
# Деплой на blueprint-ai (LXC 105). Запускать с Mac: ./scripts/deploy.sh
set -e
HOST=blueprint-ai
DEST=/opt/proyavka

cd "$(dirname "$0")/.."
# --exclude bin: ncnn-движок (Vulkan/GPU) ставится на сервере, его НЕТ в дереве —
# без исключения rsync --delete снёс бы его и сервис откатился бы на CPU
rsync -az --delete \
  --exclude .venv --exclude data --exclude node_modules --exclude .git \
  --exclude 'models/*.pth' --exclude bin --exclude desktop --exclude shots \
  ./ "$HOST:$DEST/"

ssh "$HOST" "set -e
cd $DEST
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip -q install -r requirements.txt
# torch строго с CPU-индекса, spandrel без deps (иначе притянет CUDA-torch на 10ГБ)
./.venv/bin/pip -q install --index-url https://download.pytorch.org/whl/cpu torch torchvision
./.venv/bin/pip -q install --no-deps spandrel
./.venv/bin/pip -q install safetensors einops numpy typing-extensions
bash scripts/download-models.sh
# ncnn-движок (Vulkan) — ставим, если на сервере есть GPU (/dev/dri) и его ещё нет
if [ -d /dev/dri ] && [ ! -x bin/realesrgan-ncnn-vulkan ]; then
  echo 'Ставлю ncnn/Vulkan движок (есть GPU)...'
  mkdir -p bin/models && cd /tmp
  curl -sL -o re.zip https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
  python3 -c 'import zipfile; zipfile.ZipFile(\"re.zip\").extractall(\"re\")'
  cp /tmp/re/realesrgan-ncnn-vulkan $DEST/bin/ && chmod +x $DEST/bin/realesrgan-ncnn-vulkan
  cp /tmp/re/models/realesrgan-x4plus.* /tmp/re/models/realesrgan-x4plus-anime.* $DEST/bin/models/
  rm -rf /tmp/re /tmp/re.zip; cd $DEST
  apt-get install -y -qq mesa-vulkan-drivers libvulkan1 >/dev/null 2>&1 || true
fi
mkdir -p /var/lib/proyavka
cp infra/proyavka.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now proyavka
systemctl restart proyavka
sleep 2
systemctl is-active proyavka && curl -sf http://localhost:8000/api/meta && echo && echo 'DEPLOY OK'
"
