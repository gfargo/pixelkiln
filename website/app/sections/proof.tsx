

export function ProofSection() {
  return (
        <section className="proof-strip" aria-label="PixelKiln at a glance">
        <div className="shell proof-grid">
          <div>
            <strong>04</strong>
            <span>generation providers</span>
          </div>
          <div>
            <strong>46</strong>
            <span>composable commands</span>
          </div>
          <div>
            <strong>00</strong>
            <span>LLM calls in the loop</span>
          </div>
          <p>
            You choose every image.
            <br />
            PixelKiln does the polling, hashing, and file placement the same way every time.
          </p>
        </div>
        </section>
  );
}
