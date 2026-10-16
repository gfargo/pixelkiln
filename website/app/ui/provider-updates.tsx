import { providerUpdates, type ProviderUpdate, type UpdateFigure } from "@/app/lib/provider-updates";
import { CodeWindow } from "@/app/ui/code-window";
import { TrackedLink } from "@/app/ui/tracked-link";

/** Text with `backticks` rendered as inline code. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? <code key={index}>{part}</code> : part,
      )}
    </>
  );
}

function Figure({ figure }: { figure: UpdateFigure }) {
  const image = (
    // These are pixel art at their own size; next/image would resample them.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={figure.src}
      alt={figure.alt}
      width={figure.width}
      height={figure.height}
      loading="lazy"
      style={figure.fill ? { width: "100%" } : undefined}
    />
  );
  return (
    <figure className={figure.wide ? "updates-wide" : undefined}>
      <picture>
        {figure.still ? <source media="(prefers-reduced-motion: reduce)" srcSet={figure.still} /> : null}
        {image}
      </picture>
      <figcaption>
        <b>{figure.title}</b> {figure.caption}
      </figcaption>
    </figure>
  );
}

function Links({ update }: { update: ProviderUpdate }) {
  return (
    <div className="review-links">
      {update.links.map((link) => (
        <TrackedLink key={link.id} className="text-link" id={link.id} section="provider_updates" href={link.href}>
          {link.label}
        </TrackedLink>
      ))}
    </div>
  );
}

function Featured({ update }: { update: ProviderUpdate }) {
  return (
    <div className="updates-featured" id={update.id}>
      <p className="updates-meta">
        <b>{update.provider}</b> {update.release} · {update.date}
      </p>
      <h3>{update.title}</h3>
      <p className="updates-summary">
        <Inline text={update.summary} />
      </p>
      {update.figures?.length ? (
        <div className="effects-strip updates-strip">
          {update.figures.map((figure) => (
            <Figure key={figure.src} figure={figure} />
          ))}
        </div>
      ) : null}
      <div className="effects-bottom">
        {update.code ? (
          <CodeWindow
            title={update.code.title}
            language={update.code.language}
            copyId={update.code.copyId}
            section="provider_updates"
            code={update.code.code}
          />
        ) : null}
        <ul className="check-list effects-list">
          {update.features.map((feature) => (
            <li key={feature}>
              <span>✓</span> <Inline text={feature} />
            </li>
          ))}
        </ul>
      </div>
      <Links update={update} />
    </div>
  );
}

function Earlier({ update }: { update: ProviderUpdate }) {
  return (
    <article className="updates-row" id={update.id}>
      <p className="updates-meta">
        <b>{update.provider}</b> {update.release}
        <br />
        {update.date}
      </p>
      <div>
        <h3>{update.title}</h3>
        <p className="updates-summary">
          <Inline text={update.summary} />
        </p>
        <ul className="updates-list">
          {update.features.map((feature) => (
            <li key={feature}>
              <Inline text={feature} />
            </li>
          ))}
        </ul>
        <Links update={update} />
      </div>
    </article>
  );
}

export function ProviderUpdates() {
  const [latest, ...earlier] = providerUpdates;
  if (!latest) return null;
  return (
    <section className="effects-section updates-section" id="updates">
      <div className="shell">
        <div className="section-heading split-heading">
          <div>
            <h2>Latest updates<br />from our providers.</h2>
          </div>
          <p className="section-deck">
            When a provider ships something PixelKiln can drive, it lands here
            with what it cost. The newest update shows real output from the
            project&apos;s own manifests, and each earlier one keeps a short
            note and its reference.
          </p>
        </div>
        <Featured update={latest} />
        {earlier.length ? (
          <div className="updates-earlier">
            {earlier.map((update) => (
              <Earlier key={update.id} update={update} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
