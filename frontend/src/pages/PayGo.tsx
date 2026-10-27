// The straight-to-Stripe link (Alan and Olga, 2026-10-27): the text says
// "here's your $250 link", the tap lands on Stripe's payment page, nothing
// in between. /pay/:token stays the full page (package, proposal, what's
// left to pay) for the booking invite and the proposal's Reserve button.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE as BASE } from "@/lib/apiBase";

export default function PayGo() {
  const { token = "" } = useParams();
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token)}/session`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.url) throw new Error(data.detail || "Couldn't open the payment page");
        window.location.replace(data.url);
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : "Couldn't open the payment page");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#fff", color: "#111", fontFamily: "Inter, system-ui, sans-serif", padding: 16 }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        {failed ? (
          <>
            <p style={{ fontSize: 17, lineHeight: 1.4, marginBottom: 14 }}>{failed}</p>
            <a href={`/pay/${encodeURIComponent(token)}`}
              style={{ display: "inline-block", minHeight: 44, lineHeight: "44px", padding: "0 22px", background: "#111", color: "#fff", borderRadius: 10, textDecoration: "none", fontSize: 16, fontWeight: 600 }}>
              Open your payment page
            </a>
          </>
        ) : (
          <>
            <div style={{ width: 28, height: 28, margin: "0 auto 14px", border: "3px solid #ddd", borderTopColor: "#111", borderRadius: "50%", animation: "paygo-spin 0.8s linear infinite" }} />
            <p style={{ fontSize: 17 }}>Opening your secure payment…</p>
            <style>{"@keyframes paygo-spin{to{transform:rotate(360deg)}}"}</style>
          </>
        )}
      </div>
    </main>
  );
}
