import React, { Component, useState, useEffect, useRef, useMemo, ErrorInfo, ReactNode } from "react";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  User
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  setDoc,
  addDoc,
  query,
  orderBy,
  getDocs,
  limit
} from "firebase/firestore";
import {
  Bell,
  BellRing,
  CircleCheckBig,
  CircleX,
  Download,
  FileText,
  IndianRupee,
  LayoutDashboard,
  LogOut,
  Package,
  Pen,
  Plus,
  RefreshCcw,
  Save,
  Search,
  ShoppingCart,
  ThumbsUp,
  Trash2,
  Volume2,
  VolumeX,
  Settings2,
  CheckCircle2,
  AlertTriangle,
  Smartphone,
  Laptop,
  Radio,
  Clock,
  X,
  Tag,
  BadgePercent,
  Percent,
  Calendar,
  Flame,
  Sparkles,
  Filter,
  Check,
  ToggleLeft,
  ToggleRight,
  Truck,
  CheckCheck,
  Navigation,
  ChevronRight,
  Printer,
  Minus,
  Store,
  ShoppingBag,
  Eye
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import appLogo from "./assets/images/logo.png";
import { auth, db } from "./firebase";
import { Order, Product, Category } from "./types";
import { InvoiceModal } from "./components/InvoiceModal";
import { alarmAudio } from "./utils/alarmAudio";
import {
  registerDeviceForNotifications,
  unregisterDeviceToken,
  isNotificationSupported,
  getNotificationPermission,
  onForegroundMessageListener,
  triggerTestPushNotification
} from "./services/fcm";

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=500&q=80";

// Format address whether it is string or object
const formatAddress = (addr: any): string => {
  if (!addr) return "N/A";
  if (typeof addr === "string") return addr;
  if (typeof addr === "object" && addr !== null) {
    const parts = [
      addr.street,
      addr.addressLine1 || addr.addressLine2 || addr.address,
      addr.city,
      addr.state,
      addr.postalCode || addr.zipCode || addr.zip
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(", ");
  }
  return String(addr);
};

// Robust normalizer for order status to handle all return/cancel/delivery/packaging/on_the_way variants
export const normalizeStatus = (
  rawStatus?: string,
  rawType?: string,
  rawReturnStatus?: string
): string => {
  const s = String(rawStatus || "pending").toLowerCase().trim().replace(/[\s-]+/g, "_");

  if (s.includes("return_approved") || s === "returnapproved" || rawReturnStatus === "approved") {
    return "return_approved";
  }
  if (s.includes("return_rejected") || s === "returnrejected" || rawReturnStatus === "rejected") {
    return "return_rejected";
  }
  if (
    s.includes("return") ||
    s === "returned" ||
    rawType === "return" ||
    rawReturnStatus === "requested" ||
    rawReturnStatus === "pending"
  ) {
    return "return_requested";
  }
  if (s === "accepted" || s === "accept") return "accepted";
  if (
    s === "packaging" ||
    s === "packing" ||
    s === "packed" ||
    s === "preparing" ||
    s === "in_packaging"
  ) {
    return "packaging";
  }
  if (
    s === "on_the_way" ||
    s === "ontheway" ||
    s === "out_for_delivery" ||
    s === "outfordelivery" ||
    s === "dispatched" ||
    s === "in_transit"
  ) {
    return "on_the_way";
  }
  if (s === "delivered" || s === "deliver" || s === "completed") return "delivered";
  if (s === "cancelled" || s === "cancel" || s === "canceled") return "cancelled";

  return "pending";
};

// Check if an order is a return order
export const isReturnOrder = (order: Order): boolean => {
  if (!order) return false;
  const status = String(order.status || "").toLowerCase();
  return (
    order.type === "return" ||
    status.includes("return") ||
    status === "return_requested" ||
    status === "return_approved" ||
    status === "return_rejected" ||
    Boolean(order.returnStatus)
  );
};

// 12-Hour PIN Security Verification Configuration
const PIN_VERIFICATION_DURATION = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

function getPinVerificationKey(userId: string): string {
  return `zypsomart_pin_verified_${userId}`;
}

function checkIsPinVerified(userId: string): boolean {
  if (typeof window === "undefined" || !userId) return false;
  try {
    const raw = localStorage.getItem(getPinVerificationKey(userId));
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || typeof data.verifiedAt !== "number") return false;
    const elapsed = Date.now() - data.verifiedAt;
    return elapsed >= 0 && elapsed < PIN_VERIFICATION_DURATION;
  } catch {
    return false;
  }
}

function savePinVerification(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    const record = {
      verifiedAt: Date.now(),
      vToken: btoa(`${userId}:${Date.now()}`)
    };
    localStorage.setItem(getPinVerificationKey(userId), JSON.stringify(record));
  } catch (e) {
    console.warn("Could not save PIN verification to localStorage:", e);
  }
}

function clearPinVerification(userId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) {
      localStorage.removeItem(getPinVerificationKey(userId));
    } else {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("zypsomart_pin_verified_")) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch {}
}

// Parse Firestore raw order document into typed Order
const parseOrderDoc = (id: string, data: any): Order => {
  const customerName =
    data.customerName ||
    data.name ||
    data.userName ||
    data.username ||
    data.user?.name ||
    data.user?.displayName ||
    (typeof data.user === "string" ? data.user : null) ||
    data.customer?.name ||
    (typeof data.customer === "string" ? data.customer : null) ||
    (data.firstName && data.lastName
      ? `${data.firstName} ${data.lastName}`
      : data.firstName || data.lastName || "") ||
    "Guest Customer";

  const customerPhone =
    data.customerPhone ||
    data.phone ||
    data.phoneNumber ||
    data.mobile ||
    data.contact ||
    data.user?.phone ||
    data.user?.phoneNumber ||
    data.customer?.phone ||
    data.customer?.phoneNumber ||
    "N/A";

  const customerAddress =
    formatAddress(data.customerAddress) !== "N/A"
      ? formatAddress(data.customerAddress)
      : formatAddress(data.address) !== "N/A"
      ? formatAddress(data.address)
      : formatAddress(data.deliveryAddress) !== "N/A"
      ? formatAddress(data.deliveryAddress)
      : formatAddress(data.shippingAddress) !== "N/A"
      ? formatAddress(data.shippingAddress)
      : formatAddress(data.location);

  const rawStatus = data.status || data.orderStatus || "pending";
  const rawType = data.type;
  const rawReturnStatus = data.returnStatus;
  const status = normalizeStatus(rawStatus, rawType, rawReturnStatus);

  const rawItems = data.items || data.products || data.orderItems || [];
  const items = Array.isArray(rawItems)
    ? rawItems.map((item: any) => ({
        name: item.name || item.productName || item.title || item.itemName || "Product",
        qty: Number(item.qty || item.quantity || item.qtyOrdered || item.count || 1),
        price: Number(item.price || item.rate || item.itemPrice || item.unitPrice || 0)
      }))
    : [];

  const total = Number(
    data.total ||
      data.totalBill ||
      data.totalPrice ||
      data.grandTotal ||
      items.reduce((sum, item) => sum + item.price * item.qty, 0)
  );

  const notes =
    data.notes ||
    data.customerNotes ||
    data.instructions ||
    data.deliveryInstructions ||
    data.comment ||
    data.comments ||
    "";

  const type =
    data.type ||
    (status.includes("return") || isReturnOrder({ ...data, status } as any)
      ? "return"
      : "normal");

  return {
    id,
    customerName,
    customerPhone,
    customerAddress,
    total,
    status,
    orderStatus: data.orderStatus || status,
    deliveryStatus: data.deliveryStatus,
    items,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    acceptedAt: data.acceptedAt || data.acceptTime,
    packagingAt: data.packagingAt || data.packedAt || data.packagingTime,
    packedAt: data.packedAt,
    onTheWayAt: data.onTheWayAt || data.dispatchedAt || data.outForDeliveryAt || data.onTheWayTime,
    dispatchedAt: data.dispatchedAt || data.outForDeliveryAt,
    outForDeliveryAt: data.outForDeliveryAt,
    deliveredAt: data.deliveredAt || data.deliveredTime,
    cancelledAt: data.cancelledAt,
    isCompleted: Boolean(data.isCompleted || status === "delivered"),
    paymentMethod:
      data.paymentMethod || data.paymentType || data.paymentMode || "Cash on Delivery",
    paymentStatus: data.paymentStatus || (data.paymentMethod === "Razorpay" ? "Paid Online" : "Pending COD"),
    notes,
    customerNotes: notes,
    internalNotes: data.internalNotes || data.adminNotes || data.adminNote || "",
    adminNotes: data.internalNotes || data.adminNotes || data.adminNote || "",
    type,
    returnStatus: data.returnStatus,
    returnNotes: data.returnNotes,
    returnRejectionReason: data.returnRejectionReason
  };
};

export const COMMON_PRODUCT_UNITS = [
  "Kg",
  "gram",
  "liter",
  "package",
  "bunch",
  "bottle",
  "piece",
  "paw",
  "dozen",
  "packet",
  "box"
];

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

// Helper to determine active pricing, discount badge, and offer validity
export function getProductPricing(product: Product) {
  const originalPrice = Number(product.price) || 0;
  const isOfferConfigured = Boolean(product.isOffer);

  if (!isOfferConfigured) {
    return {
      hasActiveOffer: false,
      isOffer: false,
      offerStatus: "none" as "none" | "active" | "upcoming" | "expired" | "disabled",
      originalPrice,
      finalPrice: originalPrice,
      discountPercent: 0,
      discountText: "",
      savings: 0
    };
  }

  const now = new Date();
  let status: "active" | "upcoming" | "expired" | "disabled" = "active";

  if (!product.offerEnabled) {
    status = "disabled";
  } else if (product.offerStartDate && new Date(product.offerStartDate) > now) {
    status = "upcoming";
  } else if (product.offerEndDate && new Date(product.offerEndDate) < now) {
    status = "expired";
  }

  const isActive = status === "active";
  let finalPrice = originalPrice;
  if (
    isActive &&
    typeof product.offerPrice === "number" &&
    product.offerPrice > 0 &&
    product.offerPrice < originalPrice
  ) {
    finalPrice = product.offerPrice;
  } else if (isActive && product.offerValue && product.offerValue > 0) {
    if (product.offerType === "fixed") {
      finalPrice = Math.max(0, originalPrice - product.offerValue);
    } else {
      finalPrice = Math.max(0, Math.round(originalPrice * (1 - product.offerValue / 100)));
    }
  }

  const savings = Math.max(0, originalPrice - finalPrice);
  const discountPercent =
    originalPrice > 0 && savings > 0 ? Math.round((savings / originalPrice) * 100) : 0;

  const discountText =
    product.offerType === "fixed"
      ? `₹${product.offerValue} OFF`
      : `${product.offerValue || discountPercent}% OFF`;

  return {
    hasActiveOffer: isActive && savings > 0,
    isOffer: true,
    offerStatus: status,
    originalPrice,
    finalPrice,
    discountPercent,
    discountText,
    savings
  };
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// Global Error Boundary
class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  declare props: ErrorBoundaryProps;
  public state: ErrorBoundaryState = { hasError: false, error: null };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[Global Error Boundary] Caught exception:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-center">
          <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-red-100 flex flex-col items-center">
            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mb-6 text-red-500">
              <CircleX size={40} />
            </div>
            <h2 className="text-2xl font-black text-slate-950 mb-2">Something Went Wrong</h2>
            <p className="text-sm text-slate-500 mb-6 font-medium leading-relaxed">
              The application encountered an unexpected exception. Please refresh the page or
              contact support.
            </p>
            {this.state.error?.message && (
              <pre className="w-full bg-slate-100 text-slate-600 font-mono text-[10px] p-4 rounded-xl mb-6 overflow-x-auto text-left max-h-40">
                {String(this.state.error.message)}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 rounded-2xl shadow-lg shadow-emerald-100 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <RefreshCcw size={16} />
              <span>Reload Application</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <GlobalErrorBoundary>
      <AdminDashboard />
    </GlobalErrorBoundary>
  );
}

function AdminDashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  // Fast boot: hydrate products instantly from cache to avoid layout shift & eliminate redundant reads
  const [products, setProducts] = useState<Product[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const cached = localStorage.getItem("zypsomart_cached_products_v2");
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  // Fast boot: hydrate static categories from cache
  const [categories, setCategories] = useState<Category[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const cached = localStorage.getItem("zypsomart_cached_categories_v2");
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"orders" | "products" | "offers">("orders");
  const [user, setUser] = useState<User | null>(null);

  // Scalable pagination limit for real-time orders (defaults to 100 recent orders)
  const [orderLimit, setOrderLimit] = useState<number>(100);
  const [isLoadingProducts, setIsLoadingProducts] = useState<boolean>(false);
  const productsLastFetchedRef = useRef<number>(0);
  const categoriesLastFetchedRef = useRef<number>(0);

  // Authentication states
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // PIN Verification states (Default PIN: "6823")
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [isPinVerified, setIsPinVerified] = useState(false);

  // Dashboard notification and banner error state
  const [bannerError, setBannerError] = useState("");

  // Alerts and PWA installation states
  const [newOrderAlert, setNewOrderAlert] = useState<Order | null>(null);

  // New Order Alarm & Push Notification States
  const [isAlarmEnabled, setIsAlarmEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem("zypsomart_alarm_enabled") !== "false";
    } catch {
      return true;
    }
  });
  const isAlarmEnabledRef = useRef(isAlarmEnabled);
  isAlarmEnabledRef.current = isAlarmEnabled;

  const [isAlarmRinging, setIsAlarmRinging] = useState(false);
  const [showAlarmSettingsModal, setShowAlarmSettingsModal] = useState(false);
  const [notificationPermissionState, setNotificationPermissionState] = useState<string>(() => {
    try {
      return getNotificationPermission();
    } catch {
      return "unsupported";
    }
  });
  const [isRegisteringPush, setIsRegisteringPush] = useState(false);
  const [pushStatusMessage, setPushStatusMessage] = useState("");
  const [alarmDevicesCount, setAlarmDevicesCount] = useState<number | null>(null);
  const [isTestingSirenAudio, setIsTestingSirenAudio] = useState(false);

  // Duplicate protection set across page reloads & sessions
  const alertedOrderIdsRef = useRef<Set<string>>(
    (() => {
      try {
        const stored = localStorage.getItem("zypsomart_alerted_orders_v1");
        return new Set(stored ? JSON.parse(stored) : []);
      } catch {
        return new Set<string>();
      }
    })()
  );

  // Acknowledged Order IDs for Home Page Badge & Unacknowledged Alerts
  const [acknowledgedOrderIds, setAcknowledgedOrderIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("zypsomart_acknowledged_orders_v1");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set<string>();
    }
  });

  const saveAcknowledgedOrderIds = (newSet: Set<string>) => {
    setAcknowledgedOrderIds(newSet);
    try {
      localStorage.setItem("zypsomart_acknowledged_orders_v1", JSON.stringify(Array.from(newSet)));
    } catch {}
  };

  const handleAcknowledgeOrder = (orderId: string) => {
    const next = new Set<string>(acknowledgedOrderIds);
    next.add(orderId);
    saveAcknowledgedOrderIds(next);
  };

  const handleAcknowledgeAll = () => {
    const next = new Set<string>(acknowledgedOrderIds);
    orders.forEach((o) => next.add(o.id));
    saveAcknowledgedOrderIds(next);
    showNotification("success", "All new order alerts acknowledged.");
  };

  // Test Notification state
  const [isSendingTestPush, setIsSendingTestPush] = useState(false);
  const [testNotificationCountdown, setTestNotificationCountdown] = useState<number | null>(null);
  const [testPushResult, setTestPushResult] = useState<{ success: boolean; message: string } | null>(null);

  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [isAppInstalled, setIsAppInstalled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const isStandalone =
        (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
        (window.navigator as any)?.standalone === true ||
        (typeof document !== "undefined" && document.referrer && document.referrer.includes("android-app://")) ||
        localStorage.getItem("zypsomart_pwa_installed") === "true";
      return Boolean(isStandalone);
    } catch {
      return false;
    }
  });

  // Shop Open / Closed states (Central status persisted via API & localStorage)
  const [isShopOpen, setIsShopOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("zypsomart_shop_is_open");
      if (saved !== null) return saved === "true";
    } catch {}
    return true;
  });
  const [isUpdatingShopStatus, setIsUpdatingShopStatus] = useState<boolean>(false);

  // Order Deletion states (Feature 1: Delete test/fake orders permanently)
  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null);
  const [isDeletingOrder, setIsDeletingOrder] = useState<boolean>(false);

  // Official Tax Invoice Modal state
  const [selectedOrderForInvoice, setSelectedOrderForInvoice] = useState<Order | null>(null);

  // Filter & Search states with 200ms input debouncing for smooth typing & zero lag
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const handler = setTimeout(() => {
      setSearchQuery(searchInput);
    }, 200);
    return () => clearTimeout(handler);
  }, [searchInput]);

  const handleSetSearch = (val: string) => {
    setSearchInput(val);
    setSearchQuery(val);
  };

  // Internal Notes states
  const [notesInput, setNotesInput] = useState<Record<string, string>>({});
  const [savingNotes, setSavingNotes] = useState<Record<string, boolean>>({});

  // Product modal states
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productForm, setProductForm] = useState({
    name: "",
    category: "",
    customCategory: "",
    isCustomCategory: false,
    price: "",
    unit: "piece",
    image: "",
    description: "",
    isAvailable: true,
    isOffer: false,
    offerType: "percentage" as "percentage" | "fixed",
    offerValue: "",
    offerStartDate: "",
    offerEndDate: "",
    offerEnabled: true
  });
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [productCategoryFilter, setProductCategoryFilter] = useState<string>("all");

  // Offer modal states & management
  const [showOfferModal, setShowOfferModal] = useState(false);
  const [productForOffer, setProductForOffer] = useState<Product | null>(null);
  const [offerForm, setOfferForm] = useState({
    offerType: "percentage" as "percentage" | "fixed",
    offerValue: "",
    offerStartDate: "",
    offerEndDate: "",
    offerEnabled: true
  });
  const [isSavingOffer, setIsSavingOffer] = useState(false);

  // Offers tab filters
  const [offerStatusFilter, setOfferStatusFilter] = useState<
    "all" | "active" | "upcoming" | "expired" | "disabled"
  >("all");
  const [offerCategoryFilter, setOfferCategoryFilter] = useState<string>("all");

  // Customer Store Preview & Test Checkout modal states
  const [showCustomerPreviewModal, setShowCustomerPreviewModal] = useState(false);
  const [customerCart, setCustomerCart] = useState<Record<string, number>>({});
  const [customerPreviewCategory, setCustomerPreviewCategory] = useState("all");
  const [customerPreviewSearch, setCustomerPreviewSearch] = useState("");
  const [isPlacingCustomerOrder, setIsPlacingCustomerOrder] = useState(false);
  const [customerCheckoutForm, setCustomerCheckoutForm] = useState({
    name: "Rajeev Kumar",
    phone: "9876543210",
    address: "Civil Lines, Shop 4, Near City Center",
    paymentMethod: "COD" as "COD" | "Razorpay"
  });

  // Listener and sync states
  const isInitialLoad = useRef(true);
  const seededCategories = useRef(false);
  const knownOrderIds = useRef<Set<string>>(new Set());
  const [syncStatus, setSyncStatus] = useState<"connecting" | "connected" | "reconnecting" | "failed">(
    "connecting"
  );
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<any>(null);
  const unsubscribeOrders = useRef<any>(null);

  // Action loading states
  const [toast, setToast] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [updatingOrders, setUpdatingOrders] = useState<Record<string, boolean>>({});

  // PWA Prompt capture & installed detection
  useEffect(() => {
    // Initial verification
    const checkIsInstalled = () => {
      return (
        window.matchMedia("(display-mode: standalone)").matches ||
        (window.navigator as any).standalone === true ||
        document.referrer.includes("android-app://") ||
        localStorage.getItem("zypsomart_pwa_installed") === "true"
      );
    };

    if (checkIsInstalled()) {
      setIsAppInstalled(true);
      setShowInstallBtn(false);
      setShowInstallModal(false);
    }

    const handleBeforeInstall = (e: Event) => {
      if (checkIsInstalled()) {
        setIsAppInstalled(true);
        setShowInstallBtn(false);
        setShowInstallModal(false);
        return;
      }
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);

      // Show install prompt popup if user hasn't dismissed it in this session
      const dismissed = sessionStorage.getItem("zypsomart_install_dismissed");
      if (!dismissed) {
        setShowInstallModal(true);
      }
    };

    const handleAppInstalled = () => {
      localStorage.setItem("zypsomart_pwa_installed", "true");
      setIsAppInstalled(true);
      setShowInstallBtn(false);
      setShowInstallModal(false);
      setDeferredPrompt(null);
      showNotification("success", "Zypso Mart installed successfully!");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleAppInstalled);

    // Watch for standalone display mode change
    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const handleDisplayModeChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setIsAppInstalled(true);
        setShowInstallBtn(false);
        setShowInstallModal(false);
      }
    };

    try {
      mediaQuery.addEventListener("change", handleDisplayModeChange);
    } catch {
      mediaQuery.addListener?.(handleDisplayModeChange);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleAppInstalled);
      try {
        mediaQuery.removeEventListener("change", handleDisplayModeChange);
      } catch {
        mediaQuery.removeListener?.(handleDisplayModeChange);
      }
    };
  }, []);

  // Register push notifications & listen for foreground FCM messages
  useEffect(() => {
    if (!isPinVerified) return;

    setNotificationPermissionState(getNotificationPermission());

    // Fetch registered device count from backend
    fetch("/api/admin/alarm-status")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.registeredDevices !== undefined) {
          setAlarmDevicesCount(data.registeredDevices);
        }
      })
      .catch(() => {});

    // Try auto-registering FCM token if permission already granted
    if (getNotificationPermission() === "granted") {
      registerDeviceForNotifications(user?.email || "admin@zypsomart.com");
    }

    // Foreground push listener
    const unsubPromise = onForegroundMessageListener((payload) => {
      const data = payload?.data || {};
      const orderId = data.orderId;
      if (orderId && !alertedOrderIdsRef.current.has(orderId) && isAlarmEnabledRef.current) {
        alertedOrderIdsRef.current.add(orderId);
        try {
          const stored = Array.from(alertedOrderIdsRef.current).slice(-200);
          localStorage.setItem("zypsomart_alerted_orders_v1", JSON.stringify(stored));
        } catch {}

        alarmAudio.startAlarm();
        setIsAlarmRinging(true);
        setNewOrderAlert({
          id: orderId,
          customerName: data.customerName || "Customer",
          customerPhone: data.customerPhone || "N/A",
          customerAddress: data.customerAddress || "N/A",
          total: Number(data.total || 0),
          status: "pending",
          items: [],
          createdAt: new Date(),
          paymentMethod: "Online / Cash"
        });
      }
    });

    return () => {
      alarmAudio.stopAlarm();
      if (unsubPromise && typeof (unsubPromise as any).then === "function") {
        (unsubPromise as Promise<any>).then((unsub) => {
          if (typeof unsub === "function") unsub();
        });
      }
    };
  }, [isPinVerified, user?.email]);

  const handleInstallApp = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`[PWA] User response to install: ${outcome}`);
      if (outcome === "accepted") {
        localStorage.setItem("zypsomart_pwa_installed", "true");
        setIsAppInstalled(true);
        showNotification("success", "Zypso Mart installed successfully!");
      }
    } catch (err) {
      console.warn("[PWA] Install prompt exception:", err);
    } finally {
      setDeferredPrompt(null);
      setShowInstallBtn(false);
      setShowInstallModal(false);
    }
  };

  const handleDismissInstallModal = () => {
    sessionStorage.setItem("zypsomart_install_dismissed", "true");
    setShowInstallModal(false);
  };

  // Alarm control & push notification handlers
  const handleToggleAlarm = (enabled: boolean) => {
    setIsAlarmEnabled(enabled);
    localStorage.setItem("zypsomart_alarm_enabled", enabled ? "true" : "false");
    if (!enabled && isAlarmRinging) {
      alarmAudio.stopAlarm();
      setIsAlarmRinging(false);
    }
  };

  const handleTriggerTestAlarm = async () => {
    alarmAudio.startAlarm();
    setIsAlarmRinging(true);

    const testOrder: Order = {
      id: `TEST-${Math.floor(1000 + Math.random() * 9000)}`,
      customerName: "Rahul Sharma (Test Simulation)",
      customerPhone: "+91 98765 43210",
      customerAddress: "Flat 402, Green Avenue, Delhi",
      total: 399,
      status: "pending",
      items: [
        { name: "Fresh Milk (1L)", qty: 2, price: 65 },
        { name: "Bread (400g)", qty: 1, price: 45 },
        { name: "Eggs (6pcs)", qty: 1, price: 90 }
      ],
      createdAt: new Date(),
      paymentMethod: "UPI (Test Simulation)"
    };

    setNewOrderAlert(testOrder);

    try {
      await fetch("/api/admin/test-alarm", { method: "POST" });
    } catch (e) {
      console.warn("[Test Alarm] FCM test trigger notice:", e);
    }
  };

  const handleEnablePushNotifications = async () => {
    setIsRegisteringPush(true);
    setPushStatusMessage("");
    try {
      const res = await registerDeviceForNotifications(user?.email || "admin@zypsomart.com");
      setNotificationPermissionState(getNotificationPermission());
      if (res.success) {
        setPushStatusMessage(
          res.token
            ? "✓ Device registered! Mobile & laptop background push alerts active."
            : "✓ Notifications enabled! In-app siren & alerts active."
        );
        fetch("/api/admin/alarm-status")
          .then((r) => r.json())
          .then((d) => {
            if (d.registeredDevices !== undefined) setAlarmDevicesCount(d.registeredDevices);
          })
          .catch(() => {});
      } else {
        setPushStatusMessage(res.error || "Permission could not be enabled.");
      }
    } catch (err: any) {
      setPushStatusMessage(err?.message || "Failed to register notifications.");
    } finally {
      setIsRegisteringPush(false);
    }
  };

  const handleTestSirenAudio = () => {
    setIsTestingSirenAudio(true);
    alarmAudio.startAlarm();
    setTimeout(() => {
      alarmAudio.stopAlarm();
      setIsTestingSirenAudio(false);
    }, 2000);
  };

  const handleAcceptFromAlert = async (orderId: string) => {
    alarmAudio.stopAlarm();
    setIsAlarmRinging(false);
    setNewOrderAlert(null);
    handleAcknowledgeOrder(orderId);
    if (orderId.startsWith("TEST-")) {
      showNotification("success", "Test Order Accepted! Alarm stopped.");
      return;
    }
    setActiveTab("orders");
    setStatusFilter("all");
    await handleUpdateOrderStatus(orderId, "accepted", "Order Accepted Successfully");
    setTimeout(() => {
      const el = document.getElementById(`order-card-${orderId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
  };

  const handleViewFromAlert = (orderId: string) => {
    alarmAudio.stopAlarm();
    setIsAlarmRinging(false);
    setNewOrderAlert(null);
    handleAcknowledgeOrder(orderId);
    setActiveTab("orders");
    setStatusFilter("all");
    handleSetSearch(orderId.startsWith("TEST-") ? "" : orderId);
    setTimeout(() => {
      const el = document.getElementById(`order-card-${orderId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
  };

  const handleDismissAlert = () => {
    if (newOrderAlert) {
      handleAcknowledgeOrder(newOrderAlert.id);
    }
    alarmAudio.stopAlarm();
    setIsAlarmRinging(false);
    setNewOrderAlert(null);
  };

  // Calculate unacknowledged new orders: pending or new orders not yet acknowledged
  const unacknowledgedOrders = useMemo(() => {
    return orders.filter((o) => {
      const isPending = o.status === "pending" || !o.status;
      return isPending && !acknowledgedOrderIds.has(o.id);
    });
  }, [orders, acknowledgedOrderIds]);

  // Handler for sending official FCM test notification (immediate or 5s delay for closed app)
  const handleSendTestPush = async (delaySeconds: number = 0) => {
    setIsSendingTestPush(true);
    setTestPushResult(null);

    if (delaySeconds > 0) {
      let remaining = delaySeconds;
      setTestNotificationCountdown(remaining);
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          setTestNotificationCountdown(null);
        } else {
          setTestNotificationCountdown(remaining);
        }
      }, 1000);
    }

    try {
      const res = await triggerTestPushNotification(delaySeconds);
      if (res.success) {
        setTestPushResult({
          success: true,
          message: res.message || "Test notification dispatched successfully."
        });
        showNotification("success", res.message || "Test push dispatched!");
      } else {
        setTestPushResult({
          success: false,
          message: res.error || "Failed to dispatch test notification."
        });
        showNotification("error", res.error || "Test push failed");
      }
    } catch (err: any) {
      setTestPushResult({
        success: false,
        message: err.message || "Network error sending test notification."
      });
    } finally {
      setIsSendingTestPush(false);
    }
  };

  // Convert raw timestamp to milliseconds
  const getTimestampMs = (createdAt: any): number => {
    if (!createdAt) return 0;
    if (typeof createdAt.toMillis === "function") return createdAt.toMillis();
    if (createdAt instanceof Date) return createdAt.getTime();
    if (typeof createdAt === "number") return createdAt;
    if (createdAt.seconds) return createdAt.seconds * 1000;
    const parsed = Date.parse(createdAt);
    return isNaN(parsed) ? Date.now() : parsed;
  };

  // Check if order is fresh (within last 5 minutes)
  const isOrderRecent = (order: Order): boolean => {
    if (!order) return false;
    const ts = getTimestampMs(order.createdAt);
    if (ts === 0) return false;
    return Date.now() - ts < 300 * 1000;
  };

  // Human-readable date string
  const formatDate = (val: any): string => {
    if (!val) return "Just now";
    let d: Date | null = null;
    if (typeof val.toDate === "function") d = val.toDate();
    else if (val instanceof Date) d = val;
    else if (typeof val === "number") d = new Date(val);
    else if (val?.seconds) d = new Date(val.seconds * 1000);
    else {
      const parsed = Date.parse(val);
      if (!isNaN(parsed)) d = new Date(parsed);
    }
    return d
      ? `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })} • ${d.toLocaleDateString(
          [],
          { month: "short", day: "numeric" }
        )}`
      : "Just now";
  };

  // Full timestamp formatter for CSV export & audit logs
  const formatFullDateTime = (val: any): string => {
    if (!val) return "N/A";
    let d: Date | null = null;
    if (typeof val.toDate === "function") d = val.toDate();
    else if (val instanceof Date) d = val;
    else if (typeof val === "number") d = new Date(val);
    else if (val?.seconds) d = new Date(val.seconds * 1000);
    else {
      const parsed = Date.parse(val);
      if (!isNaN(parsed)) d = new Date(parsed);
    }
    if (!d) return "N/A";
    return d.toLocaleString("en-IN", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
  };

  const showNotification = (type: "success" | "error", text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3500);
  };

  const handleImgError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    e.currentTarget.src = FALLBACK_IMAGE;
  };

  // Auth state subscriber and data loaders (Optimized: No static continuous listeners, no 10s timer)
  useEffect(() => {
    let unsubsOrders: any = null;

    const authUnsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (unsubsOrders) {
        unsubsOrders();
        unsubsOrders = null;
      }

      if (currentUser) {
        const isVerified = checkIsPinVerified(currentUser.uid);
        setIsPinVerified(isVerified);
        unsubsOrders = startOrdersSync();
        // Read products & categories once (cached in memory & localStorage)
        fetchProducts(false);
        fetchCategories(false);
      } else {
        setIsPinVerified(false);
        setLoading(false);
      }
    });

    return () => {
      authUnsub();
      if (unsubsOrders) unsubsOrders();
      if (unsubscribeOrders.current) unsubscribeOrders.current();
    };
  }, [orderLimit]);

  // On-demand data loading: when switching to Products or Offers tab, verify freshness
  useEffect(() => {
    if ((activeTab === "products" || activeTab === "offers") && user) {
      fetchProducts(false);
      fetchCategories(false);
    }
  }, [activeTab, user]);

  // Optimized Product catalog fetcher: single getDocs read with server API fallback and localStorage caching
  const fetchProducts = async (force: boolean = false) => {
    const now = Date.now();
    // Cache TTL: 5 minutes if not forced and products are already cached
    if (!force && products.length > 0 && now - productsLastFetchedRef.current < 5 * 60 * 1000) {
      return;
    }
    setIsLoadingProducts(true);
    try {
      let list: Product[] = [];
      try {
        const productsCol = collection(db, "products");
        const q = query(productsCol, orderBy("name", "asc"));
        let snap;
        try {
          snap = await getDocs(q);
        } catch (err: any) {
          if (err?.code === "failed-precondition") {
            snap = await getDocs(productsCol);
          } else {
            throw err;
          }
        }
        list = snap.docs.map((d) => ({
          id: d.id,
          ...d.data()
        })) as Product[];
      } catch (clientErr: any) {
        console.warn("[Products] Firestore direct fetch notice:", clientErr?.message || clientErr);
      }

      // If client Firestore failed or returned empty, fetch from /api/products
      if (list.length === 0) {
        try {
          const apiRes = await fetch("/api/products");
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (Array.isArray(apiData.products) && apiData.products.length > 0) {
              list = apiData.products;
            }
          }
        } catch (apiErr) {
          console.warn("[Products] API fallback fetch notice:", apiErr);
        }
      }

      if (list.length > 0) {
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setProducts(list);
        productsLastFetchedRef.current = now;
        try {
          localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(list));
        } catch {}
      }
    } catch (error: any) {
      console.warn("[Products] fetch notice:", error?.message || error);
    } finally {
      setIsLoadingProducts(false);
    }
  };

  // Categories fetcher: aggregates Firestore categories collection, backend API categories, and product catalog categories
  const fetchCategories = async (force: boolean = false) => {
    const now = Date.now();
    if (!force && categories.length > 0 && now - categoriesLastFetchedRef.current < 5 * 60 * 1000) {
      return;
    }
    try {
      const catMap = new Map<string, Category>();

      // 1. Fetch directly from Firestore categories collection
      try {
        const catCol = collection(db, "categories");
        const snap = await getDocs(catCol);
        snap.docs.forEach((d) => {
          const data = d.data();
          const name = String(data.name || data.title || "").trim();
          if (name) {
            const key = name.toLowerCase();
            catMap.set(key, { id: d.id, name });
          }
        });
      } catch (err) {
        console.warn("[Categories] Firestore direct fetch notice:", err);
      }

      // 2. Fetch from backend API /api/categories
      try {
        const apiRes = await fetch("/api/categories");
        if (apiRes.ok) {
          const apiData = await apiRes.json();
          if (Array.isArray(apiData.categories)) {
            apiData.categories.forEach((c: any) => {
              const name = String(c.name || "").trim();
              if (name) {
                const key = name.toLowerCase();
                if (!catMap.has(key)) {
                  catMap.set(key, { id: c.id || `api_${key}`, name });
                }
              }
            });
          }
        }
      } catch (apiErr) {
        console.warn("[Categories] API fetch notice:", apiErr);
      }

      // 3. Discover any categories already used across existing products in store catalog
      products.forEach((p) => {
        const catName = String(p.category || "").trim();
        if (catName) {
          const key = catName.toLowerCase();
          if (!catMap.has(key)) {
            catMap.set(key, {
              id: `prod_cat_${encodeURIComponent(key)}`,
              name: catName
            });
          }
        }
      });

      // 4. Fallback to standard presets if still empty
      if (catMap.size === 0) {
        DEFAULT_PRESET_CATEGORIES.forEach((name, i) => {
          catMap.set(name.toLowerCase(), {
            id: `preset_cat_${i + 1}`,
            name
          });
        });
      }

      const list = Array.from(catMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );

      setCategories(list);
      categoriesLastFetchedRef.current = now;
      try {
        localStorage.setItem("zypsomart_cached_categories_v2", JSON.stringify(list));
      } catch {}
    } catch (error: any) {
      console.warn("[Categories] getDocs fetch notice:", error?.message || error);
    }
  };

  // Real-time Orders Sync with auto-reconnect and composite index fallback
  const startOrdersSync = () => {
    if (unsubscribeOrders.current) {
      unsubscribeOrders.current();
      unsubscribeOrders.current = null;
    }
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }

    setSyncStatus(reconnectAttempts.current > 0 ? "reconnecting" : "connecting");
    const ordersCol = collection(db, "orders");
    const orderedQuery = query(ordersCol, orderBy("createdAt", "desc"), limit(orderLimit));

    // Fallback getDocs fetch if snapshot connection falters
    const fallbackFetch = async (targetQuery: any) => {
      try {
        const snap = await getDocs(targetQuery);
        const parsed = snap.docs.map((d) => parseOrderDoc(d.id, d.data()));
        const uniqueMap: Record<string, Order> = {};
        parsed.forEach((item) => {
          if (item?.id) uniqueMap[item.id] = item;
        });
        if (uniqueMap["sgSmeNc2e7qYYuXuTna1"]) {
          deleteDoc(doc(db, "orders", "sgSmeNc2e7qYYuXuTna1")).catch(() => {});
          fetch("/api/orders/sgSmeNc2e7qYYuXuTna1", { method: "DELETE" }).catch(() => {});
          delete uniqueMap["sgSmeNc2e7qYYuXuTna1"];
        }
        setOrders(Object.values(uniqueMap));
        setLoading(false);
      } catch (err) {
        console.error("[Orders Sync] getDocs fallback fetch failed:", err);
      }
    };

    const attachListener = (targetQuery: any, isRetryWithoutSort = false) => {
      try {
        const unsub = onSnapshot(
          targetQuery,
          (snapshot) => {
            const parsed = snapshot.docs.map((d) => parseOrderDoc(d.id, d.data()));
            const uniqueMap: Record<string, Order> = {};
            parsed.forEach((item) => {
              if (item?.id) uniqueMap[item.id] = item;
            });
            if (uniqueMap["sgSmeNc2e7qYYuXuTna1"]) {
              deleteDoc(doc(db, "orders", "sgSmeNc2e7qYYuXuTna1")).catch(() => {});
              fetch("/api/orders/sgSmeNc2e7qYYuXuTna1", { method: "DELETE" }).catch(() => {});
              delete uniqueMap["sgSmeNc2e7qYYuXuTna1"];
            }
            const uniqueOrders = Object.values(uniqueMap);

            if (isInitialLoad.current) {
              isInitialLoad.current = false;
              knownOrderIds.current = new Set(uniqueOrders.map((o) => o.id));
              // Store all initial order IDs in duplicate protection set so app load never triggers alarms
              uniqueOrders.forEach((o) => alertedOrderIdsRef.current.add(o.id));
            } else {
              const currentIds = new Set(uniqueOrders.map((o) => o.id));
              const newlyAdded = uniqueOrders.filter((o) => !knownOrderIds.current.has(o.id));
              if (newlyAdded.length > 0) {
                const latest = [...newlyAdded].sort(
                  (a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt)
                )[0];

                if (
                  latest &&
                  !alertedOrderIdsRef.current.has(latest.id) &&
                  (latest.status === "pending" || !latest.status)
                ) {
                  // Mark as alerted immediately (strict duplicate protection)
                  alertedOrderIdsRef.current.add(latest.id);
                  try {
                    const stored = Array.from(alertedOrderIdsRef.current).slice(-200);
                    localStorage.setItem("zypsomart_alerted_orders_v1", JSON.stringify(stored));
                  } catch {}

                  // Play loud repeating alarm if enabled
                  if (isAlarmEnabledRef.current) {
                    alarmAudio.startAlarm();
                    setIsAlarmRinging(true);
                  }

                  setNewOrderAlert(latest);

                  // Trigger backend FCM push to notify mobile + laptop devices in background
                  fetch("/api/admin/dispatch-alarm", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      orderId: latest.id,
                      customerName: latest.customerName,
                      total: latest.total
                    })
                  }).catch((err) => console.warn("[Alarm] FCM dispatch notice:", err));
                } else if (latest) {
                  setNewOrderAlert(latest);
                }

                window.scrollTo({ top: 0, behavior: "smooth" });
                newlyAdded.forEach((o) => knownOrderIds.current.add(o.id));
              }
              knownOrderIds.current = currentIds;
            }

            setOrders(uniqueOrders);
            setLoading(false);
            setBannerError("");
            setSyncStatus("connected");
            reconnectAttempts.current = 0;
          },
          (error) => {
            console.error("[Orders Sync] Snapshot error:", error);
            if (error.code === "failed-precondition" && !isRetryWithoutSort) {
              // Composite index missing; fallback to base collection listener
              console.warn(
                "[Orders Sync] Sorted query requires composite index. Falling back to base collection query."
              );
              unsub();
              attachListener(query(ordersCol, limit(orderLimit)), true);
              return;
            }

            fallbackFetch(targetQuery);

            if (reconnectAttempts.current < 5) {
              reconnectAttempts.current += 1;
              setSyncStatus("reconnecting");
              const delay = Math.min(reconnectAttempts.current * 3000, 15000);
              reconnectTimeout.current = setTimeout(() => {
                startOrdersSync();
              }, delay);
            } else {
              setSyncStatus("failed");
              setBannerError("Failed to sync orders. Please check your internet connection.");
              setLoading(false);
            }
          }
        );

        unsubscribeOrders.current = unsub;
        return unsub;
      } catch (err) {
        console.error("[Orders Sync] Fatal initialization throw:", err);
        fallbackFetch(targetQuery);
        return () => {};
      }
    };

    const initialUnsub = attachListener(orderedQuery, false);
    return () => {
      if (initialUnsub) initialUnsub();
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    };
  };

  // Sign In with Email and Password (with auto-create fallback for demo admin)
  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      if (
        err?.code === "auth/user-not-found" ||
        err?.code === "auth/invalid-credential" ||
        err?.message?.includes("user-not-found") ||
        err?.message?.includes("invalid-credential")
      ) {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
          return;
        } catch (createErr: any) {
          console.warn("[Auth] Create account fallback notice:", createErr);
        }
      }
      setAuthError(err.message || "Failed to sign in");
    } finally {
      setAuthLoading(false);
    }
  };

  // Sign In with Google
  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError("");
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setAuthError(err.message || "Google sign in failed");
    } finally {
      setAuthLoading(false);
    }
  };

  // PIN Verification check
  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin === "6823") {
      if (user) {
        savePinVerification(user.uid);
      }
      setIsPinVerified(true);
      setPin("");
      setPinError("");
    } else {
      setPinError("Invalid PIN. Please try again.");
    }
  };

  // Unified Sign Out with PIN verification clearance & FCM unregister
  const handleSignOut = async () => {
    if (window.confirm("Do you want to sign out from Zypso Mart Admin?")) {
      if (user) {
        clearPinVerification(user.uid);
      }
      setIsPinVerified(false);
      setPin("");
      alarmAudio.stopAlarm();
      setIsAlarmRinging(false);
      await unregisterDeviceToken().catch(() => {});
      await signOut(auth);
    }
  };

  // 12-Hour PIN Expiration Monitor: re-prompts for PIN after 12 hours
  useEffect(() => {
    if (!user || !isPinVerified) return;

    const checkPinExpiration = () => {
      if (!checkIsPinVerified(user.uid)) {
        console.log("[Security] 12-hour PIN verification window expired. Prompting PIN verification.");
        setIsPinVerified(false);
      }
    };

    const interval = setInterval(checkPinExpiration, 30000); // Check every 30s
    window.addEventListener("focus", checkPinExpiration);
    window.addEventListener("visibilitychange", checkPinExpiration);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", checkPinExpiration);
      window.removeEventListener("visibilitychange", checkPinExpiration);
    };
  }, [user, isPinVerified]);

  // Deep-link handler: when clicking closed-app FCM push notification with ?orderId=...&tab=orders
  useEffect(() => {
    if (!isPinVerified) return;
    const params = new URLSearchParams(window.location.search);
    const orderIdParam = params.get("orderId");
    const tabParam = params.get("tab");

    if (tabParam && ["orders", "products", "settings"].includes(tabParam)) {
      setActiveTab(tabParam as any);
    }

    if (orderIdParam) {
      setActiveTab("orders");
      setStatusFilter("all");
      handleSetSearch(orderIdParam);
      // Clean query parameter from address bar cleanly without page refresh
      const newUrl = window.location.pathname + (tabParam ? `?tab=${tabParam}` : "?tab=orders");
      window.history.replaceState({}, document.title, newUrl);

      setTimeout(() => {
        const el = document.getElementById(`order-card-${orderIdParam}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 500);
    }
  }, [isPinVerified]);

  // Optimized Shop Status sync: cached in localStorage & disk, synced on mount + focus
  useEffect(() => {
    let isMounted = true;

    const syncShopStatusFromApi = async () => {
      try {
        const res = await fetch("/api/shop/status");
        if (res.ok && isMounted) {
          const data = await res.json();
          if (typeof data.isOpen === "boolean") {
            setIsShopOpen(data.isOpen);
            localStorage.setItem("zypsomart_shop_is_open", data.isOpen ? "true" : "false");
          }
        }
      } catch {}
    };

    // Initial sync
    syncShopStatusFromApi();

    // Check status only on window focus or visibility change without hammering the server
    const handleFocusOrVisible = () => {
      if (document.visibilityState === "visible") {
        syncShopStatusFromApi();
      }
    };

    window.addEventListener("focus", handleFocusOrVisible);
    document.addEventListener("visibilitychange", handleFocusOrVisible);

    return () => {
      isMounted = false;
      window.removeEventListener("focus", handleFocusOrVisible);
      document.removeEventListener("visibilitychange", handleFocusOrVisible);
    };
  }, []);

  // Handler: Toggle Shop Open / Closed Status
  const handleUpdateShopStatus = async (nextIsOpen: boolean) => {
    setIsUpdatingShopStatus(true);
    try {
      // 1. Optimistic update
      setIsShopOpen(nextIsOpen);
      localStorage.setItem("zypsomart_shop_is_open", nextIsOpen ? "true" : "false");

      // 2. Authoritative sync to backend API endpoint (persisted to disk & memory)
      const res = await fetch("/api/shop/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isOpen: nextIsOpen,
          updatedBy: user?.email || "admin@zypsomart.com"
        })
      });

      if (!res.ok) {
        console.warn("[Shop Status] Backend API returned status:", res.status);
      }

      // 3. Gracefully attempt direct write to central Firestore without failing if rules restrict it
      try {
        const shopDocRef = doc(db, "shopSettings", "store");
        await setDoc(
          shopDocRef,
          {
            isOpen: nextIsOpen,
            updatedAt: new Date(),
            updatedBy: user?.email || "admin@zypsomart.com"
          },
          { merge: true }
        );
      } catch (firestoreErr) {
        // Backend API & localStorage successfully handled persistence
      }

      showNotification(
        "success",
        nextIsOpen
          ? "Shop is now OPEN 🟢 Customers can place orders."
          : "Shop is now CLOSED 🔴 Customer app shows closed & orders disabled."
      );
    } catch (err: any) {
      console.error("[Shop Status] Error updating shop status:", err);
      showNotification("error", "Failed to update shop status: " + (err.message || String(err)));
      setIsShopOpen(!nextIsOpen);
      localStorage.setItem("zypsomart_shop_is_open", (!nextIsOpen) ? "true" : "false");
    } finally {
      setIsUpdatingShopStatus(false);
    }
  };

  // Handler: Permanently delete an order (Admin only)
  const handleConfirmDeleteOrder = async () => {
    if (!orderToDelete) return;
    const orderId = orderToDelete.id;
    setIsDeletingOrder(true);
    try {
      // 1. Optimistic removal from state
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
      alertedOrderIdsRef.current.delete(orderId);
      handleAcknowledgeOrder(orderId);

      if (newOrderAlert?.id === orderId) {
        alarmAudio.stopAlarm();
        setIsAlarmRinging(false);
        setNewOrderAlert(null);
      }

      // 2. Permanent deletion from Firestore
      await deleteDoc(doc(db, "orders", orderId));

      // 3. Backend server deletion
      await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
        method: "DELETE"
      }).catch(() => {});

      showNotification("success", `Order #${orderId.slice(-6).toUpperCase()} deleted permanently.`);
      setOrderToDelete(null);
    } catch (err: any) {
      console.error("[Delete Order] Error deleting order:", err);
      showNotification("error", "Failed to delete order: " + (err.message || String(err)));
      startOrdersSync();
    } finally {
      setIsDeletingOrder(false);
    }
  };

  /**
   * Status Transition Handler:
   * 1. Calls the backend API endpoint (/api/orders/:id/status) which enforces transition validation.
   * 2. Also updates Firestore document directly for real-time listener propagation across clients.
   * 3. Provides optimistic state updates so the UI responds immediately without lag.
   */
  const handleUpdateOrderStatus = async (
    orderId: string,
    targetStatus: string,
    successMessage?: string
  ) => {
    const normalizedTarget = normalizeStatus(targetStatus) || targetStatus.toLowerCase();

    setUpdatingOrders((prev) => ({ ...prev, [orderId]: true }));

    // Optimistic UI state update
    const now = new Date();
    setOrders((prevOrders) =>
      prevOrders.map((ord) => {
        if (ord.id === orderId) {
          const isReturn =
            normalizedTarget.includes("return") || ord.type === "return";
          return {
            ...ord,
            status: normalizedTarget,
            orderStatus: normalizedTarget,
            type: isReturn ? "return" : ord.type,
            acceptedAt: normalizedTarget === "accepted" ? now : ord.acceptedAt,
            packagingAt: normalizedTarget === "packaging" ? now : ord.packagingAt,
            packedAt: normalizedTarget === "packaging" ? now : ord.packedAt,
            onTheWayAt: normalizedTarget === "on_the_way" ? now : ord.onTheWayAt,
            dispatchedAt: normalizedTarget === "on_the_way" ? now : ord.dispatchedAt,
            deliveredAt: normalizedTarget === "delivered" ? now : ord.deliveredAt,
            cancelledAt: normalizedTarget === "cancelled" ? now : ord.cancelledAt,
            isCompleted: normalizedTarget === "delivered" ? true : ord.isCompleted,
            deliveryStatus:
              normalizedTarget === "delivered"
                ? "delivered"
                : normalizedTarget === "on_the_way"
                ? "out_for_delivery"
                : ord.deliveryStatus,
            returnStatus:
              normalizedTarget === "return_approved"
                ? "approved"
                : normalizedTarget === "return_rejected"
                ? "rejected"
                : ord.returnStatus,
            updatedAt: now
          };
        }
        return ord;
      })
    );

    try {
      let apiSuccess = false;
      let apiErrorMessage = "";

      // 1. Call the validated backend controller endpoint
      try {
        const idToken = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => null) : null;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (idToken) {
          headers["Authorization"] = `Bearer ${idToken}`;
        }

        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            status: normalizedTarget,
            notes:
              normalizedTarget === "return_approved"
                ? "Approved via Admin Dashboard"
                : normalizedTarget === "return_rejected"
                ? "Rejected via Admin Dashboard"
                : ""
          })
        });

        const result = await response.json();
        if (response.ok && result.success) {
          apiSuccess = true;
        } else {
          apiErrorMessage = result.error || "Backend transition error";
        }
      } catch (networkErr: any) {
        console.warn("[API] Endpoint network notice, falling back to direct Firestore:", networkErr);
      }

      // 2. Direct Firestore update for instant real-time synchronization with Customer App
      const orderRef = doc(db, "orders", orderId);
      const updateData: Record<string, any> = {
        status: normalizedTarget,
        orderStatus: normalizedTarget,
        updatedAt: now
      };

      if (normalizedTarget === "return_approved") {
        updateData.returnStatus = "approved";
        updateData.type = "return";
        updateData.isReturned = true;
        updateData.returnApprovedAt = now;
      } else if (normalizedTarget === "return_rejected") {
        updateData.returnStatus = "rejected";
        updateData.type = "return";
        updateData.returnRejectedAt = now;
      } else if (normalizedTarget === "return_requested") {
        updateData.returnStatus = "requested";
        updateData.type = "return";
        updateData.returnRequestedAt = now;
      } else if (normalizedTarget === "accepted") {
        updateData.acceptedAt = now;
        updateData.acceptTime = now.toISOString();
      } else if (normalizedTarget === "packaging") {
        updateData.packagingAt = now;
        updateData.packedAt = now;
        updateData.packagingTime = now.toISOString();
      } else if (normalizedTarget === "on_the_way") {
        updateData.onTheWayAt = now;
        updateData.dispatchedAt = now;
        updateData.outForDeliveryAt = now;
        updateData.onTheWayTime = now.toISOString();
        updateData.deliveryStatus = "out_for_delivery";
      } else if (normalizedTarget === "delivered") {
        updateData.deliveredAt = now;
        updateData.deliveredTime = now.toISOString();
        updateData.isCompleted = true;
        updateData.deliveryStatus = "delivered";
      } else if (normalizedTarget === "cancelled") {
        updateData.cancelledAt = now;
      }

      await updateDoc(orderRef, updateData);

      const defaultMsg =
        normalizedTarget === "accepted"
          ? "Order Accepted Successfully"
          : normalizedTarget === "packaging"
          ? "Order Marked as Packaging 📦"
          : normalizedTarget === "on_the_way"
          ? "Order Marked as On the Way 🚚"
          : normalizedTarget === "delivered"
          ? "Order Marked as Delivered & Moved to Completed ✅"
          : `Order status updated to ${normalizedTarget.toUpperCase()}`;

      showNotification(
        "success",
        successMessage || defaultMsg
      );
    } catch (err: any) {
      console.error("Error updating order status:", err);
      showNotification("error", "Error updating status: " + (err.message || String(err)));
      // Re-sync orders from Firestore on error
      startOrdersSync();
    } finally {
      setUpdatingOrders((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  // Handler: Save internal admin note without changing order status
  const handleSaveInternalNotes = async (orderId: string) => {
    const rawNote = notesInput[orderId];
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;
    const noteToSave = rawNote !== undefined ? rawNote.trim() : (order.internalNotes || "").trim();

    setSavingNotes((prev) => ({ ...prev, [orderId]: true }));
    try {
      // 1. Optimistic state update (strictly preserves existing order status!)
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? { ...o, internalNotes: noteToSave, adminNotes: noteToSave }
            : o
        )
      );

      // 2. Direct Firestore update (only updates internalNotes & adminNotes, order status is unchanged!)
      const orderRef = doc(db, "orders", orderId);
      await updateDoc(orderRef, {
        internalNotes: noteToSave,
        adminNotes: noteToSave,
        updatedAt: new Date()
      });

      // 3. Backend endpoint sync (status is preserved)
      try {
        await fetch(`/api/orders/${encodeURIComponent(orderId)}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            internalNotes: noteToSave,
            updatedBy: user?.email || "admin@zypsomart.com"
          })
        });
      } catch {}

      showNotification(
        "success",
        noteToSave
          ? `Internal note attached to #${orderId.slice(-6).toUpperCase()}`
          : `Internal note cleared for #${orderId.slice(-6).toUpperCase()}`
      );
    } catch (err: any) {
      console.error("[Orders] Failed to save internal note:", err);
      showNotification("error", "Failed to save note: " + (err.message || String(err)));
    } finally {
      setSavingNotes((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  // Convert cloud storage URLs (Google Drive, Dropbox) into direct view URLs
  const formatImageUrl = (url: string) => {
    if (!url) return "";
    if (url.includes("drive.google.com")) {
      const match = url.match(/\/d\/([^/]+)/) || url.match(/id=([^&]+)/);
      if (match) return `https://drive.google.com/uc?export=view&id=${match[1]}`;
    }
    if (url.includes("dropbox.com")) {
      return url.replace("dl=0", "dl=1").replace("www.dropbox.com", "dl.dropboxusercontent.com");
    }
    return url;
  };

  // Product availability toggle with optimistic cache sync
  const handleToggleProductAvailability = async (productId: string, currentStatus: boolean) => {
    const nextStatus = !currentStatus;
    try {
      setProducts((prev) => {
        const next = prev.map((p) =>
          p.id === productId ? { ...p, isAvailable: nextStatus } : p
        );
        try {
          localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(next));
        } catch {}
        return next;
      });

      // Try client Firestore update
      try {
        await updateDoc(doc(db, "products", productId), {
          isAvailable: nextStatus
        });
      } catch (clientErr) {
        // Fallback to server API
        await fetch(`/api/products/${encodeURIComponent(productId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isAvailable: nextStatus })
        }).catch(() => {});
      }

      showNotification(
        "success",
        `Product marked as ${nextStatus ? "Available" : "Unavailable"}`
      );
    } catch (err: any) {
      showNotification("error", "Error updating product: " + err.message);
      fetchProducts(true);
    }
  };

  // Safe helper to sanitize product objects for Firestore (strictly NO undefined values)
  const sanitizeProductForFirestore = (productData: Partial<Product>): Record<string, any> => {
    const clean: Record<string, any> = {};

    if (productData.name !== undefined) clean.name = String(productData.name).trim();
    if (productData.category !== undefined) clean.category = String(productData.category).trim();
    if (productData.price !== undefined) clean.price = Math.max(0, Number(productData.price) || 0);
    if (productData.unit !== undefined) clean.unit = String(productData.unit).trim() || "piece";

    const img = productData.imageUrl || productData.image || "";
    if (img) {
      const formatted = formatImageUrl(String(img).trim());
      clean.image = formatted;
      clean.imageUrl = formatted;
    } else {
      clean.image = "";
      clean.imageUrl = "";
    }

    if (productData.description !== undefined) {
      clean.description = String(productData.description).trim();
    }

    clean.isAvailable = productData.isAvailable !== false;

    // Handle Offer fields cleanly - never undefined
    clean.isOffer = Boolean(productData.isOffer);
    if (clean.isOffer) {
      clean.offerType = productData.offerType === "fixed" ? "fixed" : "percentage";
      const rawVal = Math.max(0, Number(productData.offerValue) || 0);
      clean.offerValue = rawVal;

      let calcOfferPrice = clean.price;
      if (clean.offerType === "percentage") {
        calcOfferPrice = Math.max(0, Math.round(clean.price * (1 - rawVal / 100)));
      } else {
        calcOfferPrice = Math.max(0, Math.round(clean.price - rawVal));
      }
      clean.offerPrice = calcOfferPrice;
      clean.offerStartDate = productData.offerStartDate ? new Date(productData.offerStartDate).toISOString() : null;
      clean.offerEndDate = productData.offerEndDate ? new Date(productData.offerEndDate).toISOString() : null;
      clean.offerEnabled = productData.offerEnabled !== false;
    } else {
      clean.offerType = null;
      clean.offerValue = 0;
      clean.offerPrice = clean.price;
      clean.offerStartDate = null;
      clean.offerEndDate = null;
      clean.offerEnabled = false;
    }

    clean.updatedAt = new Date().toISOString();
    return clean;
  };

  // Open Add Product Modal with clean initial state
  const openAddProductModal = () => {
    setEditingProduct(null);
    const defaultCat = categories.length > 0 ? categories[0].name : "fruits";
    setProductForm({
      name: "",
      category: defaultCat,
      customCategory: "",
      isCustomCategory: false,
      price: "",
      unit: "piece",
      image: "",
      description: "",
      isAvailable: true,
      isOffer: false,
      offerType: "percentage",
      offerValue: "",
      offerStartDate: "",
      offerEndDate: "",
      offerEnabled: true
    });
    setShowProductModal(true);
  };

  // Open Edit Product Modal with robust null-safety and category pre-selection
  const openEditProductModal = (product: Product) => {
    if (!product) return;
    setEditingProduct(product);

    const rawCat = (product.category || "").trim();
    const matched = categories.find(
      (c) => c.name.trim().toLowerCase() === rawCat.toLowerCase()
    );
    const resolvedCat = matched ? matched.name : rawCat || (categories[0]?.name || "fruits");

    setProductForm({
      name: product.name || "",
      category: resolvedCat,
      customCategory: "",
      isCustomCategory: false,
      price: product.price !== undefined && product.price !== null ? String(product.price) : "",
      unit: product.unit || "piece",
      image: product.imageUrl || product.image || "",
      description: product.description || "",
      isAvailable: product.isAvailable !== false,
      isOffer: Boolean(product.isOffer),
      offerType: product.offerType || "percentage",
      offerValue: product.offerValue !== undefined && product.offerValue !== null ? String(product.offerValue) : "",
      offerStartDate: product.offerStartDate ? product.offerStartDate.slice(0, 16) : "",
      offerEndDate: product.offerEndDate ? product.offerEndDate.slice(0, 16) : "",
      offerEnabled: product.offerEnabled !== false
    });
    setShowProductModal(true);
  };

  // Product Add / Edit save handler: sets Firestore directly with dual-channel resilience (Client SDK + Server API sync)
  const handleSaveProduct = async (e?: React.FormEvent | React.MouseEvent) => {
    if (e) e.preventDefault();
    if (isSavingProduct) return;

    const name = (productForm.name || "").trim();
    const resolvedCategory = (
      productForm.isCustomCategory
        ? productForm.customCategory
        : (productForm.category || categories[0]?.name || "General")
    ).trim();
    const unit = (productForm.unit || "piece").trim() || "piece";
    const image = (productForm.image || "").trim();
    
    // Clean price parsing (strip currency symbols or whitespace)
    const rawPriceStr = String(productForm.price ?? "").replace(/[^0-9.]/g, "");
    const price = parseFloat(rawPriceStr);

    if (!name) {
      showNotification("error", "Product name is required.");
      return;
    }
    if (!resolvedCategory) {
      showNotification("error", "Product category is required. Please select or enter a category.");
      return;
    }
    if (isNaN(price) || price <= 0) {
      showNotification("error", "Please enter a valid price greater than ₹0.");
      return;
    }

    const isOffer = Boolean(productForm.isOffer);
    const offerType = productForm.offerType === "fixed" ? "fixed" : "percentage";
    const rawOfferVal = parseFloat(String(productForm.offerValue || "0").replace(/[^0-9.]/g, ""));
    const offerValue = isNaN(rawOfferVal) ? 0 : rawOfferVal;

    if (isOffer) {
      if (offerValue <= 0) {
        showNotification("error", "Please enter a discount value greater than 0, or disable the offer switch.");
        return;
      }
      if (offerType === "percentage" && (offerValue < 1 || offerValue >= 100)) {
        showNotification("error", "Percentage discount must be between 1% and 99%.");
        return;
      }
      if (offerType === "fixed" && offerValue >= price) {
        showNotification("error", `Flat discount (₹${offerValue}) cannot exceed product price of ₹${price}.`);
        return;
      }
    }

    // Auto-calculate offer price if offer is active
    let calculatedOfferPrice: number | undefined = undefined;
    if (isOffer && offerValue > 0) {
      if (offerType === "percentage") {
        calculatedOfferPrice = Math.max(0, Math.round(price * (1 - offerValue / 100)));
      } else {
        calculatedOfferPrice = Math.max(0, Math.round(price - offerValue));
      }
    }

    setIsSavingProduct(true);
    let finalProductId = editingProduct?.id;
    let savedProduct: Product;
    let firestoreSuccess = false;
    let serverSuccess = false;

    try {
      const sanitized = sanitizeProductForFirestore({
        name,
        category: resolvedCategory,
        price,
        unit,
        description: productForm.description,
        isAvailable: productForm.isAvailable,
        image,
        imageUrl: image,
        isOffer,
        offerType,
        offerValue: isOffer ? offerValue : undefined,
        offerPrice: isOffer ? calculatedOfferPrice : undefined,
        offerStartDate: productForm.offerStartDate ? new Date(productForm.offerStartDate).toISOString() : null,
        offerEndDate: productForm.offerEndDate ? new Date(productForm.offerEndDate).toISOString() : null,
        offerEnabled: productForm.offerEnabled
      });

      // Maintain legacy/customer app compatibility fields
      sanitized.status = productForm.isAvailable !== false ? "Available" : "Unavailable";
      sanitized.normalizedCategory = resolvedCategory.toLowerCase();

      if (finalProductId) {
        // 1. UPDATE EXISTING PRODUCT (Preserve ID strictly, never duplicate)
        savedProduct = { ...editingProduct, ...sanitized, id: finalProductId, updatedAt: new Date().toISOString() } as Product;
      } else {
        // 2. ADD NEW PRODUCT (Generate unique Firestore ID)
        const newDocRef = doc(collection(db, "products"));
        finalProductId = newDocRef.id;
        savedProduct = {
          ...sanitized,
          id: finalProductId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as unknown as Product;
      }

      // Step 1: Direct Firestore SDK write (with catch so security rules or network quirks do not abort flow)
      try {
        const docRef = doc(db, "products", finalProductId);
        await setDoc(docRef, savedProduct, { merge: true });
        firestoreSuccess = true;
      } catch (fsErr: any) {
        console.warn("[Save Product] Direct Firestore write notice:", fsErr?.message || fsErr);
      }

      // Step 2: Server API write (updates disk persistence, memory cache, and server-side Firestore sync)
      try {
        const authHeader = auth.currentUser ? `Bearer ${await auth.currentUser.getIdToken().catch(() => "")}` : undefined;
        const apiMethod = editingProduct ? "PUT" : "POST";
        const apiUrl = editingProduct ? `/api/products/${encodeURIComponent(finalProductId)}` : `/api/products`;
        
        const res = await fetch(apiUrl, {
          method: apiMethod,
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {})
          },
          body: JSON.stringify(savedProduct)
        });

        if (res.ok) {
          serverSuccess = true;
          const json = await res.json().catch(() => ({}));
          if (json.product) {
            savedProduct = { ...savedProduct, ...json.product };
          }
        } else {
          console.warn("[Save Product] Server API returned HTTP", res.status);
        }
      } catch (srvErr: any) {
        console.warn("[Save Product] Server API sync notice:", srvErr?.message || srvErr);
      }

      // If either Firestore OR Server succeeded (or both), commit save!
      if (firestoreSuccess || serverSuccess) {
        // If user created a custom category, persist to Firestore categories collection & backend
        if (productForm.isCustomCategory && resolvedCategory) {
          try {
            await addDoc(collection(db, "categories"), {
              name: resolvedCategory,
              createdAt: new Date().toISOString()
            });
          } catch (catErr) {
            console.warn("[Categories] Firestore addDoc notice:", catErr);
          }
          fetch("/api/categories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: resolvedCategory })
          }).catch(() => {});
        }

        // Update state and localStorage cache immediately
        setProducts((prev) => {
          const filtered = prev.filter((p) => p.id !== finalProductId);
          const updatedList = [savedProduct, ...filtered].sort((a, b) =>
            (a.name || "").localeCompare(b.name || "")
          );
          try {
            localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(updatedList));
          } catch {}
          return updatedList;
        });

        // Update categories list if custom category added
        setCategories((prev) => {
          if (!prev.some((c) => c.name.toLowerCase() === resolvedCategory.toLowerCase())) {
            const updated = [...prev, { id: `cat_${Date.now()}`, name: resolvedCategory }].sort((a, b) =>
              a.name.localeCompare(b.name)
            );
            try {
              localStorage.setItem("zypsomart_cached_categories_v2", JSON.stringify(updated));
            } catch {}
            return updated;
          }
          return prev;
        });

        // Success notification
        showNotification(
          "success",
          editingProduct
            ? `Product "${name}" updated successfully!`
            : `Product "${name}" saved successfully!`
        );

        setShowProductModal(false);
        setEditingProduct(null);
        setProductForm({
          name: "",
          category: "",
          customCategory: "",
          isCustomCategory: false,
          price: "",
          unit: "piece",
          image: "",
          description: "",
          isAvailable: true,
          isOffer: false,
          offerType: "percentage",
          offerValue: "",
          offerStartDate: "",
          offerEndDate: "",
          offerEnabled: true
        });

        // Background refresh to keep in sync without full reload
        fetchProducts(true);
        fetchCategories(true);
      } else {
        throw new Error("Unable to save product to Firestore or server. Please check your connection.");
      }
    } catch (err: any) {
      console.error("[Save Product] Error:", err);
      showNotification("error", `Failed to save product: ${err?.message || "Unknown error"}`);
    } finally {
      setIsSavingProduct(false);
    }
  };

  // Delete Product with optimistic cache sync & server fallback
  const handleDeleteProduct = async (productId: string) => {
    const product = products.find((p) => p.id === productId);
    const prodName = product?.name || "Product";
    if (window.confirm(`Are you sure you want to delete "${prodName}" from the store catalog?`)) {
      try {
        setProducts((prev) => {
          const next = prev.filter((p) => p.id !== productId);
          try {
            localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(next));
          } catch {}
          return next;
        });

        // Direct Firestore delete
        try {
          await deleteDoc(doc(db, "products", productId));
        } catch (fsErr) {
          console.warn("[Product Delete] Firestore direct delete notice:", fsErr);
        }

        // Server API sync
        await fetch(`/api/products/${encodeURIComponent(productId)}`, {
          method: "DELETE"
        }).catch(() => {});

        showNotification("success", `Product "${prodName}" deleted successfully`);
      } catch (err: any) {
        showNotification("error", "Delete failed: " + err.message);
        fetchProducts(true);
      }
    }
  };

  // Open Offer Modal for a product
  const openOfferModal = (product: Product) => {
    if (!product) return;
    setProductForOffer(product);
    setOfferForm({
      offerType: product.offerType || "percentage",
      offerValue: product.offerValue !== undefined && product.offerValue !== null ? String(product.offerValue) : "",
      offerStartDate: product.offerStartDate ? product.offerStartDate.slice(0, 16) : "",
      offerEndDate: product.offerEndDate ? product.offerEndDate.slice(0, 16) : "",
      offerEnabled: product.offerEnabled !== false
    });
    setShowOfferModal(true);
  };

  // Save / Update Offer on a product (stores directly in Firestore with zero undefined fields)
  const handleSaveOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productForOffer || isSavingOffer) return;

    const offerValue = Number(offerForm.offerValue);
    if (isNaN(offerValue) || offerValue <= 0) {
      showNotification("error", "Discount value must be greater than 0.");
      return;
    }

    if (offerForm.offerType === "percentage" && (offerValue < 1 || offerValue > 99)) {
      showNotification("error", "Percentage discount must be between 1% and 99%.");
      return;
    }

    if (offerForm.offerType === "fixed" && offerValue >= productForOffer.price) {
      showNotification("error", `Fixed discount cannot exceed the original price of ₹${productForOffer.price}.`);
      return;
    }

    // Auto-calculate final offer price
    let calculatedPrice = productForOffer.price;
    if (offerForm.offerType === "percentage") {
      calculatedPrice = Math.max(0, Math.round(productForOffer.price * (1 - offerValue / 100)));
    } else {
      calculatedPrice = Math.max(0, Math.round(productForOffer.price - offerValue));
    }

    if (calculatedPrice < 0) {
      showNotification("error", "Final offer price cannot be negative.");
      return;
    }

    setIsSavingOffer(true);
    try {
      const offerPayload = {
        isOffer: true,
        offerType: offerForm.offerType,
        offerValue,
        offerPrice: calculatedPrice,
        offerStartDate: offerForm.offerStartDate ? new Date(offerForm.offerStartDate).toISOString() : null,
        offerEndDate: offerForm.offerEndDate ? new Date(offerForm.offerEndDate).toISOString() : null,
        offerEnabled: Boolean(offerForm.offerEnabled),
        updatedAt: new Date().toISOString()
      };

      // 1. Direct Firestore setDoc with merge: true (never throws unsupported undefined)
      try {
        await setDoc(doc(db, "products", productForOffer.id), offerPayload, { merge: true });
      } catch (fsErr: any) {
        console.warn("[Offer Save] Direct Firestore update notice:", fsErr?.message || fsErr);
      }

      // 2. Server API sync
      await fetch(`/api/products/${encodeURIComponent(productForOffer.id)}/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offerPayload)
      }).catch(() => {});

      // Update state and local storage immediately
      setProducts((prev) => {
        const next = prev.map((p) =>
          p.id === productForOffer.id ? { ...p, ...offerPayload } : p
        );
        try {
          localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(next));
        } catch {}
        return next;
      });

      showNotification(
        "success",
        `Offer configured for "${productForOffer.name}": ₹${productForOffer.price} ➔ ₹${calculatedPrice} (${offerForm.offerType === "percentage" ? `${offerValue}% OFF` : `₹${offerValue} OFF`})`
      );
      setShowOfferModal(false);
      setProductForOffer(null);
    } catch (err: any) {
      showNotification("error", "Failed to save offer: " + err.message);
    } finally {
      setIsSavingOffer(false);
    }
  };

  // Remove Offer from a product (Preserves original catalog product at regular price)
  const handleRemoveOffer = async (productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;

    if (
      window.confirm(
        `Remove offer from "${product.name}"? The product will remain in your catalog at regular price ₹${product.price}.`
      )
    ) {
      try {
        const resetPayload = {
          isOffer: false,
          offerType: null,
          offerValue: 0,
          offerPrice: product.price,
          offerStartDate: null,
          offerEndDate: null,
          offerEnabled: false,
          updatedAt: new Date().toISOString()
        };

        // 1. Direct Firestore setDoc with merge: true (zero undefined fields)
        try {
          await setDoc(doc(db, "products", productId), resetPayload, { merge: true });
        } catch (fsErr: any) {
          console.warn("[Offer Remove] Direct Firestore update notice:", fsErr?.message || fsErr);
        }

        // 2. Server API sync
        await fetch(`/api/products/${encodeURIComponent(productId)}/offer`, {
          method: "DELETE"
        }).catch(() => {});

        setProducts((prev) => {
          const next = prev.map((p) =>
            p.id === productId ? { ...p, ...resetPayload } : p
          );
          try {
            localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(next));
          } catch {}
          return next;
        });

        showNotification("success", `Offer removed from "${product.name}". Regular price ₹${product.price} restored.`);
      } catch (err: any) {
        showNotification("error", "Error removing offer: " + err.message);
      }
    }
  };

  // Quick toggle Enable/Disable Offer
  const handleToggleOfferEnabled = async (productId: string, currentEnabled: boolean) => {
    const nextEnabled = !currentEnabled;
    const product = products.find((p) => p.id === productId);
    if (!product) return;

    try {
      setProducts((prev) => {
        const next = prev.map((p) =>
          p.id === productId ? { ...p, offerEnabled: nextEnabled } : p
        );
        try {
          localStorage.setItem("zypsomart_cached_products_v2", JSON.stringify(next));
        } catch {}
        return next;
      });

      // 1. Direct Firestore update
      try {
        await setDoc(doc(db, "products", productId), {
          offerEnabled: nextEnabled,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch (fsErr: any) {
        console.warn("[Toggle Offer] Direct Firestore update notice:", fsErr?.message || fsErr);
      }

      // 2. Server API sync
      await fetch(`/api/products/${encodeURIComponent(productId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerEnabled: nextEnabled })
      }).catch(() => {});

      showNotification(
        "success",
        `Offer for "${product.name}" ${nextEnabled ? "Enabled 🟢" : "Disabled ⏸️"}`
      );
    } catch (err: any) {
      showNotification("error", "Error updating offer status: " + err.message);
    }
  };

  // Customer Cart helper functions
  const handleUpdateCustomerCart = (productId: string, delta: number) => {
    setCustomerCart((prev) => {
      const current = prev[productId] || 0;
      const next = Math.max(0, current + delta);
      const updated = { ...prev };
      if (next === 0) {
        delete updated[productId];
      } else {
        updated[productId] = next;
      }
      return updated;
    });
  };

  // Place real customer test order in Firestore
  const handlePlaceCustomerTestOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const cartEntries = Object.entries(customerCart);
    if (cartEntries.length === 0) {
      showNotification("error", "Your customer cart is empty. Add items first.");
      return;
    }

    const items = cartEntries
      .map(([prodId, qty]) => {
        const p = products.find((prod) => prod.id === prodId);
        if (!p) return null;
        const pricing = getProductPricing(p);
        const effectivePrice = pricing.hasActiveOffer ? pricing.finalPrice : pricing.originalPrice;
        return {
          name: p.name,
          qty,
          price: effectivePrice
        };
      })
      .filter(Boolean) as { name: string; qty: number; price: number }[];

    if (items.length === 0) {
      showNotification("error", "No valid items in cart.");
      return;
    }

    const subtotal = items.reduce((acc, it) => acc + it.price * it.qty, 0);
    const deliveryFee = subtotal >= 199 ? 0 : 25;
    const finalTotal = subtotal + deliveryFee;

    setIsPlacingCustomerOrder(true);
    try {
      const newOrderRef = doc(collection(db, "orders"));
      const orderPayload = {
        id: newOrderRef.id,
        customerName: customerCheckoutForm.name.trim() || "Customer",
        customerPhone: customerCheckoutForm.phone.trim() || "9876543210",
        customerAddress: customerCheckoutForm.address.trim() || "Delivery Address",
        items,
        total: finalTotal,
        status: "pending",
        orderStatus: "pending",
        deliveryStatus: "pending",
        paymentMethod: customerCheckoutForm.paymentMethod,
        paymentStatus: customerCheckoutForm.paymentMethod === "Razorpay" ? "Paid Online" : "Pending COD",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await setDoc(newOrderRef, orderPayload);

      showNotification(
        "success",
        `🎉 Customer Order #${newOrderRef.id.slice(0, 8)} placed successfully! Total: ₹${finalTotal}`
      );
      setCustomerCart({});
      setShowCustomerPreviewModal(false);
      setActiveTab("orders");
    } catch (err: any) {
      console.error("[Customer Order] Error placing order:", err);
      showNotification("error", `Failed to place customer order: ${err?.message || "Unknown error"}`);
    } finally {
      setIsPlacingCustomerOrder(false);
    }
  };

  // Memoized searched orders list by debounced search query
  const searchedOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((ord) => {
      const name = (ord.customerName || "").toLowerCase();
      const phone = ord.customerPhone || "";
      const id = (ord.id || "").toLowerCase();
      return name.includes(q) || phone.includes(q) || id.includes(q);
    });
  }, [orders, searchQuery]);

  // 12-Hour Statistics calculation
  const stats = useMemo(() => {
    const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
    let recentOrdersCount = 0;
    let revenueCount = 0;

    orders.forEach((ord) => {
      if (!ord) return;
      const ts = getTimestampMs(ord.createdAt);
      // Valid order from last 12 hours (if timestamp is unavailable or fresh, count it)
      const isWithin12h = ts > 0 ? ts >= twelveHoursAgo : true;
      const status = (ord.status || "pending").toLowerCase();
      const isCancelled =
        status === "cancelled" ||
        status === "cancel" ||
        status === "canceled" ||
        status === "rejected";
      const total = Number(ord.total) || 0;

      if (isWithin12h && !isCancelled) {
        recentOrdersCount += 1;
        revenueCount += total;
      }
    });

    const activeProductsCount = products.filter((p) => p && p.isAvailable !== false).length;

    return {
      recentOrders: recentOrdersCount,
      totalProducts: activeProductsCount || products.length,
      revenue: revenueCount
    };
  }, [orders, products]);

  // Tab and Status filtered orders list
  const filteredOrders = useMemo(() => {
    let list = [...searchedOrders];
    if (statusFilter === "returns") {
      list = list.filter(isReturnOrder);
    } else if (statusFilter === "completed" || statusFilter === "delivered") {
      list = list.filter(
        (ord) => !isReturnOrder(ord) && (ord.status || "pending").toLowerCase() === "delivered"
      );
    } else if (statusFilter !== "all") {
      list = list.filter(
        (ord) => !isReturnOrder(ord) && (ord.status || "pending").toLowerCase() === statusFilter
      );
    }

    return list.sort((a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt));
  }, [searchedOrders, statusFilter]);

  // Filtered products list memoized by debounced search query and category filter
  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (!p) return false;
      const matchesSearch =
        !q ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.category || "").toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q);

      const matchesCategory =
        productCategoryFilter === "all" ||
        (p.category || "").trim().toLowerCase() === productCategoryFilter.toLowerCase();

      return matchesSearch && matchesCategory;
    });
  }, [products, searchQuery, productCategoryFilter]);

  // Memoized offer statistics and filtered offer products for Offer Management Tab
  const offerStats = useMemo(() => {
    let total = 0;
    let active = 0;
    let upcoming = 0;
    let expired = 0;
    let disabled = 0;

    products.forEach((p) => {
      if (p.isOffer) {
        total += 1;
        const pricing = getProductPricing(p);
        if (pricing.offerStatus === "active") active += 1;
        else if (pricing.offerStatus === "upcoming") upcoming += 1;
        else if (pricing.offerStatus === "expired") expired += 1;
        else if (pricing.offerStatus === "disabled") disabled += 1;
      }
    });

    return { total, active, upcoming, expired, disabled };
  }, [products]);

  const filteredOffers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (!p.isOffer) return false;
      const pricing = getProductPricing(p);

      // Status filter
      if (offerStatusFilter !== "all" && pricing.offerStatus !== offerStatusFilter) {
        return false;
      }

      // Category filter
      if (
        offerCategoryFilter !== "all" &&
        p.category.toLowerCase() !== offerCategoryFilter.toLowerCase()
      ) {
        return false;
      }

      // Search query
      if (q) {
        const matchName = (p.name || "").toLowerCase().includes(q);
        const matchCat = (p.category || "").toLowerCase().includes(q);
        if (!matchName && !matchCat) return false;
      }

      return true;
    });
  }, [products, searchQuery, offerStatusFilter, offerCategoryFilter]);

  // Feature: Export current filtered orders to CSV for admin record-keeping
  const exportOrdersToCSV = () => {
    if (!filteredOrders || filteredOrders.length === 0) {
      showNotification("error", "No orders to export in the current view or filter.");
      return;
    }

    // RFC 4180 CSV standard escaper with spreadsheet formula sanitization
    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '""';
      let str = String(val).replace(/\r\n/g, " ").replace(/[\r\n]/g, " ").trim();
      // Security: prevent CSV injection (DDE attacks) in Excel/Google Sheets
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      return `"${str.replace(/"/g, '""')}"`;
    };

    const headers = [
      "Order ID",
      "Order Date & Time",
      "Customer Name",
      "Customer Phone",
      "Customer Address",
      "Order Status",
      "Total Amount (INR)",
      "Payment Method",
      "Items Count",
      "Items Breakdown",
      "Customer Instructions",
      "Internal Admin Notes",
      "Return Notes"
    ];

    const rows = filteredOrders.map((ord) => {
      const itemsSummary = (ord.items || [])
        .map(
          (it: any) =>
            `${it.name || "Item"} (x${it.qty || 1}${
              it.price ? ` - Rs.${it.price * (it.qty || 1)}` : ""
            })`
        )
        .join("; ");

      const status = isReturnOrder(ord)
        ? ord.status === "return_approved"
          ? "RETURN APPROVED"
          : ord.status === "return_rejected"
          ? "RETURN REJECTED"
          : "RETURN REQUEST"
        : (ord.status || "pending").toUpperCase();

      return [
        escapeCsv(ord.id),
        escapeCsv(formatFullDateTime(ord.createdAt)),
        escapeCsv(ord.customerName || ""),
        escapeCsv(ord.customerPhone || ""),
        escapeCsv(ord.customerAddress || ""),
        escapeCsv(status),
        escapeCsv(Number(ord.total || 0).toFixed(2)),
        escapeCsv(ord.paymentMethod || "N/A"),
        escapeCsv((ord.items || []).length),
        escapeCsv(itemsSummary),
        escapeCsv(ord.notes || ord.customerNotes || ""),
        escapeCsv(ord.internalNotes || ord.adminNotes || ""),
        escapeCsv(ord.returnNotes || "")
      ].join(",");
    });

    const csvContent = [headers.map((h) => `"${h}"`).join(","), ...rows].join("\r\n");

    // Prepend UTF-8 BOM (\uFEFF) so Excel and spreadsheet apps correctly render Indian currency & unicode text
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    const filterSuffix = statusFilter !== "all" ? `-${statusFilter}` : "";
    link.href = url;
    link.download = `zypsomart-orders${filterSuffix}-${dateStr}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showNotification(
      "success",
      `Exported ${filteredOrders.length} order${
        filteredOrders.length === 1 ? "" : "s"
      } to CSV successfully.`
    );
  };

  // View: Unauthenticated Sign In Screen
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-slate-100">
          <div className="flex flex-col items-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-emerald-50 via-amber-50 to-orange-50 rounded-2xl flex items-center justify-center mb-4 p-2 border border-emerald-100 shadow-md shadow-emerald-100/50">
              <img
                src={appLogo}
                alt="Zypso Mart"
                className="w-full h-full object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">Zypso Mart Admin</h1>
            <p className="text-slate-500 text-sm mt-1">Sign in to manage your grocery store</p>
          </div>

          <form onSubmit={handleEmailSignIn} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                placeholder="admin@zypso.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                placeholder="••••••••"
                required
              />
            </div>

            {authError && (
              <p className="text-red-500 text-sm bg-red-50 p-3 rounded-lg border border-red-100">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-3 rounded-xl shadow-lg shadow-emerald-100 transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer"
            >
              {authLoading ? <RefreshCcw className="animate-spin" size={20} /> : "Sign In"}
            </button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-slate-400 font-semibold tracking-wider">
                Or continue with
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={authLoading}
            className="w-full flex items-center justify-center gap-3 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 text-slate-700 font-bold py-3 rounded-xl shadow-sm transition-all active:scale-[0.98] cursor-pointer"
          >
            <svg
              className="w-5 h-5 shrink-0"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g transform="matrix(1, 0, 0, 1, 0, 0)">
                <path
                  d="M21.35,11.1H12v2.7h5.38c-.24,1.28-.96,2.37-2.01,3.07v2.55h3.24c1.9-1.75,3-4.32,3-7.32a8.62,8.62,0,0,0-.27-2H21.35Z"
                  fill="#4285f4"
                />
                <path
                  d="M12,20.4a8.16,8.16,0,0,0,5.61-2l-3.24-2.55A5.06,5.06,0,0,1,12,16.5a5.16,5.16,0,0,1-4.85-3.57H3.77v2.63A8.4,8.4,0,0,0,12,20.4Z"
                  fill="#34a853"
                />
                <path
                  d="M7.15,12.93a5.05,5.05,0,0,1,0-1.86V8.44H3.77a8.4,8.4,0,0,0,0,7.12l3.38-2.63Z"
                  fill="#fbbc05"
                />
                <path
                  d="M12,7.5a4.78,4.78,0,0,1,3.31,1.26l2.45-2.45A8.15,8.15,0,0,0,12,3.6,8.4,8.4,0,0,0,3.77,8.44l3.38,2.63A5.16,5.16,0,0,1,12,7.5Z"
                  fill="#ea4335"
                />
              </g>
            </svg>
            <span>Sign Up / In with Google</span>
          </button>

          <div className="mt-6 text-center">
            <p className="text-xs text-slate-400 uppercase tracking-widest font-semibold">
              Demo Account: admin@zypso.com / 123456
            </p>
          </div>
        </div>
      </div>
    );
  }

  // View: PIN Verification Screen
  if (!isPinVerified) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center border border-slate-100">
          <div className="w-20 h-20 bg-gradient-to-br from-emerald-50 via-amber-50 to-orange-50 rounded-2xl flex items-center justify-center mb-6 mx-auto p-2 border border-emerald-100 shadow-md shadow-emerald-100/50">
            <img
              src={appLogo}
              alt="Zypso Mart"
              className="w-full h-full object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight mb-2">Security Verification</h1>
          <p className="text-slate-500 text-sm mb-6">
            Enter your 4-digit security PIN to access the admin dashboard
          </p>

          <form onSubmit={handlePinSubmit} className="space-y-6">
            <div className="flex flex-col items-center">
              <input
                type="password"
                maxLength={4}
                value={pin}
                autoFocus
                onChange={(e) => {
                  setPin(e.target.value.replace(/\D/g, ""));
                  if (pinError) setPinError("");
                }}
                className="w-40 text-center text-3xl tracking-[0.6em] font-black py-3 rounded-2xl border-2 border-slate-200 focus:border-emerald-500 outline-none transition-all font-mono"
                placeholder="••••"
                required
              />
            </div>
            {pinError && <p className="text-red-500 text-sm font-medium bg-red-50 py-2 px-3 rounded-lg border border-red-100">{pinError}</p>}
            <button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 rounded-xl shadow-lg shadow-emerald-600/20 transition-all active:scale-95 cursor-pointer"
            >
              Verify PIN
            </button>
          </form>

          <div className="mt-6">
            <button
              onClick={handleSignOut}
              className="hidden text-slate-400 hover:text-slate-600 text-sm font-medium transition-colors cursor-pointer"
              style={{ display: "none" }}
            >
              Sign out from {user.email}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // View: Main Admin Dashboard Layout
  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar (Desktop) */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex">
        <div className="p-5 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-50 via-amber-50 to-orange-50 p-1 border border-emerald-100 shadow-xs flex items-center justify-center shrink-0 overflow-hidden">
              <img
                src={appLogo}
                alt="Zypso Mart"
                className="w-full h-full object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
            <div>
              <span className="font-extrabold text-slate-900 text-sm tracking-tight leading-tight block">Zypso Mart</span>
              <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest block">Admin Console</span>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <button
            onClick={() => setActiveTab("orders")}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl font-semibold transition-all cursor-pointer ${
              activeTab === "orders"
                ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <div className="flex items-center gap-3">
              <ShoppingCart size={19} />
              <span>Orders</span>
            </div>
            <div className="flex items-center gap-1.5">
              {unacknowledgedOrders.length > 0 && (
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-red-500 text-white animate-pulse">
                  {unacknowledgedOrders.length} NEW
                </span>
              )}
              {orders.length > 0 && (
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    activeTab === "orders"
                      ? "bg-white/25 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {orders.length}
                </span>
              )}
            </div>
          </button>
          <button
            onClick={() => setActiveTab("products")}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl font-semibold transition-all cursor-pointer ${
              activeTab === "products"
                ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <div className="flex items-center gap-3">
              <Package size={19} />
              <span>Products</span>
            </div>
            {products.length > 0 && (
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  activeTab === "products"
                    ? "bg-white/25 text-white"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {products.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("offers")}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl font-semibold transition-all cursor-pointer ${
              activeTab === "offers"
                ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <div className="flex items-center gap-3">
              <BadgePercent size={19} />
              <span>Offers & Deals</span>
            </div>
            <div className="flex items-center gap-1.5">
              {offerStats.active > 0 && (
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-amber-500 text-white animate-pulse">
                  {offerStats.active} LIVE
                </span>
              )}
              {offerStats.total > 0 && (
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    activeTab === "offers"
                      ? "bg-white/25 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {offerStats.total}
                </span>
              )}
            </div>
          </button>

          <button
            onClick={() => setShowAlarmSettingsModal(true)}
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl font-semibold transition-all cursor-pointer text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            <div className="flex items-center gap-3">
              <BellRing
                size={19}
                className={
                  isAlarmRinging
                    ? "text-red-600 animate-bounce"
                    : isAlarmEnabled
                    ? "text-emerald-600"
                    : "text-slate-400"
                }
              />
              <span>Order Alarm</span>
            </div>
            <span
              className={`text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider ${
                isAlarmRinging
                  ? "bg-red-500 text-white animate-pulse"
                  : isAlarmEnabled
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              {isAlarmRinging ? "Ringing!" : isAlarmEnabled ? "Active" : "Muted"}
            </span>
          </button>

          {/* Feature 2 (Arrow 2): Alarm Status & Quick Toggle */}
          <div
            className={`w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-xs font-bold transition-all shadow-xs border ${
              isAlarmRinging
                ? "bg-red-600 text-white border-red-700 animate-pulse ring-2 ring-red-400"
                : isAlarmEnabled
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200/80 hover:bg-emerald-100"
                : "bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200"
            }`}
          >
            <button
              onClick={() => setShowAlarmSettingsModal(true)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
              title="Click to view Alarm Settings"
            >
              {isAlarmRinging ? (
                <Volume2 size={16} className="animate-bounce shrink-0" />
              ) : isAlarmEnabled ? (
                <BellRing size={16} className="text-emerald-600 shrink-0" />
              ) : (
                <VolumeX size={16} className="shrink-0" />
              )}
              <span className="font-bold text-xs truncate">
                {isAlarmRinging ? "ALARM RINGING!" : "Alarm Status"}
              </span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isAlarmRinging) {
                  alarmAudio.stopAlarm();
                  setIsAlarmRinging(false);
                } else {
                  handleToggleAlarm(!isAlarmEnabled);
                }
              }}
              className={`text-[9px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider cursor-pointer shadow-xs transition-transform active:scale-95 ${
                isAlarmRinging
                  ? "bg-white text-red-700 font-black animate-bounce"
                  : isAlarmEnabled
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "bg-slate-300 text-slate-700 hover:bg-slate-400"
              }`}
              title={
                isAlarmRinging
                  ? "Click to silence alarm"
                  : isAlarmEnabled
                  ? "Click to turn Alarm OFF"
                  : "Click to turn Alarm ON"
              }
            >
              {isAlarmRinging ? "SILENCE" : isAlarmEnabled ? "ON" : "OFF"}
            </button>
          </div>
        </nav>

        <div className="p-4 border-t border-slate-100">
          {showInstallBtn && !isAppInstalled && deferredPrompt && (
            <button
              onClick={handleInstallApp}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 mb-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl transition-all shadow-md text-xs tracking-wide cursor-pointer active:scale-[0.98]"
            >
              <Download size={14} className="stroke-[2.5]" />
              <span>Install Admin App</span>
            </button>
          )}

          <div className="px-4 py-3 mb-4 rounded-xl bg-slate-50 border border-slate-100 overflow-hidden space-y-2">
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Signed in as
              </p>
              <p className="text-xs font-semibold text-slate-700 truncate">{user.email}</p>
            </div>
            <div className="flex items-center gap-1.5 pt-1.5 border-t border-slate-100/85">
              <span
                className={`w-2 h-2 rounded-full ${
                  syncStatus === "connected"
                    ? "bg-emerald-500 animate-pulse"
                    : syncStatus === "connecting"
                    ? "bg-amber-500 animate-pulse"
                    : syncStatus === "reconnecting"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-red-500 animate-bounce"
                }`}
              />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {syncStatus === "connected"
                  ? "Synced (Live)"
                  : syncStatus === "connecting"
                  ? "Connecting..."
                  : syncStatus === "reconnecting"
                  ? "Reconnecting..."
                  : "Failed to Sync"}
              </span>
            </div>
          </div>

          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 w-full px-4 py-3 text-red-600 hover:bg-red-50 rounded-xl font-medium transition-colors cursor-pointer"
          >
            <LogOut size={20} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 overflow-y-auto max-w-full">
        {/* Header (Fixed / Sticky while scrolling) */}
        <header className="bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-3 sm:px-6 py-3 sm:py-4 sticky top-0 z-30 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-gradient-to-br from-emerald-50 via-amber-50 to-orange-50 p-1 border border-emerald-100 shadow-sm flex items-center justify-center shrink-0 overflow-hidden group hover:scale-105 transition-transform">
                  <img
                    src={appLogo}
                    alt="Zypso Mart Logo"
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg sm:text-2xl font-black text-slate-900 tracking-tight leading-tight truncate">
                    {activeTab === "orders" ? "Orders" : activeTab === "offers" ? "Offers & Deals" : "Products"}
                  </h2>
                  <p className="text-[11px] sm:text-xs text-slate-500 truncate">
                    {activeTab === "orders"
                      ? "Real-time order manager & updates"
                      : activeTab === "offers"
                      ? "Special discounts, promotional prices & flash deals"
                      : "Inventory & stock availability"}
                  </p>
                </div>
              </div>

              {/* Shop Status & Header Controls */}
              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                <button
                  onClick={() => handleUpdateShopStatus(!isShopOpen)}
                  disabled={isUpdatingShopStatus}
                  className={`flex items-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-xl text-xs font-black transition-all cursor-pointer border shadow-2xs shrink-0 ${
                    isShopOpen
                      ? "bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100"
                      : "bg-red-50 text-red-800 border-red-300 hover:bg-red-100 ring-2 ring-red-200 animate-pulse"
                  }`}
                  title={isShopOpen ? "Store is OPEN. Click to switch to CLOSED." : "Store is CLOSED. Click to switch to OPEN."}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      isShopOpen
                        ? "bg-emerald-500 shadow-xs shadow-emerald-500/50"
                        : "bg-red-600 shadow-xs shadow-red-600/50 animate-ping"
                    }`}
                  />
                  <span className="text-[11px] font-black">{isShopOpen ? "OPEN" : "CLOSED"}</span>
                </button>

                <button
                  onClick={() => setShowAlarmSettingsModal(true)}
                  className={`p-1.5 sm:p-2 rounded-xl border transition-all cursor-pointer shrink-0 ${
                    isAlarmRinging
                      ? "bg-red-600 text-white border-red-700 animate-bounce"
                      : isAlarmEnabled
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                      : "bg-slate-100 text-slate-500 border-slate-200"
                  }`}
                  title="Order Alarm & FCM Push Notification Settings"
                >
                  {isAlarmRinging ? (
                    <Volume2 size={16} className="animate-spin text-white" />
                  ) : (
                    <BellRing size={16} />
                  )}
                </button>

                {showInstallBtn && !isAppInstalled && deferredPrompt && (
                  <button
                    onClick={handleInstallApp}
                    className="sm:hidden flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-xs active:scale-95 transition-all shrink-0 cursor-pointer"
                    title="Install Zypso Mart App"
                  >
                    <Download size={13} className="stroke-[2.5]" />
                    <span>Install</span>
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
              {/* Medium Size Debounced Search Bar */}
              <div className="relative flex-1 sm:w-80 md:w-96 max-w-md">
                <Search
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  size={18}
                />
                <input
                  type="text"
                  placeholder={
                    activeTab === "orders"
                      ? "Search orders..."
                      : activeTab === "offers"
                      ? "Search offers or category..."
                      : "Search products..."
                  }
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-10 pr-9 py-2 sm:py-2.5 bg-slate-100 border border-slate-200/80 focus:bg-white focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 rounded-xl outline-none transition-all w-full text-xs sm:text-sm font-medium placeholder:text-slate-400"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => handleSetSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
                    title="Clear search"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>

              <button
                onClick={() => (activeTab === "orders" ? startOrdersSync() : fetchProducts(true))}
                disabled={isLoadingProducts}
                className="p-2 sm:p-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors shrink-0 cursor-pointer disabled:opacity-50"
                title={activeTab === "orders" ? "Reconnect / Refresh Orders" : "Refresh Catalog & Offers"}
              >
                <RefreshCcw
                  size={17}
                  className={`text-slate-600 ${isLoadingProducts ? "animate-spin text-emerald-600" : ""}`}
                />
              </button>

              {showInstallBtn && !isAppInstalled && deferredPrompt && (
                <button
                  onClick={handleInstallApp}
                  className="hidden sm:flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all shrink-0 cursor-pointer"
                  title="Install App"
                >
                  <Download size={14} className="stroke-[2.5]" />
                  <span>Install App</span>
                </button>
              )}

              {/* Live Customer Store Preview & Test Checkout Trigger */}
              <button
                onClick={() => setShowCustomerPreviewModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200/90 rounded-xl font-bold transition-all text-xs sm:text-sm shrink-0 cursor-pointer active:scale-95 shadow-2xs"
                title="Preview live customer store and test checkout with active offers"
              >
                <Eye size={15} className="stroke-[2.5]" />
                <span className="hidden sm:inline">Customer Store Preview</span>
                <span className="sm:hidden">Preview</span>
              </button>

              {activeTab === "products" && (
                <button
                  onClick={openAddProductModal}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-all shadow-md shadow-emerald-600/20 text-xs sm:text-sm shrink-0 cursor-pointer active:scale-95"
                >
                  <Plus size={16} />
                  <span>Add Product</span>
                </button>
              )}

              {activeTab === "offers" && (
                <button
                  onClick={() => {
                    setActiveTab("products");
                    showNotification("success", "Select any product below and click 'Add to Offer' or 'Edit Deal' to configure discounts.");
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold transition-all shadow-md shadow-amber-600/20 text-xs sm:text-sm shrink-0 cursor-pointer active:scale-95"
                >
                  <Plus size={16} />
                  <span>Add to Offer</span>
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Floating Emergency Alarm Active Notification Bar */}
        {isAlarmRinging && (
          <div className="bg-red-600 text-white px-4 py-2.5 flex items-center justify-between shadow-xl sticky top-[57px] sm:top-[73px] z-40 animate-pulse border-b-2 border-red-700">
            <div className="flex items-center gap-2.5 min-w-0">
              <Volume2 className="animate-bounce shrink-0" size={18} />
              <span className="font-black text-xs sm:text-sm uppercase tracking-wide truncate">
                🚨 New Order Alarm Active!
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  alarmAudio.stopAlarm();
                  setIsAlarmRinging(false);
                }}
                className="bg-white text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all shadow-sm active:scale-95 cursor-pointer"
              >
                🔇 Silence Sound
              </button>
            </div>
          </div>
        )}

        <div className="p-3 sm:p-6 pb-28 md:pb-8">
          {/* Global Alert Notification */}
          {bannerError && (
            <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-xl flex items-center justify-between shadow-sm">
              <span className="text-sm font-semibold">{bannerError}</span>
              <button
                onClick={() => setBannerError("")}
                className="p-1 hover:bg-amber-100 rounded-lg transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {/* Toast Notification */}
          <AnimatePresence>
            {toast && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className={`fixed top-24 left-1/2 -translate-x-1/2 z-[150] px-6 py-3 rounded-full shadow-lg text-white font-medium flex items-center gap-2 ${
                  toast.type === "success" ? "bg-emerald-500" : "bg-red-500"
                }`}
              >
                {toast.type === "success" ? <CircleCheckBig size={18} /> : <CircleX size={18} />}
                <span>{toast.text}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Add / Edit Product Modal */}
          <AnimatePresence>
            {showProductModal && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm"
              >
                <motion.div
                  initial={{ scale: 0.95, y: 20 }}
                  animate={{ scale: 1, y: 0 }}
                  className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden"
                >
                  <div className="p-4 sm:p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                    <h3 className="text-lg sm:text-xl font-bold text-slate-900">
                      {editingProduct ? "Edit Product" : "Add New Product"}
                    </h3>
                    <button
                      onClick={() => setShowProductModal(false)}
                      className="p-2 hover:bg-slate-200/60 rounded-full transition-colors cursor-pointer"
                    >
                      <X size={20} className="text-slate-400" />
                    </button>
                  </div>

                  <form onSubmit={handleSaveProduct} noValidate className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                          Product Name
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. Fresh Tomatoes, Milk, Bananas..."
                          value={productForm.name}
                          onChange={(e) =>
                            setProductForm({ ...productForm, name: e.target.value })
                          }
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none font-medium text-slate-800"
                        />
                      </div>

                      <div className="col-span-1">
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
                            Category <span className="text-red-500">*</span>
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setProductForm((prev) => ({
                                ...prev,
                                isCustomCategory: !prev.isCustomCategory,
                                customCategory: prev.isCustomCategory ? "" : prev.customCategory || prev.category
                              }))
                            }
                            className="text-[11px] font-bold text-emerald-600 hover:text-emerald-700 underline cursor-pointer"
                          >
                            {productForm.isCustomCategory ? "Select from list" : "+ New Category"}
                          </button>
                        </div>

                        {productForm.isCustomCategory ? (
                          <div className="relative">
                            <input
                              type="text"
                              required
                              placeholder="Type new category name..."
                              value={productForm.customCategory}
                              onChange={(e) =>
                                setProductForm({ ...productForm, customCategory: e.target.value })
                              }
                              className="w-full px-4 py-3 rounded-xl border-2 border-emerald-400 focus:ring-2 focus:ring-emerald-500 outline-none font-semibold text-slate-800 text-sm bg-emerald-50/30"
                              autoFocus
                            />
                            <p className="text-[10px] text-slate-400 mt-1">
                              Will be saved with the product and added to all category lists.
                            </p>
                          </div>
                        ) : (
                          <select
                            required
                            value={productForm.category}
                            onChange={(e) => {
                              if (e.target.value === "__ADD_NEW__") {
                                setProductForm({
                                  ...productForm,
                                  isCustomCategory: true,
                                  customCategory: ""
                                });
                              } else {
                                setProductForm({
                                  ...productForm,
                                  category: e.target.value
                                });
                              }
                            }}
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none font-semibold text-slate-800 text-sm bg-white cursor-pointer"
                          >
                            <option value="" disabled>-- Select a Category --</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                            {/* Include current category if not in categories list */}
                            {productForm.category &&
                              !categories.some(
                                (c) => c.name.toLowerCase() === productForm.category.toLowerCase()
                              ) && (
                                <option value={productForm.category}>
                                  {productForm.category} (Current)
                                </option>
                              )}
                            <option value="__ADD_NEW__" className="font-bold text-emerald-600 bg-emerald-50">
                              + Add New Category...
                            </option>
                          </select>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                          Price (₹)
                        </label>
                        <input
                          type="number"
                          step="any"
                          required
                          placeholder="e.g. 50"
                          value={productForm.price}
                          onChange={(e) =>
                            setProductForm({ ...productForm, price: e.target.value })
                          }
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none font-medium text-slate-800"
                        />
                      </div>

                      {/* Product Unit / Measurement Field */}
                      <div className="col-span-2 bg-slate-50/90 border border-slate-200 rounded-2xl p-4">
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block text-xs font-bold text-slate-600 uppercase tracking-widest">
                            Product Unit / Measurement
                          </label>
                          {productForm.price && productForm.unit && (
                            <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2.5 py-0.5 rounded-md border border-emerald-200">
                              Preview: ₹{productForm.price} / {productForm.unit}
                            </span>
                          )}
                        </div>

                        <div className="relative mb-2.5">
                          <input
                            type="text"
                            list="product-unit-presets"
                            required
                            placeholder="Type or pick unit (e.g. Kg, gram, liter, package, bunch, bottle, piece, paw...)"
                            value={productForm.unit}
                            onChange={(e) =>
                              setProductForm({ ...productForm, unit: e.target.value })
                            }
                            className="w-full px-4 py-2.5 bg-white rounded-xl border border-slate-300 focus:ring-2 focus:ring-emerald-500 outline-none text-sm font-semibold text-slate-800 shadow-sm"
                          />
                          <datalist id="product-unit-presets">
                            {COMMON_PRODUCT_UNITS.map((u) => (
                              <option key={u} value={u} />
                            ))}
                          </datalist>
                        </div>

                        <div>
                          <p className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center justify-between">
                            <span>Popular Units (click to choose):</span>
                            <span className="text-[10px] text-slate-400 font-normal">Kg, gram, liter, package, bunch, bottle, piece, paw etc.</span>
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {COMMON_PRODUCT_UNITS.map((u) => {
                              const isSelected =
                                (productForm.unit || "").trim().toLowerCase() === u.toLowerCase();
                              return (
                                <button
                                  key={u}
                                  type="button"
                                  onClick={() => setProductForm({ ...productForm, unit: u })}
                                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer border ${
                                    isSelected
                                      ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                                      : "bg-white hover:bg-slate-100 text-slate-700 border-slate-200"
                                  }`}
                                >
                                  {u}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2">
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                          Image URL <span className="text-slate-400 font-normal lowercase">(optional direct link, Drive or Dropbox)</span>
                        </label>
                        <div className="flex gap-3">
                          <input
                            type="text"
                            placeholder="Direct image link, Google Drive, or Dropbox (optional)"
                            value={productForm.image}
                            onChange={(e) =>
                              setProductForm({ ...productForm, image: e.target.value })
                            }
                            className="flex-1 px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none text-sm"
                          />
                          {productForm.image && (
                            <div className="w-12 h-12 rounded-lg overflow-hidden border border-slate-200 shrink-0 bg-slate-100">
                              <img
                                src={formatImageUrl(productForm.image)}
                                alt="Preview"
                                loading="lazy"
                                decoding="async"
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                                onError={handleImgError}
                              />
                            </div>
                          )}
                        </div>
                        <p className="mt-1 text-[10px] text-slate-400">
                          Links from Google Drive & Dropbox will be automatically converted to direct images. A quality placeholder is used if left blank.
                        </p>
                      </div>

                      <div className="col-span-2">
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                          Description
                        </label>
                        <textarea
                          rows={2}
                          placeholder="Optional item details or notes..."
                          value={productForm.description}
                          onChange={(e) =>
                            setProductForm({ ...productForm, description: e.target.value })
                          }
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none resize-none text-sm"
                        />
                      </div>

                      <div className="col-span-2 flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
                        <div>
                          <span className="text-xs font-bold text-slate-700 block">Stock Availability</span>
                          <span className="text-[11px] text-slate-500">
                            {productForm.isAvailable ? "Available for customers to order" : "Marked as unavailable / Out of stock"}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setProductForm({ ...productForm, isAvailable: !productForm.isAvailable })}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                            productForm.isAvailable ? "bg-emerald-500" : "bg-slate-300"
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              productForm.isAvailable ? "translate-x-6" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </div>

                      {/* Integrated Offer / Discount Configuration Section */}
                      <div className="col-span-2 bg-gradient-to-br from-amber-50/70 via-orange-50/40 to-amber-50/80 border border-amber-200/90 rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg bg-amber-500 text-white flex items-center justify-center shadow-xs">
                              <BadgePercent size={16} />
                            </div>
                            <div>
                              <span className="text-xs font-black text-amber-950 block">Special Offer / Promotional Deal</span>
                              <span className="text-[10px] text-amber-800 font-medium">Add discount badge & offer price for customers</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setProductForm({ ...productForm, isOffer: !productForm.isOffer })}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                              productForm.isOffer ? "bg-amber-500" : "bg-slate-300"
                            }`}
                            title={productForm.isOffer ? "Disable offer" : "Enable offer"}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                productForm.isOffer ? "translate-x-6" : "translate-x-1"
                              }`}
                            />
                          </button>
                        </div>

                        {productForm.isOffer && (
                          <div className="space-y-3 pt-2 border-t border-amber-200/60">
                            {/* Offer Type selector */}
                            <div>
                              <label className="block text-[11px] font-bold text-amber-900 uppercase tracking-wider mb-1.5">
                                Discount Type
                              </label>
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setProductForm({ ...productForm, offerType: "percentage" })}
                                  className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                                    productForm.offerType === "percentage"
                                      ? "bg-amber-500 text-white border-amber-600 shadow-2xs"
                                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                                  }`}
                                >
                                  <Percent size={13} />
                                  <span>Percentage (%)</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setProductForm({ ...productForm, offerType: "fixed" })}
                                  className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                                    productForm.offerType === "fixed"
                                      ? "bg-amber-500 text-white border-amber-600 shadow-2xs"
                                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                                  }`}
                                >
                                  <IndianRupee size={13} />
                                  <span>Flat Discount (₹)</span>
                                </button>
                              </div>
                            </div>

                            {/* Discount Value */}
                            <div>
                              <label className="block text-[11px] font-bold text-amber-900 uppercase tracking-wider mb-1">
                                {productForm.offerType === "percentage" ? "Discount Percentage (1% - 99%)" : "Flat Discount Amount (₹)"}
                              </label>
                              <input
                                type="number"
                                step="any"
                                placeholder={productForm.offerType === "percentage" ? "e.g. 20" : "e.g. 15"}
                                value={productForm.offerValue}
                                onChange={(e) => setProductForm({ ...productForm, offerValue: e.target.value })}
                                className="w-full px-3.5 py-2 bg-white rounded-xl border border-amber-300 text-xs font-bold text-slate-800 outline-none focus:ring-2 focus:ring-amber-500"
                              />
                            </div>

                            {/* Live calculation banner */}
                            {(() => {
                              const p = Number(productForm.price) || 0;
                              const val = Number(productForm.offerValue) || 0;
                              let calcPrice = p;
                              if (val > 0) {
                                if (productForm.offerType === "percentage" && val < 100) {
                                  calcPrice = Math.max(0, Math.round(p * (1 - val / 100)));
                                } else if (productForm.offerType === "fixed" && val < p) {
                                  calcPrice = Math.max(0, Math.round(p - val));
                                }
                              }
                              return (
                                <div className="bg-white/90 rounded-xl p-2.5 border border-amber-200 flex items-center justify-between text-xs">
                                  <span className="text-slate-500 font-medium">Customer Offer Price:</span>
                                  <div className="flex items-center gap-2">
                                    {val > 0 && calcPrice < p && (
                                      <span className="text-slate-400 line-through text-[11px]">₹{p}</span>
                                    )}
                                    <span className="font-black text-sm text-emerald-600">₹{calcPrice}</span>
                                    {val > 0 && calcPrice < p && (
                                      <span className="bg-amber-100 text-amber-800 font-extrabold text-[10px] px-1.5 py-0.5 rounded">
                                        {productForm.offerType === "percentage" ? `${val}% OFF` : `₹${val} OFF`}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Optional dates */}
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div>
                                <label className="block text-[10px] font-bold text-slate-500 mb-0.5">Start Date (Optional)</label>
                                <input
                                  type="datetime-local"
                                  value={productForm.offerStartDate}
                                  onChange={(e) => setProductForm({ ...productForm, offerStartDate: e.target.value })}
                                  className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-[11px] outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold text-slate-500 mb-0.5">End Date (Optional)</label>
                                <input
                                  type="datetime-local"
                                  value={productForm.offerEndDate}
                                  onChange={(e) => setProductForm({ ...productForm, offerEndDate: e.target.value })}
                                  className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-[11px] outline-none"
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-3 pt-4">
                      <button
                        type="button"
                        onClick={() => setShowProductModal(false)}
                        className="flex-1 py-3 border border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingProduct}
                        onClick={(e) => {
                          if (!isSavingProduct) {
                            handleSaveProduct(e);
                          }
                        }}
                        className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] disabled:opacity-50 text-white font-bold rounded-xl transition-all shadow-lg shadow-emerald-100 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        {isSavingProduct ? (
                          <>
                            <RefreshCcw size={18} className="animate-spin" />
                            <span>Saving Product...</span>
                          </>
                        ) : (
                          <>
                            <Save size={18} />
                            <span>{editingProduct ? "Update Product" : "Add Product"}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Offer Configuration Modal */}
          <AnimatePresence>
            {showOfferModal && productForOffer && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm"
              >
                <motion.div
                  initial={{ scale: 0.95, y: 20 }}
                  animate={{ scale: 1, y: 0 }}
                  className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden"
                >
                  {/* Header */}
                  <div className="p-4 sm:p-6 border-b border-amber-100 flex justify-between items-center bg-gradient-to-r from-amber-50 to-orange-50 shrink-0">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-sm">
                        <BadgePercent size={22} />
                      </div>
                      <div>
                        <h3 className="text-lg sm:text-xl font-bold text-slate-900 leading-tight">
                          Configure Offer & Discount
                        </h3>
                        <p className="text-xs text-amber-800 font-medium truncate max-w-xs sm:max-w-sm">
                          {productForOffer.name}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowOfferModal(false)}
                      className="p-2 hover:bg-amber-200/50 rounded-full transition-colors cursor-pointer"
                    >
                      <X size={20} className="text-slate-500" />
                    </button>
                  </div>

                  <form onSubmit={handleSaveOffer} className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
                    {/* Product Summary banner */}
                    <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-200 flex items-center gap-3">
                      <div className="w-14 h-14 rounded-xl bg-white border border-slate-200 p-1 flex items-center justify-center shrink-0 overflow-hidden">
                        {productForOffer.imageUrl || productForOffer.image ? (
                          <img
                            src={formatImageUrl(productForOffer.imageUrl || productForOffer.image || "")}
                            alt={productForOffer.name}
                            className="w-full h-full object-contain"
                            onError={handleImgError}
                          />
                        ) : (
                          <Package className="text-slate-300" size={24} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">
                          {productForOffer.category} {productForOffer.unit ? `• ${productForOffer.unit}` : ""}
                        </span>
                        <h4 className="font-extrabold text-slate-900 text-sm truncate">
                          {productForOffer.name}
                        </h4>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs font-semibold text-slate-500">Original Price:</span>
                          <span className="text-sm font-black text-slate-900">₹{productForOffer.price}</span>
                        </div>
                      </div>
                    </div>

                    {/* Offer Type selector */}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
                        Offer Discount Type
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setOfferForm({ ...offerForm, offerType: "percentage" })}
                          className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all cursor-pointer ${
                            offerForm.offerType === "percentage"
                              ? "border-amber-500 bg-amber-50/80 text-amber-950 font-bold shadow-xs"
                              : "border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
                          }`}
                        >
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                            offerForm.offerType === "percentage" ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-500"
                          }`}>
                            <Percent size={16} />
                          </div>
                          <div className="text-left">
                            <span className="text-xs font-bold block">Percentage (%)</span>
                            <span className="text-[10px] text-slate-500 block">e.g. 20% OFF</span>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setOfferForm({ ...offerForm, offerType: "fixed" })}
                          className={`p-3 rounded-xl border flex items-center gap-2.5 transition-all cursor-pointer ${
                            offerForm.offerType === "fixed"
                              ? "border-amber-500 bg-amber-50/80 text-amber-950 font-bold shadow-xs"
                              : "border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
                          }`}
                        >
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                            offerForm.offerType === "fixed" ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-500"
                          }`}>
                            <IndianRupee size={16} />
                          </div>
                          <div className="text-left">
                            <span className="text-xs font-bold block">Fixed Discount (₹)</span>
                            <span className="text-[10px] text-slate-500 block">e.g. ₹25 OFF</span>
                          </div>
                        </button>
                      </div>
                    </div>

                    {/* Discount Value Input */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest">
                          {offerForm.offerType === "percentage" ? "Discount Percentage (%)" : "Flat Discount Amount (₹)"}
                        </label>
                        <span className="text-[11px] text-slate-400">
                          {offerForm.offerType === "percentage" ? "1% to 99%" : `Max ₹${productForOffer.price - 1}`}
                        </span>
                      </div>
                      <input
                        type="number"
                        step="any"
                        required
                        min="1"
                        max={offerForm.offerType === "percentage" ? "99" : String(productForOffer.price - 1)}
                        placeholder={offerForm.offerType === "percentage" ? "e.g. 20" : "e.g. 15"}
                        value={offerForm.offerValue}
                        onChange={(e) => setOfferForm({ ...offerForm, offerValue: e.target.value })}
                        className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-amber-500 outline-none font-bold text-slate-800 text-base"
                      />
                    </div>

                    {/* Live Calculation Preview Card */}
                    {(() => {
                      const val = Number(offerForm.offerValue);
                      const orig = productForOffer.price;
                      let finalP = orig;
                      let savings = 0;
                      let isValid = false;

                      if (!isNaN(val) && val > 0) {
                        if (offerForm.offerType === "percentage" && val < 100) {
                          finalP = Math.max(0, Math.round(orig * (1 - val / 100)));
                          savings = orig - finalP;
                          isValid = true;
                        } else if (offerForm.offerType === "fixed" && val < orig) {
                          finalP = Math.max(0, Math.round(orig - val));
                          savings = orig - finalP;
                          isValid = true;
                        }
                      }

                      return (
                        <div className="bg-gradient-to-br from-emerald-50 via-teal-50/60 to-emerald-50 rounded-2xl p-4 border border-emerald-200/80 shadow-xs">
                          <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700 block mb-2">
                            Live Offer Calculation
                          </span>
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="text-xs text-slate-500 block">Original Price</span>
                              <span className="text-sm font-semibold text-slate-400 line-through">
                                ₹{orig}
                              </span>
                            </div>
                            <div className="text-center">
                              <span className="text-xs text-slate-500 block">Discount</span>
                              <span className="text-xs font-black text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">
                                {isValid
                                  ? offerForm.offerType === "percentage"
                                    ? `${val}% OFF`
                                    : `₹${val} OFF`
                                  : "—"}
                              </span>
                            </div>
                            <div className="text-right">
                              <span className="text-xs font-bold text-emerald-800 block">Final Customer Price</span>
                              <span className="text-2xl font-black text-emerald-600 font-sans">
                                ₹{isValid ? finalP : orig}
                              </span>
                            </div>
                          </div>
                          {isValid && (
                            <p className="mt-2 pt-2 border-t border-emerald-200/60 text-xs text-emerald-800 font-semibold flex items-center justify-between">
                              <span>Customer saves on each item:</span>
                              <span className="font-black text-emerald-700">₹{savings}</span>
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Optional Schedule Dates */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 p-3.5 rounded-2xl border border-slate-200">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 mb-1 flex items-center gap-1">
                          <Calendar size={13} className="text-slate-400" />
                          <span>Start Date & Time (Optional)</span>
                        </label>
                        <input
                          type="datetime-local"
                          value={offerForm.offerStartDate}
                          onChange={(e) => setOfferForm({ ...offerForm, offerStartDate: e.target.value })}
                          className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-700 outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 mb-1 flex items-center gap-1">
                          <Calendar size={13} className="text-slate-400" />
                          <span>End Date & Time (Optional)</span>
                        </label>
                        <input
                          type="datetime-local"
                          value={offerForm.offerEndDate}
                          onChange={(e) => setOfferForm({ ...offerForm, offerEndDate: e.target.value })}
                          className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-700 outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                    </div>

                    {/* Enable / Disable Switch */}
                    <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                      <div>
                        <span className="text-xs font-bold text-slate-800 block">Offer Status</span>
                        <span className="text-[11px] text-slate-500">
                          {offerForm.offerEnabled
                            ? "Active — Customer App will show discount badge & offer price"
                            : "Disabled — Hidden from customers, regular price will be charged"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setOfferForm({ ...offerForm, offerEnabled: !offerForm.offerEnabled })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                          offerForm.offerEnabled ? "bg-emerald-500" : "bg-slate-300"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            offerForm.offerEnabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setShowOfferModal(false)}
                        className="flex-1 py-3 border border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-colors cursor-pointer text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingOffer}
                        className="flex-1 py-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-bold rounded-xl transition-all shadow-lg shadow-amber-100 flex items-center justify-center gap-2 cursor-pointer text-sm"
                      >
                        {isSavingOffer ? (
                          <>
                            <RefreshCcw size={16} className="animate-spin" />
                            <span>Saving Offer...</span>
                          </>
                        ) : (
                          <>
                            <BadgePercent size={18} />
                            <span>Save Offer</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Customer Store Preview & Test Checkout Modal */}
          <AnimatePresence>
            {showCustomerPreviewModal && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[180] flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-sm"
              >
                <motion.div
                  initial={{ scale: 0.95, y: 20 }}
                  animate={{ scale: 1, y: 0 }}
                  className="bg-slate-50 rounded-2xl sm:rounded-3xl shadow-2xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden border border-slate-200"
                >
                  {/* Top Header */}
                  <div className="p-4 sm:p-5 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-sm">
                        <ShoppingBag size={20} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base sm:text-lg font-black text-slate-900 leading-tight">
                            Zypsomart Customer Store Preview
                          </h3>
                          <span className="bg-indigo-100 text-indigo-800 text-[10px] font-black px-2 py-0.5 rounded-full uppercase">
                            Live Customer View
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          Verify offer badges, strikethrough prices, cart calculations & test COD / Razorpay checkout
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowCustomerPreviewModal(false)}
                      className="p-2 hover:bg-slate-100 rounded-full transition-colors cursor-pointer text-slate-400 hover:text-slate-700"
                      title="Close Preview"
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Body: 2 columns on desktop (Product Catalog + Cart / Checkout) */}
                  <div className="flex-1 overflow-y-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Left: Product Catalog (2 cols) */}
                    <div className="lg:col-span-2 space-y-4">
                      {/* Shop Status Banner */}
                      <div className={`p-3 rounded-xl border flex items-center justify-between text-xs font-bold ${
                        isShopOpen
                          ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                          : "bg-red-50 border-red-200 text-red-800"
                      }`}>
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${isShopOpen ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
                          <span>{isShopOpen ? "Store is currently OPEN — Orders are accepted" : "Store is currently CLOSED — Orders are paused"}</span>
                        </div>
                        <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-white/70">
                          {isShopOpen ? "OPEN" : "CLOSED"}
                        </span>
                      </div>

                      {/* Filter & Search */}
                      <div className="flex flex-col sm:flex-row gap-2">
                        <div className="relative flex-1">
                          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                          <input
                            type="text"
                            placeholder="Search products in customer catalog..."
                            value={customerPreviewSearch}
                            onChange={(e) => setCustomerPreviewSearch(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium outline-none focus:ring-2 focus:ring-emerald-500"
                          />
                        </div>
                        <select
                          value={customerPreviewCategory}
                          onChange={(e) => setCustomerPreviewCategory(e.target.value)}
                          className="px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-emerald-500"
                        >
                          <option value="all">All Categories</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.name}>{c.name}</option>
                          ))}
                        </select>
                      </div>

                      {/* Products Grid */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {products
                          .filter((p) => {
                            if (!p.isAvailable) return false;
                            if (customerPreviewCategory !== "all" && p.category !== customerPreviewCategory) return false;
                            if (customerPreviewSearch) {
                              const q = customerPreviewSearch.toLowerCase();
                              return (p.name || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q);
                            }
                            return true;
                          })
                          .map((prod) => {
                            const pricing = getProductPricing(prod);
                            const inCartQty = customerCart[prod.id] || 0;
                            const effectivePrice = pricing.hasActiveOffer ? pricing.finalPrice : pricing.originalPrice;

                            return (
                              <div
                                key={`preview-${prod.id}`}
                                className="bg-white rounded-xl border border-slate-200 p-3 flex flex-col justify-between shadow-2xs hover:shadow-xs transition-all relative overflow-hidden"
                              >
                                {pricing.hasActiveOffer && (
                                  <div className="absolute top-2 right-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow-xs uppercase tracking-wider flex items-center gap-1">
                                    <Flame size={10} />
                                    <span>{pricing.discountText}</span>
                                  </div>
                                )}

                                <div className="flex gap-2.5 mb-2.5">
                                  <div className="w-14 h-14 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center p-1 shrink-0 overflow-hidden">
                                    <img
                                      src={formatImageUrl(prod.imageUrl || prod.image || "")}
                                      alt={prod.name}
                                      loading="lazy"
                                      className="w-full h-full object-contain"
                                      onError={handleImgError}
                                    />
                                  </div>
                                  <div className="min-w-0 flex-1 pr-12">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block truncate">
                                      {prod.category} {prod.unit ? `• ${prod.unit}` : ""}
                                    </span>
                                    <h4 className="font-bold text-slate-900 text-xs truncate leading-snug">
                                      {prod.name}
                                    </h4>
                                    <div className="flex items-baseline gap-1.5 mt-1">
                                      <span className="font-black text-sm text-emerald-600">
                                        ₹{effectivePrice}
                                      </span>
                                      {pricing.hasActiveOffer && (
                                        <span className="text-[11px] font-semibold text-slate-400 line-through">
                                          ₹{pricing.originalPrice}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                                  <span className="text-[10px] font-semibold text-slate-500">
                                    {prod.unit ? `Per ${prod.unit}` : "Per item"}
                                  </span>
                                  {inCartQty === 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => handleUpdateCustomerCart(prod.id, 1)}
                                      className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow-xs active:scale-95"
                                    >
                                      + Add to Cart
                                    </button>
                                  ) : (
                                    <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg p-0.5">
                                      <button
                                        type="button"
                                        onClick={() => handleUpdateCustomerCart(prod.id, -1)}
                                        className="w-6 h-6 rounded bg-white hover:bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-xs cursor-pointer shadow-2xs"
                                      >
                                        <Minus size={12} />
                                      </button>
                                      <span className="text-xs font-black text-emerald-800 px-1">
                                        {inCartQty}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => handleUpdateCustomerCart(prod.id, 1)}
                                        className="w-6 h-6 rounded bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center font-bold text-xs cursor-pointer shadow-2xs"
                                      >
                                        <Plus size={12} />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* Right: Cart & Test Checkout Form (1 col) */}
                    <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                          <div className="flex items-center gap-1.5 font-bold text-sm text-slate-900">
                            <ShoppingCart size={16} className="text-emerald-600" />
                            <span>Customer Cart</span>
                          </div>
                          <span className="text-xs font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                            {Object.values(customerCart).reduce((a: number, b: number) => a + b, 0)} items
                          </span>
                        </div>

                        {/* Cart Items list */}
                        {Object.entries(customerCart).length === 0 ? (
                          <div className="py-8 text-center text-slate-400">
                            <ShoppingCart size={32} className="mx-auto mb-2 opacity-40" />
                            <p className="text-xs font-medium">Cart is currently empty.</p>
                            <p className="text-[11px] text-slate-400">Click "+ Add to Cart" on any product to test live pricing.</p>
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-48 overflow-y-auto pr-1 mb-4">
                            {Object.entries(customerCart).map(([prodId, qty]) => {
                              const p = products.find((prod) => prod.id === prodId);
                              if (!p) return null;
                              const pricing = getProductPricing(p);
                              const price = pricing.hasActiveOffer ? pricing.finalPrice : pricing.originalPrice;
                              const numQty = Number(qty) || 0;
                              const itemTotal = price * numQty;

                              return (
                                <div
                                  key={`cart-item-${prodId}`}
                                  className="flex items-center justify-between text-xs py-1.5 border-b border-slate-50"
                                >
                                  <div className="min-w-0 flex-1 pr-2">
                                    <p className="font-bold text-slate-800 truncate">{p.name}</p>
                                    <p className="text-[10px] text-slate-400">
                                      ₹{price} × {numQty} {p.unit || "pc"}
                                      {pricing.hasActiveOffer && (
                                        <span className="text-amber-600 font-bold ml-1">({pricing.discountText})</span>
                                      )}
                                    </p>
                                  </div>
                                  <span className="font-black text-slate-900">₹{itemTotal}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Checkout Form */}
                        <form onSubmit={handlePlaceCustomerTestOrder} className="space-y-2.5 pt-3 border-t border-slate-100">
                          <p className="text-[11px] font-black uppercase text-slate-400 tracking-wider">
                            Customer Checkout Details
                          </p>

                          <div>
                            <input
                              type="text"
                              required
                              placeholder="Customer Name"
                              value={customerCheckoutForm.name}
                              onChange={(e) => setCustomerCheckoutForm({ ...customerCheckoutForm, name: e.target.value })}
                              className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                            />
                          </div>

                          <div>
                            <input
                              type="tel"
                              required
                              placeholder="Customer Mobile (10 digits)"
                              value={customerCheckoutForm.phone}
                              onChange={(e) => setCustomerCheckoutForm({ ...customerCheckoutForm, phone: e.target.value })}
                              className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                            />
                          </div>

                          <div>
                            <input
                              type="text"
                              required
                              placeholder="Delivery Address"
                              value={customerCheckoutForm.address}
                              onChange={(e) => setCustomerCheckoutForm({ ...customerCheckoutForm, address: e.target.value })}
                              className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                            />
                          </div>

                          {/* Payment method selector: COD vs Razorpay */}
                          <div>
                            <label className="block text-[10px] font-bold text-slate-500 mb-1">Payment Method</label>
                            <div className="grid grid-cols-2 gap-1.5">
                              <button
                                type="button"
                                onClick={() => setCustomerCheckoutForm({ ...customerCheckoutForm, paymentMethod: "COD" })}
                                className={`py-1.5 px-2 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                                  customerCheckoutForm.paymentMethod === "COD"
                                    ? "bg-emerald-50 text-emerald-800 border-emerald-400 shadow-2xs"
                                    : "bg-white text-slate-600 border-slate-200"
                                }`}
                              >
                                💵 Cash on Delivery
                              </button>
                              <button
                                type="button"
                                onClick={() => setCustomerCheckoutForm({ ...customerCheckoutForm, paymentMethod: "Razorpay" })}
                                className={`py-1.5 px-2 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                                  customerCheckoutForm.paymentMethod === "Razorpay"
                                    ? "bg-indigo-50 text-indigo-800 border-indigo-400 shadow-2xs"
                                    : "bg-white text-slate-600 border-slate-200"
                                }`}
                              >
                                💳 Razorpay Online
                              </button>
                            </div>
                          </div>

                          {/* Total Breakdown */}
                          {(() => {
                            const subtotal = Object.entries(customerCart).reduce((acc: number, [prodId, qty]) => {
                              const p = products.find((prod) => prod.id === prodId);
                              if (!p) return acc;
                              const pricing = getProductPricing(p);
                              const price = pricing.hasActiveOffer ? pricing.finalPrice : pricing.originalPrice;
                              return acc + price * (Number(qty) || 0);
                            }, 0);
                            const delivery = subtotal === 0 ? 0 : subtotal >= 199 ? 0 : 25;
                            const total = subtotal + delivery;

                            return (
                              <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-xs space-y-1">
                                <div className="flex justify-between text-slate-500">
                                  <span>Subtotal:</span>
                                  <span>₹{subtotal}</span>
                                </div>
                                <div className="flex justify-between text-slate-500">
                                  <span>Delivery:</span>
                                  <span>{subtotal === 0 ? "₹0" : delivery === 0 ? "FREE" : "₹25"}</span>
                                </div>
                                <div className="flex justify-between font-black text-slate-900 pt-1 border-t border-slate-200 text-sm">
                                  <span>Order Total:</span>
                                  <span className="text-emerald-600">₹{total}</span>
                                </div>
                              </div>
                            );
                          })()}

                          <button
                            type="submit"
                            disabled={isPlacingCustomerOrder || Object.keys(customerCart).length === 0}
                            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer text-xs active:scale-95"
                          >
                            {isPlacingCustomerOrder ? (
                              <>
                                <RefreshCcw size={14} className="animate-spin" />
                                <span>Submitting to Firestore...</span>
                              </>
                            ) : (
                              <>
                                <Check size={14} />
                                <span>Place Real Customer Order</span>
                              </>
                            )}
                          </button>
                          <p className="text-[10px] text-center text-slate-400">
                            Submits directly to Firestore <code className="font-mono">/orders</code> and triggers admin alarm.
                          </p>
                        </form>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Realtime Prominent New Order Alarm Popup Modal */}
          <AnimatePresence>
            {newOrderAlert && (
              <motion.div
                initial={{ opacity: 0, scale: 0.85, y: -20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.85, y: -20 }}
                className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-black/65 backdrop-blur-md"
              >
                <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-6 sm:p-8 relative border-4 border-red-500 overflow-hidden max-h-[92vh] overflow-y-auto ring-8 ring-red-500/20">
                  {/* Flashing siren top emergency bar */}
                  <div className="absolute top-0 left-0 w-full h-3 bg-gradient-to-r from-red-600 via-amber-400 to-red-600 animate-pulse" />

                  <button
                    onClick={handleDismissAlert}
                    className="absolute top-4 right-4 p-2 hover:bg-slate-100 rounded-full transition-colors cursor-pointer text-slate-400 hover:text-slate-600"
                    title="Silence sound & close"
                  >
                    <X size={20} />
                  </button>

                  <div className="flex flex-col items-center text-center">
                    {/* Pulsing Alarm Siren Icon */}
                    <div className="relative mb-4 sm:mb-5">
                      <div className="w-18 h-18 sm:w-20 sm:h-20 bg-red-100 rounded-3xl flex items-center justify-center shadow-lg shadow-red-500/25 border-2 border-red-200 animate-bounce">
                        <BellRing className="text-red-600 w-9 h-9 sm:w-10 sm:h-10 animate-pulse" />
                      </div>
                      <span className="absolute -top-1 -right-1 flex h-4 w-4">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-4 w-4 bg-red-600"></span>
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 px-3 py-1 bg-red-50 rounded-full border border-red-200 text-red-700 text-xs font-black uppercase tracking-wider mb-2 animate-pulse">
                      <Volume2 size={14} className="animate-bounce" />
                      <span>{newOrderAlert.id.startsWith("TEST-") ? "TEST ALARM SIMULATION" : "LOUD ALARM SOUNDING"}</span>
                    </div>

                    <h3 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight mb-1">
                      🚨 NEW ORDER!
                    </h3>
                    <p className="text-slate-500 text-xs sm:text-sm mb-4">
                      {newOrderAlert.id.startsWith("TEST-")
                        ? "Test alarm received. No database order created."
                        : "A new customer order was just placed in Zypsomart!"}
                    </p>

                    {/* Order Information Card */}
                    <div className="w-full bg-slate-50 rounded-2xl p-4 sm:p-5 mb-5 border border-slate-200 text-left space-y-3">
                      <div className="flex justify-between items-center pb-2 border-b border-slate-200/80">
                        <span className="text-xs text-slate-400 font-extrabold uppercase tracking-wider">
                          Order ID
                        </span>
                        <span className="font-mono font-black text-slate-900 text-sm sm:text-base bg-white px-2.5 py-0.5 rounded-lg border border-slate-200">
                          #{newOrderAlert.id}
                        </span>
                      </div>

                      <div className="flex justify-between items-center pb-2 border-b border-slate-200/80">
                        <span className="text-xs text-slate-400 font-extrabold uppercase tracking-wider">
                          Customer
                        </span>
                        <span className="font-bold text-slate-900 text-sm sm:text-base truncate max-w-[200px]">
                          {newOrderAlert.customerName || "Customer"}
                        </span>
                      </div>

                      {newOrderAlert.customerPhone && (
                        <div className="flex justify-between items-center pb-2 border-b border-slate-200/80 text-xs">
                          <span className="text-slate-400 font-extrabold uppercase tracking-wider">
                            Phone
                          </span>
                          <span className="font-semibold text-slate-700">
                            {newOrderAlert.customerPhone}
                          </span>
                        </div>
                      )}

                      <div className="flex justify-between items-center pt-1">
                        <span className="text-xs text-slate-400 font-extrabold uppercase tracking-wider">
                          Total Amount
                        </span>
                        <span className="text-2xl sm:text-3xl font-black text-emerald-600 font-sans">
                          ₹{Number(newOrderAlert.total || 0).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Action Buttons: VIEW ORDER & ACCEPT ORDER */}
                    <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3 mb-3">
                      <button
                        onClick={() => handleViewFromAlert(newOrderAlert.id)}
                        className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-black py-3.5 px-4 rounded-2xl transition-all shadow-sm active:scale-95 cursor-pointer flex items-center justify-center gap-2 text-xs sm:text-sm uppercase tracking-wide border border-slate-200 min-h-[50px]"
                      >
                        <Search size={16} />
                        <span>View Order</span>
                      </button>

                      <button
                        onClick={() => handleAcceptFromAlert(newOrderAlert.id)}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-3.5 px-4 rounded-2xl shadow-lg shadow-emerald-600/25 transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-2 text-xs sm:text-sm uppercase tracking-wide min-h-[50px]"
                      >
                        <CircleCheckBig size={16} />
                        <span>Accept Order</span>
                      </button>
                    </div>

                    {/* Silence Sound Button */}
                    <button
                      onClick={handleDismissAlert}
                      className="text-xs font-bold text-slate-400 hover:text-slate-600 py-1 transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      <VolumeX size={14} />
                      <span>Silence Alarm & Dismiss</span>
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Feature 1: Delete Order Confirmation Modal */}
          <AnimatePresence>
            {orderToDelete && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
              >
                <motion.div
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  className="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-6 text-center border border-slate-100"
                >
                  <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center text-red-600 mx-auto mb-4 shadow-sm">
                    <Trash2 size={26} />
                  </div>

                  <h3 className="text-lg font-black text-slate-900 tracking-tight mb-1">
                    Delete this order permanently?
                  </h3>
                  <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                    This will permanently remove order{" "}
                    <span className="font-mono font-bold text-slate-800">
                      #{orderToDelete.id.slice(-6).toUpperCase()}
                    </span>{" "}
                    ({orderToDelete.customerName} • ₹{(orderToDelete.total || 0).toLocaleString()}) from Firestore.
                    <br />
                    <span className="text-red-600 font-semibold">This action cannot be undone.</span>
                  </p>

                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      disabled={isDeletingOrder}
                      onClick={() => setOrderToDelete(null)}
                      className="py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isDeletingOrder}
                      onClick={handleConfirmDeleteOrder}
                      className="py-2.5 px-4 bg-red-600 hover:bg-red-700 text-white font-black text-xs rounded-xl shadow-md shadow-red-600/30 transition-all cursor-pointer flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50"
                    >
                      {isDeletingOrder ? (
                        <>
                          <RefreshCcw size={14} className="animate-spin" />
                          <span>Deleting...</span>
                        </>
                      ) : (
                        <>
                          <Trash2 size={14} />
                          <span>Delete</span>
                        </>
                      )}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Official Tax Invoice Modal (View, Download, Print) */}
          <AnimatePresence>
            {selectedOrderForInvoice && (
              <InvoiceModal
                order={selectedOrderForInvoice}
                onClose={() => setSelectedOrderForInvoice(null)}
                onNotify={showNotification}
              />
            )}
          </AnimatePresence>

          {/* Admin Alarm & Notification Settings Modal */}
          <AnimatePresence>
            {showAlarmSettingsModal && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm"
              >
                <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-6 sm:p-8 relative max-h-[92vh] overflow-y-auto border border-slate-100">
                  <button
                    onClick={() => {
                      setShowAlarmSettingsModal(false);
                      setPushStatusMessage("");
                    }}
                    className="absolute top-4 right-4 p-2 hover:bg-slate-100 rounded-full transition-colors cursor-pointer text-slate-400 hover:text-slate-600"
                  >
                    <X size={20} />
                  </button>

                  <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
                    <div className="w-12 h-12 bg-emerald-100 rounded-2xl flex items-center justify-center text-emerald-700 shadow-sm">
                      <BellRing size={24} />
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-slate-900 tracking-tight leading-tight">
                        Order Alarm Settings
                      </h3>
                      <p className="text-xs text-slate-500">Loud emergency alerts & FCM push notifications</p>
                    </div>
                  </div>

                  <div className="space-y-4 sm:space-y-5">
                    {/* 1. Toggle: Enable/Disable Alarm */}
                    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80 flex items-center justify-between">
                      <div className="pr-4">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-black text-slate-800">
                            🔔 New Order Alerts
                          </span>
                          <span
                            className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${
                              isAlarmEnabled
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-slate-200 text-slate-600"
                            }`}
                          >
                            {isAlarmEnabled ? "Enabled" : "Disabled"}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed">
                          Play loud repeating siren sound & show emergency modal when new orders arrive.
                        </p>
                      </div>

                      <button
                        onClick={() => handleToggleAlarm(!isAlarmEnabled)}
                        className={`w-14 h-8 flex items-center rounded-full p-1 cursor-pointer transition-colors shrink-0 ${
                          isAlarmEnabled ? "bg-emerald-600 justify-end" : "bg-slate-300 justify-start"
                        }`}
                      >
                        <motion.div
                          layout
                          className="bg-white w-6 h-6 rounded-full shadow-md"
                        />
                      </button>
                    </div>

                    {/* 2. Test Alarm Button */}
                    <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-4 border border-amber-200/80 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
                          <Volume2 size={16} className="text-amber-600" />
                          <span>Sound & Popup Verification</span>
                        </span>
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-100/80 px-2 py-0.5 rounded-md">
                          Safe • No fake orders
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        Test the exact loud repeating alarm siren, vibration, and popup on this device.
                      </p>
                      <button
                        onClick={handleTriggerTestAlarm}
                        className="w-full bg-amber-500 hover:bg-amber-600 text-white font-black py-3 px-4 rounded-xl shadow-md shadow-amber-500/20 transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-2 text-xs uppercase tracking-wide"
                      >
                        <Volume2 size={16} />
                        <span>🔊 Test Alarm Now</span>
                      </button>
                    </div>

                    {/* 3. Browser Push Notifications & FCM */}
                    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                          <Smartphone size={16} className="text-slate-600" />
                          <span>Push Notifications (Background)</span>
                        </span>
                        <span
                          className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                            notificationPermissionState === "granted"
                              ? "bg-emerald-100 text-emerald-800"
                              : notificationPermissionState === "denied"
                              ? "bg-red-100 text-red-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {notificationPermissionState === "granted"
                            ? "Granted"
                            : notificationPermissionState === "denied"
                            ? "Blocked"
                            : "Permission Needed"}
                        </span>
                      </div>

                      <p className="text-xs text-slate-500 leading-relaxed">
                        Allows mobile phones & laptops to receive high-priority alerts even when the app is in background or closed.
                      </p>

                      {notificationPermissionState !== "granted" ? (
                        <button
                          disabled={isRegisteringPush}
                          onClick={handleEnablePushNotifications}
                          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-2.5 px-4 rounded-xl shadow-sm transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-2 text-xs uppercase tracking-wide"
                        >
                          {isRegisteringPush ? (
                            <RefreshCcw size={14} className="animate-spin" />
                          ) : (
                            <Bell size={14} />
                          )}
                          <span>Enable Notifications On This Device</span>
                        </button>
                      ) : (
                        <div className="flex items-center justify-between bg-emerald-50 text-emerald-800 p-2.5 rounded-xl border border-emerald-200 text-xs font-semibold">
                          <span className="flex items-center gap-1.5">
                            <CheckCircle2 size={15} className="text-emerald-600 shrink-0" />
                            <span className="truncate">This device is registered for push alerts</span>
                          </span>
                          <button
                            onClick={handleEnablePushNotifications}
                            className="text-[10px] underline font-bold hover:text-emerald-950 cursor-pointer shrink-0"
                          >
                            Re-sync
                          </button>
                        </div>
                      )}

                      {pushStatusMessage && (
                        <p className="text-xs font-semibold text-emerald-700 bg-emerald-50/70 p-2 rounded-lg border border-emerald-100">
                          {pushStatusMessage}
                        </p>
                      )}
                    </div>

                    {/* 3b. Dedicated FCM Test Push (Closed App & Realtime Verification) */}
                    <div className="bg-sky-50 rounded-2xl p-4 border border-sky-200/80 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black uppercase tracking-wider text-sky-900 flex items-center gap-1.5">
                          <Radio size={16} className="text-sky-600" />
                          <span>FCM Closed-App Push Test</span>
                        </span>
                        <span className="text-[10px] font-bold text-sky-700 bg-sky-100/90 px-2 py-0.5 rounded-md">
                          FCM HTTP v1 • Zero Fake Orders
                        </span>
                      </div>

                      <p className="text-xs text-slate-600 leading-relaxed">
                        Sends the test push notification to this device:
                        <br />
                        <span className="font-semibold text-slate-800">Title:</span> 🚨 Zypsomart Test Notification
                        <br />
                        <span className="font-semibold text-slate-800">Body:</span> FCM is working correctly.
                      </p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                        <button
                          disabled={isSendingTestPush}
                          onClick={() => handleSendTestPush(0)}
                          className="w-full bg-sky-600 hover:bg-sky-700 text-white font-black py-2.5 px-3 rounded-xl shadow-xs transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 text-xs uppercase tracking-wide disabled:opacity-50"
                        >
                          {isSendingTestPush && testNotificationCountdown === null ? (
                            <RefreshCcw size={14} className="animate-spin" />
                          ) : (
                            <Bell size={14} />
                          )}
                          <span>⚡ Test Instant</span>
                        </button>

                        <button
                          disabled={isSendingTestPush}
                          onClick={() => handleSendTestPush(5)}
                          className="w-full bg-slate-800 hover:bg-slate-900 text-white font-black py-2.5 px-3 rounded-xl shadow-xs transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 text-xs uppercase tracking-wide disabled:opacity-50"
                        >
                          {testNotificationCountdown !== null ? (
                            <span className="animate-pulse text-amber-300 font-bold">
                              ⏳ Close App! ({testNotificationCountdown}s)
                            </span>
                          ) : (
                            <>
                              <Clock size={14} />
                              <span>⏱️ Test Closed (5s)</span>
                            </>
                          )}
                        </button>
                      </div>

                      {testNotificationCountdown !== null && (
                        <div className="p-3 bg-amber-100 border border-amber-300 rounded-xl text-amber-900 text-xs font-semibold animate-pulse text-center">
                          🚀 Scheduled! Minimize or swipe away the app and lock your phone now! Arriving in {testNotificationCountdown} seconds...
                        </div>
                      )}

                      {testPushResult && (
                        <div
                          className={`p-2.5 rounded-xl text-xs font-semibold border ${
                            testPushResult.success
                              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                              : "bg-red-50 text-red-800 border-red-200"
                          }`}
                        >
                          {testPushResult.message}
                        </div>
                      )}
                    </div>

                    {/* 4. Audio Engine Test */}
                    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80 flex items-center justify-between">
                      <div>
                        <span className="text-xs font-bold text-slate-800 block">
                          Speaker Autoplay Test
                        </span>
                        <span className="text-[11px] text-slate-500">
                          Verify speaker audio output and unlock audio context
                        </span>
                      </div>
                      <button
                        onClick={handleTestSirenAudio}
                        disabled={isTestingSirenAudio}
                        className="px-3 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-black rounded-xl transition-all cursor-pointer shrink-0"
                      >
                        {isTestingSirenAudio ? "Playing (2s)..." : "🔊 Audio Test"}
                      </button>
                    </div>

                    {/* Registered Devices Count */}
                    <div className="text-center pt-1 pb-1">
                      <p className="text-[11px] font-bold text-slate-400">
                        {alarmDevicesCount !== null
                          ? `Registered admin devices: ${alarmDevicesCount}`
                          : "Connecting to notification backend..."}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Loading Indicator */}
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500" />
            </div>
          ) : activeTab === "orders" ? (
            /* TAB 1: ORDERS DASHBOARD */
            <div className="space-y-6 pb-24">
              {/* Feature 2: Shop Closed Alert Banner */}
              {!isShopOpen && (
                <div className="bg-gradient-to-r from-red-600 via-rose-600 to-red-700 rounded-2xl p-4 sm:p-5 text-white shadow-lg shadow-red-600/25 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-red-500/50 animate-pulse">
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 bg-white/20 backdrop-blur-xs rounded-2xl flex items-center justify-center text-2xl shrink-0 shadow-inner">
                      🔴
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-black text-base tracking-tight leading-tight">
                          SHOP IS CURRENTLY CLOSED
                        </h4>
                        <span className="text-[10px] font-black uppercase px-2 py-0.5 bg-white text-red-700 rounded-full">
                          Store Inactive
                        </span>
                      </div>
                      <p className="text-xs text-white/90 mt-0.5">
                        Customer App displays "🔴 SHOP CLOSED". Customers cannot place new orders until you reopen the shop.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleUpdateShopStatus(true)}
                      disabled={isUpdatingShopStatus}
                      className="px-4 py-2 bg-white text-emerald-800 hover:bg-emerald-50 font-black text-xs rounded-xl shadow-xs transition-all cursor-pointer flex items-center gap-1.5"
                    >
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span>Switch to SHOP OPEN</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Unacknowledged New Orders Alert Banner */}
              {unacknowledgedOrders.length > 0 && (
                <div className="bg-gradient-to-r from-red-600 via-rose-600 to-amber-600 rounded-2xl p-4 sm:p-5 text-white shadow-lg shadow-red-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-red-400/30">
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 bg-white/20 backdrop-blur-xs rounded-2xl flex items-center justify-center text-2xl shrink-0 shadow-inner">
                      🚨
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-black text-base tracking-tight leading-tight">
                          {unacknowledgedOrders.length} New Order{unacknowledgedOrders.length === 1 ? "" : "s"} Received
                        </h4>
                        <span className="text-[10px] font-black uppercase px-2 py-0.5 bg-white text-red-700 rounded-full animate-pulse">
                          Unacknowledged
                        </span>
                      </div>
                      <p className="text-xs text-white/90 mt-0.5">
                        New orders detected while app was closed or in background. Review and acknowledge to stop pending status.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        setStatusFilter("pending");
                        handleSetSearch("");
                      }}
                      className="px-4 py-2 bg-white text-red-700 hover:bg-slate-100 font-black text-xs rounded-xl shadow-xs transition-all cursor-pointer"
                    >
                      View Pending ({unacknowledgedOrders.length})
                    </button>
                    <button
                      onClick={handleAcknowledgeAll}
                      className="px-3.5 py-2 bg-black/25 hover:bg-black/35 text-white font-bold text-xs rounded-xl transition-all cursor-pointer border border-white/20"
                    >
                      Acknowledge All
                    </button>
                  </div>
                </div>
              )}

              {/* Stat Cards - 3 Main Summary Statistics */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 sm:gap-4 lg:gap-5">
                {/* CARD 1 — RECENT ORDERS */}
                <div className="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200/90 shadow-xs flex items-center justify-between hover:shadow-md transition-all duration-200 group min-h-[105px]">
                  <div className="min-w-0 pr-3">
                    <p className="text-[11px] sm:text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-1 truncate">
                      RECENT ORDERS (12H)
                    </p>
                    <h4 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight leading-none">
                      {stats.recentOrders}
                    </h4>
                    <p className="text-[11px] text-slate-400 font-medium mt-1.5 truncate">
                      Excludes cancelled orders
                    </p>
                  </div>
                  <div className="w-12 h-12 sm:w-13 sm:h-13 bg-sky-50 rounded-2xl flex items-center justify-center text-sky-600 shrink-0 border border-sky-100/80 shadow-xs transition-transform duration-200 group-hover:scale-105">
                    <ShoppingCart size={22} className="stroke-[2.5]" />
                  </div>
                </div>

                {/* CARD 2 — TOTAL PRODUCTS */}
                <div className="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200/90 shadow-xs flex items-center justify-between hover:shadow-md transition-all duration-200 group min-h-[105px]">
                  <div className="min-w-0 pr-3">
                    <p className="text-[11px] sm:text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-1 truncate">
                      TOTAL PRODUCTS
                    </p>
                    <h4 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight leading-none">
                      {stats.totalProducts}
                    </h4>
                    <p className="text-[11px] text-slate-400 font-medium mt-1.5 truncate">
                      Active catalog inventory
                    </p>
                  </div>
                  <div className="w-12 h-12 sm:w-13 sm:h-13 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600 shrink-0 border border-amber-100/80 shadow-xs transition-transform duration-200 group-hover:scale-105">
                    <Package size={22} className="stroke-[2.5]" />
                  </div>
                </div>

                {/* CARD 3 — REVENUE (12H) */}
                <div className="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200/90 shadow-xs flex items-center justify-between hover:shadow-md transition-all duration-200 group min-h-[105px]">
                  <div className="min-w-0 pr-3">
                    <p className="text-[11px] sm:text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-1 truncate">
                      REVENUE (12H)
                    </p>
                    <h4 className="text-2xl sm:text-3xl font-black text-emerald-600 tracking-tight leading-none">
                      ₹{stats.revenue.toLocaleString('en-IN')}
                    </h4>
                    <p className="text-[11px] text-slate-400 font-medium mt-1.5 truncate">
                      Excludes cancelled orders
                    </p>
                  </div>
                  <div className="w-12 h-12 sm:w-13 sm:h-13 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600 shrink-0 border border-emerald-100/80 shadow-xs transition-transform duration-200 group-hover:scale-105">
                    <IndianRupee size={22} className="stroke-[2.5]" />
                  </div>
                </div>
              </div>

              {/* Order Status Filters & Actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-b border-slate-100 pb-4">
                <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
                  <h3 className="font-black text-slate-800 text-lg flex items-center gap-2">
                    <span>Recent Activity Orders</span>
                    <span className="text-xs font-extrabold bg-slate-200 text-slate-700 px-2.5 py-0.5 rounded-full">
                      {filteredOrders.length} Total
                    </span>
                  </h3>

                  {/* Proper Invoice Option replacing old CV button */}
                  <button
                    onClick={() => {
                      if (filteredOrders.length > 0) {
                        setSelectedOrderForInvoice(filteredOrders[0]);
                      } else {
                        showNotification("error", "No orders available to generate an invoice.");
                      }
                    }}
                    disabled={filteredOrders.length === 0}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 disabled:bg-slate-100 text-indigo-700 disabled:text-slate-400 font-bold text-xs rounded-xl border border-indigo-200 disabled:border-slate-200 shadow-2xs transition-all cursor-pointer disabled:cursor-not-allowed shrink-0 active:scale-95"
                    title="View, Print & Download Official Tax Invoice"
                  >
                    <FileText size={13} className="stroke-[2.5]" />
                    <span>Invoice ({filteredOrders.length})</span>
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                  {[
                    { key: "all", label: "All Orders" },
                    { key: "pending", label: "1. Pending (New)" },
                    { key: "accepted", label: "2. Accepted" },
                    { key: "packaging", label: "3. Packaging 📦" },
                    { key: "on_the_way", label: "4. On the Way 🚚" },
                    { key: "delivered", label: "Completed Orders ✅" },
                    { key: "cancelled", label: "Cancelled" },
                    { key: "returns", label: "Returns 🔄" }
                  ].map(({ key, label }) => {
                    const count =
                      key === "all"
                        ? orders.length
                        : key === "returns"
                        ? orders.filter(isReturnOrder).length
                        : orders.filter(
                            (ord) =>
                              !isReturnOrder(ord) &&
                              (ord.status || "pending").toLowerCase() === key
                          ).length;

                    return (
                      <button
                        key={key}
                        onClick={() => setStatusFilter(key)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                          statusFilter === key
                            ? "bg-emerald-600 text-white shadow-sm shadow-emerald-200"
                            : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <span>{label}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full font-extrabold ${
                            statusFilter === key
                              ? "bg-white/20 text-white"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Dedicated Completed Orders Section Banner when filter is delivered */}
              {statusFilter === "delivered" && (
                <div className="bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-emerald-500/5 border border-emerald-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
                  <div className="flex items-center gap-3.5">
                    <div className="w-11 h-11 rounded-2xl bg-emerald-600 text-white flex items-center justify-center font-black shadow-md shadow-emerald-600/20 shrink-0">
                      <CheckCheck size={22} className="stroke-[2.5]" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-base font-black text-slate-900 tracking-tight">
                          Completed Orders Section
                        </h4>
                        <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full border border-emerald-200">
                          {filteredOrders.length} Delivered
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 font-medium">
                        All successfully fulfilled & delivered customer orders. Total revenue collected: <span className="font-bold text-emerald-700">₹{filteredOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0).toLocaleString()}</span>
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setStatusFilter("all")}
                    className="self-start sm:self-auto text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-white px-3 py-1.5 rounded-xl border border-emerald-200 shadow-2xs hover:bg-emerald-50 transition-colors cursor-pointer"
                  >
                    View All Orders &rarr;
                  </button>
                </div>
              )}

              {/* Order List */}
              {filteredOrders.length === 0 ? (
                <div className="bg-white rounded-2xl p-12 text-center border border-dashed border-slate-300">
                  <ShoppingCart className="mx-auto text-slate-300 mb-4" size={48} />
                  <h3 className="text-lg font-semibold text-slate-900">No Orders Found</h3>
                  <p className="text-slate-500">
                    {searchQuery
                      ? "No orders match your search criteria."
                      : "New orders will appear here automatically."}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  {filteredOrders.map((order) => {
                    const isReturn = isReturnOrder(order);
                    const isRecent = isOrderRecent(order) && !isReturn;
                    const currentStatus = (order.status || "pending").toLowerCase();
                    const isPending = currentStatus === "pending" && !isReturn;
                    const isUpdating = updatingOrders[order.id];

                    // Check if return can be approved
                    const canApproveReturn =
                      isReturn &&
                      (currentStatus === "return_requested" ||
                        currentStatus === "return_request" ||
                        currentStatus === "returned" ||
                        currentStatus === "return" ||
                        order.returnStatus === "requested" ||
                        currentStatus !== "return_approved");

                    const isReturnApproved = currentStatus === "return_approved";
                    const isReturnRejected = currentStatus === "return_rejected";

                    return (
                      <motion.div
                        key={order.id}
                        id={`order-card-${order.id}`}
                        layout
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`bg-white rounded-2xl shadow-sm border overflow-hidden hover:shadow-md transition-all duration-300 ${
                          isReturn
                            ? isReturnApproved
                              ? "border-emerald-300 ring-2 ring-emerald-50 bg-emerald-50/5"
                              : isReturnRejected
                              ? "border-slate-300 bg-slate-50/5"
                              : "border-orange-400 ring-4 ring-orange-100/30 bg-orange-50/5"
                            : isPending
                            ? "border-amber-400 ring-4 ring-amber-100/30 bg-amber-50/5"
                            : isRecent
                            ? "border-emerald-300 ring-2 ring-emerald-50 bg-emerald-50/5"
                            : "border-slate-200"
                        }`}
                      >
                        <div className="p-5">
                          {/* Order Card Header */}
                          <div className="flex justify-between items-start mb-3 pb-3 border-b border-slate-100">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-mono font-black text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md uppercase">
                                  #{order.id.slice(-6).toUpperCase()}
                                </span>

                                {!isReturn && !isPending && isRecent && (
                                  <span className="bg-emerald-500 text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0">
                                    RECENT
                                  </span>
                                )}
                              </div>

                              <p className="text-[11px] text-slate-400 font-medium">
                                {formatDate(order.createdAt)}
                              </p>
                            </div>

                            {/* Badge & Delete Button */}
                            <div className="flex items-center gap-2 shrink-0">
                              <span
                                className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider shadow-xs ${
                                  currentStatus === "accepted"
                                    ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                                    : currentStatus === "packaging"
                                    ? "bg-amber-100 text-amber-800 border border-amber-300"
                                    : currentStatus === "on_the_way"
                                    ? "bg-blue-100 text-blue-800 border border-blue-300"
                                    : currentStatus === "delivered"
                                    ? "bg-emerald-100 text-emerald-800 border border-emerald-300 ring-2 ring-emerald-200"
                                    : currentStatus === "cancelled"
                                    ? "bg-red-100 text-red-800 border border-red-200/50"
                                    : isReturn
                                    ? isReturnApproved
                                      ? "bg-emerald-100 text-emerald-800 border border-emerald-200/50"
                                      : isReturnRejected
                                      ? "bg-slate-200 text-slate-800 border border-slate-300"
                                      : "bg-orange-100 text-orange-800 border border-orange-200/50"
                                    : "bg-amber-100 text-amber-800 border border-amber-200/50"
                                }`}
                              >
                                {isReturn
                                  ? isReturnApproved
                                    ? "RETURN APPROVED"
                                    : isReturnRejected
                                    ? "RETURN REJECTED"
                                    : "RETURN REQUEST"
                                  : currentStatus === "packaging"
                                  ? "PACKAGING 📦"
                                  : currentStatus === "on_the_way"
                                  ? "ON THE WAY 🚚"
                                  : currentStatus === "delivered"
                                  ? "COMPLETED & DELIVERED ✅"
                                  : currentStatus === "accepted"
                                  ? "ORDER ACCEPTED"
                                  : "PENDING (NEW)"}
                              </span>

                              {/* Invoice Option: View, Download & Print */}
                              <button
                                onClick={() => setSelectedOrderForInvoice(order)}
                                className="flex items-center gap-1 px-2.5 py-1 text-indigo-700 hover:text-white bg-indigo-50 hover:bg-indigo-600 rounded-lg transition-all cursor-pointer shrink-0 text-[11px] font-black border border-indigo-200 hover:border-indigo-600 shadow-2xs active:scale-95"
                                title="View, Print & Download Official Tax Invoice"
                              >
                                <FileText size={13} className="shrink-0 stroke-[2.5]" />
                                <span>Invoice</span>
                              </button>

                              {/* Delete Order Button */}
                              <button
                                onClick={() => setOrderToDelete(order)}
                                className="flex items-center gap-1 px-2.5 py-1 text-red-600 hover:text-white bg-red-50 hover:bg-red-600 rounded-lg transition-all cursor-pointer shrink-0 text-[11px] font-black border border-red-200 hover:border-red-600 shadow-2xs active:scale-95"
                                title="Delete this order permanently"
                              >
                                <Trash2 size={13} className="shrink-0 stroke-[2.5]" />
                                <span>Delete</span>
                              </button>
                            </div>
                          </div>

                          {/* Customer Information */}
                          <div className="space-y-1 mb-4">
                            <h4 className="font-bold text-slate-900 text-base">
                              {order.customerName}
                            </h4>
                            <div className="flex gap-2 text-xs">
                              <span className="text-slate-400 font-medium shrink-0">Phone:</span>
                              <a
                                href={`tel:${order.customerPhone}`}
                                className="text-emerald-600 hover:underline font-extrabold"
                              >
                                {order.customerPhone}
                              </a>
                            </div>
                            <div className="flex gap-2 text-xs">
                              <span className="text-slate-400 font-medium shrink-0">Address:</span>
                              <span className="text-slate-600 leading-normal">
                                {order.customerAddress}
                              </span>
                            </div>
                            <div className="flex gap-2 text-xs">
                              <span className="text-slate-400 font-medium shrink-0">Payment:</span>
                              <span className="font-bold text-slate-700">
                                {order.paymentMethod}
                              </span>
                            </div>

                            {(order.notes || order.customerNotes) && (
                              <div className="mt-2 text-xs bg-amber-50 px-2.5 py-2 rounded-xl border border-amber-200/60 text-amber-800 flex flex-col gap-0.5 shadow-sm">
                                <span className="font-extrabold text-[9px] uppercase tracking-wider text-amber-600/90">
                                  Customer Notes / Instructions:
                                </span>
                                <span className="leading-snug text-slate-700">
                                  {order.notes || order.customerNotes}
                                </span>
                              </div>
                            )}

                            {order.returnNotes && (
                              <div className="mt-2 text-xs bg-orange-50 px-2.5 py-2 rounded-xl border border-orange-200/60 text-orange-800 flex flex-col gap-0.5 shadow-sm">
                                <span className="font-extrabold text-[9px] uppercase tracking-wider text-orange-600/90">
                                  Return Reason / Resolution Notes:
                                </span>
                                <span className="leading-snug text-slate-700">
                                  {order.returnNotes}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Items Breakdown */}
                          <div className="bg-slate-50 rounded-xl p-3 border border-slate-100/80 mb-4">
                            <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest mb-2">
                              Order Items ({order.items?.length || 0})
                            </p>
                            <ul className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                              {order.items?.map((item, idx) => (
                                <li
                                  key={idx}
                                  className="flex justify-between items-center text-xs"
                                >
                                  <span className="text-slate-700 font-medium">
                                    {item.name}{" "}
                                    <span className="text-slate-400 font-bold">x{item.qty}</span>
                                  </span>
                                  <span className="font-bold text-slate-900">
                                    ₹{(item.price * item.qty).toLocaleString()}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            <div className="border-t border-slate-200/80 mt-2.5 pt-2.5 flex justify-between items-center text-sm">
                              <span className="font-bold text-slate-800">Total Bill</span>
                              <span className="text-lg font-black text-emerald-600 font-sans">
                                ₹{(order.total || 0).toLocaleString()}
                              </span>
                            </div>
                          </div>

                          {/* Order Status Stepper (Order Placed -> Accepted -> Packaging -> On the Way -> Delivered) */}
                          {!isReturn && currentStatus !== "cancelled" && (
                            <div className="bg-slate-50/90 rounded-xl p-2.5 sm:p-3 border border-slate-100 mb-3 overflow-x-auto scrollbar-none">
                              <div className="flex items-center justify-between relative px-2 min-w-[270px]">
                                <div className="absolute top-3 left-6 right-6 h-1 -translate-y-1/2 bg-slate-200 -z-0 rounded-full" />
                                <div
                                  className="absolute top-3 left-6 h-1 -translate-y-1/2 bg-emerald-500 transition-all duration-500 -z-0 rounded-full"
                                  style={{
                                    width:
                                      currentStatus === "pending"
                                        ? "0%"
                                        : currentStatus === "accepted"
                                        ? "33%"
                                        : currentStatus === "packaging"
                                        ? "66%"
                                        : currentStatus === "on_the_way" || currentStatus === "delivered"
                                        ? "calc(100% - 3rem)"
                                        : "0%"
                                  }}
                                />

                                {[
                                  { key: "pending", label: "Placed", num: "1" },
                                  { key: "accepted", label: "Accepted", num: "2" },
                                  { key: "packaging", label: "Packaging", num: "3" },
                                  { key: "on_the_way", label: "On the Way", num: "4" },
                                  { key: "delivered", label: "Delivered", num: "5" }
                                ].map((step, idx) => {
                                  const stepOrder = ["pending", "accepted", "packaging", "on_the_way", "delivered"];
                                  const currentIdx = stepOrder.indexOf(currentStatus);
                                  const isStepDone = currentIdx > idx || (currentStatus === "delivered" && idx === 4);
                                  const isStepActive = currentIdx === idx && currentStatus !== "delivered";

                                  return (
                                    <div key={step.key} className="flex flex-col items-center relative z-10 shrink-0">
                                      <div
                                        className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black transition-all ${
                                          isStepDone
                                            ? "bg-emerald-600 text-white shadow-xs"
                                            : isStepActive
                                            ? "bg-emerald-600 text-white ring-4 ring-emerald-100 scale-110 font-bold"
                                            : "bg-slate-200 text-slate-500"
                                        }`}
                                      >
                                        {isStepDone ? <Check size={11} strokeWidth={3} /> : step.num}
                                      </div>
                                      <span
                                        className={`text-[8.5px] sm:text-[9px] mt-1 font-bold whitespace-nowrap ${
                                          isStepActive
                                            ? "text-emerald-700 font-extrabold"
                                            : isStepDone
                                            ? "text-slate-700"
                                            : "text-slate-400"
                                        }`}
                                      >
                                        {step.label}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Action Buttons: Dynamic Next Sequential Status Button */}
                          <div className="mt-2 pt-2.5 border-t border-slate-100 relative">
                            {isUpdating && (
                              <div className="absolute inset-0 bg-white/85 backdrop-blur-[1px] flex items-center justify-center z-20 rounded-xl">
                                <RefreshCcw size={16} className="animate-spin text-emerald-600 mr-2" />
                                <span className="text-xs font-bold text-slate-700">Updating status in Firestore...</span>
                              </div>
                            )}

                            {isReturn ? (
                              /* Return Order Buttons */
                              <div className="grid grid-cols-3 gap-2">
                                <button
                                  disabled={isUpdating || isReturnApproved}
                                  onClick={() =>
                                    handleUpdateOrderStatus(
                                      order.id,
                                      "return_approved",
                                      "Return Request Approved Successfully"
                                    )
                                  }
                                  className={`col-span-2 flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl font-bold text-xs uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    isReturnApproved
                                      ? "bg-emerald-100 text-emerald-800 border border-emerald-200/50 cursor-not-allowed opacity-60"
                                      : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-md active:scale-[0.98]"
                                  }`}
                                >
                                  <CircleCheckBig size={15} className="shrink-0" />
                                  <span className="truncate">
                                    {isReturnApproved ? "Return Approved" : "Approve Return"}
                                  </span>
                                </button>

                                <button
                                  disabled={isUpdating || isReturnRejected}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        "Are you sure you want to reject this return request?"
                                      )
                                    ) {
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "return_rejected",
                                        "Return Request Rejected Successfully"
                                      );
                                    }
                                  }}
                                  className={`col-span-1 flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl font-bold text-xs uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    isReturnRejected
                                      ? "bg-red-100 text-red-800 border border-red-200/50 cursor-not-allowed opacity-60"
                                      : "bg-red-600 hover:bg-red-700 text-white shadow-md active:scale-[0.98]"
                                  }`}
                                >
                                  <CircleX size={15} className="shrink-0" />
                                  <span className="truncate">{isReturnRejected ? "Rejected" : "Reject"}</span>
                                </button>
                              </div>
                            ) : currentStatus === "delivered" ? (
                              /* Completed & Delivered Order Card Banner */
                              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center justify-between">
                                <div className="flex items-center gap-2.5 text-emerald-800">
                                  <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                                    <CheckCheck size={18} className="stroke-[2.5]" />
                                  </div>
                                  <div>
                                    <p className="text-xs font-black uppercase tracking-wide text-emerald-900">
                                      Order Completed & Delivered
                                    </p>
                                    <p className="text-[11px] text-emerald-700 font-medium">
                                      {order.deliveredAt ? `Delivered on ${formatDate(order.deliveredAt)}` : "Moved to Completed Orders section"}
                                    </p>
                                  </div>
                                </div>
                                <span className="text-[10px] font-black uppercase px-2.5 py-1 bg-emerald-200/90 text-emerald-950 rounded-lg shadow-2xs">
                                  Completed ✅
                                </span>
                              </div>
                            ) : currentStatus === "cancelled" ? (
                              /* Cancelled Order Banner */
                              <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center justify-between text-red-800">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-8 h-8 rounded-lg bg-red-600 text-white flex items-center justify-center shrink-0">
                                    <CircleX size={18} />
                                  </div>
                                  <div>
                                    <p className="text-xs font-black uppercase tracking-wide text-red-900">
                                      Order Cancelled
                                    </p>
                                    <p className="text-[11px] text-red-700 font-medium">
                                      {order.cancelledAt ? `Cancelled on ${formatDate(order.cancelledAt)}` : "Order was cancelled / rejected"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              /* Dynamic Sequential Next Status Button Flow */
                              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                                {/* Next Sequential Button: 1. Accept Order */}
                                {currentStatus === "pending" && (
                                  <button
                                    disabled={isUpdating}
                                    onClick={() =>
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "accepted",
                                        "Order Accepted Successfully"
                                      )
                                    }
                                    className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-black text-xs uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-600/20 active:scale-[0.98] transition-all cursor-pointer min-h-[44px]"
                                    title="Click to accept this new order (moves to step 2: Packaging)"
                                  >
                                    <CircleCheckBig size={16} className="shrink-0 stroke-[2.5]" />
                                    <span>Accept Order</span>
                                    <ChevronRight size={14} className="opacity-75" />
                                  </button>
                                )}

                                {/* Next Sequential Button: 2. Packaging */}
                                {currentStatus === "accepted" && (
                                  <button
                                    disabled={isUpdating}
                                    onClick={() =>
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "packaging",
                                        "Order Marked as Packaging 📦"
                                      )
                                    }
                                    className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-black text-xs uppercase tracking-wider bg-amber-500 hover:bg-amber-600 text-white shadow-md shadow-amber-500/20 active:scale-[0.98] transition-all cursor-pointer min-h-[44px]"
                                    title="Click to mark order as Packaging (moves to step 3: On the Way)"
                                  >
                                    <Package size={16} className="shrink-0 stroke-[2.5]" />
                                    <span>Packaging</span>
                                    <ChevronRight size={14} className="opacity-75" />
                                  </button>
                                )}

                                {/* Next Sequential Button: 3. On the Way */}
                                {currentStatus === "packaging" && (
                                  <button
                                    disabled={isUpdating}
                                    onClick={() =>
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "on_the_way",
                                        "Order Dispatched & On the Way 🚚"
                                      )
                                    }
                                    className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-black text-xs uppercase tracking-wider bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-600/20 active:scale-[0.98] transition-all cursor-pointer min-h-[44px]"
                                    title="Click to mark order as On the Way (moves to step 4: Delivered)"
                                  >
                                    <Truck size={16} className="shrink-0 stroke-[2.5]" />
                                    <span>On the Way</span>
                                    <ChevronRight size={14} className="opacity-75" />
                                  </button>
                                )}

                                {/* Next Sequential Button: 4. Delivered */}
                                {currentStatus === "on_the_way" && (
                                  <button
                                    disabled={isUpdating}
                                    onClick={() =>
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "delivered",
                                        "Order Marked as Delivered & Moved to Completed Orders ✅"
                                      )
                                    }
                                    className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-black text-xs uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-600/20 active:scale-[0.98] transition-all cursor-pointer min-h-[44px]"
                                    title="Click to mark order as Delivered (moves to Completed Orders section)"
                                  >
                                    <CheckCheck size={17} className="shrink-0 stroke-[2.5]" />
                                    <span>Delivered</span>
                                    <ChevronRight size={14} className="opacity-75" />
                                  </button>
                                )}

                                {/* Secondary Action: Reject / Cancel Button */}
                                <button
                                  disabled={isUpdating}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Are you sure you want to cancel / reject Order #${order.id.slice(-6).toUpperCase()}?`
                                      )
                                    ) {
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "cancelled",
                                        "Order Cancelled Successfully"
                                      );
                                    }
                                  }}
                                  className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl font-bold text-xs uppercase tracking-wider bg-slate-100 hover:bg-red-50 text-slate-600 hover:text-red-700 border border-slate-200 hover:border-red-200 transition-all cursor-pointer shrink-0 min-h-[44px]"
                                  title="Cancel or reject this order"
                                >
                                  <CircleX size={15} className="shrink-0 text-red-500" />
                                  <span>Reject</span>
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Internal Admin Note in Order Action Area */}
                          <div className="mt-3 pt-2.5 border-t border-slate-100">
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                                <FileText size={12} className="text-emerald-600 shrink-0" />
                                <span>Internal Admin Note</span>
                              </span>
                              {order.internalNotes && (
                                <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50">
                                  Saved Note
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                placeholder="Attach internal note (status will not change)..."
                                value={
                                  notesInput[order.id] !== undefined
                                    ? notesInput[order.id]
                                    : (order.internalNotes || "")
                                }
                                onChange={(e) =>
                                  setNotesInput((prev) => ({
                                    ...prev,
                                    [order.id]: e.target.value
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    handleSaveInternalNotes(order.id);
                                  }
                                }}
                                className="flex-1 min-w-0 px-3 py-1.5 sm:py-2 text-xs bg-slate-50 focus:bg-white border border-slate-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-xl outline-none transition-all placeholder:text-slate-400 font-medium"
                              />

                              <button
                                type="button"
                                onClick={() => handleSaveInternalNotes(order.id)}
                                disabled={
                                  savingNotes[order.id] ||
                                  (notesInput[order.id] !== undefined &&
                                    notesInput[order.id].trim() === (order.internalNotes || "").trim())
                                }
                                className="px-3 py-1.5 sm:py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-100 text-white disabled:text-slate-400 font-black text-xs rounded-xl shadow-xs disabled:shadow-none transition-all cursor-pointer disabled:cursor-not-allowed shrink-0 flex items-center gap-1 active:scale-95"
                                title="Attach note without changing order status"
                              >
                                {savingNotes[order.id] ? (
                                  <>
                                    <RefreshCcw size={12} className="animate-spin" />
                                    <span>Saving</span>
                                  </>
                                ) : (
                                  <>
                                    <Save size={12} />
                                    <span>Save</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}

              {/* Scalable Order Pagination / Load More */}
              {orders.length >= orderLimit && (
                <div className="mt-8 mb-4 flex justify-center">
                  <button
                    onClick={() => setOrderLimit((prev) => prev + 50)}
                    className="flex items-center gap-2 px-6 py-2.5 bg-white hover:bg-emerald-50 text-slate-700 hover:text-emerald-700 font-extrabold text-xs rounded-xl border border-slate-200 hover:border-emerald-300 shadow-xs hover:shadow transition-all cursor-pointer active:scale-95"
                  >
                    <RefreshCcw size={14} />
                    <span>Load Older Orders (Showing {orders.length}, +50)</span>
                  </button>
                </div>
              )}
            </div>
          ) : activeTab === "offers" ? (
            /* TAB 3: OFFER & DISCOUNT MANAGEMENT */
            <div className="space-y-6">
              {/* Offers Summary Metric Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs flex items-center justify-between">
                  <div>
                    <p className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                      Total Offers
                    </p>
                    <h4 className="text-xl sm:text-2xl font-black text-slate-900">
                      {offerStats.total}
                    </h4>
                    <span className="text-[10px] text-slate-500 font-medium">Configured deals</span>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                    <BadgePercent size={20} />
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-4 border border-emerald-200/90 shadow-xs flex items-center justify-between">
                  <div>
                    <p className="text-[10px] sm:text-xs font-bold text-emerald-700 uppercase tracking-wider mb-1">
                      Live on Store
                    </p>
                    <h4 className="text-xl sm:text-2xl font-black text-emerald-600">
                      {offerStats.active}
                    </h4>
                    <span className="text-[10px] text-emerald-700 font-semibold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Active now
                    </span>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <Flame size={20} />
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs flex items-center justify-between">
                  <div>
                    <p className="text-[10px] sm:text-xs font-bold text-sky-600 uppercase tracking-wider mb-1">
                      Upcoming
                    </p>
                    <h4 className="text-xl sm:text-2xl font-black text-sky-600">
                      {offerStats.upcoming}
                    </h4>
                    <span className="text-[10px] text-slate-500 font-medium">Scheduled deals</span>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
                    <Clock size={20} />
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs flex items-center justify-between">
                  <div>
                    <p className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                      Disabled / Expired
                    </p>
                    <h4 className="text-xl sm:text-2xl font-black text-slate-700">
                      {offerStats.disabled + offerStats.expired}
                    </h4>
                    <span className="text-[10px] text-slate-500 font-medium">
                      {offerStats.expired} expired, {offerStats.disabled} paused
                    </span>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-slate-50 text-slate-500 flex items-center justify-center shrink-0">
                    <Tag size={20} />
                  </div>
                </div>
              </div>

              {/* Offer Filters Bar */}
              <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
                {/* Status Tabs */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
                  {(
                    [
                      { id: "all", label: "All Offers", count: offerStats.total },
                      { id: "active", label: "Active Now 🔥", count: offerStats.active },
                      { id: "upcoming", label: "Upcoming 🕒", count: offerStats.upcoming },
                      { id: "expired", label: "Expired", count: offerStats.expired },
                      { id: "disabled", label: "Disabled", count: offerStats.disabled }
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setOfferStatusFilter(tab.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                        offerStatusFilter === tab.id
                          ? "bg-amber-500 text-white shadow-xs"
                          : "bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200"
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded-full font-black ${
                          offerStatusFilter === tab.id
                            ? "bg-white/20 text-white"
                            : "bg-slate-200 text-slate-600"
                        }`}
                      >
                        {tab.count}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Category filter dropdown */}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500 shrink-0">Category:</span>
                  <select
                    value={offerCategoryFilter}
                    onChange={(e) => setOfferCategoryFilter(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer"
                  >
                    <option value="all">All Categories</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Offers Grid */}
              {filteredOffers.length === 0 ? (
                <div className="bg-white rounded-3xl p-12 text-center border border-dashed border-slate-200 shadow-xs">
                  <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-500 flex items-center justify-center mx-auto mb-4">
                    <BadgePercent size={32} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mb-1">
                    {offerStats.total === 0
                      ? "No Products Currently on Offer"
                      : "No Offers Found for Selected Filter"}
                  </h3>
                  <p className="text-slate-500 text-xs max-w-md mx-auto mb-6">
                    {offerStats.total === 0
                      ? "You can easily add discounts to any product. Open the Products tab, find a product, and click 'Add to Offer'."
                      : "Try switching the status filter or category filter above to see other configured deals."}
                  </p>
                  <button
                    onClick={() => setActiveTab("products")}
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer inline-flex items-center gap-2 active:scale-95"
                  >
                    <Plus size={16} />
                    <span>Go to Products Catalog to Add Offers</span>
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filteredOffers.map((prod) => {
                    const pricing = getProductPricing(prod);
                    const isLive = pricing.offerStatus === "active";
                    const isUpcoming = pricing.offerStatus === "upcoming";
                    const isExpired = pricing.offerStatus === "expired";
                    const isDisabled = pricing.offerStatus === "disabled";

                    return (
                      <div
                        key={prod.id}
                        className={`bg-white rounded-2xl border shadow-xs hover:shadow-md transition-all duration-200 overflow-hidden flex flex-col ${
                          isLive
                            ? "border-amber-200 ring-1 ring-amber-100"
                            : "border-slate-200 opacity-90"
                        }`}
                      >
                        {/* Image & Badges */}
                        <div className="relative h-44 bg-slate-50 flex items-center justify-center p-3 border-b border-slate-100">
                          {prod.imageUrl || prod.image ? (
                            <img
                              src={formatImageUrl(prod.imageUrl || prod.image || "")}
                              alt={prod.name}
                              loading="lazy"
                              decoding="async"
                              className="w-full h-full object-contain"
                              referrerPolicy="no-referrer"
                              onError={handleImgError}
                            />
                          ) : (
                            <Package className="text-slate-300" size={40} />
                          )}

                          {/* Discount Pill Top Left */}
                          <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 flex-wrap">
                            <span className="bg-amber-500 text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow-xs uppercase tracking-wider flex items-center gap-1">
                              <Sparkles size={11} />
                              <span>{pricing.discountText}</span>
                            </span>
                            <span className="bg-white/90 backdrop-blur-xs text-[10px] font-bold text-slate-700 px-2 py-0.5 rounded-md border border-slate-100 uppercase tracking-wider">
                              {prod.category}
                            </span>
                          </div>

                          {/* Status Pill Top Right */}
                          <div className="absolute top-2.5 right-2.5">
                            {isLive && (
                              <span className="bg-emerald-600 text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow-xs uppercase tracking-wider flex items-center gap-1 animate-pulse">
                                <span className="w-1.5 h-1.5 rounded-full bg-white" />
                                <span>LIVE</span>
                              </span>
                            )}
                            {isUpcoming && (
                              <span className="bg-sky-600 text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow-xs uppercase tracking-wider">
                                UPCOMING
                              </span>
                            )}
                            {isExpired && (
                              <span className="bg-red-600 text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow-xs uppercase tracking-wider">
                                EXPIRED
                              </span>
                            )}
                            {isDisabled && (
                              <span className="bg-slate-400 text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow-xs uppercase tracking-wider">
                                DISABLED
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Details */}
                        <div className="p-4 flex-1 flex flex-col">
                          <h4 className="font-bold text-slate-900 text-sm leading-tight truncate mb-1" title={prod.name}>
                            {prod.name}
                          </h4>
                          {prod.unit && (
                            <span className="text-[11px] text-slate-500 font-medium mb-3">
                              Unit: <span className="font-bold text-emerald-700">{prod.unit}</span>
                            </span>
                          )}

                          {/* Price Comparison */}
                          <div className="bg-slate-50 rounded-xl p-2.5 border border-slate-200/80 mb-3">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[11px] text-slate-400 line-through">
                                Regular: ₹{pricing.originalPrice}
                              </span>
                              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                Save ₹{pricing.savings}
                              </span>
                            </div>
                            <div className="flex items-baseline gap-1">
                              <span className="text-xl font-black text-emerald-600 font-sans">
                                ₹{pricing.finalPrice}
                              </span>
                              <span className="text-[11px] font-bold text-slate-500">
                                / {prod.unit || "item"}
                              </span>
                            </div>
                          </div>

                          {/* Date Schedule info if configured */}
                          {(prod.offerStartDate || prod.offerEndDate) && (
                            <div className="text-[10px] text-slate-500 space-y-0.5 mb-3 bg-amber-50/60 p-2 rounded-lg border border-amber-100">
                              {prod.offerStartDate && (
                                <p className="truncate">
                                  <span className="font-bold text-slate-700">Starts:</span>{" "}
                                  {new Date(prod.offerStartDate).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                                </p>
                              )}
                              {prod.offerEndDate && (
                                <p className="truncate">
                                  <span className="font-bold text-slate-700">Ends:</span>{" "}
                                  {new Date(prod.offerEndDate).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Actions */}
                          <div className="mt-auto pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                            {/* Quick Enable/Disable Toggle */}
                            <button
                              type="button"
                              onClick={() => handleToggleOfferEnabled(prod.id, Boolean(prod.offerEnabled))}
                              className="flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 cursor-pointer"
                              title="Toggle offer on/off"
                            >
                              <div
                                className={`w-8 h-4.5 rounded-full transition-colors relative flex items-center ${
                                  prod.offerEnabled ? "bg-emerald-500" : "bg-slate-300"
                                }`}
                              >
                                <span
                                  className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                                    prod.offerEnabled ? "translate-x-4" : "translate-x-0.5"
                                  }`}
                                />
                              </div>
                              <span className="text-[11px]">
                                {prod.offerEnabled ? "Enabled" : "Paused"}
                              </span>
                            </button>

                            <div className="flex items-center gap-1">
                              {/* Edit Offer button */}
                              <button
                                onClick={() => openOfferModal(prod)}
                                className="p-1.5 rounded-lg text-slate-600 hover:text-amber-700 hover:bg-amber-50 transition-colors cursor-pointer"
                                title="Edit Offer Values"
                              >
                                <Pen size={15} />
                              </button>
                              {/* Remove from Offer button */}
                              <button
                                onClick={() => handleRemoveOffer(prod.id)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                                title="Remove product from Offer list (preserves catalog item)"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* TAB 2: PRODUCTS MANAGEMENT (With Offer Badges, Category Filter & Actions) */
            <div className="space-y-4">
              {/* Category Filter & Catalog Summary Bar */}
              <div className="bg-white rounded-2xl p-3 sm:p-4 border border-slate-200/80 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider shrink-0 flex items-center gap-1.5">
                    <Filter size={14} className="text-emerald-600" />
                    <span>Category:</span>
                  </span>
                  <select
                    value={productCategoryFilter}
                    onChange={(e) => setProductCategoryFilter(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    <option value="all">All Categories ({products.length})</option>
                    {categories.map((c) => {
                      const count = products.filter(
                        (p) => (p.category || "").trim().toLowerCase() === c.name.trim().toLowerCase()
                      ).length;
                      return (
                        <option key={c.id} value={c.name}>
                          {c.name} {count > 0 ? `(${count})` : ""}
                        </option>
                      );
                    })}
                  </select>
                  {productCategoryFilter !== "all" && (
                    <button
                      onClick={() => setProductCategoryFilter("all")}
                      className="px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      Clear Filter
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between sm:justify-end gap-3 text-xs font-semibold text-slate-500">
                  <span>
                    Showing <strong className="text-slate-900">{filteredProducts.length}</strong> of {products.length} products
                  </span>
                  <button
                    onClick={openAddProductModal}
                    className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center gap-1 text-xs cursor-pointer shadow-xs active:scale-95 transition-all"
                  >
                    <Plus size={14} />
                    <span>Add Product</span>
                  </button>
                </div>
              </div>

              {filteredProducts.length === 0 ? (
                <div className="bg-white rounded-2xl p-12 text-center border border-dashed border-slate-300">
                  <Package className="mx-auto text-slate-300 mb-4" size={48} />
                  <h3 className="text-lg font-semibold text-slate-900">No Products Found</h3>
                  <p className="text-slate-500">
                    {searchQuery || productCategoryFilter !== "all"
                      ? "No products match your search or category filter criteria."
                      : "Your product list will appear here."}
                  </p>
                  {productCategoryFilter !== "all" && (
                    <button
                      onClick={() => setProductCategoryFilter("all")}
                      className="mt-3 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1.5"
                    >
                      <span>Show All Categories</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5 sm:gap-5">
                  {filteredProducts.map((prod) => {
                    const pricing = getProductPricing(prod);

                    return (
                      <motion.div
                        key={prod.id}
                        layout
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`bg-white rounded-2xl shadow-xs border overflow-hidden transition-all duration-300 group hover:shadow-md flex flex-col ${
                          prod.isAvailable
                            ? prod.isOffer && pricing.hasActiveOffer
                              ? "border-amber-300 ring-1 ring-amber-200/60"
                              : "border-slate-200"
                            : "grayscale opacity-75 border-slate-200"
                        }`}
                      >
                        {/* Product Image: Medium Size with lazy-loading & async decoding */}
                        <div className="relative h-40 sm:h-44 w-full bg-slate-50 flex items-center justify-center p-2.5 overflow-hidden border-b border-slate-100 shrink-0">
                          {prod.imageUrl || prod.image ? (
                            <img
                              src={formatImageUrl(prod.imageUrl || prod.image || "")}
                              alt={prod.name}
                              loading="lazy"
                              decoding="async"
                              className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300"
                              referrerPolicy="no-referrer"
                              onError={handleImgError}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-300">
                              <Package size={38} />
                            </div>
                          )}

                          {!prod.isAvailable && (
                            <div className="absolute inset-0 bg-slate-900/40 flex items-center justify-center backdrop-blur-[2px]">
                              <span className="bg-white text-slate-900 px-3 py-1 rounded-full font-black text-[11px] uppercase tracking-wider shadow-lg">
                                Unavailable
                              </span>
                            </div>
                          )}

                          <div className="absolute top-2.5 left-2.5 flex items-center gap-1 flex-wrap">
                            <span className="bg-white/95 backdrop-blur-sm text-[10px] font-bold text-slate-700 px-2 py-0.5 rounded-md uppercase tracking-wider shadow-xs border border-slate-100">
                              {prod.category}
                            </span>
                            {prod.unit && (
                              <span className="bg-emerald-600/90 backdrop-blur-sm text-[10px] font-bold text-white px-2 py-0.5 rounded-md uppercase tracking-wider shadow-xs">
                                {prod.unit}
                              </span>
                            )}
                          </div>

                          {/* Offer Status Pill Top Right */}
                          <div className="absolute top-2.5 right-2.5">
                            {prod.isOffer ? (
                              pricing.hasActiveOffer ? (
                                <span className="bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-black px-2 py-0.5 rounded-md shadow-xs uppercase tracking-wider flex items-center gap-1 animate-pulse">
                                  <Flame size={10} />
                                  <span>{pricing.discountText}</span>
                                </span>
                              ) : (
                                <span className="bg-slate-200 text-slate-700 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-slate-300">
                                  Offer {pricing.offerStatus}
                                </span>
                              )
                            ) : (
                              <span className="bg-white/80 backdrop-blur-xs text-[9px] font-semibold text-slate-400 px-1.5 py-0.5 rounded-md border border-slate-100">
                                Regular
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="p-4 sm:p-4.5 flex-1 flex flex-col">
                          <div className="flex justify-between items-start gap-2 mb-2">
                            <div className="flex-1 min-w-0">
                              <h3 className="font-bold text-slate-900 leading-tight truncate" title={prod.name}>
                                {prod.name}
                              </h3>
                              {prod.unit && (
                                <span className="inline-block mt-0.5 text-[11px] font-semibold text-slate-500">
                                  Unit: <span className="font-bold text-emerald-700">{prod.unit}</span>
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => openEditProductModal(prod)}
                                className="p-1.5 hover:bg-emerald-50 rounded-lg text-slate-400 hover:text-emerald-600 transition-colors cursor-pointer"
                                title="Edit Product (Name, Unit, Price, etc.)"
                              >
                                <Pen size={15} />
                              </button>
                              <button
                                onClick={() => handleDeleteProduct(prod.id)}
                                className="p-1.5 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
                                title="Delete Product"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>

                          {/* Pricing block: shows offer price + original strikethrough if offer is active */}
                          <div className="mb-2">
                            {prod.isOffer && pricing.hasActiveOffer ? (
                              <div className="flex items-baseline gap-2">
                                <span className="text-emerald-600 font-black text-xl font-sans">
                                  ₹{pricing.finalPrice}
                                </span>
                                <span className="text-xs font-semibold text-slate-400 line-through">
                                  ₹{pricing.originalPrice}
                                </span>
                                {prod.unit && (
                                  <span className="text-xs font-semibold text-slate-400">/ {prod.unit}</span>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-baseline gap-1">
                                <span className="text-emerald-600 font-extrabold text-lg">₹{prod.price}</span>
                                {prod.unit && (
                                  <span className="text-xs font-semibold text-slate-400">/ {prod.unit}</span>
                                )}
                              </div>
                            )}
                          </div>

                          <p className="text-xs text-slate-500 mb-3 line-clamp-1">
                            {prod.description || "No description available"}
                          </p>

                          {/* Offer Action Button */}
                          <div className="mt-auto pt-2 border-t border-slate-100 flex items-center justify-between gap-1 mb-2">
                            {prod.isOffer ? (
                              <div className="flex items-center justify-between w-full gap-1">
                                <button
                                  type="button"
                                  onClick={() => openOfferModal(prod)}
                                  className="flex-1 py-1 px-2 bg-amber-50 hover:bg-amber-100 text-amber-800 text-[11px] font-extrabold rounded-lg border border-amber-200 transition-all flex items-center justify-center gap-1 cursor-pointer"
                                  title="Edit Offer Discount & Validity"
                                >
                                  <BadgePercent size={13} />
                                  <span>Edit Deal</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveOffer(prod.id)}
                                  className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                                  title="Remove from Offer"
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => openOfferModal(prod)}
                                className="w-full py-1 px-2 bg-slate-50 hover:bg-amber-50 hover:text-amber-800 hover:border-amber-200 text-slate-600 text-[11px] font-bold rounded-lg border border-slate-200 transition-all flex items-center justify-center gap-1 cursor-pointer"
                                title="Add this product to Offer / Discount"
                              >
                                <Plus size={12} />
                                <span>Add to Offer</span>
                              </button>
                            )}
                          </div>

                          {/* Stock status toggle */}
                          <div className="flex items-center justify-between pt-2 border-t border-slate-50">
                            <div className="flex flex-col">
                              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                                Status
                              </span>
                              <span
                                className={`text-[11px] font-bold ${
                                  prod.isAvailable ? "text-emerald-500" : "text-slate-400"
                                }`}
                              >
                                {prod.isAvailable ? "Available" : "Unavailable"}
                              </span>
                            </div>

                            <button
                              onClick={() =>
                                handleToggleProductAvailability(prod.id, prod.isAvailable)
                              }
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1 cursor-pointer ${
                                prod.isAvailable ? "bg-emerald-500" : "bg-slate-200"
                              }`}
                            >
                              <span
                                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                                  prod.isAvailable ? "translate-x-4.5" : "translate-x-0.5"
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Clean Install App Prompt / Modal */}
      <AnimatePresence>
        {showInstallModal && !isAppInstalled && deferredPrompt && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.95 }}
            className="fixed bottom-20 md:bottom-6 right-3 left-3 sm:left-auto sm:right-6 sm:w-96 z-[150] bg-white rounded-2xl shadow-2xl border border-emerald-200 p-4 sm:p-5 overflow-hidden"
          >
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-50 via-amber-50 to-orange-50 p-1 border border-emerald-200 shadow-xs flex items-center justify-center shrink-0">
                <img
                  src={appLogo}
                  alt="Zypso Mart"
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <h4 className="font-extrabold text-slate-900 text-sm tracking-tight">
                    Install Zypso Mart App
                  </h4>
                  <button
                    onClick={handleDismissInstallModal}
                    className="text-slate-400 hover:text-slate-600 p-1 rounded-lg transition-colors cursor-pointer"
                    title="Dismiss"
                  >
                    <X size={16} />
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  Install on your Android or Chrome home screen for full-screen mode, real-time order alerts, and offline access.
                </p>
                <div className="flex items-center gap-2 mt-3.5">
                  <button
                    onClick={handleInstallApp}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-md shadow-emerald-600/20 active:scale-95 transition-all cursor-pointer"
                  >
                    <Download size={14} className="stroke-[2.5]" />
                    <span>Install App</span>
                  </button>
                  <button
                    onClick={handleDismissInstallModal}
                    className="py-2.5 px-3 text-slate-600 hover:bg-slate-100 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Later
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile Bottom Navigation (Fixed) */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-slate-200/90 shadow-lg z-40 flex justify-around items-center px-2 pt-1 pb-[max(0.65rem,env(safe-area-inset-bottom))]">
        <button
          onClick={() => setActiveTab("orders")}
          className={`flex flex-col items-center justify-center flex-1 py-1 min-h-[48px] transition-all cursor-pointer ${
            activeTab === "orders"
              ? "text-emerald-600 font-extrabold"
              : "text-slate-500 hover:text-slate-800 font-medium"
          }`}
        >
          <div className="relative">
            <ShoppingCart
              size={20}
              className={activeTab === "orders" ? "stroke-[2.5px]" : "stroke-2"}
            />
            {unacknowledgedOrders.length > 0 && (
              <span className="absolute -top-1.5 -right-2 bg-red-600 text-white text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center animate-bounce shadow-xs">
                {unacknowledgedOrders.length}
              </span>
            )}
          </div>
          <span className="text-[10px] mt-1">Orders</span>
        </button>

        <button
          onClick={() => setActiveTab("products")}
          className={`flex flex-col items-center justify-center flex-1 py-1 min-h-[48px] transition-all cursor-pointer ${
            activeTab === "products"
              ? "text-emerald-600 font-extrabold"
              : "text-slate-500 hover:text-slate-800 font-medium"
          }`}
        >
          <Package
            size={20}
            className={activeTab === "products" ? "stroke-[2.5px]" : "stroke-2"}
          />
          <span className="text-[10px] mt-1">Products</span>
        </button>

        <button
          onClick={() => setActiveTab("offers")}
          className={`flex flex-col items-center justify-center flex-1 py-1 min-h-[48px] transition-all cursor-pointer relative ${
            activeTab === "offers"
              ? "text-emerald-600 font-extrabold"
              : "text-slate-500 hover:text-slate-800 font-medium"
          }`}
        >
          <div className="relative">
            <BadgePercent
              size={20}
              className={activeTab === "offers" ? "stroke-[2.5px]" : "stroke-2"}
            />
            {offerStats.active > 0 && (
              <span className="absolute -top-1.5 -right-2 bg-amber-500 text-white text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center animate-pulse shadow-xs">
                {offerStats.active}
              </span>
            )}
          </div>
          <span className="text-[10px] mt-1">Offers</span>
        </button>

        <button
          onClick={() => setShowAlarmSettingsModal(true)}
          className={`flex flex-col items-center justify-center flex-1 py-1 min-h-[48px] transition-all cursor-pointer relative ${
            isAlarmRinging
              ? "text-red-600 font-extrabold"
              : isAlarmEnabled
              ? "text-emerald-700 font-bold"
              : "text-slate-500 font-medium"
          }`}
        >
          <div className="relative">
            <BellRing
              size={20}
              className={isAlarmRinging ? "animate-bounce stroke-[2.5px] text-red-600" : "stroke-2"}
            />
            {isAlarmRinging && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-600 animate-ping" />
            )}
          </div>
          <span className="text-[10px] mt-1">{isAlarmRinging ? "RINGING!" : "Alarm"}</span>
        </button>

        {showInstallBtn && !isAppInstalled && deferredPrompt && (
          <button
            onClick={handleInstallApp}
            className="flex flex-col items-center justify-center flex-1 py-1 min-h-[48px] text-emerald-600 transition-all cursor-pointer"
          >
            <div className="relative">
              <Download size={20} className="stroke-[2.5px]" />
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
            </div>
            <span className="text-[10px] mt-1 font-black">Install</span>
          </button>
        )}

        <button
          onClick={handleSignOut}
          className="flex flex-col items-center justify-center flex-1 py-1 min-h-[48px] text-red-500 hover:text-red-700 transition-all cursor-pointer"
        >
          <LogOut size={20} className="stroke-2" />
          <span className="text-[10px] mt-1 font-bold">Logout</span>
        </button>
      </div>
    </div>
  );
}
