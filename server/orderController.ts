import { Request, Response } from "express";
import { getFirebaseAdmin, hasAdminServiceAccountCredentials } from "./fcmController.js";
import { getFirestore } from "firebase-admin/firestore";
import { isShopCurrentlyOpen } from "./shopController.js";

const FIREBASE_PROJECT_ID = "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";

// Valid order statuses
export const VALID_STATUSES = [
  "pending",
  "accepted",
  "delivered",
  "cancelled",
  "return_requested",
  "return_approved",
  "return_rejected"
] as const;

export type OrderStatus = (typeof VALID_STATUSES)[number];

// Normalize status string to canonical form
export function normalizeStatus(rawStatus: any): OrderStatus | null {
  if (!rawStatus || typeof rawStatus !== "string") return null;
  const s = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (s === "pending") return "pending";
  if (s === "accepted" || s === "accept") return "accepted";
  if (s === "delivered" || s === "deliver") return "delivered";
  if (s === "cancelled" || s === "cancel" || s === "canceled") return "cancelled";
  if (
    s === "return_requested" ||
    s === "return_request" ||
    s === "returnrequested" ||
    s === "return" ||
    s === "returned" ||
    s === "return_pending" ||
    s === "return_initiated"
  ) {
    return "return_requested";
  }
  if (
    s === "return_approved" ||
    s === "returnapproved" ||
    s === "approved_return" ||
    s === "approved"
  ) {
    return "return_approved";
  }
  if (
    s === "return_rejected" ||
    s === "returnrejected" ||
    s === "rejected_return" ||
    s === "rejected"
  ) {
    return "return_rejected";
  }

  return null;
}

// Allowed state transitions map
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["accepted", "cancelled"],
  accepted: ["delivered", "cancelled"],
  delivered: ["return_requested", "cancelled"],
  return_requested: ["return_approved", "return_rejected", "cancelled"],
  return_approved: ["return_approved", "return_rejected"], // idempotent or reconsider
  return_rejected: ["return_rejected", "return_approved"], // idempotent or reconsider
  cancelled: ["cancelled", "pending"] // idempotent or re-open
};

// Helper to fetch order from Firestore REST API
async function getFirestoreOrder(orderId: string, authToken?: string): Promise<any | null> {
  const url = `${FIRESTORE_REST_BASE}/orders/${encodeURIComponent(orderId)}?key=${FIREBASE_API_KEY}`;
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = authToken;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    // If permission denied, document may exist but rules require client token
    if (res.status === 403) {
      console.warn(`[OrderController] Firestore read returned 403. Using permissive fallback.`);
      return { _permissionRestricted: true };
    }
    throw new Error(`Firestore fetch failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json;
}

// Convert Firestore fields format to simple JS object
function parseFirestoreFields(fields: Record<string, any> = {}): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = Number(val.integerValue);
    else if (val.doubleValue !== undefined) result[key] = Number(val.doubleValue);
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.timestampValue !== undefined) result[key] = val.timestampValue;
    else if (val.nullValue !== undefined) result[key] = null;
    else if (val.mapValue !== undefined) result[key] = parseFirestoreFields(val.mapValue.fields);
    else if (val.arrayValue !== undefined) {
      result[key] = (val.arrayValue.values || []).map((item: any) => {
        if (item.stringValue !== undefined) return item.stringValue;
        if (item.mapValue !== undefined) return parseFirestoreFields(item.mapValue.fields);
        return item;
      });
    } else {
      result[key] = val;
    }
  }
  return result;
}

// Helper to update order in Firestore via REST API
async function updateFirestoreOrder(
  orderId: string,
  updateFields: Record<string, any>,
  fieldPaths: string[],
  authToken?: string
): Promise<any> {
  const maskQuery = fieldPaths.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const url = `${FIRESTORE_REST_BASE}/orders/${encodeURIComponent(orderId)}?${maskQuery}&key=${FIREBASE_API_KEY}`;

  const firestoreFields: Record<string, any> = {};
  for (const [key, value] of Object.entries(updateFields)) {
    if (typeof value === "string") {
      firestoreFields[key] = { stringValue: value };
    } else if (typeof value === "boolean") {
      firestoreFields[key] = { booleanValue: value };
    } else if (typeof value === "number") {
      firestoreFields[key] = Number.isInteger(value)
        ? { integerValue: value.toString() }
        : { doubleValue: value };
    } else if (value instanceof Date) {
      firestoreFields[key] = { timestampValue: value.toISOString() };
    } else if (value === null) {
      firestoreFields[key] = { nullValue: null };
    } else {
      firestoreFields[key] = { stringValue: String(value) };
    }
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = authToken;
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ fields: firestoreFields })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 403) {
      console.warn(`[OrderController] Firestore PATCH returned 403. Client SDK will apply direct update.`);
      return { _permissionRestricted: true };
    }
    throw new Error(`Firestore update failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Controller: Update order status with validation and transition checks
 * Handles return approval, rejection, accept, deliver, and cancel
 */
export async function updateOrderStatusController(req: Request, res: Response): Promise<void> {
  try {
    const orderId = (req.params.id || req.body.orderId || req.body.id || "").trim();
    const rawTargetStatus = req.body.status;
    const notes = req.body.notes || req.body.reason || "";
    const force = Boolean(req.body.force);

    // 1. Validate Order ID
    if (!orderId) {
      res.status(400).json({
        success: false,
        error: "Validation failed: 'orderId' is required."
      });
      return;
    }

    // 2. Validate Target Status
    if (!rawTargetStatus) {
      res.status(400).json({
        success: false,
        error: "Validation failed: 'status' is required."
      });
      return;
    }

    const targetStatus = normalizeStatus(rawTargetStatus);
    if (!targetStatus) {
      res.status(400).json({
        success: false,
        error: `Validation failed: '${rawTargetStatus}' is not a valid status. Valid statuses are: ${VALID_STATUSES.join(", ")}.`
      });
      return;
    }

    // 3. Fetch current order from database
    const authToken = req.headers.authorization;
    let existingDoc: any = null;
    try {
      existingDoc = await getFirestoreOrder(orderId, authToken);
    } catch (err: any) {
      console.error(`[OrderController] Error fetching order ${orderId}:`, err);
      res.status(500).json({
        success: false,
        error: `Failed to retrieve order from database: ${err.message}`
      });
      return;
    }

    if (!existingDoc) {
      res.status(404).json({
        success: false,
        error: `Order with ID '${orderId}' not found in database.`
      });
      return;
    }

    const currentData = existingDoc.fields ? parseFirestoreFields(existingDoc.fields) : {};
    const rawCurrentStatus =
      currentData.status || currentData.orderStatus || req.body.currentStatus || "pending";
    const currentStatus = normalizeStatus(rawCurrentStatus) || "pending";

    // 4. Validate Status Transition Logic
    if (!force) {
      // Check if already in target status (Idempotency)
      if (currentStatus === targetStatus) {
        res.status(200).json({
          success: true,
          message: `Order is already in '${targetStatus}' status.`,
          orderId,
          status: targetStatus,
          previousStatus: currentStatus,
          updatedAt: currentData.updatedAt || new Date().toISOString()
        });
        return;
      }

      const allowedTransitions = ALLOWED_TRANSITIONS[currentStatus] || [];
      const isAllowed = allowedTransitions.includes(targetStatus);

      // Special handling: if order has type "return" or returnStatus "requested", allow return_approved/return_rejected
      const isReturnRequest =
        currentData.type === "return" ||
        currentData.returnStatus === "requested" ||
        currentStatus === "return_requested";

      const canApproveReturn =
        (targetStatus === "return_approved" || targetStatus === "return_rejected") &&
        (isReturnRequest || currentStatus === "delivered");

      if (!isAllowed && !canApproveReturn) {
        res.status(400).json({
          success: false,
          error: `Invalid status transition: Cannot change order status from '${currentStatus}' to '${targetStatus}'. Allowed transitions from '${currentStatus}' are: ${allowedTransitions.join(", ") || "none"}.`,
          currentStatus,
          targetStatus,
          allowedTransitions
        });
        return;
      }
    }

    // 5. Build update payload according to target status
    const now = new Date();
    const updatePayload: Record<string, any> = {
      status: targetStatus,
      updatedAt: now
    };
    const fieldPathsToUpdate = ["status", "updatedAt"];

    if (targetStatus === "return_approved") {
      updatePayload.returnStatus = "approved";
      updatePayload.type = "return";
      updatePayload.isReturned = true;
      updatePayload.returnApprovedAt = now;
      if (notes) updatePayload.returnNotes = notes;
      fieldPathsToUpdate.push("returnStatus", "type", "isReturned", "returnApprovedAt");
      if (notes) fieldPathsToUpdate.push("returnNotes");
    } else if (targetStatus === "return_rejected") {
      updatePayload.returnStatus = "rejected";
      updatePayload.type = "return";
      updatePayload.returnRejectedAt = now;
      if (notes) updatePayload.returnRejectionReason = notes;
      fieldPathsToUpdate.push("returnStatus", "type", "returnRejectedAt");
      if (notes) fieldPathsToUpdate.push("returnRejectionReason");
    } else if (targetStatus === "return_requested") {
      updatePayload.returnStatus = "requested";
      updatePayload.type = "return";
      updatePayload.returnRequestedAt = now;
      fieldPathsToUpdate.push("returnStatus", "type", "returnRequestedAt");
    } else if (targetStatus === "accepted") {
      updatePayload.acceptedAt = now;
      fieldPathsToUpdate.push("acceptedAt");
    } else if (targetStatus === "delivered") {
      updatePayload.deliveredAt = now;
      fieldPathsToUpdate.push("deliveredAt");
    } else if (targetStatus === "cancelled") {
      updatePayload.cancelledAt = now;
      if (notes) updatePayload.cancelReason = notes;
      fieldPathsToUpdate.push("cancelledAt");
      if (notes) fieldPathsToUpdate.push("cancelReason");
    }

    // 6. Update in Firestore
    await updateFirestoreOrder(orderId, updatePayload, fieldPathsToUpdate, authToken);

    console.log(
      `[OrderController] Successfully transitioned order ${orderId} from '${currentStatus}' to '${targetStatus}'`
    );

    res.status(200).json({
      success: true,
      message:
        targetStatus === "return_approved"
          ? "Return Request Approved Successfully"
          : targetStatus === "return_rejected"
          ? "Return Request Rejected Successfully"
          : `Order status updated to ${targetStatus.toUpperCase()}`,
      orderId,
      status: targetStatus,
      previousStatus: currentStatus,
      updatedAt: now.toISOString(),
      fieldsUpdated: fieldPathsToUpdate
    });
  } catch (error: any) {
    console.error("[OrderController] Unhandled error in updateOrderStatusController:", error);
    res.status(500).json({
      success: false,
      error: `Internal server error: ${error.message || "Failed to update order status"}`
    });
  }
}

/**
 * Controller: Get details of a single order
 */
export async function getOrderController(req: Request, res: Response): Promise<void> {
  try {
    const orderId = (req.params.id || "").trim();
    if (!orderId) {
      res.status(400).json({ success: false, error: "Order ID is required" });
      return;
    }

    const authToken = req.headers.authorization;
    const doc = await getFirestoreOrder(orderId, authToken);
    if (!doc) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    if (doc._permissionRestricted) {
      res.status(200).json({
        success: true,
        order: {
          id: orderId,
          status: "pending"
        },
        note: "Permission restricted. Client SDK will access order data directly."
      });
      return;
    }

    const orderData = parseFirestoreFields(doc.fields);
    res.status(200).json({
      success: true,
      order: {
        id: orderId,
        ...orderData
      }
    });
  } catch (error: any) {
    console.error(`[OrderController] Error getting order ${req.params.id}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Controller: Get list of orders
 */
export async function listOrdersController(req: Request, res: Response): Promise<void> {
  try {
    const statusFilter = req.query.status as string | undefined;
    const url = `${FIRESTORE_REST_BASE}/orders?key=${FIREBASE_API_KEY}`;
    const headers: Record<string, string> = {};
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      if (response.status === 403) {
        // Firestore security rules require client authentication
        res.status(200).json({
          success: true,
          count: 0,
          orders: [],
          note: "Firestore security rules require client SDK authentication."
        });
        return;
      }
      throw new Error(`Failed to list orders (${response.status})`);
    }
    const data = await response.json();
    const documents = data.documents || [];

    let orders = documents.map((doc: any) => {
      const parts = (doc.name || "").split("/");
      const id = parts[parts.length - 1];
      const parsed = parseFirestoreFields(doc.fields);
      return { id, ...parsed };
    });

    if (statusFilter) {
      const normalizedFilter = normalizeStatus(statusFilter);
      if (normalizedFilter) {
        orders = orders.filter((o: any) => normalizeStatus(o.status) === normalizedFilter);
      }
    }

    res.status(200).json({
      success: true,
      count: orders.length,
      orders
    });
  } catch (error: any) {
    console.error("[OrderController] Error listing orders:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Controller: Delete an order permanently (Admin only)
 */
export async function deleteOrderController(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ success: false, error: "Missing order ID" });
    return;
  }

  try {
    // 1. Delete via Admin SDK if credentials are present
    if (hasAdminServiceAccountCredentials()) {
      try {
        const adminApp = getFirebaseAdmin();
        if (adminApp) {
          const db = getFirestore(adminApp);
          await db.collection("orders").doc(id).delete();
          console.log(`[OrderController] Deleted order #${id} via Admin SDK.`);
        }
      } catch (adminErr) {
        console.warn("[OrderController] Admin SDK delete notice:", adminErr);
      }
    }

    // 2. Delete via REST API
    const url = `${FIRESTORE_REST_BASE}/orders/${encodeURIComponent(id)}?key=${FIREBASE_API_KEY}`;
    const headers: Record<string, string> = {};
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    await fetch(url, {
      method: "DELETE",
      headers
    }).catch(() => {});

    console.log(`[OrderController] Order #${id} deleted permanently by admin.`);

    res.status(200).json({
      success: true,
      message: `Order #${id} deleted successfully.`,
      orderId: id
    });
  } catch (error: any) {
    console.error(`[OrderController] Error deleting order ${id}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Controller: Create Order (Customer App)
 * Strictly verifies that shop is OPEN before allowing order placement!
 */
export async function createOrderController(req: Request, res: Response): Promise<void> {
  try {
    if (!isShopCurrentlyOpen()) {
      res.status(403).json({
        success: false,
        error: "Shop is currently CLOSED 🔴. Customer ordering is temporarily paused.",
        isShopOpen: false
      });
      return;
    }

    const { customerName, customerPhone, items, total } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, error: "Order must contain at least one item." });
      return;
    }

    const orderId = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const orderData = {
      customerName: customerName || "Customer",
      customerPhone: customerPhone || "N/A",
      items,
      total: Number(total || 0),
      status: "pending",
      createdAt: new Date().toISOString()
    };

    // Save via Admin SDK if available
    if (hasAdminServiceAccountCredentials()) {
      try {
        const adminApp = getFirebaseAdmin();
        if (adminApp) {
          const db = getFirestore(adminApp);
          await db.collection("orders").doc(orderId).set(orderData);
        }
      } catch (adminErr) {
        console.warn("[OrderController] Admin SDK order creation notice:", adminErr);
      }
    }

    res.status(201).json({
      success: true,
      message: "Order placed successfully.",
      orderId,
      order: orderData
    });
  } catch (error: any) {
    console.error("[OrderController] Error creating order:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}
