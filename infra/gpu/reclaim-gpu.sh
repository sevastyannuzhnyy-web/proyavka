#!/bin/bash
# Вернуть RX 7700/7800 XT (0000:0d:00.x) от vfio-pci хосту (amdgpu) БЕЗ ребута.
# НЕ запускать пока winvm (VM 200) работает. Обратно: release-gpu.sh
set -e
if qm status 200 2>/dev/null | grep -q running; then
  echo "ОШИБКА: winvm запущена. Сначала: qm shutdown 200"; exit 1
fi
GPU=0000:0d:00.0
AUDIO=0000:0d:00.1
for dev in $GPU $AUDIO; do
  [ -e /sys/bus/pci/drivers/vfio-pci/$dev ] && echo $dev > /sys/bus/pci/drivers/vfio-pci/unbind
  echo > /sys/bus/pci/devices/$dev/driver_override
done
modprobe amdgpu
echo $GPU > /sys/bus/pci/drivers_probe
echo $AUDIO > /sys/bus/pci/drivers_probe
sleep 3
if [ -d /dev/dri ]; then
  echo "OK: GPU у хоста:"; ls -la /dev/dri/
  echo "Дальше: добавь в /etc/pve/lxc/105.conf строки из lxc-gpu.conf и pct reboot 105"
else
  echo "ПРОБЛЕМА: /dev/dri не появился. dmesg | tail -20:"; dmesg | tail -20
fi
