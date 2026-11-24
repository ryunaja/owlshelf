/**
 * socket.mjs — a `SocketLike` over `ws`, with a real `Origin` header.
 *
 * The relay refuses a connection whose `Origin` is missing or not in
 * `ALLOWED_ORIGINS` (`origin_allowed` fails closed, §9 admission step 1). A
 * browser always sends one; Node's built-in `WebSocket` cannot be told to. That
 * single fact is why §5.3 stayed manual for so long — "the browser is the only
 * honest client".
 *
 * `ws` is the exception: it takes an `origin` option, so the shipped engine can
 * drive the shipped relay from Node. The adapter below is the whole of the
 * difference — the engine sees the same four handlers it sees in a browser.
 */

import { WebSocket } from "ws";

/**
 * A `SocketFactory` that dials with `origin`.
 *
 * `ws` reports close codes and reasons differently from the browser
 * (`(code, Buffer)` rather than an event), and it emits `error` before `close`
 * on a failed dial. Both are normalised here so the engine's close-code table
 * sees exactly what a browser would give it.
 */
export function relaySocketFactory(origin) {
  return (url) => {
    const ws = new WebSocket(url, { origin });

    const socket = {
      url,
      /** Frames the engine sent, for assertions. */
      sent: [],
      closed: null,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data) {
        socket.sent.push(JSON.parse(data));
        ws.send(data);
      },
      close(code, reason) {
        socket.closed = { code, reason };
        try {
          ws.close(code, reason);
        } catch {
          /* already gone */
        }
      },
    };

    ws.on("open", () => socket.onopen?.({}));
    ws.on("message", (data) => socket.onmessage?.({ data: data.toString() }));
    ws.on("close", (code, reason) => {
      socket.onclose?.({ code, reason: reason.toString() });
    });
    ws.on("error", (error) => {
      // `ws` always follows an error with a close, so the engine's no-op
      // `onerror` is correct here too.
      socket.onerror?.(error);
    });

    return socket;
  };
}
