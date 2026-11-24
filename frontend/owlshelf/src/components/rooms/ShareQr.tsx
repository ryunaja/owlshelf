/**
 * ShareQr.tsx — the invite fragment as a scannable code (plan §6.7).
 *
 * The fragment is ~350–450 bytes, which at ECC M lands around QR version 12–16:
 * dense, but the plan's own budget, and the reason §6.7 has a documented
 * fallback (a short code plus owner-mediated exchange) if field testing shows
 * scan failures. Nothing here truncates or compresses the fragment to make the
 * code prettier — a QR that does not encode the whole trust anchor is worse
 * than no QR.
 *
 * Rendering: one `<path>` of 1×1 modules rather than a `<rect>` per dark cell.
 * A version-13 code is 73×73 with the quiet zone, so the rect version would put
 * a few thousand nodes in the dialog; the path is one node and scales cleanly
 * with `viewBox`.
 */

import { useMemo } from "react";
import { encode } from "uqr";

interface ShareQrProps {
  /** The full `owlshelf://join?...` fragment. */
  text: string;
  size?: number;
}

export function ShareQr({ text, size = 220 }: ShareQrProps) {
  const qr = useMemo(() => {
    try {
      // ECC M: 15% recoverable, the level §6.7's size budget assumes.
      return encode(text, { ecc: "M", border: 2 });
    } catch {
      // `uqr` throws when the payload cannot fit any version at this ECC. The
      // dialog must still work: the text and the copy button are the fallback.
      return null;
    }
  }, [text]);

  if (!qr) {
    return (
      <p className="share-qr-fallback">
        This invite is too large to draw as a QR code. Use <strong>Copy</strong> and send it
        through a channel you trust.
      </p>
    );
  }

  let d = "";
  for (let y = 0; y < qr.size; y += 1) {
    const row = qr.data[y];
    for (let x = 0; x < qr.size; x += 1) {
      if (row?.[x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }

  return (
    <svg
      className="share-qr"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`Invite QR code (version ${qr.version}, error correction M)`}
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
