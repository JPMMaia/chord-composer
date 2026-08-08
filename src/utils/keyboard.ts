/**
 * True for the elements that own their own keys — text fields and dropdowns.
 *
 * Every window-level shortcut has to bail on these, or typing a project name would
 * transpose the selection and pressing S in a text box would open a save dialog.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}
