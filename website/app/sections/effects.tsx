import { CodeWindow } from "@/app/ui/code-window";
import { TrackedLink } from "@/app/ui/tracked-link";

export function EffectsSection() {
  return (
        <section className="effects-section" id="effects">
          <div className="shell">
            <div className="section-heading split-heading">
              <div>
                <h2>Free effects on your sprites.</h2>
              </div>
              <p className="section-deck">
                <code>pixelkiln vfx</code> drives PixelLab&apos;s VFX workbench. Start
                from one of its presets or layer its parts, build the effect around
                a character, and get a spritesheet, a GIF, an atlas, and a game pack
                with every piece as its own clip. The workbench renders a recipe
                instead of generating, so it costs nothing on a subscription, and
                the recipe it saves renders the same pixels again.
              </p>
            </div>
            <div className="effects-strip">
              <figure>
                <picture>
                  <source media="(prefers-reduced-motion: reduce)" srcSet="/effects/robot-shield-still.png" />
                  <img src="/effects/robot-shield.gif" alt="A shimmering bubble shield around the robot" width={192} height={192} loading="lazy" />
                </picture>
                <figcaption><b>shield_bubble</b> preset</figcaption>
              </figure>
              <figure>
                <picture>
                  <source media="(prefers-reduced-motion: reduce)" srcSet="/effects/robot-aura-still.png" />
                  <img src="/effects/robot-aura.gif" alt="A crackling blue aura rising around the robot" width={192} height={224} loading="lazy" />
                </picture>
                <figcaption><b>aura</b> preset, electric ramp</figcaption>
              </figure>
              <figure>
                <picture>
                  <source media="(prefers-reduced-motion: reduce)" srcSet="/effects/robot-lightning-still.png" />
                  <img src="/effects/robot-lightning.gif" alt="A lightning bolt striking the robot, with a shockwave ring" width={192} height={256} loading="lazy" />
                </picture>
                <figcaption><b>lightning_strike</b> preset, one-shot</figcaption>
              </figure>
              <figure>
                <picture>
                  <source media="(prefers-reduced-motion: reduce)" srcSet="/effects/robot-stun-still.png" />
                  <img src="/effects/robot-stun.gif" alt="Stars circling over the robot's head" width={142} height={186} loading="lazy" />
                </picture>
                <figcaption><b>stun_stars</b> part</figcaption>
              </figure>
            </div>
            <div className="effects-bottom">
              <CodeWindow
                title="terminal"
                language="shell"
                copyId="effects_vfx_commands"
                section="effects"
                code={`
pixelkiln vfx --preset lightning_strike --sprite robot.png --out fx/zap
# writes fx/zap.png  .gif  .json  .vfx.json

pixelkiln vfx --recipe fx/zap.vfx.json --out fx/zap-again
`}
              />
              <ul className="check-list effects-list">
                <li><span className="tick" aria-hidden="true" /> 17 presets and about 90 parts: explosions, slashes, auras, shields, status icons, weather.</li>
                <li><span className="tick" aria-hidden="true" /> Every effect is saved to your PixelLab account, where its sliders can be moved; <code>--effect</code> pulls the edit back down.</li>
                <li><span className="tick" aria-hidden="true" /> A <code>.vfx.json</code> record keeps the full recipe; re-rendering one gave a byte-identical sheet.</li>
              </ul>
            </div>
            <div className="review-links">
              <TrackedLink className="text-link" id="effects_cli_docs" section="effects" href="/docs/cli#vfx">
                Read the vfx reference
              </TrackedLink>
            </div>
          </div>
        </section>
  );
}
