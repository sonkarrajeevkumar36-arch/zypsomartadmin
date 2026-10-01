import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";
const STATUS_FILE = path.join(process.cwd(), "shop_status.json");

// Load persistent shop status from disk
function loadStatusFromDisk() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const content = fs.readFileSync(STATUS_FILE, "utf8");
      const parsed = JSON.parse(content);
      if (typeof parsed.isOpen === "boolean") {
        return {
          isOpen: parsed.isOpen,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          updatedBy: parsed.updatedBy || "system"
        };
      }
    }
  } catch (e) {
    console.warn("[ShopController] Error reading shop_status.json:", e);
  }
  return {
    isOpen: true,
    updatedAt: new Date().toISOString(),
    updatedBy: "system"
  };
}

// Cache shop status in memory & disk for lightning-fast, zero-permission-error responses
let shopStatusCache = loadStatusFromDisk();

function saveStatusToDisk() {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(shopStatusCache, null, 2), "utf8");
  } catch (err) {
    console.warn("[ShopController] Failed to write shop status to disk:", err);
  }
}

/**
 * Controller: Get Shop Status (Open / Closed)
 * Document: shopSettings/store
 */
export async function getShopStatusController(req: Request, res: Response): Promise<void> {
  try {
    res.status(200).json({
      success: true,
      shopName: "Zypsomart",
      isOpen: shopStatusCache.isOpen,
      statusText: shopStatusCache.isOpen ? "OPEN" : "CLOSED",
      updatedAt: shopStatusCache.updatedAt,
      updatedBy: shopStatusCache.updatedBy
    });
  } catch (error: any) {
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

    // Update in-memory cache and save to disk immediately
    shopStatusCache = {
      isOpen,
      updatedAt: now,
      updatedBy: adminUser
    };
    saveStatusToDisk();

    // Attempt Firebase Admin SDK write if available
    const apps = getApps();
    if (apps.length > 0) {
      try {
        const adminDb = getFirestore(apps[0]!);
        adminDb.collection("shopSettings").doc("store").set(
          {
            isOpen,
            updatedAt: now,
            updatedBy: adminUser
          },
          { merge: true }
        ).catch(() => {});
      } catch {}
    }

    // Attempt Firestore REST endpoint gracefully
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

    fetch(url, {
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
