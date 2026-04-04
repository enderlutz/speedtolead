export interface PdfFieldPlacement {
  page: number;
  x: number;
  y: number;
  font_size: number;
  color: string;
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
  essential_monthly: "Essential Monthly",
  signature_monthly: "Signature Monthly",
  legacy_monthly: "Legacy Monthly",
  pricing_includes: "Pricing Includes",
  date: "Date",
};

export const PRESET_FIELD_COLORS: Record<string, string> = {
  customer_name: "#ef4444",
  essential_price: "#22c55e",
  signature_price: "#3b82f6",
  legacy_price: "#8b5cf6",
  essential_monthly: "#14b8a6",
  signature_monthly: "#0ea5e9",
  legacy_monthly: "#a855f7",
  pricing_includes: "#f59e0b",
  date: "#6b7280",
};
