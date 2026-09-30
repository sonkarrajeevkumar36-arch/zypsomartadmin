import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";
import { doc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { app, db, auth } from "../firebase";

export interface FCMRegistrationResult {
  success: boolean;
  token?: string;
  error?: string;
}

// Get VAPID key from env or fallback if configured
const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY || "";

let messagingInstance: ReturnType<typeof getMessaging> | null = null;

export async function getFCMInstance() {
  if (typeof window === "undefined") return null;
  const supported = await isSupported().catch(() => false);
  if (!supported) {
    console.warn("[FCM] Firebase Cloud Messaging is not supported in this browser environment.");
    return null;
  }
  if (!messagingInstance) {
    try {
      messagingInstance = getMessaging(app);
    } catch (err) {
      console.warn("[FCM] Initialization error:", err);
    }
  }
  return messagingInstance;
}

export function isNotificationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator
  );
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (!isNotificationSupported()) return "unsupported";
  return Notification.permission;
}

export function detectDeviceInfo() {
  if (typeof navigator === "undefined") {
    return { deviceType: "unknown", browser: "unknown", platform: "unknown" };
  }
  const ua = navigator.userAgent;
  let deviceType = "desktop";
  if (/mobile/i.test(ua)) deviceType = "mobile";
  else if (/tablet|ipad/i.test(ua)) deviceType = "tablet";

  let browser = "Other";
  if (/edg/i.test(ua)) browser = "Edge";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";

  let platform = "Other";
  if (/android/i.test(ua)) platform = "Android";
  else if (/iphone|ipad|ipod/i.test(ua)) platform = "iOS";
  else if (/macintosh|mac os x/i.test(ua)) platform = "macOS";
  else if (/windows/i.test(ua)) platform = "Windows";
  else if (/linux/i.test(ua)) platform = "Linux";

  return { deviceType, browser, platform };
}

/**
 * Register device for Push Notifications & FCM
 */
export async function registerDeviceForNotifications(adminEmail?: string): Promise<FCMRegistrationResult> {
  if (!isNotificationSupported()) {
    return { success: false, error: "Push notifications are not supported in this browser." };
  }

  try {
    // 1. Request browser notification permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { success: false, error: "Notification permission was denied by the browser." };
    }

    // 2. Ensure Service Worker is registered
    let swReg: ServiceWorkerRegistration | undefined;
    if ("serviceWorker" in navigator) {
      swReg = await navigator.serviceWorker.ready.catch(() => undefined);
      if (!swReg) {
        swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(() => undefined);
      }
    }

    // 3. Obtain FCM Token
    const messaging = await getFCMInstance();
    if (!messaging) {
      return {
        success: true,
        error: "FCM messaging is unsupported in this web view. In-app loud alarm is active."
      };
    }

    const tokenOptions: { serviceWorkerRegistration?: ServiceWorkerRegistration; vapidKey?: string } = {};
    if (swReg) {
      tokenOptions.serviceWorkerRegistration = swReg;
    }
    if (VAPID_KEY) {
      tokenOptions.vapidKey = VAPID_KEY;
    }

    let token = "";
    try {
      token = await getToken(messaging, tokenOptions);
    } catch (tokenErr: any) {
      console.warn("[FCM] getToken notice:", tokenErr?.message || tokenErr);
      return {
        success: true,
        error: "VAPID key pending in Firebase settings. In-app siren & realtime alarms active."
      };
    }

    if (token) {
      // 4. Save device token in localStorage
      localStorage.setItem("zypsomart_fcm_token", token);
      const deviceInfo = detectDeviceInfo();
      const currentEmail = adminEmail || auth.currentUser?.email || "admin@zypsomart.com";

      // 5. Direct write to Firestore admin_device_tokens using authenticated client SDK
      try {
        const docId = btoa(token).replace(/[+/=]/g, "_").substring(0, 80);
        await setDoc(
          doc(db, "admin_device_tokens", docId),
          {
            token,
            adminEmail: currentEmail,
            loggedIn: true,
            enabled: true,
            ...deviceInfo,
            userAgent: navigator.userAgent,
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
        console.log("[FCM] Registered device token in Firestore admin_device_tokens successfully.");
      } catch (fsErr) {
        console.warn("[FCM] Firestore token write notice:", fsErr);
      }

      // 6. Also sync with server backend endpoint
      await fetch("/api/admin/fcm-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          adminEmail: currentEmail,
          loggedIn: true,
          ...deviceInfo,
          userAgent: navigator.userAgent
        })
      }).catch((e) => console.warn("[FCM] Backend token sync notice:", e));

      return { success: true, token };
    }

    return { success: true };
  } catch (err: any) {
    console.error("[FCM] Registration error:", err);
    return { success: false, error: err?.message || "Failed to register notifications" };
  }
}

/**
 * Unregister device token
 */
export async function unregisterDeviceToken() {
  const token = localStorage.getItem("zypsomart_fcm_token");
  if (!token) return;

  try {
    // 1. Direct delete from Firestore if authenticated
    try {
      const docId = btoa(token).replace(/[+/=]/g, "_").substring(0, 80);
      await deleteDoc(doc(db, "admin_device_tokens", docId));
    } catch {}

    // 2. Also unregister on server
    await fetch("/api/admin/fcm-token", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    localStorage.removeItem("zypsomart_fcm_token");
  } catch (err) {
    console.warn("[FCM] Token unregister error:", err);
  }
}

/**
 * Trigger Test Notification:
 * Title: 🚨 Zypsomart Test Notification
 * Body: FCM is working correctly.
 */
export async function triggerTestPushNotification(delaySeconds: number = 0) {
  const response = await fetch("/api/admin/test-notification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delaySeconds })
  });
  return response.json();
}

/**
 * Listen for foreground FCM push messages
 */
export async function onForegroundMessageListener(callback: (payload: any) => void) {
  const messaging = await getFCMInstance();
  if (!messaging) return () => {};

  return onMessage(messaging, (payload) => {
    console.log("[FCM] Foreground push message received:", payload);
    callback(payload);
  });
}
