"""Two packages still open on the booking invite, and "show colors in person"."""
from api.proposal_live import COLOR_IN_PERSON, booking_pair, package_label


def test_pair_puts_the_higher_package_first():
    assert booking_pair("essential", "signature") == ("signature", "essential")
    assert booking_pair("legacy", "signature") == ("legacy", "signature")


def test_one_package_or_none_stays_single():
    assert booking_pair("signature", "") == ("signature", "")
    assert booking_pair("signature", "signature") == ("signature", "")
    assert booking_pair("none", "essential") == ("none", "")


def test_label_reads_cheaper_first():
    assert package_label("signature", "essential").startswith("Essential")
    assert " or " in package_label("legacy", "signature")
    assert " or " not in package_label("legacy")


def test_in_person_words_match_the_frontend():
    assert COLOR_IN_PERSON == "Shown in person"
