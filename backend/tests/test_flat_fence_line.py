"""A flat price with no package (Alan, 2026-11-05) goes on a line called just
"Fence staining"; any other fence staining line still has to name the package."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import stripe_pay as sp  # noqa: E402


def test_a_plain_fence_staining_line_is_a_flat_price():
    _, _, due = sp._invoice_lines([sp.InvoiceItem(name="Fence staining", amount=650)], None)
    assert due == 650


def test_other_fence_staining_lines_still_need_the_package():
    with pytest.raises(HTTPException):
        sp._invoice_lines([sp.InvoiceItem(name="Fence staining, outside", amount=650)], None)
    _, _, due = sp._invoice_lines([sp.InvoiceItem(name="Signature Finish- Fence Staining", amount=650)], None)
    assert due == 650
