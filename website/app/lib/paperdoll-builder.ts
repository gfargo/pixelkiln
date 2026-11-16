/**
 * The character builder's data: which paperdoll layers exist, which slot each
 * fills, and the order they are drawn in. Every layer is one atlas PNG in
 * /public/sprites/paperdoll/builder, all on the same grid, so "draw frame N
 * of each chosen layer" is the whole renderer.
 */

/** Atlas cell edge in source pixels: a 64px frame with room for 16px of padding on every side. */
export const BUILDER_CELL = 96;
/** Atlas columns. Row 0 holds the eight rotations; the walk rows use six. */
export const BUILDER_COLUMNS = 8;
export const BUILDER_ROWS = 5;

/** Row 0, left to right. */
export const BUILDER_DIRECTIONS = [
  "south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west",
] as const;
export type BuilderDirection = (typeof BUILDER_DIRECTIONS)[number];

/** The row each walk loop is on. Diagonals have no walk in this set. */
export const BUILDER_WALK_ROWS: Partial<Record<BuilderDirection, number>> = {
  south: 1,
  east: 2,
  north: 3,
  west: 4,
};
export const BUILDER_WALK_FRAMES = 6;
export const BUILDER_WALK_FPS = 8;

export type BuilderOption = {
  /** The manifest asset id, which is also the atlas file's name. */
  id: string;
  label: string;
  /** How the layer was made, for the readout. */
  made: "inpainted" | "placed" | "placed, gripped";
};

export type BuilderSlot = {
  id: string;
  label: string;
  options: BuilderOption[];
};

/** Slots in the order the controls list them. */
export const BUILDER_SLOTS: BuilderSlot[] = [
  {
    id: "legs",
    label: "Legs",
    options: [
      { id: "hero.greaves", label: "Plate greaves", made: "inpainted" },
      { id: "hero.wraps", label: "Assassin wraps", made: "inpainted" },
      { id: "hero.kilt", label: "War kilt", made: "inpainted" },
    ],
  },
  {
    id: "top",
    label: "Top",
    options: [
      { id: "hero.plate", label: "Dragon plate", made: "inpainted" },
      { id: "hero.robe", label: "Archmage robe", made: "inpainted" },
      { id: "hero.jerkin", label: "Assassin jerkin", made: "inpainted" },
    ],
  },
  {
    id: "hair",
    label: "Hair",
    options: [
      { id: "hero.silver", label: "Silver", made: "inpainted" },
      { id: "hero.mohawk", label: "Mohawk", made: "inpainted" },
    ],
  },
  {
    id: "head",
    label: "Headwear",
    options: [
      { id: "hero.helm", label: "Horned helm", made: "inpainted" },
      { id: "hero.wizardhat", label: "Wizard hat", made: "inpainted" },
      { id: "hero.cowl", label: "Cowl and mask", made: "inpainted" },
    ],
  },
  {
    id: "back",
    label: "Back",
    options: [
      { id: "hero.wings", label: "Dragon wings", made: "inpainted" },
      { id: "hero.warcape", label: "War cape", made: "inpainted" },
      { id: "hero.quiver", label: "Bow and quiver", made: "inpainted" },
    ],
  },
  {
    id: "right",
    label: "Right hand",
    options: [
      { id: "hero.greatsword", label: "Runed greatsword", made: "placed, gripped" },
      { id: "hero.staff", label: "Crystal staff", made: "placed, gripped" },
      { id: "hero.dagger", label: "Dagger", made: "placed, gripped" },
    ],
  },
  {
    id: "left",
    label: "Left hand",
    options: [
      { id: "hero.kiteshield", label: "Dragon shield", made: "placed" },
      { id: "hero.torch", label: "Torch", made: "placed, gripped" },
    ],
  },
];

/** Whole outfits, as a place to start. Slots a look leaves out are empty. */
export const BUILDER_LOOKS: Array<{ id: string; label: string; wears: Record<string, string> }> = [
  {
    id: "knight",
    label: "Dark knight",
    wears: { legs: "hero.greaves", top: "hero.plate", head: "hero.helm", back: "hero.warcape", right: "hero.greatsword", left: "hero.kiteshield" },
  },
  {
    id: "mage",
    label: "Archmage",
    wears: { top: "hero.robe", hair: "hero.silver", head: "hero.wizardhat", right: "hero.staff" },
  },
  {
    id: "assassin",
    label: "Assassin",
    wears: { legs: "hero.wraps", top: "hero.jerkin", head: "hero.cowl", back: "hero.quiver", right: "hero.dagger" },
  },
  {
    id: "dragonborn",
    label: "Dragonborn",
    wears: { legs: "hero.kilt", hair: "hero.mohawk", back: "hero.wings", right: "hero.greatsword", left: "hero.torch" },
  },
];

/** Layers every build draws, beneath the slots. */
export const BUILDER_ALWAYS = ["hero", "hero.briefs"];

/**
 * Bottom to top. A layer holds only what its frame shows, so one fixed order
 * works for every direction: a cloak seen from the front is already just its
 * edges, and a held item behind the body already has the covered part left out.
 */
export const BUILDER_DRAW_ORDER = ["legs", "top", "back", "hair", "left", "right", "head"];

export function builderAtlas(id: string): string {
  return `/sprites/paperdoll/builder/${id}.png`;
}
