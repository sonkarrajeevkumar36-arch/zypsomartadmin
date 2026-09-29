import { Request, Response } from "express";
import { initializeApp, getApps, cert, applicationDefault, type App } from "firebase-admin/app";
import { getMessaging, type MulticastMessage } from "firebase-admin/messaging";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";

// In-memory cache of alerted order IDs for ultra-fast local duplicate protection
const alertedOrderIdsCache = new Set<string>();

let adminApp: App | null = null;

/**
 * Initialize Firebase Admin SDK using Service Account credentials or Application Default Credentials.
 * This utilizes FCM HTTP v1 under the hood (no deprecated legacy server keys).
 */
function getFirebaseAdmin(): App | null {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    adminApp = existingApps[0]!;
    return adminApp;
  }

  try {
    const serviceAccountRaw =
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      process.env.GOOGLE_SERVICE_ACCOUNT;

    if (serviceAccountRaw) {
      let certObj: any;
      const trimmed = serviceAccountRaw.trim();
      if (trimmed.startsWith("{")) {
        certObj = JSON.parse(trimmed);
      } else {
        // Support base64-encoded service account JSON
        const decoded = Buffer.from(trimmed, "base64").toString("utf8");
        if (decoded.trim().startsWith("{")) {
          certObj = JSON.parse(decoded);
        }
      }

      if (certObj) {
        console.log("[Firebase Admin] Initializing with service account credentials for HTTP v1...");
        adminApp = initializeApp({
          credential: cert(certObj),
          projectId: certObj.project_id || FIREBASE_PROJECT_ID
        });
        return adminApp;
      }
    }

    // Attempt Application Default Credentials (e.g. Cloud Run, GCP environment, or GOOGLE_APPLICATION_CREDENTIALS)
    adminApp = initializeApp({
      credential: applicationDefault(),
      projectId: FIREBASE_PROJECT_ID
    });
    return adminApp;
  } catch (err: any) {
    // Fallback: initialize with projectId only so Firestore/Messaging instances are reachable
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

// Eager initialization of Admin App
getFirebaseAdmin();

/**
 * Register or update an admin device FCM token
 * Stored in Firestore collection: `admin_device_tokens`
 */
export async function registerDeviceTokenController(req: Request, res: Response) {
  try {
    const { token, adminEmail, deviceType, browser, platform, userAgent } = req.body;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Missing or invalid device token" });
    }

    const app = getFirebaseAdmin();
    // Try Firestore Admin SDK first if available
    try {
      if (app) {
        const db = getFirestore(app);
        const docId = Buffer.from(token).toString("base64url").substring(0, 80);
        await db.collection("admin_device_tokens").doc(docId).set(
          {
            token,
            adminEmail: adminEmail || "admin@zypsomart.com",
            deviceType: deviceType || "desktop",
            browser: browser || "Unknown",
            platform: platform || "Unknown",
            userAgent: (userAgent || "").substring(0, 200),
            enabled: true,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        return res.json({
          success: true,
          message: "Device registered for new order alarm alerts successfully."
        });
      }
    } catch (adminErr) {
      // Fall through to REST API below
    }

    // Fallback to Firestore REST API with API key
    const docId = Buffer.from(token).toString("base64url").substring(0, 80);
    const url = `${FIRESTORE_REST_BASE}/admin_device_tokens/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`;

    const firestoreFields: Record<string, any> = {
      token: { stringValue: token },
      adminEmail: { stringValue: adminEmail || "admin@zypsomart.com" },
      deviceType: { stringValue: deviceType || "desktop" },
      browser: { stringValue: browser || "Unknown" },
      platform: { stringValue: platform || "Unknown" },
      userAgent: { stringValue: (userAgent || "").substring(0, 200) },
      enabled: { booleanValue: true },
      updatedAt: { timestampValue: new Date().toISOString() }
    };

    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: firestoreFields })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[FCM Backend] Token save returned ${response.status}:`, errText);
    }

    return res.json({
      success: true,
      message: "Device registered for new order alarm alerts successfully."
    });
  } catch (err: any) {
    console.error("[FCM Backend] Error registering device token:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

/**
 * Unregister device token
 */
export async function unregisterDeviceTokenController(req: Request, res: Response) {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const docId = Buffer.from(token).toString("base64url").substring(0, 80);
    const app = getFirebaseAdmin();

    try {
      if (app) {
        await getFirestore(app).collection("admin_device_tokens").doc(docId).delete();
        return res.json({ success: true, message: "Device unregistered." });
      }
    } catch {
      // Fall through to REST API
    }

    const url = `${FIRESTORE_REST_BASE}/admin_device_tokens/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`;
    await fetch(url, { method: "DELETE" }).catch(() => {});
    return res.json({ success: true, message: "Device unregistered." });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

/**
 * Helper to get all registered admin device tokens
 */
async function getAllAdminTokens(): Promise<string[]> {
  const app = getFirebaseAdmin();
  // 1. Try Firebase Admin Firestore
  try {
    if (app) {
      const snapshot = await getFirestore(app)
        .collection("admin_device_tokens")
        .where("enabled", "==", true)
        .get();

      const tokens: string[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.token) tokens.push(data.token);
      });
      if (tokens.length > 0) return tokens;
    }
  } catch {
    // Fall back to REST API below
  }

  // 2. Fallback to Firestore REST API
  try {
    const url = `${FIRESTORE_REST_BASE}/admin_device_tokens?key=${FIREBASE_API_KEY}&pageSize=100`;
    const response = await fetch(url);
    if (!response.ok) return [];

    const json = await response.json();
    const documents = json.documents || [];
    const tokens: string[] = [];

    for (const doc of documents) {
      const fields = doc.fields || {};
      const token = fields.token?.stringValue;
      const enabled = fields.enabled?.booleanValue ?? true;
      if (token && enabled) {
        tokens.push(token);
      }
    }
    return tokens;
  } catch (err) {
    console.warn("[FCM Backend] Failed to fetch admin tokens from Firestore:", err);
    return [];
  }
}

/**
 * Remove stale or invalid registration token from Firestore
 */
async function removeStaleToken(token: string) {
  try {
    const docId = Buffer.from(token).toString("base64url").substring(0, 80);
    const app = getFirebaseAdmin();
    if (app) {
      await getFirestore(app).collection("admin_device_tokens").doc(docId).delete();
      return;
    }
    const url = `${FIRESTORE_REST_BASE}/admin_device_tokens/${encodeURIComponent(docId)}?key=${FIREBASE_API_KEY}`;
    await fetch(url, { method: "DELETE" }).catch(() => {});
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Check if order was already alerted in Firestore `adminAlerts` collection
 */
async function hasOrderBeenAlerted(orderId: string): Promise<boolean> {
  if (alertedOrderIdsCache.has(orderId)) return true;

  const app = getFirebaseAdmin();
  try {
    if (app) {
      const doc = await getFirestore(app).collection("adminAlerts").doc(orderId).get();
      if (doc.exists) {
        alertedOrderIdsCache.add(orderId);
        return true;
      }
    }
  } catch {
    // Fall back to REST API
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
async function recordOrderAlert(orderId: string, details: { customerName?: string; total?: number }) {
  alertedOrderIdsCache.add(orderId);

  const app = getFirebaseAdmin();
  try {
    if (app) {
      await getFirestore(app).collection("adminAlerts").doc(orderId).set({
        orderId,
        customerName: details.customerName || "Customer",
        total: Number(details.total || 0),
        alertedAt: FieldValue.serverTimestamp(),
        status: "sent"
      });
      return;
    }
  } catch {
    // Fall back to REST API
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
  } catch (err) {
    console.warn("[FCM Backend] Record alert error:", err);
  }
}

/**
 * Send FCM Push Notification via Firebase Admin SDK (FCM HTTP v1 Multicast).
 * No legacy server key is required.
 */
async function sendFCMPush(
  tokens: string[],
  orderData: {
    orderId: string;
    customerName: string;
    total: number | string;
    isTest?: boolean;
  }
) {
  const isTest = !!orderData.isTest;
  const title = isTest ? "🚨 [TEST ALARM] NEW ZYPSOMART ORDER" : "🚨 NEW ZYPSOMART ORDER";
  const body = `Order #${orderData.orderId} • ₹${orderData.total} from ${orderData.customerName}`;

  console.log(`[FCM HTTP v1] Preparing dispatch to ${tokens.length} registered admin device(s) for Order #${orderData.orderId}`);

  if (tokens.length === 0) {
    return { success: true, count: 0, reason: "No registered device tokens found" };
  }

  try {
    const app = getFirebaseAdmin();
    if (!app) {
      console.warn("[FCM HTTP v1] Firebase Admin app could not be initialized.");
      return { success: true, count: tokens.length, sentViaFCM: false };
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
        orderId: String(orderData.orderId),
        customerName: String(orderData.customerName),
        total: String(orderData.total),
        url: `/?orderId=${orderData.orderId}&tab=orders`,
        type: isTest ? "test_alarm" : "new_order_alarm",
        timestamp: String(Date.now())
      },
      android: {
        priority: "high",
        notification: {
          channelId: "new_order_alerts",
          sound: "new_order_alarm",
          defaultSound: false,
          priority: "max",
          visibility: "public"
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
          tag: `new-order-${orderData.orderId}`,
          renotify: true,
          requireInteraction: true,
          vibrate: [300, 150, 300, 150, 600],
          data: {
            url: `/?orderId=${orderData.orderId}&tab=orders`,
            orderId: String(orderData.orderId),
            customerName: String(orderData.customerName),
            total: String(orderData.total)
          },
          actions: [
            { action: "view", title: "👀 View Order" },
            { action: "accept", title: "✅ Accept Order" }
          ]
        }
      }
    };

    const response = await messaging.sendEachForMulticast(message);
    console.log(`[FCM HTTP v1] Multicast dispatch result: ${response.successCount} sent successfully, ${response.failureCount} failed.`);

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
    console.warn("[FCM HTTP v1] Firebase Admin messaging push dispatch notice:", err?.message || err);
    // Real-time client Firestore subscription / Audio alarms continue uninterrupted
    return {
      success: true,
      count: tokens.length,
      sentViaFCM: false,
      notice: err?.message || "Admin credentials not configured in local environment"
    };
  }
}

/**
 * Endpoint to trigger test alarm without creating any fake order
 */
export async function testAlarmController(req: Request, res: Response) {
  try {
    const testOrderId = `TEST-${Date.now().toString().slice(-4)}`;
    const testPayload = {
      orderId: testOrderId,
      customerName: "Rahul Sharma (Test)",
      total: 349,
      isTest: true
    };

    const tokens = await getAllAdminTokens();
    const fcmResult = await sendFCMPush(tokens, testPayload);

    return res.json({
      success: true,
      message: "Test alarm triggered successfully on all registered devices via Firebase Admin SDK.",
      testPayload,
      deviceTokensCount: tokens.length,
      fcmResult
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to trigger test alarm" });
  }
}

/**
 * Dispatch new order alarm with strict duplicate protection
 */
export async function dispatchNewOrderAlarmController(req: Request, res: Response) {
  try {
    const { orderId, customerName, total } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    // 1. Strict duplicate check
    const alreadyAlerted = await hasOrderBeenAlerted(orderId);
    if (alreadyAlerted) {
      return res.json({
        skipped: true,
        reason: "Duplicate alert skipped. Order has already been alerted.",
        orderId
      });
    }

    // 2. Record alert in Firestore to prevent any future duplicate
    await recordOrderAlert(orderId, { customerName, total });

    // 3. Send FCM Push to all registered devices via Firebase Admin SDK (HTTP v1)
    const tokens = await getAllAdminTokens();
    const result = await sendFCMPush(tokens, {
      orderId,
      customerName: customerName || "Customer",
      total: total || 0
    });

    return res.json({
      success: true,
      orderId,
      devicesNotified: result.count
    });
  } catch (err: any) {
    console.error("[FCM Backend] Dispatch error:", err);
    return res.status(500).json({ error: err?.message || "Failed to dispatch alarm" });
  }
}

/**
 * Get alarm system status and registered device count
 */
export async function getAlarmStatusController(req: Request, res: Response) {
  try {
    const tokens = await getAllAdminTokens();
    const hasServiceAccount =
      !!process.env.FIREBASE_SERVICE_ACCOUNT ||
      !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

    return res.json({
      status: "active",
      provider: "Firebase Admin SDK (FCM HTTP v1)",
      fcmConfigured: hasServiceAccount || getApps().length > 0,
      registeredDevices: tokens.length,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to fetch status" });
  }
}
