<div align="center">

# Проявка

**Улучшайзер фотографий на нейросети.** Загружаешь фото — получаешь чёткое и живое.

Один экран, минимум кнопок. Веб и десктоп (Windows · macOS).

</div>

---

## Что это

«Проявка» прогоняет фотографию через [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)
и увеличивает её в 2× или 4×, вытягивая детали. Название — метафора проявки плёнки:
фото медленно «проявляется» из размытия, и это же — визуальный язык прогресса.

Сделано как настоящий продукт: единый интерфейс для веба и нативного приложения,
честный прогресс, сравнение «до/после» одним движением пальца.

## Две формы, один интерфейс

| | Веб | Десктоп |
|---|---|---|
| Запуск | открыть ссылку | поставить `.exe` / `.dmg` |
| Движок | Real-ESRGAN на сервере (PyTorch CPU, опц. GPU) | локально, sidecar `realesrgan-ncnn-vulkan` (Vulkan/MoltenVK) |
| Файлы | `app/` (FastAPI) + `static/` | `desktop/` (Tauri) + те же `static/` |

UI (`static/`) общается с бэкендом через адаптер `static/api.js`: в вебе это REST к
FastAPI, в десктопе — `invoke` к Rust. `app.js` не знает, где он запущен.

## Возможности

- Перетащи фото или выбери из галереи → видимый прогресс → слайдер «до/после» → скачать.
- 2× / 4×, переключатель характера обработки («Попробовать по-другому»).
- Клиент сам ужимает фото до 2048px перед отправкой — серверу легче, ждать меньше.
- PNG остаётся PNG, прозрачность не чернеет, EXIF-поворот применяется.
- На телефоне: сохранение через системную шторку, экран не гаснет во время обработки.

## Запуск веб-версии

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# движок:
#   ENGINE=fake  — без нейросети (Lanczos), для разработки UI
#   ENGINE=torch — Real-ESRGAN на CPU (нужен torch + spandrel, см. requirements-ml.txt)
#   ENGINE=auto  — ncnn при наличии GPU (/dev/dri), иначе torch
bash scripts/download-models.sh          # веса (BSD-3)
ENGINE=torch uvicorn app.main:app --port 8000
```

Деплой на сервер (systemd): `scripts/deploy.sh` (см. `infra/proyavka.service`).

## Сборка десктоп-приложения

```bash
cd desktop/src-tauri
bash scripts/fetch-assets.sh aarch64-apple-darwin   # движок + модели под платформу
cargo tauri build                                    # → .app + .dmg (macOS) / .exe (Windows)
```

Кросс-сборку Windows + macOS делает GitHub Actions: `.github/workflows/desktop.yml`
(тег `v*` или ручной запуск → артефакты `.exe` и `.dmg`).

## Тесты

```bash
pytest tests/                                         # API на fake-движке
python tests/e2e_playwright.py http://127.0.0.1:8000 shots/   # e2e + скриншоты
PROYAVKA_SELFTEST=photo.jpg ./Проявка.app/Contents/MacOS/proyavka   # самотест движка десктопа
```

## Лицензии

Весь стек разрешён для коммерческого использования: Real-ESRGAN (BSD-3),
realesrgan-ncnn-vulkan (MIT), FastAPI/Tauri/Pillow/spandrel (MIT/Apache/BSD),
шрифт Spectral (SIL OFL). Сознательно не используются модели с non-commercial
лицензиями (CodeFormer, 4x-UltraSharp и т.п.).

<div align="center"><sub>сделано Севой · с любовью</sub></div>
