// /b/{token}: the customer's booking invite (Alan, 2026-10-14). Our own page
// in place of the Google Calendar invite: the date is held until the $250
// deposit, and it reads "confirmed" by itself once that's paid. Raw fetch,
// never api.request(): a 401 there would bounce a customer to the staff login.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { BookingInvite, type BookingTrust } from "@/components/proposal/BookingInvite";

import { API_BASE as BASE } from "@/lib/apiBase";

type Booking = {
  status: "held" | "confirmed" | "cancelled";
  first_name: string; address: string; date: string; tier: string; package: string;
  color: string; notes: string; sides: string[]; feet: number; total: number; deposit: number;
  paid: number; paid_kind: string; hold_until: string; proposal_url: string;
  klarna?: boolean;
  price?: number; discount?: number; discount_label?: string;
  repairs?: { name: string; qty: number; unit_price: number }[];
  repairs_discount?: number; repairs_discount_label?: string;
  services?: { name: string; price: number; description?: string }[];
  services_only?: boolean;
  /** Who sent the invite: their face goes on the pay box (Alan, 2026-10-29). */
  sender?: { name: string; role: string; photo: string } | null;
};

type Reviews = { rating: number | null; total: number; reviews: { author: string; rating: number; text: string }[] };

export default function BookingPage() {
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const [b, setB] = useState<Booking | null>(null);
  const [gone, setGone] = useState(false);
  const [reviews, setReviews] = useState<Reviews | null>(null);
  // The sender's photo has to load, or the plain pay box shows instead.
  const [photoOk, setPhotoOk] = useState(false);
  useEffect(() => {
    if (!b?.sender?.photo) return;
    const img = new Image();
    img.onload = () => setPhotoOk(true);
    img.onerror = () => setPhotoOk(false);
    img.src = b.sender.photo;
  }, [b?.sender?.photo]);
  useEffect(() => {
    let alive = true;
    fetch(`${BASE}/api/public/reviews`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setReviews(d as Reviews); }).catch(() => { /* no reviews box */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    document.title = "Your booking · Sterling Fence Staining";
    // ?preview=1: staff looking, never counted as the customer's visit.
    const qs = params.get("preview") === "1" ? "?preview=1" : "";
    fetch(`${BASE}/api/public/booking/${encodeURIComponent(token || "")}${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Booking;
        if (alive) setB(d);
      })
      .catch(() => { if (alive) setGone(true); });
    return () => { alive = false; };
  }, [token, params]);

  const pay = async () => {
    const r = await fetch(`${BASE}/api/public/booking/${encodeURIComponent(token || "")}/pay`, { method: "POST" });
    const d = (await r.json().catch(() => ({}))) as { url?: string; detail?: string };
    if (!r.ok || !d.url) throw new Error(d.detail || "Couldn't open the payment page. Call or text us.");
    window.location.assign(d.url);
  };

  const finance = async () => {
    const r = await fetch(`${BASE}/api/public/booking/${encodeURIComponent(token || "")}/finance`, { method: "POST" });
    const d = (await r.json().catch(() => ({}))) as { url?: string; detail?: string };
    if (!r.ok || !d.url) throw new Error(d.detail || "Couldn't open Klarna. Call or text us.");
    window.location.assign(d.url);
  };

  if (gone) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F3E7] p-6 text-center text-[#15130F]">
        <div>
          <img src="/sterling-logo.png" alt="Sterling Fence Staining" className="mx-auto mb-4 h-10 w-auto" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          <p className="text-[19px] font-bold">We couldn't find this booking.</p>
          <p className="mt-2 text-[16px]">Call or text us at <a className="font-bold underline" href="tel:+13465897877">346-589-7877</a>.</p>
        </div>
      </div>
    );
  }
  if (!b) return <div className="min-h-screen bg-[#F8F3E7]" />;

  // The face, the money as a sum, card protection and a real review
  // (Alan, 2026-10-25: the $250 has to feel safe to pay).
  const quote = reviews?.reviews.filter((x) => x.rating === 5 && x.text && x.text.length <= 170).sort((x, y) => y.text.length - x.text.length)[0];
  const trust: BookingTrust | undefined = b.sender && photoOk ? {
    ...b.sender,
    reviews: reviews && reviews.total > 0 ? {
      rating: reviews.rating, total: reviews.total,
      quote: quote ? { author: quote.author.split(" ")[0], text: quote.text } : undefined,
    } : undefined,
  } : undefined;

  return (
    <BookingInvite
      page
      initial={b.status}
      firstName={b.first_name}
      address={b.address}
      pkgName={b.package}
      color={b.color}
      sides={b.sides}
      feet={b.feet}
      total={b.total}
      date={new Date(`${b.date}T12:00:00`)}
      notes={b.notes}
      holdUntilIso={b.hold_until}
      paidAmount={b.paid}
      proposalHref={b.proposal_url || undefined}
      onPay={pay}
      klarna={!!b.klarna}
      discount={b.discount || 0}
      discountLabel={b.discount_label || ""}
      repairs={b.repairs || []}
      repairsDiscount={b.repairs_discount || 0}
      repairsDiscountLabel={b.repairs_discount_label || ""}
      services={b.services || []}
      servicesOnly={!!b.services_only}
      onFinance={finance}
      trust={trust}
    />
  );
}
