export interface PdfFieldPlacement {
  page: number;
  x: number;
  y: number;
  font_size: number;
  color: string;
  width?: number; // text box width (0 = no box, left-aligned)
  locked?: boolean;
}

export interface PdfField extends PdfFieldPlacement {
  id: string;
  label: string;
  value?: string;
}

export const PRESET_FIELDS = [
  "customer_name",
  "essential_price",
  "signature_price",
  "legacy_price",
  "essential_slashed_price",
  "signature_slashed_price",
  "legacy_slashed_price",
  "essential_save_price",
  "signature_save_price",
  "legacy_save_price",
  "essential_monthly",
  "signature_monthly",
  "legacy_monthly",
  "pricing_includes",
  "date",
] as const;

export type PresetFieldKey = (typeof PRESET_FIELDS)[number];

export const PRESET_FIELD_LABELS: Record<string, string> = {
  customer_name: "Customer Name",
  essential_price: "Essential Price",
  signature_price: "Signature Price",
  legacy_price: "Legacy Price",
  essential_slashed_price: "Essential — Slashed (red strike)",
  signature_slashed_price: "Signature — Slashed (red strike)",
  legacy_slashed_price: "Legacy — Slashed (red strike)",
  essential_save_price: "Essential — You Save $",
  signature_save_price: "Signature — You Save $",
  legacy_save_price: "Legacy — You Save $",
  essential_monthly: "Essential Monthly",
  signature_monthly: "Signature Monthly",
  legacy_monthly: "Legacy Monthly",
  pricing_includes: "Pricing Includes",
  date: "Date",
};

export const PRESET_FIELD_COLORS: Record<string, string> = {
  customer_name: "#000000",
  essential_price: "#2b3a16",
  signature_price: "#5b2c10",
  legacy_price: "#c1891f",
  essential_slashed_price: "#D32F2F",
  signature_slashed_price: "#D32F2F",
  legacy_slashed_price: "#D32F2F",
  essential_save_price: "#09311c",
  signature_save_price: "#09311c",
  legacy_save_price: "#ffffff",
  essential_monthly: "#2b3a16",
  signature_monthly: "#5b2c10",
  legacy_monthly: "#c1891f",
  pricing_includes: "#e6c68a",
  date: "#000000",
};
