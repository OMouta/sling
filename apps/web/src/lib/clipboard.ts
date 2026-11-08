/**
 * Copies text to the clipboard. Browsers only offer the Clipboard API on HTTPS
 * and localhost, so on a plain-HTTP address, such as Sling on the local
 * network, this selects the text in a hidden field and runs the copy command
 * instead. Resolves false when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused, for example when the page isn't focused: try the command.
    }
  }
  return copyWithCommand(text);
}

function copyWithCommand(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  // Off screen. 16px keeps iOS from zooming in when it takes focus.
  field.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
  // Inside an open dialog, so focus doesn't leave it.
  (previous?.closest<HTMLElement>("[role=dialog]") ?? document.body).append(field);
  field.focus({ preventScroll: true });
  field.select();
  field.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  previous?.focus({ preventScroll: true });
  return copied;
}
