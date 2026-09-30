import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { initializeApp, getApps, deleteApp, cert, type App } from "firebase-admin/app";
import { getMessaging, type MulticastMessage } from "firebase-admin/messaging";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";

// Local storage directory for server token persistence
const DATA_DIR = path.join(process.cwd(), ".data");
const TOKENS_FILE = path.join(DATA_DIR, "admin_tokens.json");
const SERVICE_ACCOUNT_FILE = path.join(DATA_DIR, "service-account.json");

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

// In-memory persistent map of registered admin device tokens
interface DeviceTokenInfo {
  token: string;
  adminEmail: string;
  deviceType?: string;
  browser?: string;
  platform?: string;
  userAgent?: string;
  enabled: boolean;
  loggedIn: boolean;
  updatedAt: string;
}

const persistentDeviceTokensMap = new Map<string, DeviceTokenInfo>();

// Load cached tokens from disk on startup
function loadTokensFromDisk() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const raw = fs.readFileSync(TOKENS_FILE, "utf8");
      const list: DeviceTokenInfo[] = JSON.parse(raw);
      for (const item of list) {
        if (item.token) {
          persistentDeviceTokensMap.set(item.token, item);
        }
      }
      console.log(`[FCM Backend] Loaded ${persistentDeviceTokensMap.size} admin device token(s) from local cache.`);
    }
  } catch (err) {
    console.warn("[FCM Backend] Error loading tokens from disk:", err);
  }
}

function saveTokensToDisk() {
  try {
    const list = Array.from(persistentDeviceTokensMap.values());
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.warn("[FCM Backend] Error saving tokens to disk:", err);
  }
}

loadTokensFromDisk();

// In-memory cache of alerted order IDs for ultra-fast local duplicate protection
export const alertedOrderIdsCache = new Set<string>();

let adminApp: App | null = null;

/**
 * Check if the server environment has explicit Firebase Admin Service Account credentials
 */
export function hasAdminServiceAccountCredentials(): boolean {
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) return true;
  if (fs.existsSync(path.join(process.cwd(), "service-account.json"))) return true;
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.GOOGLE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

/**
 * Parse Service Account object from env or local file
 */
function getServiceAccountObject(): any {
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, "utf8"));
    } catch {}
  }
  const rootSA = path.join(process.cwd(), "service-account.json");
  if (fs.existsSync(rootSA)) {
    try {
      return JSON.parse(fs.readFileSync(rootSA, "utf8"));
    } catch {}
  }

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.GOOGLE_SERVICE_ACCOUNT;

  if (raw) {
    try {
      const trimmed = raw.trim();
      if (trimmed.startsWith("{")) return JSON.parse(trimmed);
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      if (decoded.trim().startsWith("{")) return JSON.parse(decoded);
    } catch {}
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    try {
      return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
    } catch {}
  }

  return null;
}

/**
 * Initialize Firebase Admin SDK using Service Account credentials for zypso-mart-cd989
 */
export function getFirebaseAdmin(): App | null {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    adminApp = existingApps[0]!;
    return adminApp;
  }

  try {
    const certObj = getServiceAccountObject();
    if (certObj) {
      console.log("[Firebase Admin] Initializing with service account credentials for HTTP v1...");
      adminApp = initializeApp({
        credential: cert(certObj),
        projectId: certObj.project_id || FIREBASE_PROJECT_ID
      });
      return adminApp;
    }

    // Default initialization with projectId only
    adminApp = initializeApp({
      projectId: FIREBASE_PROJECT_ID
    });
    return adminApp;
  } catch (err: any) {
    try {
      adminApp = initializeApp({
        projectId: FIREBASE_PROJECT_ID
      });
      return adminApp;
    } catch {
      return null;
    }
  }
}

getFirebaseAdmin();

/**
 * Endpoint to configure Service Account JSON from Admin UI settings
 */
export async function configureServiceAccountController(req: Request, res: Response) {
  try {
    const { serviceAccountJson } = req.body;
    if (!serviceAccountJson) {
      return res.status(400).json({ error: "Missing serviceAccountJson payload" });
    }

    let parsed: any;
    if (typeof serviceAccountJson === "string") {
      parsed = JSON.parse(serviceAccountJson.trim());
    } else {
      parsed = serviceAccountJson;
    }

    if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
      return res.status(400).json({
        error: "Invalid service account JSON. Must contain project_id, private_key, and client_email."
      });
    }

    // Save to disk
    fs.writeFileSync(SERVICE_ACCOUNT_FILE, JSON.stringify(parsed, null, 2), "utf8");

    // Re-initialize Firebase Admin
    const apps = getApps();
    for (const app of apps) {
      await deleteApp(app).catch(() => {});
    }

    adminApp = initializeApp({
      credential: cert(parsed),
      projectId: parsed.project_id || FIREBASE_PROJECT_ID
    });

    console.log("[Firebase Admin] Successfully configured and initialized service account for:", parsed.project_id);

    return res.json({
      success: true,
      message: `Service Account for project ${parsed.project_id} configured successfully. FCM HTTP v1 push notifications active.`
    });
  } catch (err: any) {
    console.error("[Firebase Admin] Error configuring service account:", err);
    return res.status(500).json({ error: err.message || "Failed to parse service account" });
  }
}

/**
 * Register or update an admin device FCM token
 * Stored in:
 * 1. Persistent in-memory map & disk cache
 * 2. Firestore collection `admin_device_tokens` (if authenticated)
 */
export async function registerDeviceTokenController(req: Request, res: Response) {
  try {
    const { token, adminEmail, deviceType, browser, platform, userAgent } = req.body;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Missing or invalid device token" });
    }

    // 1. Save in server local persistent memory & disk
    const info: DeviceTokenInfo = {
      token,
      adminEmail: adminEmail || "admin@zypsomart.com",
      deviceType: deviceType || "desktop",
      browser: browser || "Unknown",
      platform: platform || "Unknown",
      userAgent: (userAgent || "").substring(0, 200),
      enabled: true,
      loggedIn: true,
      updatedAt: new Date().toISOString()
    };

    persistentDeviceTokensMap.set(token, info);
    saveTokensToDisk();
    console.log(`[FCM Backend] Registered device token (${info.deviceType} / ${info.browser}). Total devices: ${persistentDeviceTokensMap.size}`);

    // 2. Also sync to Firestore if Admin SDK is authenticated
    const app = getFirebaseAdmin();
    if (app && hasAdminServiceAccountCredentials()) {
      try {
        const db = getFirestore(app);
        const docId = Buffer.from(token).toString("base64url").substring(0, 80);
        await db.collection("admin_device_tokens").doc(docId).set(
          {
            ...info,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      } catch (err) {
        console.warn("[FCM Backend] Firestore token write notice:", err);
      }
    }

    return res.json({
      success: true,
      message: "Device registered for new order alarm alerts successfully.",
      deviceTokensCount: persistentDeviceTokensMap.size
    });
  } catch (err: any) {
    console.error("[FCM Backend] Error registering device token:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

/**
 * Unregister device token when admin logs out
 */
export async function unregisterDeviceTokenController(req: Request, res: Response) {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    persistentDeviceTokensMap.delete(token);
    saveTokensToDisk();

    const app = getFirebaseAdmin();
    if (app && hasAdminServiceAccountCredentials()) {
      try {
        const docId = Buffer.from(token).toString("base64url").substring(0, 80);
        await getFirestore(app).collection("admin_device_tokens").doc(docId).delete();
      } catch {}
    }

    return res.json({ success: true, message: "Device unregistered." });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

/**
 * Helper to get all registered and logged-in admin device tokens
 */
export async function getAllAdminTokens(): Promise<string[]> {
  const tokens = new Set<string>();

  // 1. From server local persistent cache
  for (const [t, info] of persistentDeviceTokensMap.entries()) {
    if (info.enabled && info.loggedIn !== false) {
      tokens.add(t);
    }
  }

  // 2. From Firestore Admin if authenticated
  const app = getFirebaseAdmin();
  if (app && hasAdminServiceAccountCredentials()) {
    try {
      const snapshot = await getFirestore(app)
        .collection("admin_device_tokens")
        .where("enabled", "==", true)
        .get();

      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.token && data.loggedIn !== false) {
          tokens.add(data.token);
          if (!persistentDeviceTokensMap.has(data.token)) {
            persistentDeviceTokensMap.set(data.token, {
              token: data.token,
              adminEmail: data.adminEmail || "admin@zypsomart.com",
              deviceType: data.deviceType || "desktop",
              browser: data.browser || "Unknown",
              platform: data.platform || "Unknown",
              enabled: true,
              loggedIn: true,
              updatedAt: new Date().toISOString()
            });
          }
        }
      });
      saveTokensToDisk();
    } catch {}
  }

  return Array.from(tokens);
}

/**
 * Remove stale or invalid registration token
 */
export async function removeStaleToken(token: string) {
  persistentDeviceTokensMap.delete(token);
  saveTokensToDisk();

  try {
    const app = getFirebaseAdmin();
    if (app && hasAdminServiceAccountCredentials()) {
      const docId = Buffer.from(token).toString("base64url").substring(0, 80);
      await getFirestore(app).collection("admin_device_tokens").doc(docId).delete();
    }
  } catch {}
}

/**
 * Check if order was already alerted in Firestore `adminAlerts` collection
 */
export async function hasOrderBeenAlerted(orderId: string): Promise<boolean> {
  if (alertedOrderIdsCache.has(orderId)) return true;

  const app = getFirebaseAdmin();
  if (app && hasAdminServiceAccountCredentials()) {
    try {
      const doc = await getFirestore(app).collection("adminAlerts").doc(orderId).get();
      if (doc.exists) {
        alertedOrderIdsCache.add(orderId);
        return true;
      }
    } catch {}
  }

  try {
    const url = `${FIRESTORE_REST_BASE}/adminAlerts/${encodeURIComponent(orderId)}?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url);
    if (res.status === 200) {
      alertedOrderIdsCache.add(orderId);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Record alerted order in Firestore `adminAlerts` to prevent any duplicate notifications
 */
export async function recordOrderAlert(orderId: string, details: { customerName?: string; total?: number }) {
  alertedOrderIdsCache.add(orderId);

  const app = getFirebaseAdmin();
  if (app && hasAdminServiceAccountCredentials()) {
    try {
      await getFirestore(app).collection("adminAlerts").doc(orderId).set({
        orderId,
        customerName: details.customerName || "Customer",
        total: Number(details.total || 0),
        alertedAt: FieldValue.serverTimestamp(),
        status: "sent"
      });
      return;
    } catch {}
  }

  try {
    const url = `${FIRESTORE_REST_BASE}/adminAlerts/${encodeURIComponent(orderId)}?key=${FIREBASE_API_KEY}`;
    await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          orderId: { stringValue: orderId },
          customerName: { stringValue: details.customerName || "Customer" },
          total: { doubleValue: Number(details.total || 0) },
          alertedAt: { timestampValue: new Date().toISOString() },
          status: { stringValue: "sent" }
        }
      })
    });
  } catch {}
}

/**
 * Send FCM Push Notification via Firebase Admin SDK (FCM HTTP v1 Multicast).
 * Android channel: "Zypsomart New Orders" (channelId: "zypsomart_new_orders")
 * Sound: "new_order_alarm"
 */
export async function sendFCMPush(
  tokens: string[],
  notificationData: {
    title: string;
    body: string;
    orderId?: string;
    customerName?: string;
    total?: number | string;
    url?: string;
    isTest?: boolean;
  }
) {
  const title = notificationData.title || "🚨 NEW ZYPSOMART ORDER";
  const body = notificationData.body || "New order received.";
  const orderId = notificationData.orderId || "";
  const targetUrl = notificationData.url || (orderId ? `/?orderId=${encodeURIComponent(orderId)}&tab=orders` : "/?tab=orders");

  console.log(`[FCM HTTP v1] Preparing dispatch to ${tokens.length} registered admin device(s)`);

  if (tokens.length === 0) {
    return { success: true, count: 0, reason: "No registered device tokens found" };
  }

  try {
    const app = getFirebaseAdmin();
    if (!app) {
      return { success: false, count: 0, error: "Firebase Admin app could not be initialized." };
    }

    const messaging = getMessaging(app);

    // Build standard FCM HTTP v1 Multicast message using Firebase Admin SDK
    const message: MulticastMessage = {
      tokens: tokens,
      notification: {
        title,
        body
      },
      data: {
        title,
        body,
        orderId: String(orderId),
        customerName: String(notificationData.customerName || ""),
        total: String(notificationData.total || ""),
        url: targetUrl,
        type: notificationData.isTest ? "test_notification" : "new_order_alarm",
        timestamp: String(Date.now())
      },
      android: {
        priority: "high",
        ttl: 3600,
        notification: {
          channelId: "zypsomart_new_orders",
          sound: "new_order_alarm",
          defaultSound: false,
          priority: "max",
          visibility: "public",
          defaultVibrateTimings: false,
          vibrateTimingsMillis: [500, 200, 500, 200, 1000, 200, 500, 200, 500],
          clickAction: targetUrl,
          tag: orderId ? `new-order-${orderId}` : "test-notification"
        }
      },
      webpush: {
        headers: {
          Urgency: "high"
        },
        notification: {
          title,
          body,
          icon: "/pwa-192x192.png",
          badge: "/favicon.png",
          tag: orderId ? `new-order-${orderId}` : "test-notification",
          renotify: true,
          requireInteraction: true,
          vibrate: [500, 200, 500, 200, 1000, 200, 500, 200, 500],
          data: {
            url: targetUrl,
            orderId: String(orderId),
            customerName: String(notificationData.customerName || ""),
            total: String(notificationData.total || ""),
            type: notificationData.isTest ? "test_notification" : "new_order_alarm"
          },
          actions: [
            { action: "view", title: "👀 View Order" },
            { action: "accept", title: "✅ Accept Order" }
          ]
        },
        fcmOptions: {
          link: targetUrl
        }
      }
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`[FCM HTTP v1] Dispatch result: ${response.successCount} sent successfully, ${response.failureCount} failed.`);

    // Automatically prune stale / unregistered tokens
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errCode = resp.error?.code;
          if (
            errCode === "messaging/invalid-registration-token" ||
            errCode === "messaging/registration-token-not-registered"
          ) {
            removeStaleToken(tokens[idx]);
          }
        }
      });
    }

    return {
      success: true,
      count: response.successCount,
      failed: response.failureCount,
      sentViaFCM: true
    };
  } catch (err: any) {
    console.warn("[FCM HTTP v1] Push dispatch error:", err?.message || err);
    return {
      success: false,
      count: 0,
      sentViaFCM: false,
      error: err?.message || "Failed to send FCM push"
    };
  }
}

/**
 * Unified dispatch handler for real new order alarms
 * Title: 🚨 NEW ZYPSOMART ORDER
 * Body: New order received. Order ID: {orderId} | Total: ₹{total}
 */
export async function dispatchNewOrderAlarm(
  orderId: string,
  details: { customerName?: string; total?: number | string }
) {
  if (!orderId) {
    return { skipped: true, reason: "Missing orderId" };
  }

  // 1. Strict duplicate check
  const alreadyAlerted = await hasOrderBeenAlerted(orderId);
  if (alreadyAlerted) {
    return {
      skipped: true,
      reason: "Duplicate alert skipped. Order has already been alerted.",
      orderId
    };
  }

  // 2. Record alert in Firestore to prevent any future duplicate
  await recordOrderAlert(orderId, {
    customerName: details.customerName,
    total: Number(details.total || 0)
  });

  // 3. Send FCM Push to all registered & logged-in admin devices via Firebase Admin SDK (HTTP v1)
  const tokens = await getAllAdminTokens();
  const formattedTotal = Number(details.total || 0).toLocaleString("en-IN");

  const result = await sendFCMPush(tokens, {
    title: "🚨 NEW ZYPSOMART ORDER",
    body: `New order received. Order ID: ${orderId} | Total: ₹${formattedTotal}`,
    orderId,
    customerName: details.customerName || "Customer",
    total: details.total || 0,
    url: `/?orderId=${encodeURIComponent(orderId)}&tab=orders`
  });

  return {
    success: true,
    orderId,
    devicesNotified: result.count
  };
}

/**
 * Dedicated TEST NOTIFICATION endpoint requested by user:
 * Title: 🚨 Zypsomart Test Notification
 * Body: FCM is working correctly.
 * Can be sent immediately or with a delay (e.g. 5 seconds) so user can close the app / lock screen first!
 */
export async function testNotificationController(req: Request, res: Response) {
  try {
    const delaySeconds = Math.max(0, Math.min(30, Number(req.body.delaySeconds || 0)));
    const tokens = await getAllAdminTokens();

    if (tokens.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No registered admin devices found. Please click 'Enable Notifications' in the Admin App first."
      });
    }

    const sendTestPush = async () => {
      const fcmResult = await sendFCMPush(tokens, {
        title: "🚨 Zypsomart Test Notification",
        body: "FCM is working correctly.",
        url: "/?tab=orders",
        isTest: true
      });
      console.log(`[Test Notification] Dispatched test notification to ${tokens.length} device(s):`, fcmResult);
    };

    if (delaySeconds > 0) {
      // Execute after specified delay
      setTimeout(sendTestPush, delaySeconds * 1000);
      return res.json({
        success: true,
        delayed: true,
        delaySeconds,
        message: `Test notification scheduled! Close your app and lock your phone now. Notification will arrive in ${delaySeconds} seconds.`,
        registeredDevices: tokens.length
      });
    } else {
      await sendTestPush();
      return res.json({
        success: true,
        message: "Test notification sent immediately to all registered devices.",
        registeredDevices: tokens.length
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to send test notification" });
  }
}

// Alias for backwards compatibility with server routes
export const testAlarmController = testNotificationController;

/**
 * Dispatch new order alarm endpoint (can be called from client or internal trigger)
 */
export async function dispatchNewOrderAlarmController(req: Request, res: Response) {
  try {
    const { orderId, customerName, total } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const result = await dispatchNewOrderAlarm(orderId, { customerName, total });
    return res.json(result);
  } catch (err: any) {
    console.error("[FCM Backend] Dispatch error:", err);
    return res.status(500).json({ error: err?.message || "Failed to dispatch alarm" });
  }
}

/**
 * Get alarm system status, registered device count, and service account status
 */
export async function getAlarmStatusController(req: Request, res: Response) {
  try {
    const tokens = await getAllAdminTokens();
    const hasServiceAccount = hasAdminServiceAccountCredentials();

    return res.json({
      status: "active",
      provider: "Firebase Admin SDK (FCM HTTP v1)",
      channel: "Zypsomart New Orders",
      channelId: "zypsomart_new_orders",
      sound: "new_order_alarm",
      serviceAccountConfigured: hasServiceAccount,
      fcmConfigured: hasServiceAccount,
      registeredDevices: tokens.length,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to fetch status" });
  }
}
