"""E2E-прогон UI через Playwright + скриншоты всех состояний.

Запуск: сервер должен крутиться (ENGINE=fake для локалки):
  .venv/bin/python tests/e2e_playwright.py http://127.0.0.1:8077 shots/
"""
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8077"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "shots")
OUT.mkdir(exist_ok=True)


def make_test_photo(path: Path):
    """Маленькое «фото» с деталями, чтобы апскейл было видно."""
    img = Image.new("RGB", (320, 400), (244, 240, 232))
    d = ImageDraw.Draw(img)
    for i in range(0, 320, 16):
        d.line([(i, 0), (i, 400)], fill=(200 - i % 60, 150, 120), width=2)
    d.ellipse([80, 100, 240, 260], fill=(163, 90, 60), outline=(27, 26, 23), width=3)
    d.text((100, 320), "проявка тест", fill=(27, 26, 23))
    img.save(path, "JPEG", quality=88)


def shoot(page, name):
    page.screenshot(path=str(OUT / name), full_page=True)
    print(f"  📸 {name}")


def run(playwright, viewport, tag):
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport=viewport)
    photo = OUT / "_test_photo.jpg"
    make_test_photo(photo)

    print(f"[{tag}] {BASE}")
    page.goto(BASE, wait_until="networkidle")
    shoot(page, f"{tag}-1-idle.png")

    # загрузка файла
    page.set_input_files("#file", str(photo))

    # processing: ждём появления прогресса
    page.wait_for_selector("#progressline:not([hidden])", timeout=10000)
    time.sleep(0.8)
    shoot(page, f"{tag}-2-processing.png")

    # done: слайдер и кнопки
    page.wait_for_selector('#frame[data-state="done"]', timeout=180000)
    page.wait_for_selector("#actions:not([hidden])", timeout=5000)
    time.sleep(1.5)  # авто-проезд слайдера
    shoot(page, f"{tag}-3-done.png")

    # подвигать слайдер
    box = page.locator("#stage").bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.7, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.25, box["y"] + box["height"] / 2, steps=8)
    page.mouse.up()
    shoot(page, f"{tag}-4-slider.png")

    # скачивание
    with page.expect_download(timeout=30000) as dl:
        page.click("#downloadBtn")
    download = dl.value
    size = Path(download.path()).stat().st_size
    assert size > 1000, "скачанный файл подозрительно мал"
    print(f"  ⬇ скачано: {download.suggested_filename} ({size} байт)")

    # попробовать по-другому → снова processing → done
    if page.locator("#retryBtn").is_visible():
        page.click("#retryBtn")
        page.wait_for_selector('#frame[data-state="done"]', timeout=180000)
        shoot(page, f"{tag}-5-retry-done.png")

    # сброс
    page.click("#resetBtn")
    expect(page.locator('#frame[data-state="idle"]')).to_be_visible()
    print(f"  ✓ [{tag}] полный сценарий пройден")
    browser.close()


with sync_playwright() as p:
    run(p, {"width": 1280, "height": 900}, "desktop")
    run(p, {"width": 390, "height": 844}, "mobile")

print("E2E OK")
