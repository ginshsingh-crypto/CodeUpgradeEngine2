/**
 * Admin Routes for Cloudflare Workers
 * 
 * Admin-only endpoints for order management, user management, and refunds.
 * Requires admin role to access.
 */

import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createDb } from "../db";
import { createStorage } from "../storage/database";
import { createSessionStore } from "../storage/kv-sessions";
import { createStorageService } from "../storage/r2";

const admin = new Hono<HonoEnv>();

// Admin auth middleware - check user has isAdmin flag
async function requireAdmin(c: any, next: () => Promise<void>) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ message: "Authentication required" }, 401);
    }

    const token = authHeader.slice(7);
    const sessions = createSessionStore(c.env.SESSIONS);
    const userId = await sessions.validateSession(token);

    if (!userId) {
        return c.json({ message: "Invalid or expired session" }, 401);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);
    const user = await storage.getUser(userId);

    if (!user) {
        return c.json({ message: "User not found" }, 404);
    }

    // Schema has isAdmin as integer (0 or 1), not role string
    if (!user.isAdmin || user.isAdmin !== 1) {
        return c.json({ message: "Admin access required" }, 403);
    }

    c.set("userId", userId);
    c.set("user", user);
    await next();
}

// Get all orders (admin view)
admin.get("/orders", requireAdmin, async (c) => {
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const orders = await storage.getAllOrders();
    return c.json(orders);
});

// Get single order with details
admin.get("/orders/:orderId", requireAdmin, async (c) => {
    const orderId = c.req.param("orderId");
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrderWithFiles(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    return c.json(order);
});

// Update order status (for processing workflow)
admin.patch("/orders/:orderId/status", requireAdmin, async (c) => {
    const orderId = c.req.param("orderId");
    const { status, notes } = await c.req.json();

    if (!status) {
        return c.json({ message: "status is required" }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    const updated = await storage.updateOrder(orderId, {
        status,
        notes: notes || order.notes,
    });

    return c.json(updated);
});

// Upload output file (processed result) - Get presigned URL
// UI calls: POST /api/admin/orders/:orderId/upload-url
admin.post("/orders/:orderId/upload-url", requireAdmin, async (c) => {
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    // Get presigned URL for admin to upload output
    const { generateUploadUrl, getOrderOutputKey } = await import("../storage/r2-presigned");

    const { fileName } = await c.req.json();
    if (!fileName) {
        return c.json({ message: "fileName is required" }, 400);
    }

    const storageKey = getOrderOutputKey(orderId, fileName);

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const { uploadUrl, expiresAt } = await generateUploadUrl(credentials, storageKey, {
        contentType: "application/zip",
        expiresIn: 3600,
    });

    return c.json({
        uploadUrl,
        storageKey,
        expiresAt: expiresAt.toISOString(),
    });
});

// Confirm output upload - UI calls: POST /api/admin/orders/:orderId/upload-complete
admin.post("/orders/:orderId/upload-complete", requireAdmin, async (c) => {
    const orderId = c.req.param("orderId");
    const { storageKey, fileName } = await c.req.json();

    if (!storageKey || !fileName) {
        return c.json({ message: "storageKey and fileName required" }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    // Verify file exists
    const r2 = createStorageService(c.env.FILES_BUCKET);
    const exists = await r2.objectExists(storageKey);
    if (!exists.exists) {
        return c.json({ message: "File not found in storage" }, 400);
    }

    // Record output file
    await storage.createFile({
        orderId,
        fileType: "output",
        fileName,
        fileSize: exists.size || null,
        storageKey,
        mimeType: "application/zip",
    });

    // Update order to complete
    await storage.updateOrder(orderId, {
        status: "complete",
        completedAt: new Date(),
    });

    return c.json({ success: true });
});

// Get all users
admin.get("/users", requireAdmin, async (c) => {
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const users = await storage.getAllUsers();
    return c.json(users);
});

// Get refund requests list
admin.get("/refunds", requireAdmin, async (c) => {
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    // Get all refund_request transactions
    const refunds = await storage.getRefundRequests();
    return c.json(refunds);
});

// Approve refund request
admin.post("/refunds/:transactionId/approve", requireAdmin, async (c) => {
    const transactionId = c.req.param("transactionId");
    const adminUserId = c.get("userId")!;

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const result = await storage.approveRefund(transactionId, adminUserId);
    if (!result.success) {
        return c.json({ message: result.error }, 400);
    }

    return c.json({ success: true });
});

// Reject refund request
admin.post("/refunds/:transactionId/reject", requireAdmin, async (c) => {
    const transactionId = c.req.param("transactionId");
    const adminUserId = c.get("userId")!;
    const { reason } = await c.req.json();

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const result = await storage.rejectRefund(transactionId, adminUserId, reason);
    if (!result.success) {
        return c.json({ message: result.error }, 400);
    }

    return c.json({ success: true });
});

export { admin };

