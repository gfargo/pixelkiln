import { TrackedLink } from "@/app/ui/tracked-link";

export function CostsSection() {
  return (
        <section className="generator-section" id="costs">
          <div className="shell">
            <div className="section-heading split-heading">
              <div>
                <h2>One sprite, 1 to 25 generations.</h2>
              </div>
              <p className="section-deck">Measured PixelLab costs vary by up to 25×. Retro Diffusion bills in USD, Scenario in compute units, and self-hosted ComfyUI has no provider charge. PixelKiln keeps those units separate.</p>
            </div>
            <div className="generator-table">
              <div className="generator-row header"><span>Generator</span><span>Best for</span><span>Measured cost</span></div>
              <div className="generator-row"><strong>map</strong><span>Standalone props and icons</span><span><i style={{ width: "4%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>pixflux</strong><span>Exact closed palettes</span><span><i style={{ width: "4%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>imagePro</strong><span>Non-square or larger scenes, style transfer, a target palette</span><span><i style={{ width: "100%" }} /> 10–25 gen by canvas</span></div>
              <div className="generator-row"><strong>1dir</strong><span>References and candidate variety</span><span><i style={{ width: "72%" }} /> 10–25 gen</span></div>
              <div className="generator-row"><strong>tiles</strong><span>Ground and structural sets</span><span><i style={{ width: "100%" }} /> 10–25 gen</span></div>
              <div className="generator-row"><strong>terrain</strong><span>Two-terrain tilesets, connected sets, and sidescroller platforms</span><span><i style={{ width: "60%" }} /> 15 gen Pro (25 at 64px), 3 standard or sidescroller</span></div>
              <div className="generator-row"><strong>isometricTile</strong><span>A single elevation tile, such as a mesa or a cliff block</span><span><i style={{ width: "4%" }} /> 1 gen</span></div>
              <div className="generator-row"><strong>character</strong><span>A base in 8 directions, its poses, its loops</span><span><i style={{ width: "28%" }} /> 1–25 gen per base by engine, 1–4 per template loop, mirrors free</span></div>
              <div className="generator-row"><strong>objectPro</strong><span>A skeleton-free prop&apos;s base, poses, and loops</span><span><i style={{ width: "28%" }} /> about 6 gen per base at 64px, 1 per loop (unmeasured)</span></div>
              <div className="generator-row"><strong>imageProFlash</strong><span>Styled stills on the Pro Flash model, 16–256px</span><span><i style={{ width: "36%" }} /> 5–9 gen (quoted)</span></div>
              <div className="generator-row"><strong>uiAsset</strong><span>UI panels, buttons, and bars from pieces and elements</span><span><i style={{ width: "100%" }} /> 10–25 gen (20 measured before PixelLab&apos;s price cut)</span></div>
              <div className="generator-row"><strong>uiElement</strong><span>One UI element from a description, 16px and up</span><span><i style={{ width: "100%" }} /> 10–25 gen (unmeasured)</span></div>
              <div className="generator-row"><strong>vfx</strong><span>Animated effects: explosions, spells, auras, hits, on their own or around a sprite</span><span><i style={{ width: "4%" }} /> free from presets, 1 gen and up when described</span></div>
              <div className="generator-row"><strong>animation</strong><span>Retro Diffusion GIFs and sprite sheets</span><span>USD quote</span></div>
              <div className="generator-row"><strong>frames</strong><span>Controlled ComfyUI still sequences</span><span>0 provider units</span></div>
            </div>
            <div className="review-links">
              <TrackedLink className="text-link" id="generator_compare" section="generator" href="/docs/generators">
                Compare generator capabilities
              </TrackedLink>
              <TrackedLink className="text-link" id="provider_compare" section="generator" href="/docs/provider-notes">
                Compare providers
              </TrackedLink>
            </div>
          </div>
        </section>
  );
}
