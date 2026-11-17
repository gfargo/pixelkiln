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
  made: "inpainted" | "placed" | "placed, gripped" | "recoloured";
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
      { id: "hero.kilt.green", label: "Green kilt", made: "recoloured" },
    ],
  },
  {
    id: "top",
    label: "Top",
    options: [
      { id: "hero.plate", label: "Dragon plate", made: "inpainted" },
      { id: "hero.robe", label: "Archmage robe", made: "inpainted" },
      { id: "hero.robe.crimson", label: "Crimson robe", made: "recoloured" },
      { id: "hero.jerkin", label: "Assassin jerkin", made: "inpainted" },
    ],
  },
  {
    id: "hair",
    label: "Hair",
    options: [
      { id: "hero.silver", label: "Silver", made: "inpainted" },
      { id: "hero.mohawk", label: "Mohawk", made: "inpainted" },
      { id: "hero.mohawk.green", label: "Green mohawk", made: "recoloured" },
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
      { id: "hero.wings.frost", label: "Frost wings", made: "recoloured" },
      { id: "hero.warcape", label: "War cape", made: "inpainted" },
      { id: "hero.warcape.blue", label: "Blue cape", made: "recoloured" },
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

/**
 * Skins: the base and its walks with their hue turned, which costs nothing.
 * The first is the base as generated and has no atlas of its own.
 */
export const BUILDER_SKINS: Array<{ id: string; label: string; swatch: string }> = [
  { id: "", label: "Peach", swatch: "#f3b581" },
  { id: "tan", label: "Tan", swatch: "#d1915b" },
  { id: "brown", label: "Brown", swatch: "#9c623d" },
  { id: "deep", label: "Deep", swatch: "#6b432c" },
  { id: "orc", label: "Orc", swatch: "#84c76e" },
  { id: "frost", label: "Frost", swatch: "#9bbee7" },
];

/** Layers with skin in them: a gripped item holds the fingers, so each has a recolour per skin. */
const BUILDER_SKINNED = new Set(["hero", "hero.greatsword", "hero.staff", "hero.dagger", "hero.torch"]);

/** The atlas a layer is drawn from on a given skin. */
export function builderLayer(id: string, skin: string): string {
  return skin && BUILDER_SKINNED.has(id) ? `${id}.${skin}` : id;
}

export function builderAtlas(id: string): string {
  return `/sprites/paperdoll/builder/${id}.png`;
}
