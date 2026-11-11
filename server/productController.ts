import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "zypso-mart-cd989";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIREBASE_API_KEY = "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU";

const DATA_DIR = path.join(process.cwd(), ".data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

export const DEFAULT_PRESET_CATEGORIES = [
  "Fruits",
  "Vegetables",
  "Dairy & Eggs",
  "Bakery & Bread",
  "Snacks & Chips",
  "Beverages",
  "Personal Care",
  "Cosmetics",
  "Fast Food",
  "Stationary",
  "Electronic Products",
  "Household Essentials",
  "Sweets & Confectionery"
];

export interface ServerProduct {
  id: string;
  name: string;
  category: string;
  price: number;
  unit: string;
  image?: string;
  imageUrl?: string;
  description?: string;
  isAvailable: boolean;
  createdAt?: string;
  updatedAt?: string;
  // Offer fields
  isOffer?: boolean;
  offerType?: "percentage" | "fixed";
  offerValue?: number;
  offerPrice?: number;
  offerStartDate?: string | null;
  offerEndDate?: string | null;
  offerEnabled?: boolean;
}

// In-memory product cache for instant response times
let productsCache: Map<string, ServerProduct> = new Map();

// Helper to calculate offer price
export function calculateOfferPrice(
  originalPrice: number,
  offerType?: "percentage" | "fixed",
  offerValue?: number
): number {
  if (!offerType || offerValue === undefined || offerValue === null || offerValue <= 0) {
    return originalPrice;
  }
  if (offerType === "percentage") {
    const discounted = originalPrice * (1 - offerValue / 100);
    return Math.max(0, Math.round(discounted * 100) / 100);
  }
  if (offerType === "fixed") {
    const discounted = originalPrice - offerValue;
    return Math.max(0, Math.round(discounted * 100) / 100);
  }
  return originalPrice;
}

// Load products from disk
function loadProductsFromDisk(): void {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const content = fs.readFileSync(PRODUCTS_FILE, "utf8");
      const list: ServerProduct[] = JSON.parse(content);
      productsCache.clear();
      for (const p of list) {
        if (p && p.id) {
          productsCache.set(p.id, p);
        }
      }
      console.log(`[ProductController] Loaded ${productsCache.size} products from local persistence.`);
    }
  } catch (err) {
    console.warn("[ProductController] Error loading products from disk:", err);
  }
}

// Save products to disk
function saveProductsToDisk(): void {
  try {
    const list = Array.from(productsCache.values());
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.warn("[ProductController] Failed to write products to disk:", err);
  }
}

// Sync single product write to Firestore (background, non-blocking)
async function syncProductToFirestore(
  productId: string,
  productData: Partial<ServerProduct>,
  authToken?: string
): Promise<void> {
  try {
    // 1. Try Firebase Admin SDK if initialized
    const apps = getApps();
    if (apps.length > 0) {
      try {
        const adminDb = getFirestore(apps[0]!);
        await adminDb.collection("products").doc(productId).set(productData, { merge: true });
        return;
      } catch (adminErr) {
        // Fall back to REST
      }
    }

    // 2. Try Firestore REST API
    const baseUrl = `${FIRESTORE_REST_BASE}/products/${encodeURIComponent(productId)}?key=${FIREBASE_API_KEY}`;
    const firestoreFields: Record<string, any> = {};

    for (const [key, val] of Object.entries(productData)) {
      if (val === undefined) continue;
      if (typeof val === "string") {
        firestoreFields[key] = { stringValue: val };
      } else if (typeof val === "boolean") {
        firestoreFields[key] = { booleanValue: val };
      } else if (typeof val === "number") {
        firestoreFields[key] = Number.isInteger(val)
          ? { integerValue: val.toString() }
          : { doubleValue: val };
      } else if (val === null) {
        firestoreFields[key] = { nullValue: null };
      }
    }

    const fieldKeys = Object.keys(firestoreFields);
    const maskQuery = fieldKeys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    const fullUrl = maskQuery ? `${baseUrl}&${maskQuery}` : baseUrl;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) {
      headers["Authorization"] = authToken;
    }

    const restRes = await fetch(fullUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: firestoreFields })
    });
    if (!restRes.ok && restRes.status !== 404) {
      const restErr = await restRes.text().catch(() => "");
      console.warn(`[ProductController] Cloud sync response (HTTP ${restRes.status}):`, restErr.slice(0, 200));
    }
  } catch (err: any) {
    console.warn(`[ProductController] Firestore cloud sync notice for product ${productId}:`, err?.message || err);
  }
}

// Initialize on load
loadProductsFromDisk();

/**
 * Controller: List all products
 * GET /api/products
 */
export async function listProductsController(req: Request, res: Response): Promise<void> {
  try {
    const list = Array.from(productsCache.values());
    res.status(200).json({
      success: true,
      count: list.length,
      products: list
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Create new product
 * POST /api/products
 */
export async function createProductController(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const category = String(body.category || "").trim();
    const price = Number(body.price);
    const unit = String(body.unit || "piece").trim();
    const image = String(body.image || body.imageUrl || "").trim();
    const description = String(body.description || "").trim();
    const isAvailable = body.isAvailable !== false;

    // Offer fields
    const isOffer = Boolean(body.isOffer);
    const offerType = body.offerType === "fixed" ? "fixed" : "percentage";
    const offerValue = body.offerValue !== undefined ? Number(body.offerValue) : undefined;
    const offerStartDate = body.offerStartDate || null;
    const offerEndDate = body.offerEndDate || null;
    const offerEnabled = body.offerEnabled !== false;

    if (!name) {
      res.status(400).json({ success: false, error: "Product name is required." });
      return;
    }
    if (!category) {
      res.status(400).json({ success: false, error: "Product category is required." });
      return;
    }
    if (isNaN(price) || price <= 0) {
      res.status(400).json({ success: false, error: "Price must be a valid number greater than 0." });
      return;
    }

    // Generate unique ID (Firestore style random string)
    const newId =
      body.id ||
      "prod_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);

    const calculatedPrice = isOffer && offerValue !== undefined
      ? calculateOfferPrice(price, offerType, offerValue)
      : price;

    const newProduct: ServerProduct = {
      id: newId,
      name,
      category,
      price,
      unit: unit || "piece",
      image: image || "",
      imageUrl: image || "",
      description,
      isAvailable,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isOffer: Boolean(isOffer),
      offerType: isOffer ? offerType : undefined,
      offerValue: isOffer ? offerValue : undefined,
      offerPrice: isOffer ? calculatedPrice : undefined,
      offerStartDate: isOffer ? offerStartDate : null,
      offerEndDate: isOffer ? offerEndDate : null,
      offerEnabled: isOffer ? offerEnabled : false
    };

    productsCache.set(newId, newProduct);
    saveProductsToDisk();

    // Background sync to Firestore
    syncProductToFirestore(newId, newProduct, req.headers.authorization);

    console.log(`[ProductController] Created new product "${name}" (ID: ${newId}, Price: ₹${price})`);

    res.status(201).json({
      success: true,
      message: `Product "${name}" added successfully.`,
      product: newProduct
    });
  } catch (err: any) {
    console.error("[ProductController] Error creating product:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Update existing product
 * PUT /api/products/:id or PATCH /api/products/:id
 */
export async function updateProductController(req: Request, res: Response): Promise<void> {
  try {
    const productId = String(req.params.id || req.body.id || "").trim();
    if (!productId) {
      res.status(400).json({ success: false, error: "Product ID is required." });
      return;
    }

    const existing = productsCache.get(productId) || {
      id: productId,
      name: "",
      category: "",
      price: 0,
      unit: "piece",
      isAvailable: true
    };

    const body = req.body || {};
    const name = body.name !== undefined ? String(body.name).trim() : existing.name;
    const category = body.category !== undefined ? String(body.category).trim() : existing.category;
    const price = body.price !== undefined ? Number(body.price) : existing.price;
    const unit = body.unit !== undefined ? String(body.unit).trim() : existing.unit || "piece";
    const image =
      body.image !== undefined
        ? String(body.image).trim()
        : body.imageUrl !== undefined
        ? String(body.imageUrl).trim()
        : existing.imageUrl || existing.image || "";
    const description =
      body.description !== undefined ? String(body.description).trim() : existing.description || "";
    const isAvailable =
      body.isAvailable !== undefined ? Boolean(body.isAvailable) : existing.isAvailable;

    if (!name) {
      res.status(400).json({ success: false, error: "Product name cannot be empty." });
      return;
    }
    if (!category) {
      res.status(400).json({ success: false, error: "Product category cannot be empty." });
      return;
    }
    if (isNaN(price) || price <= 0) {
      res.status(400).json({ success: false, error: "Price must be a valid positive number." });
      return;
    }

    // Offer fields handling
    let isOffer = existing.isOffer ?? false;
    let offerType = existing.offerType ?? "percentage";
    let offerValue = existing.offerValue;
    let offerPrice = existing.offerPrice;
    let offerStartDate = existing.offerStartDate;
    let offerEndDate = existing.offerEndDate;
    let offerEnabled = existing.offerEnabled ?? false;

    if (body.isOffer !== undefined) isOffer = Boolean(body.isOffer);
    if (body.offerType !== undefined) offerType = body.offerType === "fixed" ? "fixed" : "percentage";
    if (body.offerValue !== undefined) offerValue = Number(body.offerValue);
    if (body.offerStartDate !== undefined) offerStartDate = body.offerStartDate;
    if (body.offerEndDate !== undefined) offerEndDate = body.offerEndDate;
    if (body.offerEnabled !== undefined) offerEnabled = Boolean(body.offerEnabled);

    if (isOffer && offerValue !== undefined) {
      offerPrice = calculateOfferPrice(price, offerType, offerValue);
    } else if (!isOffer) {
      offerPrice = undefined;
    }

    const updated: ServerProduct = {
      ...existing,
      id: productId,
      name,
      category,
      price,
      unit,
      image,
      imageUrl: image,
      description,
      isAvailable,
      updatedAt: new Date().toISOString(),
      isOffer,
      offerType: isOffer ? offerType : undefined,
      offerValue: isOffer ? offerValue : undefined,
      offerPrice: isOffer ? offerPrice : undefined,
      offerStartDate: isOffer ? offerStartDate : null,
      offerEndDate: isOffer ? offerEndDate : null,
      offerEnabled: isOffer ? offerEnabled : false
    };

    productsCache.set(productId, updated);
    saveProductsToDisk();

    // Background sync to Firestore
    syncProductToFirestore(productId, updated, req.headers.authorization);

    console.log(`[ProductController] Updated product "${name}" (ID: ${productId})`);

    res.status(200).json({
      success: true,
      message: `Product "${name}" updated successfully.`,
      product: updated
    });
  } catch (err: any) {
    console.error("[ProductController] Error updating product:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Delete product
 * DELETE /api/products/:id
 */
export async function deleteProductController(req: Request, res: Response): Promise<void> {
  try {
    const productId = String(req.params.id || "").trim();
    if (!productId) {
      res.status(400).json({ success: false, error: "Product ID is required." });
      return;
    }

    const existing = productsCache.get(productId);
    productsCache.delete(productId);
    saveProductsToDisk();

    // Also attempt delete from Firestore
    try {
      const url = `${FIRESTORE_REST_BASE}/products/${encodeURIComponent(productId)}?key=${FIREBASE_API_KEY}`;
      const headers: Record<string, string> = {};
      if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;
      fetch(url, { method: "DELETE", headers }).catch(() => {});
    } catch {}

    res.status(200).json({
      success: true,
      message: `Product ${existing?.name || productId} deleted successfully.`,
      productId
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Configure or toggle Offer on a Product
 * POST /api/products/:id/offer
 */
export async function setProductOfferController(req: Request, res: Response): Promise<void> {
  try {
    const productId = String(req.params.id || "").trim();
    if (!productId) {
      res.status(400).json({ success: false, error: "Product ID is required." });
      return;
    }

    const product = productsCache.get(productId);
    if (!product) {
      res.status(404).json({ success: false, error: "Product not found." });
      return;
    }

    const {
      offerType = "percentage",
      offerValue,
      offerStartDate = null,
      offerEndDate = null,
      offerEnabled = true
    } = req.body;

    const numValue = Number(offerValue);
    if (isNaN(numValue) || numValue <= 0) {
      res.status(400).json({ success: false, error: "Discount value must be greater than 0." });
      return;
    }

    if (offerType === "percentage" && (numValue > 99 || numValue < 1)) {
      res.status(400).json({ success: false, error: "Percentage discount must be between 1% and 99%." });
      return;
    }

    if (offerType === "fixed" && numValue >= product.price) {
      res.status(400).json({ success: false, error: `Fixed discount cannot exceed product price of ₹${product.price}.` });
      return;
    }

    const calculatedOfferPrice = calculateOfferPrice(product.price, offerType, numValue);

    const updated: ServerProduct = {
      ...product,
      isOffer: true,
      offerType: offerType === "fixed" ? "fixed" : "percentage",
      offerValue: numValue,
      offerPrice: calculatedOfferPrice,
      offerStartDate: offerStartDate || null,
      offerEndDate: offerEndDate || null,
      offerEnabled: Boolean(offerEnabled),
      updatedAt: new Date().toISOString()
    };

    productsCache.set(productId, updated);
    saveProductsToDisk();

    syncProductToFirestore(productId, updated, req.headers.authorization);

    res.status(200).json({
      success: true,
      message: `Offer configured for "${product.name}": ₹${product.price} ➔ ₹${calculatedOfferPrice}`,
      product: updated
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Remove Offer from a Product
 * DELETE /api/products/:id/offer
 */
export async function removeProductOfferController(req: Request, res: Response): Promise<void> {
  try {
    const productId = String(req.params.id || "").trim();
    if (!productId) {
      res.status(400).json({ success: false, error: "Product ID is required." });
      return;
    }

    const product = productsCache.get(productId);
    if (!product) {
      res.status(404).json({ success: false, error: "Product not found." });
      return;
    }

    const updated: ServerProduct = {
      ...product,
      isOffer: false,
      offerType: undefined,
      offerValue: undefined,
      offerPrice: undefined,
      offerStartDate: null,
      offerEndDate: null,
      offerEnabled: false,
      updatedAt: new Date().toISOString()
    };

    productsCache.set(productId, updated);
    saveProductsToDisk();

    syncProductToFirestore(productId, updated, req.headers.authorization);

    res.status(200).json({
      success: true,
      message: `Offer removed from "${product.name}".`,
      product: updated
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
/**
 * Controller: List Categories with presets fallback & dynamically extracted product categories
 * GET /api/categories
 */
export async function listCategoriesController(req: Request, res: Response): Promise<void> {
  try {
    const catMap = new Map<string, { id: string; name: string; icon?: string }>();

    // 1. Load from CATEGORIES_FILE if present
    if (fs.existsSync(CATEGORIES_FILE)) {
      try {
        const fileContent = fs.readFileSync(CATEGORIES_FILE, "utf8");
        const parsed = JSON.parse(fileContent);
        if (Array.isArray(parsed)) {
          parsed.forEach((c) => {
            const name = String(c.name || "").trim();
            if (name) {
              catMap.set(name.toLowerCase(), {
                id: c.id || `cat_${name.toLowerCase()}`,
                name: name,
                icon: c.icon || ""
              });
            }
          });
        }
      } catch {}
    }

    // 2. Discover all categories from loaded products in memory
    for (const p of productsCache.values()) {
      const pCat = String(p.category || "").trim();
      if (pCat && !catMap.has(pCat.toLowerCase())) {
        catMap.set(pCat.toLowerCase(), {
          id: `cat_prod_${encodeURIComponent(pCat.toLowerCase())}`,
          name: pCat
        });
      }
    }

    // 3. Fallback presets if empty
    if (catMap.size === 0) {
      DEFAULT_PRESET_CATEGORIES.forEach((name, i) => {
        catMap.set(name.toLowerCase(), {
          id: `preset_cat_${i + 1}`,
          name
        });
      });
    }

    const categories = Array.from(catMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

    res.status(200).json({
      success: true,
      categories
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Add a category
 * POST /api/categories
 */
export async function addCategoryController(req: Request, res: Response): Promise<void> {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      res.status(400).json({ success: false, error: "Category name is required." });
      return;
    }

    let list: Array<{ id: string; name: string; icon?: string }> = [];
    if (fs.existsSync(CATEGORIES_FILE)) {
      try {
        list = JSON.parse(fs.readFileSync(CATEGORIES_FILE, "utf8"));
      } catch {}
    }

    const exists = list.some((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      const newCat = {
        id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        icon: req.body.icon || "📦"
      };
      list.push(newCat);
      fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(list, null, 2), "utf8");
      res.status(201).json({ success: true, category: newCat });
      return;
    }

    res.status(200).json({ success: true, message: "Category already exists." });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}
