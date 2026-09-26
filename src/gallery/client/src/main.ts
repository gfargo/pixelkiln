import { refresh } from "./refresh.ts"
import { openStudio } from "./studio.ts"
import { openCompare } from "./compare.ts"
import { $, S, backdropControl, loadPrefs, savePrefs, ui } from "./core.ts"
import { closeItem, drawerFrames, keyFromHash, readUrlState, render, step, stopPlayback } from "./drawer.ts"
import { pollEditor } from "./editor.ts"
import { familyState } from "./family.ts"
import { enableNotifications, pollJobs } from "./jobs.ts"
import { setPlayLoops } from "./motion.ts"
import { setSelecting } from "./selection.ts"
import { closeEditorSheet } from "./sheet.ts"

loadPrefs();
$('refresh').onclick = refresh;
$('select').onclick = () => setSelecting(!ui.selecting);
$('playloops').checked = ui.playLoops;
$('playloops').onchange = (e) => { setPlayLoops(e.target.checked); savePrefs(); };
$('backdrop-slot').replaceWith(backdropControl());
// Notifications only mean something while jobs can run from this page.
$('notify-chip').hidden = !GENERATION || typeof Notification === 'undefined';
$('notify').checked = ui.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted';
$('notify').onchange = async (e) => {
  const on = e.target.checked && await enableNotifications();
  e.target.checked = on;
  ui.notify = on;
  savePrefs();
};
$('studio').hidden = !EDITABLE;
$('studio').onclick = openStudio;
let autoTimer: ReturnType<typeof setTimeout> | null = null;
$('auto').onchange = (e) => {
  if (autoTimer) clearInterval(autoTimer ?? undefined);
  autoTimer = e.target.checked ? setInterval(() => { if (!document.hidden) refresh(); }, 5000) : null;
};

// ---- input ----------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | null = null;
$('q').addEventListener('input', (e) => {
  ui.q = e.target.value;
  clearTimeout(searchTimer ?? undefined);
  searchTimer = setTimeout(render, 90);
});
$('sort').onchange = (e) => { ui.sort = e.target.value; render(); };
$('group').onchange = (e) => { ui.group = e.target.value; render(); };
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus(); return; }
  if (e.key === 'Escape') {
    if (typing && document.activeElement?.id === 'q') { (document.activeElement as HTMLElement).blur(); return; }
    if (S.SHEET) { e.preventDefault(); closeEditorSheet(); return; }
    if ($('dialog-host').childNodes.length) { e.preventDefault(); $('dialog-host').textContent = ''; return; }
    if (ui.open) { e.preventDefault(); closeItem(); return; }
    if (ui.selecting) { e.preventDefault(); setSelecting(false); }
    return;
  }
  if (ui.open && !typing && !$('dialog-host').childNodes.length) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    const frames = drawerFrames();
    if (frames && (e.key === ',' || e.key === '.')) { e.preventDefault(); frames.step(e.key === ',' ? -1 : 1); }
    else if (frames && e.key === ' ' && !/^(BUTTON|A)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); frames.toggle(); }
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });

readUrlState();
$('q').value = ui.q;
$('sort').value = ui.sort;
$('group').value = ui.group;
const initialKey = keyFromHash();
if (initialKey && S.snap.items.some((i) => i.id === initialKey)) ui.open = initialKey;
ui.compare = ui.compare.filter((id) => S.snap.items.some((i) => i.id === id));
render();
if (ui.open) document.querySelector('.card.active')?.scrollIntoView({ block: 'center' });
if (GENERATION) pollJobs();
if (EDITOR) pollEditor();
if (ui.compare.length >= 2 && !ui.open) openCompare();

// A read-only handle for browser tests and the devtools console: the page's
// state lives inside the bundle, where a script evaluated in the page cannot
// otherwise see it.
(window as unknown as { __pixelkiln: unknown }).__pixelkiln = { S, ui, family: familyState };
