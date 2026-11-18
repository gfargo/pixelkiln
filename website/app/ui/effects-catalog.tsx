"use client";

import { useMemo, useState } from "react";
import type { CodexEffect, LocalCategory, LocalEffect, Preset } from "@/app/lib/effects-catalog";

type Still = { gif: string; src: string; width: number; height: number; alt: string };

/** The largest whole-number zoom that keeps a still inside a card's stage. */
function zoom(width: number, height: number) {
  return Math.max(1, Math.min(3, Math.floor(Math.min(240 / width, 150 / height))));
}

function matches(query: string, ...fields: string[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** All three catalogs with one filter box over them. Everything is in the page; the filter only hides cards. */
export function EffectsCatalog({
  presets,
  presetStills,
  presetsReadOn,
  categories,
  effects,
  version,
  codexEffects,
  codexCategories,
  codexVersion,
}: {
  presets: Preset[];
  presetStills: Record<string, Still>;
  presetsReadOn: string;
  categories: LocalCategory[];
  effects: LocalEffect[];
  version: string;
  codexEffects: CodexEffect[];
  codexCategories: string[];
  codexVersion: string;
}) {
  const [query, setQuery] = useState("");
  // Presets this site has a picture of lead, so the first row is a full row of pictures.
  const shownPresets = useMemo(
    () =>
      presets
        .filter((preset) => matches(query, preset.name, preset.summary))
        .sort((a, b) => Number(Boolean(presetStills[b.name] ?? b.gif)) - Number(Boolean(presetStills[a.name] ?? a.gif))),
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
  const shownCodex = useMemo(
    () => codexEffects.filter((effect) => matches(query, effect.id, effect.name, effect.description, effect.category, ...effect.schools)),
    [codexEffects, query],
  );

  return (
    <>
      <div className="catalog-bar">
        <div className="shell">
        <label className="catalog-filter">
          <span>Filter all three lists</span>
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
          {shownPresets.length} of {presets.length} presets, {shownEffects.length} of {effects.length} pixelfx, {shownCodex.length} of {codexEffects.length} codex
        </p>
        </div>
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
              <code>--sprite</code>. Most are shown here as the workbench draws
              them with none; the ones that only light or wrap a sprite are
              shown on a robot, a chest or a kiln. PixelLab adds to this list; it was read
              from the workbench on {presetsReadOn}, and{" "}
              <code>pixelkiln vfx presets</code> prints today&apos;s.
            </p>
          </div>
          {shownPresets.length ? (
            <ul className="catalog-grid">
              {shownPresets.map((preset) => {
                const still: Still | undefined =
                  presetStills[preset.name] ??
                  (preset.gif && preset.still
                    ? { gif: preset.gif, src: preset.still, width: preset.width, height: preset.height, alt: `The ${preset.name} preset, animated` }
                    : undefined);
                const k = still ? zoom(still.width, still.height) : 1;
                return (
                  <li key={preset.name} className="catalog-card">
                    {still ? (
                      <div className="catalog-stage">
                        <picture>
                          <source media="(prefers-reduced-motion: reduce)" srcSet={still.src} />
                          <img src={still.gif} alt={still.alt} width={still.width * k} height={still.height * k} loading="lazy" />
                        </picture>
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
              alone and PixelKiln renders them. The other{" "}
              {effects.length - standalone} are built around a character;
              they are shown here acted out by pixelfx&apos;s own stand-in
              figure, and PixelKiln does not render them yet.
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
                <h3>{category.name}</h3>
                {category.blurb ? <p>{category.blurb}</p> : null}
                <ul className="catalog-grid">
                  {inCategory.map((effect) => {
                    const art = effect.art ?? { width: effect.width, height: effect.height };
                    const k = zoom(art.width, art.height);
                    return (
                      <li key={effect.id} className="catalog-card">
                        {effect.still ? (
                          <div className="catalog-stage">
                            <picture>
                              {effect.anim ? <source media="(prefers-reduced-motion: no-preference)" srcSet={effect.anim} type="image/webp" /> : null}
                              <img src={effect.still} alt={`${effect.name}: the effect ${effect.anim ? "playing" : "in one frame"}`} width={art.width * k} height={art.height * k} loading="lazy" />
                            </picture>
                          </div>
                        ) : null}
                        <div className="catalog-body">
                          <h3>{effect.id}</h3>
                          <p className="catalog-facts">
                            {effect.width}×{effect.height} · {effect.loop ? "loops" : "plays once"}, {effect.duration}s
                          </p>
                          <p>{effect.description}</p>
                          {effect.needsCharacter ? (
                            <p className="catalog-note">Needs a character. Shown with pixelfx&apos;s stand-in; PixelKiln does not render it yet.</p>
                          ) : (
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

      <section className="catalog-section" id="codex">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <h2>pixel-vfx-codex effects.</h2>
            </div>
            <p className="section-deck">
              Every effect in{" "}
              <a className="catalog-link" href="https://github.com/888wing/pixel-vfx-codex" rel="noreferrer">pixel-vfx-codex</a>{" "}
              {codexVersion}, an MIT-licensed library by 888wing and
              contributors, rendered on your own machine with{" "}
              <code>--lib codex</code>. Each is defined once in 3D, so{" "}
              <code>--camera</code> shows it side-on (shown here), isometric
              or orbiting. Effects take their own <code>--param</code> values and
              recolor with <code>--hue</code>.
            </p>
          </div>
          <nav className="catalog-jump" aria-label="pixel-vfx-codex categories">
            {codexCategories.map((category) => {
              const count = shownCodex.filter((effect) => effect.category === category).length;
              return count ? (
                <a key={category} href={`#codex-${category}`}>
                  {category} <span>{count}</span>
                </a>
              ) : null;
            })}
          </nav>
          {shownCodex.length ? null : <p className="catalog-empty">No pixel-vfx-codex effect matches “{query}”.</p>}
          {codexCategories.map((category) => {
            const inCategory = shownCodex.filter((effect) => effect.category === category);
            if (!inCategory.length) return null;
            return (
              <div key={category} className="catalog-category" id={`codex-${category}`}>
                <h3>{category}</h3>
                <ul className="catalog-grid">
                  {inCategory.map((effect) => {
                    const k = zoom(effect.art.width, effect.art.height);
                    return (
                      <li key={effect.id} className="catalog-card">
                        <div className="catalog-stage">
                          <picture>
                            {effect.anim ? <source media="(prefers-reduced-motion: no-preference)" srcSet={effect.anim} type="image/webp" /> : null}
                            <img src={effect.still} alt={`${effect.name}: the effect ${effect.anim ? "playing" : "in one frame"}`} width={effect.art.width * k} height={effect.art.height * k} loading="lazy" />
                          </picture>
                        </div>
                        <div className="catalog-body">
                          <h3>{effect.id}</h3>
                          <p className="catalog-facts">
                            {effect.art.width}×{effect.art.height} · loops, {effect.seconds}s
                            {effect.params.length ? ` · ${effect.params.length} parameters` : ""}
                          </p>
                          <p>{effect.name}. {effect.description}</p>
                          <code className="catalog-command">pixelkiln vfx --lib codex --effect {effect.id} --out fx/{effect.id}</code>
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
