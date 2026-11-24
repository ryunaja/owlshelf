/**
 * clipboard.ts — copy text without assuming a secure context.
 *
 * `navigator.clipboard` is gated on a secure context, and the app runs on
 * `http://<lan-ip>:4173` whenever it is opened from a phone during testing —
 * exactly where `crypto.subtle` is also absent. The invite is the one string a
 * user must move between devices by hand in that case, so falling back to the
 * old selection trick is the difference between "copy" and "copy by editing the
 * page source".
 *
 * Both paths are best-effort: the caller shows the text in a selectable field
 * anyway, so a refusal is a hint, never a dead end.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection path */
  }

  if (typeof document === "undefined") return false;

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: `display: none` is not selectable in some
    // engines, and the scroll jump is the visible artefact we are avoiding.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
