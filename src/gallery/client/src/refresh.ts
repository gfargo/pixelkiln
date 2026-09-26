import { $, S } from "./core.ts"
import { renderQuietly } from "./drawer.ts"

// ---- refresh --------------------------------------------------------------

let refreshing = false;
export async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const b = $('refresh');
  b.disabled = true;
  try {
    const res = await fetch('/api/gallery.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    S.snap = await res.json();
    $('note').textContent = '';
    // Refresh is often automatic or mid-job; never discard a form in progress.
    renderQuietly();
  } catch (err) {
    $('note').textContent = ' Refresh failed: ' + err.message + '. Is pixelkiln gallery still running?';
  } finally {
    refreshing = false;
    b.disabled = false;
  }
}
