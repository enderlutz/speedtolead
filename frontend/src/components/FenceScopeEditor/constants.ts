// Locked design system for the Fence Staining Scope tool. Per the product
// spec: the VA controls image, address, fence path, blue/red, and blue
// arrow direction. Nothing else. Every value below is deliberately NOT
// exposed as a user-facing control.

export const BLUE = "#0091FF";
export const RED = "#E8291C";
export const LINE_HALO = "#ffffff";
export const NODE_FILL = "#ffffff";
export const NODE_STROKE = "#1a1a1a";

export const LINE_WIDTH_INNER = 6;
export const LINE_WIDTH_HALO = 11;
export const NODE_RADIUS = 6;

export const ARROW_SPACING_PX = 85; // spec Section 17: "every 70-100 px"
export const ARROW_LENGTH = 16;
export const ARROW_WIDTH = 9;

// Export resolution — spec Section 22. Portrait, since an aerial property
// shot is almost always wider-than-tall cropped to a phone-readable frame.
export const EXPORT_WIDTH = 1536;
export const EXPORT_HEIGHT = 2048;

// Locked template layout, as fractions of the full exported canvas — spec
// Section 23. The aerial image occupies the body between the header and
// the legend; header/legend are drawn OVER a black bar, not over the photo.
export const HEADER_HEIGHT_FRAC = 0.115;
export const LEGEND_WIDTH_FRAC = 0.46;
export const LEGEND_HEIGHT_FRAC = 0.1;
export const LEGEND_MARGIN_FRAC = 0.02;

export const HEADER_BG = "#0d0d0d";
export const GOLD = "#C9A24B";
export const HEADER_TEXT = "#F5F0E6";

export const MAX_SOURCE_IMAGE_MB = 20;
