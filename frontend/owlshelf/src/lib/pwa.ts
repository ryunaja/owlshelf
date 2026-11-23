/**
 * pwa.ts — service-worker registration and update policy.
 *
 * The plugin's injected registration only calls `register()` on load. A new
 * worker then activates (the build sets `skipWaiting` + `clientsClaim`) but
 * the running page keeps the old bundle until the user reloads — and a
 * long-lived tab never asks for a new worker at all, so the only way out is
 * clearing site data. This registration owns the lifecycle instead:
 *
 * - the worker script is fetched with `updateViaCache: "none"`, so a CDN's
 *   HTTP cache cannot pin an old `sw.js`;
 * - a NEW worker taking control reloads the page exactly once (never on the
 *   first install, where there is nothing to replace);
 * - an update check runs on load, whenever the tab becomes visible, when the
 *   network comes back, and every 15 minutes.
 *
 * Dev builds register nothing: `devOptions.enabled` is false in
 * vite.config.ts, and a dev SW serves stale bundles (plan §12.14).
 */

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;

  // A page loaded without a controller is a first install: the worker
  // claiming it is not an update, so it must not trigger a reload.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const register = async (): Promise<void> => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });

      const check = (): void => {
        void registration.update().catch(() => {
          /* offline or the server is down — the next trigger retries */
        });
      };

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.addEventListener("online", check);
      window.setInterval(check, UPDATE_INTERVAL_MS);
    } catch (e) {
      console.warn("[owlshelf] service worker registration failed", e);
    }
  };

  if (document.readyState === "complete") void register();
  else window.addEventListener("load", () => void register(), { once: true });
}
