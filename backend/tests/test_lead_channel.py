"""Where a lead came from (services/lead_channel.py).

Pins: a website lead is a website lead even though it has no Facebook
source (it used to be filed as "ad"); an ad lead keeps the campaign, ad set
and ad with their Meta ids; a hand-set source on the dashboard wins.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.lead_channel import classify, lead_channel  # noqa: E402

AD = {
    "source": "Facebook",
    "tags": ["ad from premium 1"],
    "attributions": [
        {"isLast": True, "utmCampaign": "LATER", "utmCampaignId": "9", "medium": "facebook"},
        {"isFirst": True, "adSource": "facebook", "utmCampaign": "FENCE STAINING – Copy",
         "utmCampaignId": "120243400719740434", "utmMedium": "New Leads ad set – Copy 2",
         "utmContent": "New Leads ad – Copy", "utmAdId": "120243400727130434", "medium": "facebook"},
    ],
}


def test_website_form_lead_is_website():
    c = {"tags": ["website-lead"], "attributionSource": {"sessionSource": "CRM Workflows", "medium": "Manual"}}
    assert classify(c)["channel"] == "website"


def test_ad_lead_keeps_the_first_touch_campaign_ad_set_and_ad():
    r = classify(AD)
    assert r["channel"] == "facebook_ad"
    assert r["campaign"] == "FENCE STAINING – Copy" and r["campaign_id"] == "120243400719740434"
    assert r["ad_set"] == "New Leads ad set – Copy 2"
    assert r["ad"] == "New Leads ad – Copy" and r["ad_id"] == "120243400727130434"


def test_messenger_conversation_is_not_an_ad():
    c = {"attributionSource": {"sessionSource": "Social media", "medium": "facebook", "pSid": "1"}}
    assert classify(c)["channel"] == "facebook_messenger"


def test_inbound_call_and_hand_added():
    assert classify({"tags": ["couldn't find caller name"]})["channel"] == "phone_call"
    assert classify({"tags": [], "source": ""})["channel"] == "added_by_team"


def test_hand_set_source_wins_and_old_defaults_do_not():
    assert lead_channel("referral", "facebook_ad") == "referral"
    assert lead_channel("ad", "website") == "website"
    assert lead_channel("contact_mirror", "") == "added_by_team"
    assert lead_channel("ad", "") == "facebook_ad"
