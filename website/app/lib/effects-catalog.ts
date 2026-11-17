import data from "./effects-catalog.json";

/** One of PixelLab's whole-effect presets, as its workbench listed it. */
export type Preset = {
  name: string;
  summary: string;
  width: number;
  height: number;
  frames: number;
  loop: boolean;
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
  still?: string;
};

export type LocalCategory = { id: string; name: string; blurb?: string };

export const presetsReadOn: string = data.presets.readOn;
export const presets: Preset[] = data.presets.items;
export const pixelfxVersion: string = data.pixelfx.version;
export const pixelfxCategories: LocalCategory[] = data.pixelfx.categories;
export const pixelfxEffects: LocalEffect[] = data.pixelfx.effects;

/** Presets this site already shows rendered around a sprite. */
export const presetStills: Record<string, { src: string; width: number; height: number; alt: string }> = {
  aura: { src: "/effects/robot-aura-still.png", width: 96, height: 112, alt: "A blue aura around a robot" },
  shield_bubble: { src: "/effects/object-chest-shield-still.png", width: 96, height: 96, alt: "A bubble shield around a chest" },
  lightning_strike: { src: "/effects/robot-lightning-still.png", width: 96, height: 128, alt: "Lightning striking a robot" },
  rim_glow: { src: "/effects/object-kiln-rim-still.png", width: 64, height: 64, alt: "A purple glow behind a small kiln" },
};
