#!/bin/bash
# Отдать GPU обратно под winvm (вернуть на vfio-pci).
# ВАЖНО: сначала останови всё, что использует /dev/dri (упскейлер в CT 105: pct exec 105 -- systemctl stop <сервис>; убери lxc-строки из 105.conf + pct reboot 105)
set -e
GPU=0000:0d:00.0
AUDIO=0000:0d:00.1
fuser -v /dev/dri/* 2>/dev/null && { echo "ОШИБКА: /dev/dri занят (см. выше)"; exit 1; }
echo $AUDIO > /sys/bus/pci/drivers/snd_hda_intel/unbind 2>/dev/null || true
echo $GPU > /sys/bus/pci/drivers/amdgpu/unbind
for dev in $GPU $AUDIO; do
  echo vfio-pci > /sys/bus/pci/devices/$dev/driver_override
  echo $dev > /sys/bus/pci/drivers_probe
done
echo "OK: GPU на vfio-pci, winvm можно запускать (qm start 200)"
echo "Редкий случай: если amdgpu unbind завис — поможет только ребут хоста."
