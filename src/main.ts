import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { init } from './app.ts';

const updateBanner = document.getElementById('update-banner');
const updateBannerBtn = document.getElementById('update-banner-btn');

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;

    setInterval(() => {
      if (navigator.onLine) void registration.update();
    }, 60 * 1000);
  },
  onNeedRefresh() {
    // Let the player choose when to reload instead of yanking the tab out
    // from under an in-progress game (unsent moves live only in memory).
    updateBanner?.classList.add('show');
  },
  onOfflineReady() {
    // The app is cached and ready for offline use.
  },
});

updateBannerBtn?.addEventListener('click', () => {
  void updateSW(true);
});

document.addEventListener('DOMContentLoaded', init);
