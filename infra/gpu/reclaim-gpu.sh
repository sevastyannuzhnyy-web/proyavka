#!/bin/bash
# Вернуть RX 7700/7800 XT (0000:0d:00.x) от vfio-pci хосту (amdgpu) БЕЗ ребута.
# НЕ запускать пока winvm (VM 200) работает. Обратно: release-gpu.sh
set -e
if qm status 200 2>/dev/null | grep -q running; then
  echo "ОШИБКА: winvm запущена. Сначала: qm shutdown 200"; exit 1
fi
GPU=0000:0d:00.0
# ВАЖНО: в /etc/modprobe.d/vfio.conf стоит `options vfio-pci ids=1002:747e,...`,
# поэтому просто очистить override + drivers_probe НЕ работает — vfio перехватит
# карту обратно. Нужно явно форсить driver_override=amdgpu ПЕРЕД bind.
modprobe amdgpu
[ -e /sys/bus/pci/drivers/vfio-pci/$GPU ] && echo $GPU > /sys/bus/pci/drivers/vfio-pci/unbind
echo amdgpu > /sys/bus/pci/devices/$GPU/driver_override
echo $GPU > /sys/bus/pci/drivers/amdgpu/bind
echo > /sys/bus/pci/devices/$GPU/driver_override   # вернуть пустым на будущее
# аудио-функция 0d:00.1 для компьюта не нужна — оставляем на vfio
sleep 3
if [ -e /dev/dri/renderD128 ] && lspci -nnk -s $GPU | grep -q "amdgpu"; then
  echo "OK: GPU у хоста (amdgpu):"; ls -la /dev/dri/
  # непривилегированный CT не видит render-нод без этого:
  chmod 0666 /dev/dri/renderD128 /dev/dri/card0 2>/dev/null || true
  echo "Дальше: добавь в /etc/pve/lxc/105.conf строки из lxc-gpu.conf и pct reboot 105"
else
  echo "ПРОБЛЕМА: amdgpu не привязался. dmesg | tail -20:"; dmesg | tail -20
fi
