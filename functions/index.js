const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * Trigger: Firestore onCreate for new documents in 'orders' collection
 * Flow: New Order → Firestore → Cloud Function → FCM → Admin Mobile + Laptop
 * Works when Admin App is OPEN, IN BACKGROUND, or COMPLETELY CLOSED!
 */
exports.onNewOrderAlarm = functions.firestore
  .document("orders/{orderId}")
  .onCreate(async (snapshot, context) => {
    const orderId = context.params.orderId;
    const orderData = snapshot.data() || {};

    console.log(`[Cloud Function] New order detected: #${orderId}`);

    // 1. DUPLICATE PROTECTION: Check if this order was already alerted
    const alertRef = db.collection("adminAlerts").doc(orderId);
    const alertDoc = await alertRef.get();
    if (alertDoc.exists) {
      console.log(`[Cloud Function] Order #${orderId} was already alerted. Skipping duplicate.`);
      return null;
    }

    const customerName =
      orderData.customerName || orderData.name || orderData.customer?.name || "Customer";
    const total = orderData.total || orderData.orderTotal || 0;
    const itemsCount = Array.isArray(orderData.items) ? orderData.items.length : 1;
    const targetUrl = `/?orderId=${encodeURIComponent(orderId)}&tab=orders`;

    // 2. FETCH ALL REGISTERED & LOGGED-IN ADMIN DEVICE TOKENS (Mobile + Laptop)
    const tokensSnapshot = await db
      .collection("admin_device_tokens")
      .where("enabled", "==", true)
      .get();

    if (tokensSnapshot.empty) {
      console.log("[Cloud Function] No registered admin device tokens found in admin_device_tokens.");
      // Record alert document so we don't re-trigger later
      await alertRef.set({
        orderId,
        customerName,
        total,
        alertedAt: admin.firestore.FieldValue.serverTimestamp(),
        deviceCount: 0,
        status: "no_devices"
      });
      return null;
    }

    const tokens = [];
    tokensSnapshot.forEach((doc) => {
      const data = doc.data();
      // Only send to logged-in admin devices
      if (data.token && data.loggedIn !== false) {
        tokens.push(data.token);
      }
    });

    if (tokens.length === 0) {
      console.log("[Cloud Function] No logged-in admin device tokens found.");
      return null;
    }

    console.log(`[Cloud Function] Sending FCM push alert to ${tokens.length} logged-in admin device(s)`);

    // 3. BUILD FCM HIGH-PRIORITY MULTICAST PAYLOAD
    // High-priority Android notification channel: "Zypsomart New Orders" (channelId: "zypsomart_new_orders")
    // Custom sound: "new_order_alarm"
    // Notification Title: "🚨 NEW ORDER"
    const message = {
      tokens: tokens,
      notification: {
        title: "🚨 NEW ZYPSOMART ORDER",
        body: `New order received. Order ID: ${orderId} | Total: ₹${total}`
      },
      data: {
        orderId: String(orderId),
        customerName: String(customerName),
        total: String(total),
        url: targetUrl,
        type: "new_order_alarm",
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
          tag: `new-order-${orderId}`
        }
      },
      webpush: {
        headers: {
          Urgency: "high"
        },
        notification: {
          title: "🚨 NEW ZYPSOMART ORDER",
          body: `New order received. Order ID: ${orderId} | Total: ₹${total}`,
          icon: "/pwa-192x192.png",
          badge: "/favicon.png",
          tag: `new-order-${orderId}`,
          renotify: true,
          requireInteraction: true,
          vibrate: [500, 200, 500, 200, 1000, 200, 500, 200, 500],
          data: {
            url: targetUrl,
            orderId: String(orderId),
            customerName: String(customerName),
            total: String(total),
            type: "new_order_alarm"
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

    // 4. SEND FCM MULTICAST & CLEAN UP EXPIRED TOKENS
    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(`[Cloud Function] FCM sent: ${response.successCount} success, ${response.failureCount} failed.`);

      // Clean up invalid registration tokens
      if (response.failureCount > 0) {
        const failedTokens = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errCode = resp.error?.code;
            if (
              errCode === "messaging/invalid-registration-token" ||
              errCode === "messaging/registration-token-not-registered"
            ) {
              failedTokens.push(tokens[idx]);
            }
          }
        });

        if (failedTokens.length > 0) {
          const batch = db.batch();
          const toDeleteSnap = await db
            .collection("admin_device_tokens")
            .where("token", "in", failedTokens.slice(0, 30))
            .get();
          toDeleteSnap.forEach((d) => batch.delete(d.ref));
          await batch.commit();
          console.log(`[Cloud Function] Removed ${failedTokens.length} stale device tokens.`);
        }
      }

      // 5. RECORD PROCESSED ALERT IN adminAlerts (DUPLICATE PREVENTION)
      await alertRef.set({
        orderId,
        customerName,
        total,
        alertedAt: admin.firestore.FieldValue.serverTimestamp(),
        deviceCount: tokens.length,
        successCount: response.successCount,
        status: "delivered"
      });

      return { success: true, count: response.successCount };
    } catch (err) {
      console.error("[Cloud Function] Multicast send error:", err);
      return null;
    }
  });
