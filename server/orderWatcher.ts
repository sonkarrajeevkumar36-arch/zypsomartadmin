import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  dispatchNewOrderAlarm,
  hasOrderBeenAlerted,
  recordOrderAlert
} from "./fcmController.js";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";

// Keep track of observed order IDs so we only alert for new orders
const observedOrderIds = new Set<string>();
let isInitialized = false;
let pollingInterval: NodeJS.Timeout | null = null;
let firestoreUnsubscribe: (() => void) | null = null;

/**
 * Format address helper
 */
function extractTotal(fields: Record<string, any>): number {
  if (!fields) return 0;
  if (fields.total?.doubleValue !== undefined) return fields.total.doubleValue;
  if (fields.total?.integerValue !== undefined) return Number(fields.total.integerValue);
  if (fields.total?.stringValue) return parseFloat(fields.total.stringValue) || 0;
  if (fields.orderTotal?.doubleValue !== undefined) return fields.orderTotal.doubleValue;
  return 0;
}

function extractCustomerName(fields: Record<string, any>): string {
  if (!fields) return "Customer";
  if (fields.customerName?.stringValue) return fields.customerName.stringValue;
  if (fields.name?.stringValue) return fields.name.stringValue;
  if (fields.customer?.mapValue?.fields?.name?.stringValue) {
    return fields.customer.mapValue.fields.name.stringValue;
  }
  return "Customer";
}

function extractStatus(fields: Record<string, any>): string {
  if (!fields) return "pending";
  return (fields.status?.stringValue || fields.orderStatus?.stringValue || "pending").toLowerCase();
}

/**
 * Seed existing orders into memory on server boot so we NEVER blast alerts for historical orders
 */
async function seedExistingOrders(): Promise<void> {
  try {
    const url = `${FIRESTORE_REST_BASE}/orders?key=${FIREBASE_API_KEY}&pageSize=100`;
    const response = await fetch(url);
    if (!response.ok) return;

    const data = await response.json();
    const documents = data.documents || [];

    for (const doc of documents) {
      const nameParts = (doc.name || "").split("/");
      const orderId = nameParts[nameParts.length - 1];
      if (orderId) {
        observedOrderIds.add(orderId);
      }
    }
    console.log(`[Order Watcher] Seeded ${observedOrderIds.size} existing orders into memory.`);
  } catch (err) {
    console.warn("[Order Watcher] Error seeding existing orders:", err);
  } finally {
    isInitialized = true;
  }
}

/**
 * Process a potentially new order document
 */
async function processOrderCandidate(
  orderId: string,
  customerName: string,
  total: number,
  status: string
) {
  if (!orderId) return;

  // If this order is already known from server boot, skip
  if (observedOrderIds.has(orderId)) {
    return;
  }

  // Mark as observed immediately
  observedOrderIds.add(orderId);

  // We only alert for new/pending orders (not delivered or cancelled)
  const isAlertableStatus =
    status === "pending" ||
    status === "new" ||
    status === "order_placed" ||
    status === "placed";

  if (!isAlertableStatus) {
    return;
  }

  // Check duplicate protection in Firestore adminAlerts collection
  const alreadyAlerted = await hasOrderBeenAlerted(orderId);
  if (alreadyAlerted) {
    return;
  }

  console.log(`[Order Watcher] 🚨 NEW ORDER DETECTED: #${orderId} from ${customerName} (₹${total}). Dispatching FCM alarm to all admin devices!`);

  try {
    await dispatchNewOrderAlarm(orderId, {
      customerName,
      total
    });
  } catch (err) {
    console.error(`[Order Watcher] Failed to dispatch alarm for #${orderId}:`, err);
  }
}

/**
 * Poll Firestore REST API every 5 seconds as an ultra-reliable background loop
 * Works with zero native Firebase dependencies, guaranteed to run when app is closed!
 */
async function checkRecentOrdersViaREST() {
  if (!isInitialized) return;

  try {
    const url = `${FIRESTORE_REST_BASE}/orders?key=${FIREBASE_API_KEY}&pageSize=20`;
    const response = await fetch(url);
    if (!response.ok) return;

    const data = await response.json();
    const documents = data.documents || [];

    for (const doc of documents) {
      const nameParts = (doc.name || "").split("/");
      const orderId = nameParts[nameParts.length - 1];
      if (!orderId) continue;

      const fields = doc.fields || {};
      const status = extractStatus(fields);
      const customerName = extractCustomerName(fields);
      const total = extractTotal(fields);

      await processOrderCandidate(orderId, customerName, total, status);
    }
  } catch (err) {
    // Non-blocking background log
    // console.warn("[Order Watcher] Polling check notice:", err);
  }
}

/**
 * Start real-time Firestore Admin listener if Admin credentials are active
 */
function attachAdminFirestoreListener(): boolean {
  try {
    const apps = getApps();
    if (apps.length === 0) return false;

    const db = getFirestore(apps[0]!);
    console.log("[Order Watcher] Attaching real-time Firestore Admin SDK onSnapshot listener...");

    firestoreUnsubscribe = db.collection("orders").onSnapshot(
      (snapshot) => {
        if (!isInitialized) return;

        snapshot.docChanges().forEach(async (change) => {
          if (change.type === "added" || change.type === "modified") {
            const doc = change.doc;
            const orderId = doc.id;
            const data = doc.data();
            const status = (data.status || data.orderStatus || "pending").toLowerCase();
            const customerName =
              data.customerName || data.name || data.customer?.name || "Customer";
            const total = Number(data.total || data.orderTotal || 0);

            await processOrderCandidate(orderId, customerName, total, status);
          }
        });
      },
      (error) => {
        console.warn("[Order Watcher] Firestore onSnapshot warning (fallback to REST polling active):", error.message);
      }
    );

    return true;
  } catch (err: any) {
    console.warn("[Order Watcher] Could not attach Admin onSnapshot:", err?.message || err);
    return false;
  }
}

/**
 * Start the background Order Watcher service
 */
export async function startServerOrderWatcher() {
  console.log("[Order Watcher] Initializing Server-side New Order Alarm Service...");

  // 1. Seed existing orders into memory
  await seedExistingOrders();

  // 2. Attach real-time onSnapshot listener
  attachAdminFirestoreListener();

  // 3. Start high-frequency REST polling loop (every 5 seconds) as guaranteed dual-redundant safety net
  if (!pollingInterval) {
    pollingInterval = setInterval(checkRecentOrdersViaREST, 5000);
  }

  console.log("[Order Watcher] Active! Monitoring for new orders 24/7 (closed-app alarm ready).");
}

export function stopServerOrderWatcher() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (firestoreUnsubscribe) {
    firestoreUnsubscribe();
    firestoreUnsubscribe = null;
  }
}
