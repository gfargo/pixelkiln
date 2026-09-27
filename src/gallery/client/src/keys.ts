import { $, el } from "./core.ts"

/**
 * The `?` sheet: every keyboard shortcut and pointer gesture the page
 * answers to, grouped by where it applies, in place of the footer
 * paragraph that used to list half of them.
 */
const GROUPS: Array<{ title: string; keys: Array<[string[], string]> }> = [
  {
    title: 'Anywhere',
    keys: [
      [['/'], 'jump to search'],
      [['?'], 'this list'],
      [['Esc'], 'close whatever is open: a sheet, the record, the View menu, or select mode'],
      [['⌘/ctrl', 'Z'], 'undo the gallery\'s last manifest edit (with --edit)'],
    ],
  },
  {
    title: 'On the grid',
    keys: [
      [['click'], 'open a record'],
      [['shift', 'click'], 'add it to a side-by-side comparison (up to four)'],
      [['ctrl/⌘', 'click'], 'select it; the bar at the bottom acts on the selection'],
      [['hover'], 'play a loop'],
    ],
  },
  {
    title: 'With a record open',
    keys: [
      [['←', '→'], 'step through the records in view'],
      [[',', '.'], 'step a loop one frame back or on'],
      [['space'], 'play or pause a loop'],
      [['←', '→'], 'switch tabs, once a tab has focus'],
    ],
  },
  {
    title: 'In the family view',
    keys: [
      [['drag'], 'turn the sprite on the turntable'],
      [['←', '→'], 'turn it a step, once the turntable has focus'],
    ],
  },
];

export function openShortcuts() {
  const host = $('dialog-host');
  host.textContent = '';
  const wrap = el('div', 'dialog');
  wrap.onclick = (e) => { if (e.target === wrap) host.textContent = ''; };
  const box = el('div', 'keys-sheet');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Keyboard shortcuts');
  const head = el('div', 'keys-head');
  head.append(el('h3', null, 'Keyboard shortcuts'));
  const close = el('button', null, 'Close'); close.type = 'button';
  close.onclick = () => { host.textContent = ''; };
  head.append(close);
  box.append(head);
  for (const group of GROUPS) {
    const section = el('section');
    section.append(el('h4', null, group.title));
    const dl = el('dl');
    for (const [keys, what] of group.keys) {
      const dt = el('dt');
      keys.forEach((k, i) => {
        if (i) dt.append(document.createTextNode(k === 'click' ? '+' : ' '));
        dt.append(el('kbd', null, k));
      });
      dl.append(dt, el('dd', null, what));
    }
    section.append(dl);
    box.append(section);
  }
  wrap.append(box);
  host.append(wrap);
  close.focus();
}
