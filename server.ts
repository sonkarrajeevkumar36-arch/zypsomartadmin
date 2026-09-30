import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import {
  updateOrderStatusController,
  getOrderController,
  listOrdersController,
  deleteOrderController
} from "./server/orderController.js";
import {
  getShopStatusController,
  updateShopStatusController
} from "./server/shopController.js";
import {
  registerDeviceTokenController,
  unregisterDeviceTokenController,
  testAlarmController,
  dispatchNewOrderAlarmController,
  getAlarmStatusController,
  testNotificationController,
  configureServiceAccountController
} from "./server/fcmController.js";
import { startServerOrderWatcher } from "./server/orderWatcher.js";

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  // Body parser middlewares
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      console.log(`[API] ${req.method} ${req.path}`);
    }
    next();
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  // Shop Open / Closed Status API (for Admin & Customer Apps)
  app.get("/api/shop/status", getShopStatusController);
  app.post("/api/shop/status", updateShopStatusController);
  app.put("/api/shop/status", updateShopStatusController);

  // Order status transition API endpoints with validation
  app.post("/api/orders/:id/status", updateOrderStatusController);
  app.patch("/api/orders/:id/status", updateOrderStatusController);
  app.post("/api/orders/status", updateOrderStatusController);
  app.delete("/api/orders/:id", deleteOrderController);

  // Order query endpoints
  app.get("/api/orders/:id", getOrderController);
  app.get("/api/orders", listOrdersController);

  // FCM Admin Alarm Endpoints
  app.post("/api/admin/fcm-token", registerDeviceTokenController);
  app.delete("/api/admin/fcm-token", unregisterDeviceTokenController);
  app.post("/api/admin/test-alarm", testAlarmController);
  app.post("/api/admin/test-notification", testNotificationController);
  app.post("/api/admin/service-account", configureServiceAccountController);
  app.post("/api/admin/dispatch-alarm", dispatchNewOrderAlarmController);
  app.get("/api/admin/alarm-status", getAlarmStatusController);

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server
        }
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    // Start 24/7 background order watcher for closed-app alarm notifications
    startServerOrderWatcher().catch((err) => {
      console.warn("[Order Watcher] Startup warning:", err);
    });
  });
}

startServer();
