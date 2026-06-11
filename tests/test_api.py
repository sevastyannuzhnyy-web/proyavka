import io
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app, manager


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def make_photo(w=120, h=90, fmt="JPEG"):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (180, 120, 90)).save(buf, fmt)
    buf.seek(0)
    return buf


def wait_done(client, jid, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/jobs/{jid}").json()
        if body["status"] in ("done", "error"):
            return body
        time.sleep(0.05)
    raise AssertionError("job не завершился за отведённое время")


def test_happy_path(client):
    r = client.post("/api/jobs",
                    files={"photo": ("cat.jpg", make_photo(), "image/jpeg")},
                    data={"scale": 2, "model": "soft"})
    assert r.status_code == 200, r.text
    jid = r.json()["id"]

    body = wait_done(client, jid)
    assert body["status"] == "done"
    assert body["progress"] == 100
    assert body["width"] == 240 and body["height"] == 180

    res = client.get(f"/api/jobs/{jid}/result")
    assert res.status_code == 200
    out = Image.open(io.BytesIO(res.content))
    assert out.size == (240, 180)

    orig = client.get(f"/api/jobs/{jid}/original")
    assert orig.status_code == 200

    dl = client.get(f"/api/jobs/{jid}/result?download=1")
    assert "attachment" in dl.headers["content-disposition"]


def test_png_stays_png(client):
    r = client.post("/api/jobs",
                    files={"photo": ("pic.png", make_photo(fmt="PNG"), "image/png")},
                    data={"scale": 2, "model": "soft"})
    jid = r.json()["id"]
    body = wait_done(client, jid)
    assert body["status"] == "done"
    res = client.get(f"/api/jobs/{jid}/result")
    assert res.headers["content-type"] == "image/png"


def test_scale_4(client):
    r = client.post("/api/jobs",
                    files={"photo": ("cat.jpg", make_photo(50, 40), "image/jpeg")},
                    data={"scale": 4, "model": "soft"})
    body = wait_done(client, r.json()["id"])
    assert body["width"] == 200 and body["height"] == 160


def test_rejects_garbage(client):
    r = client.post("/api/jobs",
                    files={"photo": ("x.jpg", io.BytesIO(b"not a photo"), "image/jpeg")},
                    data={"scale": 2, "model": "soft"})
    assert r.status_code == 400
    assert "photo" in r.json()["detail"]


def test_rejects_bad_scale(client):
    r = client.post("/api/jobs",
                    files={"photo": ("cat.jpg", make_photo(), "image/jpeg")},
                    data={"scale": 3, "model": "soft"})
    assert r.status_code == 400


def test_rejects_unknown_model(client):
    r = client.post("/api/jobs",
                    files={"photo": ("cat.jpg", make_photo(), "image/jpeg")},
                    data={"scale": 2, "model": "nope"})
    assert r.status_code == 400


def test_unknown_job_404(client):
    assert client.get("/api/jobs/deadbeef0000").status_code == 404


def test_huge_input_downscaled(client):
    # 3000x2400 = 7.2 Мп > потолка 4.6 Мп: вход ужимается, scale применяется к ужатому
    r = client.post("/api/jobs",
                    files={"photo": ("big.jpg", make_photo(3000, 2400), "image/jpeg")},
                    data={"scale": 2, "model": "soft"})
    assert r.status_code == 200
    body = wait_done(client, r.json()["id"], timeout=20)
    assert body["status"] == "done"
    assert body["width"] < 6000


def test_meta(client):
    body = client.get("/api/meta").json()
    assert body["engine"] == "fake"
    assert "soft" in body["models"]


def test_exif_orientation_applied(client):
    # фото 120x90 с EXIF orientation=6 (поворот на 90°) должно стать 90x120 ещё на входе
    buf = io.BytesIO()
    img = Image.new("RGB", (120, 90), (10, 200, 30))
    exif = img.getexif()
    exif[0x0112] = 6
    img.save(buf, "JPEG", exif=exif)
    buf.seek(0)
    r = client.post("/api/jobs",
                    files={"photo": ("rot.jpg", buf, "image/jpeg")},
                    data={"scale": 2, "model": "soft"})
    body = wait_done(client, r.json()["id"])
    assert (body["width"], body["height"]) == (180, 240)
