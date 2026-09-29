import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register PWA service worker with auto-update handling
registerSW({
  immediate: true,
  onNeedRefresh() {
    console.log('[PWA] New version detected');
  },
  onOfflineReady() {
    console.log('[PWA] Content cached for offline use');
  },
  onRegistered(registration) {
    console.log('[PWA] Service Worker registered successfully:', registration?.scope);
  },
  onRegisterError(error) {
    console.warn('[PWA] Service Worker registration failed:', error);
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
