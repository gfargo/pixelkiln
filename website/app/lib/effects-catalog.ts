import data from "./effects-catalog.json";

/** One of PixelLab's whole-effect presets, as its workbench listed it. */
export type Preset = {
  name: string;
  summary: string;
  width: number;
  height: number;
  frames: number;
  loop: boolean;
  /** A workbench render with no sprite, made by `scripts/gen-effects-catalog.ts --render-presets`. */
  gif?: string;
  still?: string;
};

/** One effect of the pixelfx library; `still` is a frame rendered by `scripts/gen-effects-catalog.ts`. */
export type LocalEffect = {
  id: string;
  category: string;
  name: string;
  description: string;
  width: number;
  height: number;
  duration: number;
  loop: boolean;
  needsCharacter: boolean;
  options: string[];
  /** One frame, shown under reduced motion. */
  still?: string;
  /** The effect playing, as an animated WebP. */
  anim?: string;
  /** The picture's own size: an acted effect's stage is wider than the effect's canvas. */
  art?: { width: number; height: number };
};

export type LocalCategory = { id: string; name: string; blurb?: string };

export const presetsReadOn: string = data.presets.readOn;
export const presets: Preset[] = data.presets.items;
export const pixelfxVersion: string = data.pixelfx.version;
export const pixelfxCategories: LocalCategory[] = data.pixelfx.categories;
export const pixelfxEffects: LocalEffect[] = data.pixelfx.effects;

/** Presets this site already shows rendered around a sprite; these stand in for a bare render. */
export const presetStills: Record<string, { gif: string; src: string; width: number; height: number; alt: string }> = {
  aura: { gif: "/effects/robot-aura.gif", src: "/effects/robot-aura-still.png", width: 96, height: 112, alt: "A blue aura around a robot" },
  shield_bubble: { gif: "/effects/object-chest-shield.gif", src: "/effects/object-chest-shield-still.png", width: 96, height: 96, alt: "A bubble shield around a chest" },
  lightning_strike: { gif: "/effects/robot-lightning.gif", src: "/effects/robot-lightning-still.png", width: 96, height: 128, alt: "Lightning striking a robot" },
  rim_glow: { gif: "/effects/object-kiln-rim.gif", src: "/effects/object-kiln-rim-still.png", width: 64, height: 64, alt: "A purple glow behind a small kiln" },
};
