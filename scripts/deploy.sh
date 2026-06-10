#!/bin/bash
# Деплой на blueprint-ai (LXC 105). Запускать с Mac: ./scripts/deploy.sh
set -e
HOST=blueprint-ai
DEST=/opt/proyavka

rsync -az --delete \
  --exclude .venv --exclude data --exclude node_modules --exclude .git \
  --exclude 'models/*.pth' --exclude desktop --exclude shots \
  "$(dirname "$0")/.." "$HOST:$DEST/"

ssh "$HOST" "set -e
cd $DEST
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip -q install -r requirements.txt
# torch строго с CPU-индекса, spandrel без deps (иначе притянет CUDA-torch на 10ГБ)
./.venv/bin/pip -q install --index-url https://download.pytorch.org/whl/cpu torch torchvision
./.venv/bin/pip -q install --no-deps spandrel
./.venv/bin/pip -q install safetensors einops numpy typing-extensions
bash scripts/download-models.sh
mkdir -p /var/lib/proyavka
cp infra/proyavka.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now proyavka
systemctl restart proyavka
sleep 2
systemctl is-active proyavka && curl -sf http://localhost:8000/api/meta && echo && echo 'DEPLOY OK'
"
