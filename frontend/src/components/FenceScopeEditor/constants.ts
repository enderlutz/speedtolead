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

// Export width — spec Section 22. Height is NOT fixed: the page is the photo
// plus a header band, so it takes the photo's own shape. Forcing a portrait
// page meant every landscape screenshot got squashed to fit, and turning a
// photo 90 degrees squashed it by a third.
export const EXPORT_WIDTH = 1536;
/** Only used before a photo has loaded, to size the empty frame. */
export const DEFAULT_PHOTO_ASPECT = 0.75;

// Locked template layout — spec Section 23. The header is a band above the
// photo, measured against page WIDTH (page height depends on the photo, so
// measuring it against height would be circular).
export const HEADER_HEIGHT_OF_WIDTH = 0.17;
export const LEGEND_WIDTH_FRAC = 0.46;
export const LEGEND_HEIGHT_FRAC = 0.1;
export const LEGEND_MARGIN_FRAC = 0.02;

// Breathing room down both sides of the header, as a fraction of page width.
// Without it the wordmark and the address sit flush against the paper edge,
// which is the single fastest way to make a document look unfinished. The
// right side gets more, so the title and address read as pulled in from the
// edge rather than pushed against it.
export const PAGE_MARGIN_FRAC = 0.022;
export const TEXT_RIGHT_MARGIN_FRAC = 0.055;
// The logo never gets more than this share of the width, so a wide logo can't
// crowd out the title and address next to it. It should still read as the
// biggest thing in the band — it's the brand, the title is a caption.
export const LOGO_MAX_WIDTH_FRAC = 0.44;
export const LOGO_HEIGHT_FRAC = 0.84; // of header height

// Header type. Sizes are ceilings — both lines are measured and stepped down
// if they'd run past the text column, so nothing ever overruns the page.
export const TITLE_FONT = "Georgia, 'Times New Roman', serif";
export const BODY_FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
export const TITLE_SIZE_MAX = 0.3; // of header height
export const TITLE_SIZE_MIN = 0.2;
export const TITLE_LETTER_SPACING = 0.02; // of font size
export const ADDRESS_SIZE_MAX = 0.165;
export const ADDRESS_SIZE_MIN = 0.1;

export const HEADER_BG = "#0d0d0d";
export const GOLD = "#C9A24B";
export const HEADER_TEXT = "#F5F0E6";

export const MAX_SOURCE_IMAGE_MB = 20;
