const serviceWorkers = [];

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      const registration =
        await navigator.serviceWorker.register("/service-worker.js");
      console.log("Service worker registered with scope: ", registration.scope);
    } catch (e) {
      console.log("Failed to register service worker: " + e);
    }
  }
}

registerServiceWorker();
