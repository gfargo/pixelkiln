import { FEATURES, type Feature } from "@/app/lib/features";
import { FeatureArt } from "@/app/ui/feature-art";
import { TrackedLink } from "@/app/ui/tracked-link";

/**
 * The way into each feature page. On the home page it lists all six; under a
 * feature page it lists the other five, smaller.
 */
export function HubSection({ except, heading, deck }: { except?: Feature["id"]; heading: string; deck?: string }) {
  const entries = FEATURES.filter((entry) => entry.id !== except && entry.inHub !== false);
  return (
    <section className={`hub-section shell${except ? " hub-more" : ""}`} id="features">
      <div className="section-heading hub-heading">
        <h2>{heading}</h2>
        {deck ? <p className="section-deck">{deck}</p> : null}
      </div>
      <ul className="hub-grid">
        {entries.map((entry) => (
          <li key={entry.id} className={`hub-tile hub-${entry.id}`}>
            <TrackedLink id={`hub_${entry.id}`} section={except ? "feature_page" : "hub"} href={entry.href}>
              <FeatureArt id={entry.id} />
              <span className="hub-copy">
                <strong>{entry.name}</strong>
                <span>{entry.summary}</span>
              </span>
            </TrackedLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
