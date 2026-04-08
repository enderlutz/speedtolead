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
  customer_name: "#000000",
  essential_price: "#65351f",
  signature_price: "#65351f",
  legacy_price: "#e3a742",
  essential_monthly: "#65351f",
  signature_monthly: "#65351f",
  legacy_monthly: "#e3a742",
  pricing_includes: "#e6c68a",
  date: "#000000",
};
