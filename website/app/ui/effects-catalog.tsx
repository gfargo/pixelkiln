"use client";

import { useMemo, useState } from "react";
import type { LocalCategory, LocalEffect, Preset } from "@/app/lib/effects-catalog";

type Still = { src: string; width: number; height: number; alt: string };

/** The largest whole-number zoom that keeps a still inside a card's stage. */
function zoom(width: number, height: number) {
  return Math.max(1, Math.min(3, Math.floor(Math.min(240 / width, 150 / height))));
}

function matches(query: string, ...fields: string[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Both catalogs with one filter box over them. Everything is in the page; the filter only hides cards. */
export function EffectsCatalog({
  presets,
  presetStills,
  presetsReadOn,
  categories,
  effects,
  version,
}: {
  presets: Preset[];
  presetStills: Record<string, Still>;
  presetsReadOn: string;
  categories: LocalCategory[];
  effects: LocalEffect[];
  version: string;
}) {
  const [query, setQuery] = useState("");
  // Presets this site has a picture of lead, so the first row is a full row of pictures.
  const shownPresets = useMemo(
    () =>
      presets
        .filter((preset) => matches(query, preset.name, preset.summary))
        .sort((a, b) => Number(Boolean(presetStills[b.name])) - Number(Boolean(presetStills[a.name]))),
    [presets, presetStills, query],
  );
  const shownEffects = useMemo(
    // Within a category, the effects that can be rendered come before the ones that need a character.
    () =>
      effects
        .filter((effect) => matches(query, effect.id, effect.name, effect.description))
        .sort((a, b) => Number(a.needsCharacter) - Number(b.needsCharacter)),
    [effects, query],
  );
  const standalone = effects.filter((effect) => !effect.needsCharacter).length;

  return (
    <>
      <div className="catalog-bar shell">
        <label className="catalog-filter">
          <span>Filter both lists</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="fire, shield, loop, explosion…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="catalog-count" aria-live="polite">
          {shownPresets.length} of {presets.length} presets, {shownEffects.length} of {effects.length} pixelfx effects
        </p>
      </div>

      <section className="catalog-section" id="presets">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>PixelLab presets.</h2>
            </div>
            <p className="section-deck">
              Whole effects from PixelLab&apos;s VFX workbench, free on a
              subscription. Each can be built around your own sprite with{" "}
              <code>--sprite</code>. PixelLab adds to this list; it was read
              from the workbench on {presetsReadOn}, and{" "}
              <code>pixelkiln vfx presets</code> prints today&apos;s.
            </p>
          </div>
          {shownPresets.length ? (
            <ul className="catalog-grid">
              {shownPresets.map((preset) => {
                const still = presetStills[preset.name];
                const k = still ? zoom(still.width, still.height) : 1;
                return (
                  <li key={preset.name} className="catalog-card">
                    {still ? (
                      <div className="catalog-stage">
                        <img src={still.src} alt={still.alt} width={still.width * k} height={still.height * k} loading="lazy" />
                      </div>
                    ) : null}
                    <div className="catalog-body">
                      <h3>{preset.name}</h3>
                      <p className="catalog-facts">
                        {preset.width}×{preset.height} · {preset.frames} frames · {preset.loop ? "loops" : "plays once"}
                      </p>
                      <p>{preset.summary}</p>
                      <code className="catalog-command">pixelkiln vfx --preset {preset.name} --out fx/{preset.name.replace(/_/g, "-")}</code>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="catalog-empty">No preset matches “{query}”.</p>
          )}
        </div>
      </section>

      <section className="catalog-section catalog-section-alt" id="pixelfx">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>pixelfx effects.</h2>
            </div>
            <p className="section-deck">
              Every effect in{" "}
              <a className="catalog-link" href="https://github.com/patch-gg/pixelfx" rel="noreferrer">pixelfx</a>{" "}
              {version}, an MIT-licensed library by Patch, rendered on your
              own machine with <code>--lib pixelfx</code>. {standalone} stand
              alone and are shown as one frame each; the other{" "}
              {effects.length - standalone} need a character to wrap and are
              not rendered by PixelKiln yet.
            </p>
          </div>
          <nav className="catalog-jump" aria-label="pixelfx categories">
            {categories.map((category) => {
              const count = shownEffects.filter((effect) => effect.category === category.id).length;
              return count ? (
                <a key={category.id} href={`#pixelfx-${category.id}`}>
                  {category.name} <span>{count}</span>
                </a>
              ) : null;
            })}
          </nav>
          {shownEffects.length ? null : <p className="catalog-empty">No pixelfx effect matches “{query}”.</p>}
          {categories.map((category) => {
            const inCategory = shownEffects.filter((effect) => effect.category === category.id);
            if (!inCategory.length) return null;
            return (
              <div key={category.id} className="catalog-category" id={`pixelfx-${category.id}`}>
                <h3>
                  {category.name}
                  {category.blurb ? <span>{category.blurb}</span> : null}
                </h3>
                <ul className="catalog-grid">
                  {inCategory.map((effect) => {
                    const k = zoom(effect.width, effect.height);
                    return (
                      <li key={effect.id} className={`catalog-card${effect.needsCharacter ? " catalog-card-off" : ""}`}>
                        {effect.still ? (
                          <div className="catalog-stage">
                            <img src={effect.still} alt={`${effect.name}: one frame of the effect`} width={effect.width * k} height={effect.height * k} loading="lazy" />
                          </div>
                        ) : null}
                        <div className="catalog-body">
                          <h3>{effect.id}</h3>
                          <p className="catalog-facts">
                            {effect.width}×{effect.height} · {effect.loop ? "loops" : "plays once"}, {effect.duration}s
                            {effect.needsCharacter ? " · needs a character" : ""}
                          </p>
                          <p>{effect.description}</p>
                          {effect.needsCharacter ? null : (
                            <code className="catalog-command">pixelkiln vfx --lib pixelfx --effect {effect.id} --out fx/{effect.id.split("/")[1]}</code>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
