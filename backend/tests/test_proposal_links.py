"""PROPOSAL_BASE_URL as a list: first for Sterling, second for A&T, /p/ links."""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402


def _set(monkeypatch, value):
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(proposal_base_url=value))


def test_one_address_is_used_as_is_without_a_trailing_slash(monkeypatch):
    _set(monkeypatch, "https://estimate.sterlingfencetx.com/")
    assert config.proposal_bases() == ["https://estimate.sterlingfencetx.com"]
    assert config.proposal_link("abc", "fence") == "https://estimate.sterlingfencetx.com/p/abc"
    assert config.proposal_link("abc", "brick") == "https://estimate.sterlingfencetx.com/p/abc"


def test_two_addresses_split_by_division(monkeypatch):
    # What Fragne set on 2026-10-10, spaces and all.
    _set(monkeypatch, "https://estimate.sterlingfencetx.com, https://proposal.atpressurewash.com/")
    assert config.proposal_bases() == ["https://estimate.sterlingfencetx.com", "https://proposal.atpressurewash.com"]
    assert config.proposal_link("t1") == "https://estimate.sterlingfencetx.com/p/t1"
    assert config.proposal_link("t1", "fence") == "https://estimate.sterlingfencetx.com/p/t1"
    assert config.proposal_link("t1", "brick") == "https://proposal.atpressurewash.com/p/t1"
    assert config.proposal_base("BRICK") == "https://proposal.atpressurewash.com"


def test_empty_or_messy_values_still_give_a_link(monkeypatch):
    _set(monkeypatch, "")
    assert config.proposal_link("x") == "http://localhost:5173/p/x"
    _set(monkeypatch, " ,, https://a.test ;https://a.test, ")
    assert config.proposal_bases() == ["https://a.test"]
