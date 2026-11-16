import { CodeBody } from "@/app/ui/code-window";
import { TrackedLink } from "@/app/ui/tracked-link";

export function SafetySection() {
  return (
        <section className="safety-section" id="recovery">
          <div className="shell safety-grid">
            <div className="section-heading safety-copy">
              <h2>Paid work needs a paper trail.</h2>
              <p className="section-deck">
                Every provider object, prompt identity, output role, path, and
                byte hash survives in project state. A failed download remains
                recoverable work, not a reason to pay twice.
              </p>
              <ul className="check-list">
                <li><span>✓</span> Remote identity saved before polling</li>
                <li><span>✓</span> Content-addressed local recovery cache</li>
                <li><span>✓</span> Hand edits kept beside the generated file</li>
                <li><span>✓</span> Replaced generations kept, restorable at no cost</li>
                <li><span>✓</span> Manual-edit and overwrite protection</li>
                <li><span>✓</span> Transactional atlas and export writes</li>
              </ul>
              <TrackedLink className="text-link" id="safety_recovery" section="safety" href="/docs/recovery">
                Explore recovery guarantees
              </TrackedLink>
            </div>
            <div className="lock-visual" aria-label="Example provenance lock entry">
              <div className="lock-label">pixelkiln.lock.json</div>
              <CodeBody language="json" code={`
{
  "base/anvil": {
    "status": "downloaded",
    "provider": "pixellab",
    "specHash": "61c9…a071",
    "cost": { "value": 1,
              "unit": "generations" },
    "outputs": [{
      "path": "art/base/anvil.png",
      "sha256": "98f1…c42a"
    }]
  }
}
`} />
              <div className="lock-callout top"><span>◇</span> paid-work identity</div>
              <div className="lock-callout bottom"><span>◇</span> exact output bytes</div>
            </div>
          </div>
        </section>
  );
}
