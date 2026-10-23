// The invoice as a sheet of paper (Alan, 2026-10-23: "it looks too AI-y, it
// needs to look more like a PDF, like a billion-dollar company's invoice").
//
// What those invoices have in common (Stripe, Apple, Shopify, Google): a
// white page, one typeface, black text with one grey for labels, hairlines
// instead of bands, the sender and the bill-to side by side, a numbered
// header (number, date issued, date due), a four-column table with the
// figures right-aligned in tabular digits, the totals in a narrow stack on
// the right with "Amount due" the only bold line, and a short footer that
// says how to pay. No colour blocks, no display type on the numbers, no
// rounded cards inside the document.
//
// Used by the pay page, the receipt and the builder's preview: the same
// props as the old InvoiceDoc, so it drops in.
import { formatCurrency } from "@/lib/utils";
import { dueText } from "@/lib/due";

export type SheetItem = {
  name: string; description?: string; amount: number;
  discount?: number; discount_label?: string; total_discount?: boolean;
  qty?: number; quantity?: number; unit_price?: number;
};
export type SheetInfo = {
  amount: number; items?: SheetItem[]; credit?: number;
  name?: string; first_name?: string; address?: string;
  invoice_number?: string; date?: string; due_date?: string | null;
  /** On a receipt: when it was paid (ISO). */
  paid_at?: string;
};

const INK = "#111110";
const MUTED = "#6B6963";
const RULE = "#E4E2DD";
const GOLD = "#C9972F";
const PHONE = "346-589-7877";
const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";

const money = (n: number) => formatCurrency(n);
const minus = (n: number) => `−${formatCurrency(Math.abs(n))}`;
const longDate = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
};
/** "Teila Ebrahimi" from however the office typed it. */
const properName = (s?: string) => (s || "").trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m) => m.toUpperCase());
/** "2245 W Main St Houston, TX 77098 United States" → two lines, no country. */
const addressLines = (a?: string): string[] => {
  const s = (a || "").replace(/,?\s*(United States|USA|US)\s*$/i, "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  const m = s.match(/^(.*?)[,\s]+([A-Za-z .]+?,?\s*(?:TX|Texas)\s*\d{5}(?:-\d{4})?)$/i);
  return m ? [m[1].replace(/,$/, "").trim(), m[2].replace(/\s*,\s*/, ", ").replace(/(\w)\s+(TX|Texas)/i, "$1, $2")] : [s];
};

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] font-medium uppercase tracking-[0.08em]" style={{ color: MUTED }}>{children}</span>;
}

export function InvoiceSheet({ info, paid = false }: { info: SheetInfo; paid?: boolean }) {
  const items = info.items ?? [];
  const lines = items.filter((i) => !i.total_discount);
  const wholeOff = items.filter((i) => i.total_discount);
  const subtotal = lines.reduce((t, i) => t + i.amount, 0);
  const lineOff = lines.reduce((t, i) => t + (i.discount || 0), 0);
  const credit = info.credit || 0;
  const issued = longDate(info.date);
  const paidOn = longDate(info.paid_at) || issued;
  const due = dueText(info.due_date);
  const who = properName(info.name) || properName(info.first_name);
  const addr = addressLines(info.address);
  const th = "pb-2 text-[12px] font-medium uppercase tracking-[0.08em]";
  const num = "whitespace-nowrap text-right tabular-nums";

  return (
    <div className="mt-5 bg-white text-[15px] leading-snug" style={{ fontFamily: FONT, color: INK, border: `1px solid ${RULE}`, borderRadius: 6, boxShadow: "0 1px 2px rgba(0,0,0,.04), 0 10px 30px rgba(0,0,0,.06)" }}>
      <div className="px-5 pb-6 pt-5 sm:px-7 sm:pt-6">
        {/* Masthead: who it's from, and what it is. */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.2em]">Sterling</p>
            <p className="text-[13px]" style={{ color: MUTED }}>Fence Staining</p>
          </div>
          <div className="text-right">
            <p className="text-[22px] font-medium leading-none tracking-[-0.01em]">{paid ? "Receipt" : "Invoice"}</p>
            {paid ? <p className="mt-1.5 inline-block rounded-[3px] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ border: `1px solid ${INK}` }}>Paid</p> : null}
          </div>
        </div>
        <div className="mt-4 h-px" style={{ background: GOLD }} />

        {/* The numbers that name this document. */}
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5">
          {info.invoice_number ? (<><dt><Label>Invoice number</Label></dt><dd className="tabular-nums">{info.invoice_number}</dd></>) : null}
          {issued ? (<><dt><Label>Date issued</Label></dt><dd>{issued}</dd></>) : null}
          {paid
            ? (paidOn ? (<><dt><Label>Date paid</Label></dt><dd>{paidOn}</dd></>) : null)
            : (<><dt><Label>Due</Label></dt><dd className="font-medium">{due}</dd></>)}
        </dl>

        {/* From and bill to, side by side where there's room. */}
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <div>
            <Label>From</Label>
            <p className="mt-1 font-medium">Sterling Fence Staining</p>
            <p style={{ color: MUTED }}>Cypress, Texas</p>
            <p style={{ color: MUTED }}>{PHONE}</p>
            <p style={{ color: MUTED }}>sterlingfencetx.com</p>
          </div>
          <div>
            <Label>Bill to</Label>
            {who ? <p className="mt-1 font-medium">{who}</p> : null}
            {addr.map((l, i) => <p key={i} style={{ color: MUTED }}>{l}</p>)}
          </div>
        </div>

        {/* The one line a customer reads first. */}
        <p className="mt-6 text-[19px] font-semibold tabular-nums tracking-[-0.01em]">
          {money(info.amount)} {paid ? `paid${paidOn ? ` on ${paidOn}` : ""}` : `due ${due === "Upon receipt" ? "upon receipt" : due}`}
        </p>

        {/* Line items. Qty and unit price get their own columns where there's
            room; on a phone they sit under the name. */}
        <table className="mt-5 w-full border-collapse">
          <thead>
            <tr style={{ color: MUTED, borderBottom: `1px solid ${INK}` }}>
              <th scope="col" className={`${th} text-left`}>Description</th>
              <th scope="col" className={`${th} hidden text-right sm:table-cell`}>Qty</th>
              <th scope="col" className={`${th} hidden text-right sm:table-cell`}>Unit price</th>
              <th scope="col" className={`${th} text-right`}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((i, n) => {
              const qty = i.qty ?? i.quantity ?? 1;
              const unit = i.unit_price ?? (qty > 0 ? i.amount / qty : i.amount);
              return (
                <tr key={n} className="align-top" style={{ borderBottom: `1px solid ${RULE}` }}>
                  <td className="py-3 pr-3">
                    <p className="font-medium">{i.name}</p>
                    {i.description ? <p className="mt-0.5 text-[14px]" style={{ color: MUTED }}>{i.description}</p> : null}
                    {qty > 1 ? <p className="mt-0.5 text-[14px] tabular-nums sm:hidden" style={{ color: MUTED }}>{qty} × {money(unit)}</p> : null}
                    {i.discount ? <p className="mt-0.5 text-[14px]" style={{ color: MUTED }}>{i.discount_label || "Discount"}</p> : null}
                  </td>
                  <td className={`${num} hidden py-3 sm:table-cell`}>{qty}</td>
                  <td className={`${num} hidden py-3 pl-3 sm:table-cell`}>{money(unit)}</td>
                  <td className={`${num} py-3 pl-3`}>
                    <p>{money(i.amount)}</p>
                    {i.discount ? <p className="mt-0.5 text-[14px]" style={{ color: MUTED }}>{minus(i.discount)}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Totals, stacked on the right. One bold line. */}
        <dl className="ml-auto mt-4 w-full space-y-1.5 sm:w-72">
          <div className="flex justify-between gap-4"><dt style={{ color: MUTED }}>Subtotal</dt><dd className="tabular-nums">{money(subtotal)}</dd></div>
          {lineOff ? <div className="flex justify-between gap-4"><dt style={{ color: MUTED }}>Discounts</dt><dd className="tabular-nums">{minus(lineOff)}</dd></div> : null}
          {wholeOff.map((i, n) => (
            <div key={n} className="flex justify-between gap-4"><dt style={{ color: MUTED }}>{i.name}</dt><dd className="tabular-nums">{minus(i.amount)}</dd></div>
          ))}
          {credit ? <div className="flex justify-between gap-4"><dt style={{ color: MUTED }}>{paid ? "Previously paid" : "Amount paid"}</dt><dd className="tabular-nums">{minus(credit)}</dd></div> : null}
          <div className="flex justify-between gap-4 pt-2 text-[17px] font-semibold" style={{ borderTop: `1px solid ${INK}` }}>
            <dt>{paid ? "Total paid" : "Amount due"}</dt><dd className="tabular-nums">{money(info.amount)}</dd>
          </div>
        </dl>

        {/* How to pay, and thanks. */}
        <div className="mt-7 space-y-1 text-[13px]" style={{ color: MUTED, borderTop: `1px solid ${RULE}`, paddingTop: 14 }}>
          {paid
            ? <p>Paid in full. Keep this receipt for your records.</p>
            : <p>Pay online below with a card, Apple Pay, Google Pay or your bank account.</p>}
          <p>Questions? Call or text {PHONE}.</p>
          <p>Thank you for choosing Sterling Fence Staining.</p>
        </div>
      </div>
    </div>
  );
}
