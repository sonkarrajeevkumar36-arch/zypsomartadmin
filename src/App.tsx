import React, { Component, useState, useEffect, useRef, useMemo, ErrorInfo, ReactNode } from "react";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  User
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  orderBy,
  getDocs
} from "firebase/firestore";
import {
  Bell,
  BellRing,
  CircleCheckBig,
  CircleX,
  Download,
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
  X
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import appLogo from "./assets/images/logo.png";
import { auth, db } from "./firebase";
import { Order, Product, Category } from "./types";
import { alarmAudio } from "./utils/alarmAudio";
import {
  registerDeviceForNotifications,
  unregisterDeviceToken,
  isNotificationSupported,
  getNotificationPermission,
  onForegroundMessageListener
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

// Robust normalizer for order status to handle all return/cancel/delivery variants
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
  if (s === "delivered" || s === "deliver") return "delivered";
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
    items,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    paymentMethod:
      data.paymentMethod || data.paymentType || data.paymentMode || "Cash on Delivery",
    notes,
    customerNotes: notes,
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
    const msg = error?.message || "";
    if (
      msg.includes("WebSocket") ||
      msg.includes("websocket") ||
      msg.includes("Cloud Firestore backend") ||
      msg.includes("offline mode")
    ) {
      return { hasError: false, error: null };
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const msg = error?.message || "";
    if (
      msg.includes("WebSocket") ||
      msg.includes("websocket") ||
      msg.includes("Cloud Firestore backend") ||
      msg.includes("offline mode")
    ) {
      return;
    }
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
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"orders" | "products">("orders");
  const [user, setUser] = useState<User | null>(null);

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

  // Periodic timer ticker for relative time formatting
  const [, setClockTime] = useState(Date.now());

  // Alerts and PWA installation states
  const [newOrderAlert, setNewOrderAlert] = useState<Order | null>(null);

  // New Order Alarm & Push Notification States
  const [isAlarmEnabled, setIsAlarmEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("zypsomart_alarm_enabled") !== "false";
  });
  const isAlarmEnabledRef = useRef(isAlarmEnabled);
  isAlarmEnabledRef.current = isAlarmEnabled;

  const [isAlarmRinging, setIsAlarmRinging] = useState(false);
  const [showAlarmSettingsModal, setShowAlarmSettingsModal] = useState(false);
  const [notificationPermissionState, setNotificationPermissionState] = useState<string>(() => {
    return getNotificationPermission();
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

  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [isAppInstalled, setIsAppInstalled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true ||
      document.referrer.includes("android-app://") ||
      localStorage.getItem("zypsomart_pwa_installed") === "true";
    return Boolean(isStandalone);
  });

  // Filter & Search states
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Product modal states
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productForm, setProductForm] = useState({
    name: "",
    category: "",
    price: "",
    unit: "piece",
    image: "",
    description: "",
    isAvailable: true
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
    setActiveTab("orders");
    setStatusFilter("all");
    setSearchQuery(orderId.startsWith("TEST-") ? "" : orderId);
    setTimeout(() => {
      const el = document.getElementById(`order-card-${orderId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
  };

  const handleDismissAlert = () => {
    alarmAudio.stopAlarm();
    setIsAlarmRinging(false);
    setNewOrderAlert(null);
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

  const showNotification = (type: "success" | "error", text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3500);
  };

  const handleImgError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    e.currentTarget.src = FALLBACK_IMAGE;
  };

  // Auth state subscriber and data loaders
  useEffect(() => {
    let unsubsOrders: any = null;
    let unsubsProducts: any = null;
    let unsubsCategories: any = null;

    const authUnsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (unsubsOrders) {
        unsubsOrders();
        unsubsOrders = null;
      }
      if (unsubsProducts) {
        unsubsProducts();
        unsubsProducts = null;
      }
      if (unsubsCategories) {
        unsubsCategories();
        unsubsCategories = null;
      }

      if (currentUser) {
        const isVerified = checkIsPinVerified(currentUser.uid);
        setIsPinVerified(isVerified);
        unsubsOrders = startOrdersSync();
        unsubsProducts = loadProducts();
        unsubsCategories = loadCategories();
      } else {
        setIsPinVerified(false);
        setLoading(false);
      }
    });

    const timer = setInterval(() => {
      setClockTime(Date.now());
    }, 10000);

    return () => {
      authUnsub();
      if (unsubsOrders) unsubsOrders();
      if (unsubsProducts) unsubsProducts();
      if (unsubsCategories) unsubsCategories();
      clearInterval(timer);
    };
  }, []);

  // Products realtime listener
  const loadProducts = () => {
    const productsCol = collection(db, "products");
    const q = query(productsCol, orderBy("name", "asc"));
    return onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data()
        })) as Product[];
        setProducts(list);
      },
      (error) => {
        console.error("Products listener error:", error);
        if (error.code === "failed-precondition") {
          return onSnapshot(productsCol, (snap) => {
            const list = snap.docs.map((d) => ({
              id: d.id,
              ...d.data()
            })) as Product[];
            list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            setProducts(list);
          });
        }
        setBannerError("Notice: Unable to sync products - " + error.message);
      }
    );
  };

  // Categories realtime listener and auto-seed
  const loadCategories = () => {
    const q = query(collection(db, "categories"), orderBy("name", "asc"));
    return onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data()
        })) as Category[];
        setCategories(list);

        if (list.length === 0 && !seededCategories.current && auth.currentUser) {
          seededCategories.current = true;
          const defaults = ["Fruits", "Vegetables", "Dairy", "Bakery", "Beverages", "Snacks"];
          defaults.forEach(async (catName) => {
            try {
              await addDoc(collection(db, "categories"), { name: catName });
            } catch (err) {
              console.error("Error seeding default category:", err);
            }
          });
        }
      },
      (error) => {
        console.error("Categories listener error:", error);
      }
    );
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
    const orderedQuery = query(ordersCol, orderBy("createdAt", "desc"));

    // Fallback getDocs fetch if snapshot connection falters
    const fallbackFetch = async (targetQuery: any) => {
      try {
        const snap = await getDocs(targetQuery);
        const parsed = snap.docs.map((d) => parseOrderDoc(d.id, d.data()));
        const uniqueMap: Record<string, Order> = {};
        parsed.forEach((item) => {
          if (item?.id) uniqueMap[item.id] = item;
        });
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
              attachListener(ordersCol, true);
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

  // Sign In with Email and Password
  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
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
      setSearchQuery(orderIdParam);
      // Clean query parameter from address bar cleanly without page refresh
      const newUrl = window.location.pathname + (tabParam ? `?tab=${tabParam}` : "");
      window.history.replaceState({}, document.title, newUrl);
    }
  }, [isPinVerified]);

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
    setOrders((prevOrders) =>
      prevOrders.map((ord) => {
        if (ord.id === orderId) {
          const isReturn =
            normalizedTarget.includes("return") || ord.type === "return";
          return {
            ...ord,
            status: normalizedTarget,
            type: isReturn ? "return" : ord.type,
            returnStatus:
              normalizedTarget === "return_approved"
                ? "approved"
                : normalizedTarget === "return_rejected"
                ? "rejected"
                : ord.returnStatus,
            updatedAt: new Date()
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

      // 2. Direct Firestore update for real-time guarantee
      const orderRef = doc(db, "orders", orderId);
      const updateData: Record<string, any> = {
        status: normalizedTarget,
        updatedAt: new Date()
      };

      if (normalizedTarget === "return_approved") {
        updateData.returnStatus = "approved";
        updateData.type = "return";
        updateData.isReturned = true;
        updateData.returnApprovedAt = new Date();
      } else if (normalizedTarget === "return_rejected") {
        updateData.returnStatus = "rejected";
        updateData.type = "return";
        updateData.returnRejectedAt = new Date();
      } else if (normalizedTarget === "return_requested") {
        updateData.returnStatus = "requested";
        updateData.type = "return";
      }

      await updateDoc(orderRef, updateData);

      showNotification(
        "success",
        successMessage || `Order status updated to ${normalizedTarget.toUpperCase()}`
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

  // Product availability toggle
  const handleToggleProductAvailability = async (productId: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, "products", productId), {
        isAvailable: !currentStatus
      });
      showNotification(
        "success",
        `Product marked as ${!currentStatus ? "Available" : "Unavailable"}`
      );
    } catch (err: any) {
      showNotification("error", "Error updating product: " + err.message);
    }
  };

  // Product Add / Edit save handler
  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = productForm.name.trim();
    const category = productForm.category.trim();
    const unit = productForm.unit.trim() || "piece";
    const image = productForm.image.trim();
    const price = Number(productForm.price);

    if (!name) {
      showNotification("error", "Product name is required.");
      return;
    }
    if (!category) {
      showNotification("error", "Product category is required.");
      return;
    }
    if (isNaN(price) || price <= 0) {
      showNotification("error", "Price must be a valid positive number.");
      return;
    }
    if (!editingProduct && !image) {
      showNotification("error", "Image URL is required.");
      return;
    }

    // Check duplicate name
    if (
      products.some(
        (p) => p.name.toLowerCase() === name.toLowerCase() && (!editingProduct || p.id !== editingProduct.id)
      )
    ) {
      showNotification("error", "A product with this name already exists.");
      return;
    }

    try {
      const payload: Record<string, any> = {
        name,
        category,
        price,
        unit,
        description: productForm.description.trim(),
        isAvailable: productForm.isAvailable
      };

      if (image) {
        const formattedImg = formatImageUrl(image);
        payload.image = formattedImg;
        payload.imageUrl = formattedImg;
      }

      if (editingProduct?.id) {
        await updateDoc(doc(db, "products", editingProduct.id), payload);
        showNotification("success", `Product "${name}" updated successfully`);
      } else {
        await addDoc(collection(db, "products"), payload);
        showNotification("success", `Product "${name}" added successfully`);
      }

      setShowProductModal(false);
      setEditingProduct(null);
      setProductForm({
        name: "",
        category: "",
        price: "",
        unit: "piece",
        image: "",
        description: "",
        isAvailable: true
      });
    } catch (err: any) {
      showNotification("error", "Failed: " + err.message);
    }
  };

  // Open Edit Product Modal
  const openEditProductModal = (product: Product) => {
    setEditingProduct(product);
    setProductForm({
      name: product.name,
      category: product.category,
      price: product.price.toString(),
      unit: product.unit || "piece",
      image: product.imageUrl || product.image || "",
      description: product.description || "",
      isAvailable: product.isAvailable
    });
    setShowProductModal(true);
  };

  // Delete Product
  const handleDeleteProduct = async (productId: string) => {
    if (window.confirm("Are you sure you want to delete this product?")) {
      try {
        await deleteDoc(doc(db, "products", productId));
        showNotification("success", "Product deleted successfully");
      } catch (err: any) {
        showNotification("error", "Delete failed: " + err.message);
      }
    }
  };

  // Filtered orders list by search query
  const searchedOrders = orders.filter((ord) => {
    const name = (ord.customerName || "").toLowerCase();
    const phone = ord.customerPhone || "";
    const id = ord.id || "";
    const q = searchQuery.toLowerCase();
    return name.includes(q) || phone.includes(q) || id.toLowerCase().includes(q);
  });

  // 12-Hour Statistics calculation
  const stats = useMemo(() => {
    const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
    let recentOrdersCount = 0;
    let revenueCount = 0;

    orders.forEach((ord) => {
      const ts = getTimestampMs(ord.createdAt);
      const isWithin12h = ts ? ts >= twelveHoursAgo : true;
      const status = (ord.status || "pending").toLowerCase();
      const total = Number(ord.total) || 0;

      if (isWithin12h && status !== "cancelled") {
        recentOrdersCount += 1;
      }
      if (isWithin12h && (status === "accepted" || status === "delivered")) {
        revenueCount += total;
      }
    });

    return {
      recentOrders: recentOrdersCount,
      totalProducts: products.length,
      revenue: revenueCount
    };
  }, [orders, products]);

  // Tab and Status filtered orders list
  const filteredOrders = useMemo(() => {
    let list = [...searchedOrders];
    if (statusFilter === "returns") {
      list = list.filter(isReturnOrder);
    } else if (statusFilter !== "all") {
      list = list.filter(
        (ord) => !isReturnOrder(ord) && (ord.status || "pending").toLowerCase() === statusFilter
      );
    }

    return list.sort((a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt));
  }, [searchedOrders, statusFilter]);

  // Filtered products list
  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg sm:text-2xl font-black text-slate-900 tracking-tight leading-tight truncate">
                    {activeTab === "orders" ? "Orders" : "Products"}
                  </h2>
                  <p className="text-[11px] sm:text-xs text-slate-500 truncate">
                    {activeTab === "orders"
                      ? "Real-time order manager & updates"
                      : "Inventory & stock availability"}
                  </p>
                </div>
              </div>

              {/* Install button in header for mobile */}
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

            <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-64">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  size={17}
                />
                <input
                  type="text"
                  placeholder={
                    activeTab === "orders" ? "Search orders..." : "Search products..."
                  }
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 pr-3 py-2 bg-slate-100 border-transparent focus:bg-white focus:ring-2 focus:ring-emerald-500 rounded-xl outline-none transition-all w-full text-xs sm:text-sm font-medium"
                />
              </div>

              <button
                onClick={() => (activeTab === "orders" ? startOrdersSync() : loadProducts())}
                className="p-2 sm:p-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors shrink-0 cursor-pointer"
                title="Refresh Content"
              >
                <RefreshCcw size={17} className="text-slate-600" />
              </button>

              {/* Alarm Control & Status Button in Header */}
              <button
                onClick={() => setShowAlarmSettingsModal(true)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl text-xs font-bold transition-all shrink-0 cursor-pointer shadow-xs ${
                  isAlarmRinging
                    ? "bg-red-600 text-white animate-pulse ring-2 ring-red-400"
                    : isAlarmEnabled
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200/80 hover:bg-emerald-100"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
                title="New Order Alarm & Push Notification Settings"
              >
                {isAlarmRinging ? (
                  <>
                    <Volume2 size={16} className="animate-bounce" />
                    <span className="font-black text-[11px] sm:text-xs">ALARM RINGING!</span>
                  </>
                ) : (
                  <>
                    {isAlarmEnabled ? (
                      <BellRing size={16} className="text-emerald-600" />
                    ) : (
                      <VolumeX size={16} />
                    )}
                    <span className="hidden sm:inline">Alarm:</span>
                    <span className={isAlarmEnabled ? "text-emerald-700 font-black" : "text-slate-500 font-bold"}>
                      {isAlarmEnabled ? "ON" : "OFF"}
                    </span>
                  </>
                )}
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

              {activeTab === "products" && (
                <button
                  onClick={() => {
                    setEditingProduct(null);
                    setProductForm({
                      name: "",
                      category: "",
                      price: "",
                      unit: "piece",
                      image: "",
                      description: "",
                      isAvailable: true
                    });
                    setShowProductModal(true);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-all shadow-md shadow-emerald-600/20 text-xs sm:text-sm shrink-0 cursor-pointer active:scale-95"
                >
                  <Plus size={16} />
                  <span>Add Product</span>
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

                  <form onSubmit={handleSaveProduct} className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
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

                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                          Category
                        </label>
                        {categories.length === 0 ? (
                          <div className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 text-slate-500 font-medium text-sm flex items-center justify-between">
                            <span>No category available</span>
                          </div>
                        ) : (
                          <select
                            required
                            value={productForm.category}
                            onChange={(e) =>
                              setProductForm({ ...productForm, category: e.target.value })
                            }
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none bg-white font-medium text-slate-700 text-sm cursor-pointer"
                          >
                            <option value="">Select Category</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.name}>
                                {c.name}
                              </option>
                            ))}
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
                          Image URL {editingProduct && <span className="text-slate-400 font-normal lowercase">(direct image link, Drive or Dropbox)</span>}
                        </label>
                        <div className="flex gap-3">
                          <input
                            type="text"
                            required={!editingProduct}
                            placeholder="Google Drive, Dropbox, or direct link"
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
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                                onError={handleImgError}
                              />
                            </div>
                          )}
                        </div>
                        <p className="mt-1 text-[10px] text-slate-400">
                          Links from Google Drive & Dropbox will be automatically converted to direct images.
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
                        className="flex-1 py-3 bg-emerald-500 text-white font-bold rounded-xl hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-100 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <Save size={18} />
                        <span>{editingProduct ? "Update Product" : "Add Product"}</span>
                      </button>
                    </div>
                  </form>
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
              {/* Stat Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow">
                  <div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                      Recent Orders (12h)
                    </p>
                    <h4 className="text-2xl font-black text-slate-950">
                      {stats.recentOrders}
                    </h4>
                    <p className="text-[10px] text-slate-500 mt-0.5">Excludes cancelled orders</p>
                  </div>
                  <div className="w-12 h-12 bg-sky-50 rounded-xl flex items-center justify-center text-sky-500 shrink-0 shadow-inner">
                    <ShoppingCart size={22} className="stroke-[2.5]" />
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow">
                  <div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                      Total Products
                    </p>
                    <h4 className="text-2xl font-black text-slate-950">
                      {stats.totalProducts}
                    </h4>
                    <p className="text-[10px] text-slate-500 mt-0.5">Active catalog inventory</p>
                  </div>
                  <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center text-amber-500 shrink-0 shadow-inner">
                    <Package size={22} className="stroke-[2.5]" />
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow">
                  <div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                      Revenue (12h)
                    </p>
                    <h4 className="text-2xl font-black text-emerald-600">
                      ₹{stats.revenue.toLocaleString()}
                    </h4>
                    <p className="text-[10px] text-slate-500 mt-0.5">Accepted & Delivered only</p>
                  </div>
                  <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center text-emerald-500 shrink-0 shadow-inner">
                    <span className="text-lg font-bold font-sans">₹</span>
                  </div>
                </div>
              </div>

              {/* Order Status Filters */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-b border-slate-100 pb-4">
                <h3 className="font-black text-slate-800 text-lg flex items-center gap-2">
                  <span>Recent Activity Orders</span>
                  <span className="text-xs font-extrabold bg-slate-200 text-slate-700 px-2.5 py-0.5 rounded-full">
                    {filteredOrders.length} Total
                  </span>
                </h3>

                <div className="flex flex-wrap gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                  {["all", "pending", "accepted", "delivered", "cancelled", "returns"].map((key) => {
                    const label =
                      key === "all"
                        ? "All Orders"
                        : key === "returns"
                        ? "RETURNS 🔄"
                        : key.toUpperCase();

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
                            ? "bg-emerald-500 text-white shadow-sm shadow-emerald-100"
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

                                {isReturn && (
                                  <span
                                    className={`text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider shrink-0 flex items-center gap-1 ${
                                      isReturnApproved
                                        ? "bg-emerald-600 text-white"
                                        : isReturnRejected
                                        ? "bg-slate-500 text-white"
                                        : "bg-orange-500 text-white animate-pulse shadow-sm"
                                    }`}
                                  >
                                    {!isReturnApproved && !isReturnRejected && (
                                      <span className="inline-block w-1 h-1 rounded-full bg-white animate-ping" />
                                    )}
                                    <span>
                                      {isReturnApproved
                                        ? "RETURN APPROVED"
                                        : isReturnRejected
                                        ? "RETURN REJECTED"
                                        : "RETURN REQUEST"}
                                    </span>
                                  </span>
                                )}

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

                            {/* Badge */}
                            <span
                              className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm ${
                                currentStatus === "accepted"
                                  ? "bg-emerald-100 text-emerald-800 border border-emerald-200/50"
                                  : currentStatus === "delivered"
                                  ? "bg-blue-100 text-blue-800 border border-blue-200/50"
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
                                : order.status.toUpperCase()}
                            </span>
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

                          {/* Action Buttons */}
                          <div className="grid grid-cols-3 gap-1.5 sm:gap-2 mt-2 pt-2 border-t border-slate-100 relative">
                            {isUpdating && (
                              <div className="absolute inset-0 bg-white/75 backdrop-blur-[1px] flex items-center justify-center z-10 rounded-xl">
                                <RefreshCcw size={16} className="animate-spin text-emerald-600 mr-2" />
                                <span className="text-xs font-bold text-slate-600">Updating...</span>
                              </div>
                            )}

                            {isReturn ? (
                              /* Return Order Buttons */
                              <>
                                <button
                                  disabled={isUpdating || isReturnApproved}
                                  onClick={() =>
                                    handleUpdateOrderStatus(
                                      order.id,
                                      "return_approved",
                                      "Return Request Approved Successfully"
                                    )
                                  }
                                  className={`col-span-2 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 py-2 sm:py-2.5 px-2 rounded-xl font-bold text-[10px] sm:text-[11px] uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    isReturnApproved
                                      ? "bg-emerald-100 text-emerald-800 border border-emerald-200/50 cursor-not-allowed opacity-60"
                                      : "bg-emerald-500 hover:bg-emerald-600 text-white shadow-md active:scale-[0.98]"
                                  }`}
                                >
                                  <CircleCheckBig size={14} className="shrink-0" />
                                  <span className="truncate">
                                    {isReturnApproved ? "Approved" : "Approve Return"}
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
                                  className={`col-span-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 py-2 sm:py-2.5 px-2 rounded-xl font-bold text-[10px] sm:text-[11px] uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    isReturnRejected
                                      ? "bg-red-100 text-red-800 border border-red-200/50 cursor-not-allowed opacity-60"
                                      : "bg-red-600 hover:bg-red-700 text-white shadow-md active:scale-[0.98]"
                                  }`}
                                >
                                  <CircleX size={14} className="shrink-0" />
                                  <span className="truncate">{isReturnRejected ? "Rejected" : "Reject"}</span>
                                </button>
                              </>
                            ) : (
                              /* Standard Order Buttons */
                              <>
                                <button
                                  disabled={currentStatus !== "pending" || isUpdating}
                                  onClick={() =>
                                    handleUpdateOrderStatus(
                                      order.id,
                                      "accepted",
                                      "Order Accepted Successfully"
                                    )
                                  }
                                  className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 py-2 sm:py-2.5 px-1.5 sm:px-2 rounded-xl font-bold text-[10px] sm:text-[11px] uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    currentStatus === "accepted" || currentStatus === "delivered"
                                      ? "bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200"
                                      : currentStatus === "pending"
                                      ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-md active:scale-[0.98]"
                                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                                  }`}
                                  title="Accept Order"
                                >
                                  <CircleCheckBig size={14} className="shrink-0" />
                                  <span className="truncate">Accept</span>
                                </button>

                                <button
                                  disabled={currentStatus !== "accepted" || isUpdating}
                                  onClick={() =>
                                    handleUpdateOrderStatus(
                                      order.id,
                                      "delivered",
                                      "Order Delivered Successfully"
                                    )
                                  }
                                  className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 py-2 sm:py-2.5 px-1.5 sm:px-2 rounded-xl font-bold text-[10px] sm:text-[11px] uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    currentStatus === "delivered"
                                      ? "bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200"
                                      : currentStatus === "accepted"
                                      ? "bg-blue-500 hover:bg-blue-600 text-white shadow-md active:scale-[0.98]"
                                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                                  }`}
                                  title="Mark as Delivered"
                                >
                                  <ThumbsUp size={14} className="shrink-0" />
                                  <span className="truncate">Delivered</span>
                                </button>

                                <button
                                  disabled={
                                    (currentStatus !== "pending" && currentStatus !== "accepted") ||
                                    isUpdating
                                  }
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        "Are you sure you want to cancel / reject this order?"
                                      )
                                    ) {
                                      handleUpdateOrderStatus(
                                        order.id,
                                        "cancelled",
                                        "Order Cancelled Successfully"
                                      );
                                    }
                                  }}
                                  className={`flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 py-2 sm:py-2.5 px-1.5 sm:px-2 rounded-xl font-bold text-[10px] sm:text-[11px] uppercase tracking-wider transition-all cursor-pointer min-h-[44px] ${
                                    currentStatus === "cancelled"
                                      ? "bg-slate-100 text-slate-400 cursor-not-allowed opacity-60 border border-slate-200"
                                      : currentStatus === "pending" || currentStatus === "accepted"
                                      ? "bg-red-500 hover:bg-red-600 text-white shadow-md active:scale-[0.98]"
                                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                                  }`}
                                  title="Cancel or Reject Order"
                                >
                                  <CircleX size={14} className="shrink-0" />
                                  <span className="truncate">Reject</span>
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* TAB 2: PRODUCTS MANAGEMENT */
            <div>
              {filteredProducts.length === 0 ? (
                <div className="bg-white rounded-2xl p-12 text-center border border-dashed border-slate-300">
                  <Package className="mx-auto text-slate-300 mb-4" size={48} />
                  <h3 className="text-lg font-semibold text-slate-900">No Products Found</h3>
                  <p className="text-slate-500">
                    {searchQuery
                      ? "No products match your search criteria."
                      : "Your product list will appear here."}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
                  {filteredProducts.map((prod) => (
                    <motion.div
                      key={prod.id}
                      layout
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={`bg-white rounded-2xl shadow-sm border overflow-hidden transition-all duration-300 ${
                        prod.isAvailable
                          ? "border-slate-200 hover:shadow-md"
                          : "grayscale opacity-75 border-slate-200"
                      }`}
                    >
                      <div className="relative aspect-square bg-slate-100">
                        {prod.imageUrl || prod.image ? (
                          <img
                            src={formatImageUrl(prod.imageUrl || prod.image || "")}
                            alt={prod.name}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                            onError={handleImgError}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-300">
                            <Package size={48} />
                          </div>
                        )}

                        {!prod.isAvailable && (
                          <div className="absolute inset-0 bg-slate-900/40 flex items-center justify-center backdrop-blur-[2px]">
                            <span className="bg-white text-slate-900 px-4 py-2 rounded-full font-black text-xs uppercase tracking-widest shadow-xl">
                              Unavailable
                            </span>
                          </div>
                        )}

                        <div className="absolute top-3 left-3 flex items-center gap-1.5 flex-wrap">
                          <span className="bg-white/95 backdrop-blur-sm text-[10px] font-bold text-slate-700 px-2 py-0.5 rounded-md uppercase tracking-wider shadow-sm">
                            {prod.category}
                          </span>
                          {prod.unit && (
                            <span className="bg-emerald-600/90 backdrop-blur-sm text-[10px] font-bold text-white px-2 py-0.5 rounded-md uppercase tracking-wider shadow-sm">
                              {prod.unit}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="p-5">
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

                        <div className="flex items-baseline gap-1 mb-2">
                          <span className="text-emerald-600 font-extrabold text-lg">₹{prod.price}</span>
                          {prod.unit && (
                            <span className="text-xs font-semibold text-slate-400">/ {prod.unit}</span>
                          )}
                        </div>

                        <p className="text-xs text-slate-500 mb-4 line-clamp-1">
                          {prod.description || "No description available"}
                        </p>

                        <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                              Status
                            </span>
                            <span
                              className={`text-xs font-bold ${
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
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 cursor-pointer ${
                              prod.isAvailable ? "bg-emerald-500" : "bg-slate-200"
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                prod.isAvailable ? "translate-x-6" : "translate-x-1"
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
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
          <ShoppingCart
            size={20}
            className={activeTab === "orders" ? "stroke-[2.5px]" : "stroke-2"}
          />
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
