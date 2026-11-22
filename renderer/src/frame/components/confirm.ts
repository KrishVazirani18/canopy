// The one row every building block ends with: a primary button on the right, disabled until there is something to
// send; once sent, a quiet "Sent" in its place, at the same height, so nothing below moves.
import { esc } from '../element';

export const CONFIRM_CSS = `
.foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-height: 32px; margin-top: 12px; }
.foot .done { display: none; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--color-text-tertiary); }
.foot .done svg { width: 12px; height: 12px; }
.foot .aside { margin-right: auto; }
:host([data-locked]) .foot button { display: none; }
:host([data-locked]) .foot .done { display: inline-flex; }
`;

const CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3L9.5 3.6"/></svg>';

/** The row's markup. `aside` is anything that sits at its left (a Reset). */
export const confirmRow = (aside = '') => `<div class="foot" part="confirm">${aside}<span class="done">${CHECK}Sent</span><button class="primary send" type="button" disabled></button></div>`;

/** Bring the row's button up to date without redrawing it (it may have focus). */
export function updateConfirm(root: ShadowRoot, label: string, ready: boolean) {
  const b = root.querySelector<HTMLButtonElement>('button.send');
  if (!b) return;
  if (b.textContent !== label) b.textContent = label;
  if (b.disabled === ready) b.disabled = !ready;
}

export { esc };
