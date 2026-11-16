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
  made: "inpainted" | "placed";
};

export type BuilderSlot = {
  id: string;
  label: string;
  options: BuilderOption[];
  /** The option worn when the page loads; null for nothing. */
  initial: string | null;
};

/** Slots in the order the controls list them. */
export const BUILDER_SLOTS: BuilderSlot[] = [
  {
    id: "legs",
    label: "Legs",
    initial: "hero.trousers",
    options: [
      { id: "hero.trousers", label: "Trousers", made: "inpainted" },
      { id: "hero.shorts", label: "Shorts", made: "inpainted" },
    ],
  },
  {
    id: "top",
    label: "Top",
    initial: "hero.tunic",
    options: [
      { id: "hero.tunic", label: "Tunic", made: "inpainted" },
      { id: "hero.shirt", label: "Shirt", made: "inpainted" },
    ],
  },
  {
    id: "hair",
    label: "Hair",
    initial: "hero.hair",
    options: [{ id: "hero.hair", label: "Short hair", made: "inpainted" }],
  },
  {
    id: "head",
    label: "Headwear",
    initial: null,
    options: [
      { id: "hero.hat", label: "Ranger hat", made: "inpainted" },
      { id: "hero.helmet", label: "Helmet", made: "inpainted" },
    ],
  },
  {
    id: "back",
    label: "Back",
    initial: "hero.cape",
    options: [
      { id: "hero.cape", label: "Cloak", made: "inpainted" },
      { id: "hero.pack", label: "Backpack", made: "inpainted" },
    ],
  },
  {
    id: "right",
    label: "Right hand",
    initial: "hero.sword",
    options: [{ id: "hero.sword", label: "Sword", made: "placed" }],
  },
  {
    id: "left",
    label: "Left hand",
    initial: null,
    options: [
      { id: "hero.shield", label: "Shield", made: "placed" },
      { id: "hero.lantern", label: "Lantern", made: "placed" },
    ],
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
