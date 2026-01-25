/**
 * Order Routes for Cloudflare Workers
 * 
 * Handles order creation, status, file uploads, and downloads.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { HonoEnv } from "../types";
import { createDb } from "../db";
import { createStorage } from "../storage/database";
import { createSessionStore } from "../storage/kv-sessions";
import { createStorageService } from "../storage/r2";
import { createMoyasarClient } from "../services/moyasar";
import { createEmailService } from "../services/email";

const orders = new Hono<HonoEnv>();

// Schemas
const createOrderSchema = z.object({
    sheetCount: z.number().int().positive(),
    sheets: z.array(z.object({
        sheetElementId: z.string(),
        sheetNumber: z.string(),
        sheetName: z.string(),
    })),
});

const uploadCompleteSchema = z.object({
    fileName: z.string(),
    fileSize: z.number().optional(),
    storageKey: z.string(),
});

// Auth middleware
async function requireAuth(c: any, next: () => Promise<void>) {
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

    c.set("userId", userId);
    c.set("user", user);
    await next();
}

// Get price per sheet
orders.get("/price", (c) => {
    const price = parseInt(c.env.PRICE_PER_SHEET_SAR) || 150;
    return c.json({ pricePerSheet: price, currency: "SAR" });
});

// Get Moyasar publishable key
orders.get("/payment-config", (c) => {
    return c.json({
        publishableKey: c.env.MOYASAR_PUBLISHABLE_KEY,
    });
});

// Get user's orders
orders.get("/", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const userOrders = await storage.getOrdersByUserId(userId);
    return c.json(userOrders);
});

// Create new order
orders.post("/", requireAuth, zValidator("json", createOrderSchema), async (c) => {
    const userId = c.get("userId")!;
    const { sheetCount, sheets } = c.req.valid("json");

    // Security: Validate sheet count matches array
    if (sheets.length !== sheetCount) {
        return c.json({
            message: `Sheet count mismatch: claimed ${sheetCount} but provided ${sheets.length} sheets`,
        }, 400);
    }

    const pricePerSheet = parseInt(c.env.PRICE_PER_SHEET_SAR) || 150;
    const totalPriceSar = sheetCount * pricePerSheet;

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.createOrderWithSheets({
        userId,
        sheetCount,
        totalPriceSar,
        status: "pending",
    }, sheets);

    return c.json(order, 201);
});

// Get single order
orders.get("/:orderId", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrderWithFiles(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    return c.json(order);
});

// Get order status
orders.get("/:orderId/status", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrderWithFiles(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    return c.json(order);
});

// Initiate checkout (redirect to payment page)
orders.get("/:orderId/checkout", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "pending") {
        return c.json({ message: "Order is not pending payment" }, 400);
    }

    // Redirect to frontend payment page
    return c.redirect(`/payment/${orderId}`);
});

// Create payment intent for Moyasar
orders.post("/:orderId/payment-intent", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "pending") {
        return c.json({ message: "Order is not pending payment" }, 400);
    }

    const moyasar = createMoyasarClient(
        c.env.MOYASAR_SECRET_KEY,
        c.env.MOYASAR_PUBLISHABLE_KEY
    );

    const host = c.req.header("Host") || "lod400.com";
    const protocol = c.req.header("X-Forwarded-Proto") || "https";
    const callbackUrl = `${protocol}://${host}/api/payment/callback`;

    const payment = await moyasar.createPayment({
        amount: order.totalPriceSar * 100, // Convert to halalas
        currency: "SAR",
        description: `LOD 400 Shop Drawings - ${order.sheetCount} sheets`,
        callback_url: callbackUrl,
        metadata: {
            orderId,
            userId,
        },
    });

    return c.json({
        paymentId: payment.id,
        amount: payment.amount,
        formUrl: moyasar.buildPaymentFormUrl(payment.id),
    });
});

// Get upload URL for order files - returns R2 presigned URL
orders.post("/:orderId/upload-url", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { fileName } = await c.req.json();

    if (!fileName) {
        return c.json({ message: "fileName is required" }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "paid") {
        return c.json({ message: "Order must be paid before uploading files" }, 400);
    }

    // Generate R2 presigned PUT URL for direct client upload
    // This bypasses the Workers body size limit (100MB-500MB)
    const { generateUploadUrl, getOrderInputKey } = await import("../storage/r2-presigned");

    const storageKey = getOrderInputKey(orderId, fileName);

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const { uploadUrl, expiresAt } = await generateUploadUrl(credentials, storageKey, {
        contentType: "application/zip",
        expiresIn: 3600, // 1 hour
    });

    return c.json({
        uploadUrl,
        storageKey,
        expiresAt: expiresAt.toISOString(),
    });
});

// DEPRECATED: Direct file upload for small files only
// Use the upload-url + upload-complete flow instead
// Kept for backwards compatibility - has Workers body size limits
orders.put("/:orderId/upload/:fileName", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const fileName = c.req.param("fileName");

    const db = createDb(c.env.DATABASE_URL);
    const dbStorage = createStorage(db);

    const order = await dbStorage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "paid") {
        return c.json({ message: "Order must be paid before uploading files" }, 400);
    }

    // WARNING: This has body size limits in Workers (~100MB-500MB depending on plan)
    // For large files, use the presigned URL flow instead
    const body = await c.req.arrayBuffer();

    // Use input/ prefix to match presigned URL flow
    const { getOrderInputKey } = await import("../storage/r2-presigned");
    const storageKey = getOrderInputKey(orderId, fileName);

    // Store in R2
    const r2 = createStorageService(c.env.FILES_BUCKET);
    await r2.putObject(storageKey, body, {
        contentType: "application/zip",
    });

    // Validate it's a ZIP file
    const validation = await r2.validateZipFile(storageKey);
    if (!validation.valid) {
        await r2.deleteObject(storageKey);
        return c.json({ message: validation.error }, 400);
    }

    // Record in database
    await dbStorage.createFile({
        orderId,
        fileType: "input",
        fileName,
        fileSize: body.byteLength,
        storageKey,
        mimeType: "application/zip",
    });

    // Update order status
    await dbStorage.updateOrder(orderId, {
        status: "uploaded",
        uploadedAt: new Date(),
    });

    return c.json({ success: true, storageKey });
});

// Complete upload (for resumable uploads from add-in)
orders.post("/:orderId/upload-complete", requireAuth, zValidator("json", uploadCompleteSchema), async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { fileName, fileSize, storageKey } = c.req.valid("json");

    // SECURITY: Validate storageKey matches expected pattern for this order
    const expectedPrefix = `orders/${orderId}/input/`;
    if (!storageKey.startsWith(expectedPrefix)) {
        return c.json({
            message: `Invalid storageKey. Must start with ${expectedPrefix}`
        }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const dbStorage = createStorage(db);

    const order = await dbStorage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    // Only allow upload for paid orders
    if (order.status !== "paid") {
        return c.json({ message: "Order must be paid before uploading files" }, 400);
    }

    // Verify file exists in R2
    const r2 = createStorageService(c.env.FILES_BUCKET);
    const exists = await r2.objectExists(storageKey);
    if (!exists.exists) {
        return c.json({ message: "File not found in storage" }, 400);
    }

    // Validate ZIP
    const validation = await r2.validateZipFile(storageKey);
    if (!validation.valid) {
        return c.json({ message: validation.error }, 400);
    }

    // Record in database
    await dbStorage.createFile({
        orderId,
        fileType: "input",
        fileName,
        fileSize: exists.size || fileSize || null,
        storageKey,
        mimeType: "application/zip",
    });

    // Update order status
    await dbStorage.updateOrder(orderId, {
        status: "uploaded",
        uploadedAt: new Date(),
    });

    return c.json({ success: true });
});

// Download output file
orders.get("/:orderId/download/:fileName", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const fileName = c.req.param("fileName");

    const db = createDb(c.env.DATABASE_URL);
    const dbStorage = createStorage(db);

    const order = await dbStorage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "complete") {
        return c.json({ message: "Order is not complete" }, 400);
    }

    const r2 = createStorageService(c.env.FILES_BUCKET);
    const storageKey = `orders/${orderId}/output/${fileName}`;

    const stream = await r2.getDownloadStream(storageKey);
    if (!stream) {
        return c.json({ message: "File not found" }, 404);
    }

    const metadata = await r2.getObjectMetadata(storageKey);

    return new Response(stream, {
        headers: {
            "Content-Type": metadata?.contentType || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Content-Length": metadata?.size.toString() || "",
        },
    });
});

// Pay with balance - UI calls this endpoint
// This is an alias/proxy to the balance route
orders.post("/:orderId/pay-with-balance", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { companyId } = await c.req.json();

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "pending") {
        return c.json({ message: "Order is not pending payment" }, 400);
    }

    const amountRequired = order.totalPriceSar;
    let availableBalance: number;

    if (companyId) {
        const isMember = await storage.isUserCompanyMember(userId, companyId);
        if (!isMember) {
            return c.json({ message: "Not a member of this company" }, 403);
        }
        availableBalance = await storage.getCompanyBalance(companyId);
    } else {
        availableBalance = await storage.getUserBalance(userId);
    }

    if (availableBalance < amountRequired) {
        return c.json({
            message: "Insufficient balance",
            required: amountRequired,
            available: availableBalance,
        }, 400);
    }

    // Deduct balance
    if (companyId) {
        await storage.updateCompanyBalance(companyId, -amountRequired);
    } else {
        await storage.updateUserBalance(userId, -amountRequired);
    }

    // Log transaction
    await storage.createBalanceTransaction({
        userId,
        companyId: companyId || undefined,
        type: "debit",
        amountSar: -amountRequired,
        orderId,
        status: "completed",
        note: `Payment for order ${orderId}`,
    });

    // Update order to paid
    await storage.updateOrder(orderId, {
        status: "paid",
        paidAt: new Date(),
    });

    return c.json({ success: true, orderId });
});

// Cancel order (only if pending)
orders.post("/:orderId/cancel", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    if (order.status !== "pending") {
        return c.json({ message: "Cannot cancel order that is not pending" }, 400);
    }

    await storage.updateOrderStatus(orderId, "cancelled");

    return c.json({ success: true });
});

// Request refund (if paid)
orders.post("/:orderId/refund-request", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const order = await storage.getOrder(orderId);
    if (!order) {
        return c.json({ message: "Order not found" }, 404);
    }

    if (order.userId !== userId) {
        return c.json({ message: "Forbidden" }, 403);
    }

    // Allow refund request for paid, processing, uploaded, complete statuses
    if (["paid", "processing", "uploaded", "complete"].includes(order.status) === false) {
        return c.json({ message: "Order is not eligible for refund" }, 400);
    }

    // Create a refund request transaction
    await storage.createBalanceTransaction({
        userId,
        type: "refund_request",
        amountSar: order.totalPriceSar,
        orderId,
        status: "pending",
        note: "User requested refund via UI",
    });

    return c.json({ success: true });
});

export { orders };

