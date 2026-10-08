"""The captured photo has to carry the traced lines, in the right colours.

Background: the capture saved a bare aerial. The lines Alan draws are Google
Maps browser overlays — they exist only in the page and can never appear in
a server-fetched image. Static Maps has to redraw them from the coordinates,
at the same centre and zoom, which is also why they land exactly where they
were traced.

The colours matter and are not decoration: Alan reads them to tell one side
of the fence from another, so a photo whose colours disagree with what he
just drew is worse than no lines at all.

What these pin:
  * each run becomes one path, in its own colour
  * a closed run loops back to its first point
  * a run with fewer than two points draws nothing rather than a dot
  * a bogus colour falls back instead of injecting anything into the URL
  * rubbish coordinates are dropped, not forwarded to Google
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from api.leads import CapturePath, _is_hex6, _path_params  # noqa: E402

A = {"lat": 29.760000, "lng": -95.370000}
B = {"lat": 29.760100, "lng": -95.370100}
C = {"lat": 29.760200, "lng": -95.369900}


def test_one_run_becomes_one_path_in_its_colour():
    out = _path_params([CapturePath(color="f59e0b", points=[A, B])])
    assert out == "&path=color:0xf59e0bff|weight:4|29.760000,-95.370000|29.760100,-95.370100"


def test_each_run_keeps_its_own_colour():
    """The whole point of the request — different colours per side."""
    out = _path_params([
        CapturePath(color="f59e0b", points=[A, B]),
        CapturePath(color="38bdf8", points=[B, C]),
    ])
    assert out.count("&path=") == 2
    assert "0xf59e0bff" in out and "0x38bdf8ff" in out


def test_a_closed_run_returns_to_its_start():
    out = _path_params([CapturePath(color="a3e635", closed=True, points=[A, B, C])])
    coords = out.split("|")[2:]
    assert coords[0] == coords[-1], "closed run must loop back"
    assert len(coords) == 4


def test_a_closed_run_of_two_points_is_not_looped():
    """Two points are a line, not a shape; looping would double it back."""
    out = _path_params([CapturePath(closed=True, points=[A, B])])
    assert out.count("29.760000,-95.370000") == 1


@pytest.mark.parametrize("points", [[], [A]])
def test_a_run_too_short_to_be_a_line_draws_nothing(points):
    assert _path_params([CapturePath(points=points)]) == ""


def test_no_runs_adds_nothing_to_the_url():
    assert _path_params([]) == ""


def test_a_bogus_colour_falls_back_rather_than_reaching_the_url():
    """A colour arrives as a string from the browser. Anything but six hex
    digits must not be interpolated into a URL we then call."""
    for bad in ("#f59e0b", "red", "zzzzzz", "", "f59e0b|evil", "../../x",
                "ff0000&path=color:0x000000ff|weight:9"):
        out = _path_params([CapturePath(color=bad, points=[A, B])])
        # Falls back to the default colour...
        assert "0xf59e0bff" in out, bad
        # ...and nothing from the untrusted string reaches the URL. One path,
        # one weight, so an injected "&path=" or "|weight:" cannot have
        # smuggled itself through.
        assert out.count("&path=") == 1, bad
        assert out.count("weight:") == 1, bad
        assert "evil" not in out and ".." not in out


def test_rubbish_coordinates_are_dropped():
    out = _path_params([CapturePath(points=[
        A, {"lat": "abc", "lng": 1}, {"lat": 999, "lng": 0}, {"nope": 1}, B,
    ])])
    assert out.count("|") == 3  # weight + two surviving points
    assert "999" not in out


def test_a_run_left_with_one_valid_point_draws_nothing():
    out = _path_params([CapturePath(points=[A, {"lat": 999, "lng": 999}])])
    assert out == ""


@pytest.mark.parametrize("v,ok", [
    ("f59e0b", True), ("FFFFFF", True), ("000000", True),
    ("#f59e0b", False), ("fff", False), ("f59e0bb", False), ("", False), ("zzzzzz", False),
])
def test_hex6_validation(v, ok):
    assert _is_hex6(v) is ok
