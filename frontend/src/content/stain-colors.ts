// Every stain colour we show a customer, with its job photo. One list for
// the proposal's "See the colors" and for the colours link we text
// contractors (/colors). Signature = Valspar semi-transparent, Legacy =
// Valspar solid.
export type StainPhoto = { name: string; src: string; full?: string; note?: string };

export const SIGNATURE_PHOTOS: StainPhoto[] = [
  { name: "Redwood Naturaltone", src: "/proposal-mockup/stain-redwood-naturaltone.jpg" },
  { name: "Cedar Naturaltone", src: "/proposal-mockup/stain-cedar-naturaltone.jpg" },
  // Also a Legacy solid; the note here is the semi-transparent one (Alan, 2026-10-22).
  { name: "Simply Cedar", src: "/proposal-mockup/stain-simply-cedar.jpg", note: "Classic cedar orange-brown with the grain showing through. The colour most people picture when they say \"stained fence\"." },
  // Signature is Valspar semi-transparent (water-based) only (Alan,
  // 2026-11-04): the Ready Seal oil colours (Pecan, Redwood, Dark Walnut)
  // soak up more stain on old wood and look uneven, so they came off.
  // Cowboy Suede is Alan's job photo; Reindeer is from the Fence Photos library.
  { name: "Cowboy Suede", src: "/proposal-mockup/stain-cowboy-suede.jpg" },
  { name: "Cottage Gray", src: "/proposal-mockup/stain-cottage-gray.jpg" },
  { name: "Monticello Tan", src: "/proposal-mockup/stain-monticello-tan.jpg" },
  { name: "Reindeer", src: "/proposal-mockup/stain-reindeer.jpg" },
  { name: "Chocolate Chips", src: "/proposal-mockup/stain-chocolate-chips.jpg" },
];
// Legacy solid colours: the best photo of each from the dashboard's Fence
// Photos (Valspar solid line), one per colour, as Alan picked the rule
// (2026-10-10). Served straight from the photo storage. Cedar Naturaltone
// and Midnight Gray have no photo yet.
export const LEGACY_PHOTOS: StainPhoto[] = [
  // Alan's photo (2026-10-25) in place of the library one.
  { name: "Simply Cedar", src: "/proposal-mockup/legacy-simply-cedar.jpg", full: "/proposal-mockup/legacy-simply-cedar-full.jpg" },
  { name: "Pine Bark", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/35fd7c95-2407-4bb8-ab12-c530ce523f02/cf591159-dadc-4bf8-bfce-e96984b906e8_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/35fd7c95-2407-4bb8-ab12-c530ce523f02/cf591159-dadc-4bf8-bfce-e96984b906e8.jpg" },
  { name: "October Brown", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/bb52bae5-9222-42b1-bd6a-2aa01cf4e22a/8231b4c2-0f42-459a-b568-631b81d2e1b4_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/bb52bae5-9222-42b1-bd6a-2aa01cf4e22a/8231b4c2-0f42-459a-b568-631b81d2e1b4.jpg" },
  // Alan's cleaner photo (2026-10-22) in place of the library one.
  { name: "Potato Skin", src: "/proposal-mockup/legacy-potato-skin.jpg", full: "/proposal-mockup/legacy-potato-skin-full.jpg" },
  { name: "Chocolate Chip", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/ad73d243-da98-4448-8158-646f436f0070/3a3a2501-207a-4c97-be2e-1fda6dba0bc3_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/ad73d243-da98-4448-8158-646f436f0070/3a3a2501-207a-4c97-be2e-1fda6dba0bc3.jpg" },
  // Alan's photo (2026-10-25) in place of the library one.
  { name: "Classic Mahogany", src: "/proposal-mockup/legacy-classic-mahogany.jpg", full: "/proposal-mockup/legacy-classic-mahogany-full.jpg" },
  // Alan's cleaner photo (2026-10-22) in place of the library one.
  { name: "Plymouth Red", src: "/proposal-mockup/legacy-plymouth-red.jpg", full: "/proposal-mockup/legacy-plymouth-red-full.jpg" },
  { name: "Galapagos Grey", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/573f331f-c1b8-4aa5-b301-c6ca83300c8f/bcc20eac-8ae7-418f-a333-da5613a3e06d_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/573f331f-c1b8-4aa5-b301-c6ca83300c8f/bcc20eac-8ae7-418f-a333-da5613a3e06d.jpg" },
  { name: "Silver Mine", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/0ad80f7d-f86e-4ace-9f18-466daf8efbe6/cf7043e7-45cc-4b04-8538-1aada511ca11_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/0ad80f7d-f86e-4ace-9f18-466daf8efbe6/cf7043e7-45cc-4b04-8538-1aada511ca11.jpg" },
  { name: "Darkest Night", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/3fdbff10-04d9-44a1-b878-f51f3e0ae197/49241180-35a4-48f5-91a9-52fa7c664ab9_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/3fdbff10-04d9-44a1-b878-f51f3e0ae197/49241180-35a4-48f5-91a9-52fa7c664ab9.jpg" },
];


export type Finish = "semi-transparent" | "solid";
export type BoardColor = { key: string; name: string; finish: Finish; label: string; src: string; full: string };

// The colours board: no package names, no prices, just each colour with
// "semi-transparent" or "solid" after it (Alan, 2026-11-07, for Lionheart
// and other contractors who get one price and pick a colour). The Legacy
// photo list says "Chocolate Chip"; the can says Chocolate Chips.
export const COLOR_BOARD: BoardColor[] = [
  ...SIGNATURE_PHOTOS.map((c) => ({
    key: `semi-${c.name}`, name: c.name, finish: "semi-transparent" as const,
    label: `${c.name} semi-transparent`, src: c.src, full: c.full || c.src,
  })),
  ...LEGACY_PHOTOS.map((c) => {
    const name = c.name === "Chocolate Chip" ? "Chocolate Chips" : c.name;
    return { key: `solid-${name}`, name, finish: "solid" as const, label: `${name} solid`, src: c.src, full: c.full || c.src };
  }),
];
