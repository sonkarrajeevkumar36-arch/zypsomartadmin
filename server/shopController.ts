import { Request, Response } from "express";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";

// Cache shop status in memory for lightning-fast responses
let shopStatusCache = {
  isOpen: true,
  updatedAt: new Date().toISOString(),
  updatedBy: "system"
};

/**
 * Controller: Get Shop Status (Open / Closed)
 * Document: shopSettings/store
 */
export async function getShopStatusController(req: Request, res: Response): Promise<void> {
  try {
    const url = `${FIRESTORE_REST_BASE}/shopSettings/store?key=${FIREBASE_API_KEY}`;
    const headers: Record<string, string> = {};
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    const response = await fetch(url, { headers });
    if (response.ok) {
      const data = await response.json();
      const fields = data.fields || {};
      const isOpen = fields.isOpen?.booleanValue !== undefined ? fields.isOpen.booleanValue : true;
      const updatedAt = fields.updatedAt?.timestampValue || fields.updatedAt?.stringValue || shopStatusCache.updatedAt;
      const updatedBy = fields.updatedBy?.stringValue || "admin";

      shopStatusCache = {
        isOpen,
        updatedAt,
        updatedBy
      };
    }

    res.status(200).json({
      success: true,
      shopName: "Zypsomart",
      isOpen: shopStatusCache.isOpen,
      statusText: shopStatusCache.isOpen ? "OPEN" : "CLOSED",
      updatedAt: shopStatusCache.updatedAt,
      updatedBy: shopStatusCache.updatedBy
    });
  } catch (error: any) {
    // Return cached status on network failure
    res.status(200).json({
      success: true,
      shopName: "Zypsomart",
      isOpen: shopStatusCache.isOpen,
      statusText: shopStatusCache.isOpen ? "OPEN" : "CLOSED",
      updatedAt: shopStatusCache.updatedAt,
      updatedBy: shopStatusCache.updatedBy
    });
  }
}

/**
 * Controller: Update Shop Status (Admin Open / Close)
 * Document: shopSettings/store
 */
export async function updateShopStatusController(req: Request, res: Response): Promise<void> {
  try {
    const { isOpen, updatedBy } = req.body;
    if (typeof isOpen !== "boolean") {
      res.status(400).json({ success: false, error: "Missing or invalid 'isOpen' boolean parameter" });
      return;
    }

    const now = new Date().toISOString();
    const adminUser = updatedBy || "admin@zypsomart.com";

    // Update in-memory cache immediately
    shopStatusCache = {
      isOpen,
      updatedAt: now,
      updatedBy: adminUser
    };

    // Commit to Firestore REST endpoint
    const url = `${FIRESTORE_REST_BASE}/shopSettings/store?updateMask.fieldPaths=isOpen&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=updatedBy&key=${FIREBASE_API_KEY}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    const body = {
      fields: {
        isOpen: { booleanValue: isOpen },
        updatedAt: { timestampValue: now },
        updatedBy: { stringValue: adminUser }
      }
    };

    await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body)
    }).catch((err) => {
      console.warn("[ShopController] Firestore REST patch notice:", err?.message || err);
    });

    console.log(`[ShopController] Shop status updated to: ${isOpen ? "🟢 OPEN" : "🔴 CLOSED"} by ${adminUser}`);

    res.status(200).json({
      success: true,
      isOpen,
      statusText: isOpen ? "OPEN" : "CLOSED",
      message: `Shop status changed to ${isOpen ? "OPEN" : "CLOSED"}.`,
      updatedAt: now,
      updatedBy: adminUser
    });
  } catch (error: any) {
    console.error("[ShopController] Error updating shop status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}
