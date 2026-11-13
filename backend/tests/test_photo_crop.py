"""Customer photo crop (2026-11-13: cut a water bottle out of an after photo)."""
import io
import json
from types import SimpleNamespace as NS

from PIL import Image

from services import photo_crop as pc


def test_clean_crop_clamps_and_whole_photo_is_empty():
    assert pc.clean_crop({}) == ""
    assert pc.clean_crop({"x": 0, "y": 0, "w": 1, "h": 1}) == ""
    c = json.loads(pc.clean_crop({"x": 0.9, "y": -1, "w": 0.5, "h": 0.5}))
    assert c == {"x": 0.5, "y": 0.0, "w": 0.5, "h": 0.5}
    assert json.loads(pc.clean_crop({"x": 0, "y": 0, "w": 0.01, "h": 0.01}))["w"] == pc.MIN_SIDE


def _photo(crop):
    buf = io.BytesIO()
    Image.new("RGB", (1000, 800), "white").save(buf, "JPEG")
    return NS(id="p1", image_data=buf.getvalue(), storage_url="", customer_crop=crop)


def test_cropped_jpeg_keeps_full_resolution_of_the_cut():
    out = pc.cropped_jpeg(_photo(pc.clean_crop({"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8})))
    assert Image.open(io.BytesIO(out)).size == (800, 640)


def test_no_crop_serves_the_original():
    assert pc.cropped_jpeg(_photo("")) is None
    assert pc.version(_photo("")) == ""


def test_version_is_stable_and_changes_with_the_crop():
    a = pc.clean_crop({"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8})
    b = pc.clean_crop({"x": 0.2, "y": 0.1, "w": 0.8, "h": 0.8})
    assert pc.version(_photo(a)) == pc.version(_photo(a)) != pc.version(_photo(b))
