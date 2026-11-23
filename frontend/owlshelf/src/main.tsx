import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { requestPersistentStorage } from '@/lib/db'
import { registerServiceWorker } from '@/lib/pwa'

// Dev-only service-worker hygiene (plan §12.14): dev SWs serve stale cached
// bundles and break migration debugging. ?clear-sw unregisters every SW and
// clears every cache, then reloads clean. Never registered in prod builds.
if (import.meta.env.DEV && typeof location !== "undefined" && location.search.includes("clear-sw")) {
  (async () => {
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      location.replace(location.pathname); // drop ?clear-sw from the URL
    } catch (e) {
      console.warn("[owlshelf] clear-sw failed", e);
      location.reload();
    }
  })();
}

// Persistence ask from a tab context (plan §12.15). Refusal is honest, not
// fatal — the answer is surfaced on the console for now, sync status later.
requestPersistentStorage();

// Production only (dev builds register nothing): pulls the latest worker on
// load and reloads once when a new version takes control.
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
