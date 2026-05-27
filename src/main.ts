import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { init } from './app.ts';

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;

    setInterval(() => {
      if (navigator.onLine) void registration.update();
    }, 60 * 1000);
  },
  onNeedRefresh() {
    void updateSW(true);
  },
  onOfflineReady() {
    // The app is cached and ready for offline use.
  },
});

document.addEventListener('DOMContentLoaded', init);
