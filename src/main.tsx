import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Safely render app entry point with crash recovery
const rootElement = document.getElementById('root');
if (rootElement) {
  try {
    createRoot(rootElement).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  } catch (err: any) {
    console.error('[Root Mount] Fatal render error:', err);
    rootElement.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;padding:24px;text-align:center;background:#f8fafc;">
        <div style="background:#fff;padding:32px;border-radius:20px;max-width:440px;box-shadow:0 10px 30px rgba(0,0,0,0.08);border:1px solid #e2e8f0;">
          <div style="width:50px;height:50px;background:#ecfdf5;color:#059669;border-radius:12px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;">Z</div>
          <h2 style="color:#0f172a;margin-bottom:8px;font-size:20px;font-weight:800;">Zypso Mart Admin</h2>
          <p style="color:#64748b;font-size:13px;line-height:1.5;margin-bottom:20px;">The application initialized with a temporary environment state. Click below to refresh.</p>
          <button onclick="window.location.reload()" style="background:#059669;color:#fff;border:none;padding:12px 24px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;width:100%;">
            Reload Application
          </button>
        </div>
      </div>
    `;
  }
}

// Register PWA service worker safely in background without blocking root render
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  try {
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
        console.warn('[PWA] Service Worker registration skipped:', error);
      },
    });
  } catch (err) {
    console.warn('[PWA] Service Worker registration ignored:', err);
  }
}
