/**
 * Add-in Routes for Cloudflare Workers
 * 
 * API endpoints specifically for the Revit add-in with version enforcement.
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

const addin = new Hono<HonoEnv>();

// Schemas
const createOrderSchema = z.object({
    sheetCount: z.number().int().positive(),
    sheets: z.array(z.object({
        sheetElementId: z.string(),
        sheetNumber: z.string(),
        sheetName: z.string(),
    })),
});

/**
 * Compare semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map((n) => parseInt(n, 10) || 0);
    const partsB = b.split(".").map((n) => parseInt(n, 10) || 0);

    for (let i = 0; i < 3; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA < numB) return -1;
        if (numA > numB) return 1;
    }
    return 0;
}

// Version enforcement middleware
async function checkAddinVersion(c: any, next: () => Promise<void>) {
    const clientVersion = c.req.header("X-Client-Version");
    const minVersion = c.env.MIN_ADDIN_VERSION || "1.0.0";

    // If no version header, allow for backwards compatibility
    if (!clientVersion) {
        return next();
    }

    if (compareVersions(clientVersion, minVersion) < 0) {
        return c.json({
            message: `Your add-in version (${clientVersion}) is outdated. Please update to version ${minVersion} or later.`,
            minVersion,
            currentVersion: clientVersion,
        }, 426);
    }

    await next();
}

// Auth middleware for add-in
async function requireAddinAuth(c: any, next: () => Promise<void>) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({
            message: "Authentication required. Please sign in with your email and password.",
        }, 401);
    }

    const token = authHeader.slice(7);
    const sessions = createSessionStore(c.env.SESSIONS);
    const userId = await sessions.validateSession(token);

    if (!userId) {
        return c.json({
            message: "Session expired. Please sign in again.",
        }, 401);
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

// Apply middleware to all routes
addin.use("*", checkAddinVersion);

// Validate session
addin.get("/validate", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const minVersion = c.env.MIN_ADDIN_VERSION || "1.0.0";

    return c.json({
        valid: true,
        userId,
        minVersion,
    });
});

// Get user's orders
addin.get("/orders", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const orders = await storage.getOrdersByUserId(userId);
    return c.json(orders);
});

// Get order status
addin.get("/orders/:orderId/status", requireAddinAuth, async (c) => {
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

// Create order with checkout URL
addin.post("/create-order", requireAddinAuth, zValidator("json", createOrderSchema), async (c) => {
    const userId = c.get("userId")!;
    const user = c.get("user")!;
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

    // Build checkout URL
    const host = c.req.header("Host") || "lod400.com";
    const protocol = c.req.header("X-Forwarded-Proto") || "https";
    const checkoutUrl = `${protocol}://${host}/payment/${order.id}`;

    return c.json({
        order,
        checkoutUrl,
    }, 201);
});

// Get upload URL for add-in - returns R2 presigned URL
addin.post("/orders/:orderId/upload-url", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { fileName, fileSize } = await c.req.json();

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
        // Worker endpoint for confirming upload completion
        completeUrl: `/api/addin/orders/${orderId}/upload-complete`,
    });
});

// Confirm upload completion - called after client uploads directly to R2
// This validates the file and updates the database
addin.post("/orders/:orderId/upload-complete", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { storageKey, fileName, fileSize } = await c.req.json();

    if (!storageKey || !fileName) {
        return c.json({ message: "storageKey and fileName are required" }, 400);
    }

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

    // Allow upload for 'paid' status only - this is the expected flow
    if (order.status !== "paid") {
        return c.json({ message: "Order must be paid before uploading files" }, 400);
    }

    // Verify file exists in R2 and validate
    const r2 = createStorageService(c.env.FILES_BUCKET);
    const exists = await r2.objectExists(storageKey);
    if (!exists.exists) {
        return c.json({ message: "File not found in storage. Upload may have failed." }, 400);
    }

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
        fileSize: exists.size || fileSize || null,
        storageKey,
        mimeType: "application/zip",
    });

    // Update order status
    await dbStorage.updateOrder(orderId, {
        status: "uploaded",
        uploadedAt: new Date(),
    });

    // Send confirmation email
    const user = c.get("user")!;
    if (user.email) {
        const emailService = createEmailService(c.env.RESEND_API_KEY);
        emailService.sendOrderPaidEmail(
            user.email,
            orderId,
            order.sheetCount,
            user.firstName || undefined
        ).catch((err) => console.error("Failed to send email:", err));
    }

    return c.json({ success: true, storageKey });
});

// Get user balance
addin.get("/balance", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const personalBalance = await storage.getUserBalance(userId);
    const companies = await storage.getUserCompanies(userId);

    return c.json({
        personalBalance,
        companies,
    });
});

// Download completed files
addin.get("/orders/:orderId/download/:fileName", requireAddinAuth, async (c) => {
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

async function getLatestOutputFile(dbStorage: ReturnType<typeof createStorage>, orderId: string, fileName?: string) {
    const files = await dbStorage.getFilesByOrderId(orderId);
    const outputFiles = files.filter((f: any) => f.fileType === "output");

    if (outputFiles.length === 0) {
        return null;
    }

    if (fileName) {
        const match = outputFiles.find((f: any) => f.fileName === fileName);
        if (match) return match;
    }

    outputFiles.sort((a: any, b: any) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
    });

    return outputFiles[0];
}

// Get download URL (presigned) - used by add-in ApiService.cs
addin.get("/orders/:orderId/download-url", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");

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

    const outputFile = await getLatestOutputFile(dbStorage, orderId);
    if (!outputFile) {
        return c.json({ message: "No output file found" }, 404);
    }

    const { generateDownloadUrl } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const { downloadUrl, expiresAt } = await generateDownloadUrl(credentials, outputFile.storageKey, {
        expiresIn: 3600,
    });

    return c.json({
        downloadUrl,
        downloadURL: downloadUrl,
        fileName: outputFile.fileName,
        expiresAt: expiresAt.toISOString(),
    });
});

// Post-based download URL (supports explicit fileName)
addin.post("/orders/:orderId/download-url", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const body = await c.req.json().catch(() => ({}));
    const fileName = body?.fileName as string | undefined;

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

    const outputFile = await getLatestOutputFile(dbStorage, orderId, fileName);
    if (!outputFile) {
        return c.json({ message: "No output file found" }, 404);
    }

    // Generate presigned GET URL for download
    const { generateDownloadUrl } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const { downloadUrl, expiresAt } = await generateDownloadUrl(credentials, outputFile.storageKey, {
        expiresIn: 3600, // 1 hour
    });

    return c.json({
        downloadUrl,
        downloadURL: downloadUrl,
        fileName: outputFile.fileName,
        expiresAt: expiresAt.toISOString(),
    });
});

// ============================================
// RESUMABLE UPLOADS (Multipart, R2 compatible)
// ============================================

const MULTIPART_MIN_PART_SIZE = 8 * 1024 * 1024; // 8 MB (>= 5 MB minimum)
const MULTIPART_MAX_PARTS = 10000;

// Initiate multipart upload session
addin.post("/orders/:orderId/resumable-upload", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { fileName, fileSize } = await c.req.json();

    if (!fileName || !fileSize) {
        return c.json({ message: "fileName and fileSize are required" }, 400);
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

    const { createMultipartUpload, getOrderInputKey } = await import("../storage/r2-presigned");

    const storageKey = getOrderInputKey(orderId, fileName);

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const { uploadId } = await createMultipartUpload(credentials, storageKey, "application/zip");

    const sizeFromLimit = Math.ceil(Number(fileSize) / MULTIPART_MAX_PARTS);
    const partSize = Math.max(MULTIPART_MIN_PART_SIZE, sizeFromLimit);

    return c.json({
        uploadId,
        storageKey,
        partSize,
        // Backwards-compat for older clients expecting sessionUri
        sessionUri: uploadId,
    });
});

// Generate presigned URL for a multipart part
addin.post("/orders/:orderId/resumable-upload/part-url", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { uploadId, storageKey, partNumber } = await c.req.json();

    if (!uploadId || !storageKey || !partNumber) {
        return c.json({ message: "uploadId, storageKey, and partNumber are required" }, 400);
    }

    const expectedPrefix = `orders/${orderId}/input/`;
    if (!storageKey.startsWith(expectedPrefix)) {
        return c.json({ message: `Invalid storageKey. Must start with ${expectedPrefix}` }, 400);
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

    const { generatePartUploadUrl } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const uploadUrl = await generatePartUploadUrl(
        credentials,
        storageKey,
        uploadId,
        Number(partNumber),
        3600
    );

    return c.json({
        uploadUrl,
        expiresIn: 3600,
    });
});

// Complete multipart upload
addin.post("/orders/:orderId/resumable-upload/complete", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { uploadId, storageKey, parts } = await c.req.json();

    if (!uploadId || !storageKey || !parts || !Array.isArray(parts) || parts.length === 0) {
        return c.json({ message: "uploadId, storageKey, and parts are required" }, 400);
    }

    const expectedPrefix = `orders/${orderId}/input/`;
    if (!storageKey.startsWith(expectedPrefix)) {
        return c.json({ message: `Invalid storageKey. Must start with ${expectedPrefix}` }, 400);
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

    const { completeMultipartUpload } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const normalizedParts = parts.map((part: any) => ({
        PartNumber: part.PartNumber ?? part.partNumber,
        ETag: part.ETag ?? part.eTag,
    })).filter((part: any) => part.PartNumber && part.ETag)
        .sort((a: any, b: any) => a.PartNumber - b.PartNumber);

    if (normalizedParts.length === 0) {
        return c.json({ message: "No valid parts provided" }, 400);
    }

    await completeMultipartUpload(credentials, storageKey, uploadId, normalizedParts);

    return c.json({ success: true });
});

// Abort multipart upload
addin.post("/orders/:orderId/resumable-upload/abort", requireAddinAuth, async (c) => {
    const userId = c.get("userId")!;
    const orderId = c.req.param("orderId");
    const { uploadId, storageKey } = await c.req.json();

    if (!uploadId || !storageKey) {
        return c.json({ message: "uploadId and storageKey are required" }, 400);
    }

    const expectedPrefix = `orders/${orderId}/input/`;
    if (!storageKey.startsWith(expectedPrefix)) {
        return c.json({ message: `Invalid storageKey. Must start with ${expectedPrefix}` }, 400);
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

    const { abortMultipartUpload } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    await abortMultipartUpload(credentials, storageKey, uploadId);

    return c.json({ success: true });
});

// Check resumable upload status (order-scoped)
addin.post("/orders/:orderId/resumable-upload-status", requireAddinAuth, async (c) => {
    const orderId = c.req.param("orderId");
    const { uploadId, storageKey, fileSize } = await c.req.json();

    if (!uploadId || !storageKey) {
        return c.json({ message: "uploadId and storageKey are required" }, 400);
    }

    const expectedPrefix = `orders/${orderId}/input/`;
    if (!storageKey.startsWith(expectedPrefix)) {
        return c.json({ message: `Invalid storageKey. Must start with ${expectedPrefix}` }, 400);
    }

    const { listMultipartUploadParts } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const rawParts = await listMultipartUploadParts(credentials, storageKey, uploadId);
    const parts = rawParts.map((part) => ({
        partNumber: part.PartNumber,
        eTag: part.ETag,
        size: part.Size,
    }));
    const bytesUploaded = rawParts.reduce((sum, part) => sum + (part.Size || 0), 0);
    const isComplete = typeof fileSize === "number" ? bytesUploaded >= fileSize : false;

    return c.json({
        bytesUploaded,
        isComplete,
        parts,
    });
});

// Legacy status endpoint (no orderId in path)
addin.post("/resumable-upload-status", requireAddinAuth, async (c) => {
    const { uploadId, storageKey, fileSize } = await c.req.json();

    if (!uploadId || !storageKey) {
        return c.json({ message: "uploadId and storageKey are required" }, 400);
    }

    const { listMultipartUploadParts } = await import("../storage/r2-presigned");

    const credentials = {
        accountId: c.env.R2_ACCOUNT_ID,
        accessKeyId: c.env.R2_ACCESS_KEY_ID,
        secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        bucketName: c.env.R2_BUCKET_NAME || "lod400-files",
    };

    const rawParts = await listMultipartUploadParts(credentials, storageKey, uploadId);
    const parts = rawParts.map((part) => ({
        partNumber: part.PartNumber,
        eTag: part.ETag,
        size: part.Size,
    }));
    const bytesUploaded = rawParts.reduce((sum, part) => sum + (part.Size || 0), 0);
    const isComplete = typeof fileSize === "number" ? bytesUploaded >= fileSize : false;

    return c.json({
        bytesUploaded,
        isComplete,
        parts,
    });
});

export { addin };

