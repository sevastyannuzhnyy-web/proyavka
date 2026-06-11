"""E2E for the multi-photo flow + screenshots.

Usage (server must be running, ENGINE=fake for local):
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


def make_photo(path, seed):
    img = Image.new("RGB", (320, 400), (244 - seed * 20, 240, 232))
    d = ImageDraw.Draw(img)
    for i in range(0, 320, 16):
        d.line([(i, 0), (i, 400)], fill=(200 - i % 60, 150, 120), width=2)
    d.ellipse([80, 100, 240, 260], fill=(163, 90 + seed * 30, 60), outline=(27, 26, 23), width=3)
    img.save(path, "JPEG", quality=88)


def shoot(page, name):
    page.screenshot(path=str(OUT / name), full_page=True)
    print(f"  📸 {name}")


def run(playwright, viewport, tag):
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport=viewport)

    photos = []
    for i in range(3):
        p = OUT / f"_test_{i}.jpg"
        make_photo(p, i)
        photos.append(str(p))

    print(f"[{tag}] {BASE}")
    page.goto(BASE, wait_until="networkidle")
    shoot(page, f"{tag}-1-idle.png")

    # choose THREE photos at once
    page.set_input_files("#file", photos)

    # staged grid: 3 thumbnails, primary enabled, says "Enhance 3 photos"
    page.wait_for_selector(".thumb", timeout=10000)
    expect(page.locator(".thumb")).to_have_count(3)
    page.wait_for_function(
        "() => { const b = document.getElementById('primaryBtn');"
        "return b && !b.disabled && /Enhance 3/.test(b.textContent); }",
        timeout=10000)
    shoot(page, f"{tag}-2-staged.png")

    # start
    page.click("#primaryBtn")

    # all three done
    page.wait_for_function(
        "() => document.querySelectorAll('.thumb[data-status=\"done\"]').length === 3",
        timeout=180000)
    page.wait_for_function(
        "() => /Save all/.test(document.getElementById('primaryBtn').textContent)",
        timeout=5000)
    shoot(page, f"{tag}-3-done-grid.png")

    # open first result → overlay slider
    page.locator(".thumb").first.click()
    page.wait_for_selector("#overlay:not([hidden])", timeout=5000)
    time.sleep(1.4)  # auto-sweep
    shoot(page, f"{tag}-4-overlay.png")

    # drag the slider
    box = page.locator("#stage").bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.7, box["y"] + box["height"] / 2, steps=8)
    page.mouse.up()

    # per-photo save
    with page.expect_download(timeout=30000) as dl:
        page.click("#saveBtn")
    assert Path(dl.value.path()).stat().st_size > 1000, "saved file too small"
    print(f"  ⬇ saved: {dl.value.suggested_filename}")

    # close overlay
    page.click("#overlayClose")
    expect(page.locator("#overlay")).to_be_hidden()

    # add one more (re-opens picker) — verify "Add more" present
    expect(page.locator("#addBtn")).to_be_visible()

    print(f"  ✓ [{tag}] multi-photo flow passed")
    browser.close()


with sync_playwright() as p:
    run(p, {"width": 1280, "height": 900}, "desktop")
    run(p, {"width": 390, "height": 844}, "mobile")

print("E2E OK")
