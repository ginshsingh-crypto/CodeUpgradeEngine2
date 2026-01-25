/**
 * Balance Routes for Cloudflare Workers
 * 
 * Endpoints for balance management, top-ups, and transactions.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { HonoEnv } from "../types";
import { createDb } from "../db";
import { createStorage } from "../storage/database";
import { createSessionStore } from "../storage/kv-sessions";
import { createMoyasarClient } from "../services/moyasar";

const balance = new Hono<HonoEnv>();

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

// Get user balance
balance.get("/", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const user = c.get("user")!;

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const userBalance = await storage.getUserBalance(userId);
    const companies = await storage.getUserCompanies(userId);

    return c.json({
        personal: {
            balanceSar: userBalance,
        },
        companies: companies.map((c: any) => ({
            id: c.id,
            name: c.name,
            balanceSar: c.balanceSar,
            role: c.role,
        })),
    });
});

// Get transaction history
balance.get("/transactions", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const companyId = c.req.query("companyId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    // If companyId provided, verify user is member
    if (companyId) {
        const isMember = await storage.isUserCompanyMember(userId, companyId);
        if (!isMember) {
            return c.json({ message: "Not a member of this company" }, 403);
        }
    }

    const transactions = await storage.getBalanceTransactions(userId, companyId);
    return c.json(transactions);
});

// Top-up schemas
const topupSchema = z.object({
    amountSar: z.number().int().min(100).max(100000),
    companyId: z.string().optional(),
});

// Create top-up payment
balance.post("/topup", requireAuth, zValidator("json", topupSchema), async (c) => {
    const userId = c.get("userId")!;
    const { amountSar, companyId } = c.req.valid("json");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    // If company top-up, verify user is admin of company
    if (companyId) {
        const companies = await storage.getUserCompanies(userId);
        const company = companies.find((c: any) => c.id === companyId);
        if (!company || company.role !== "admin") {
            return c.json({ message: "Must be company admin to top up" }, 403);
        }
    }

    // Create a transaction ID for tracking
    const transactionId = crypto.randomUUID();

    // Create pending balance transaction
    await storage.createBalanceTransaction({
        userId,
        companyId: companyId || undefined,
        type: "topup",
        amountSar,
        // moyasarPaymentId will be set by webhook after payment completes
        status: "pending",
        note: `Top-up initiated: ${transactionId}`,
    });

    // Create Moyasar payment
    const moyasar = createMoyasarClient(
        c.env.MOYASAR_SECRET_KEY,
        c.env.MOYASAR_PUBLISHABLE_KEY
    );

    const host = c.req.header("Host") || "lod400.com";
    const protocol = c.req.header("X-Forwarded-Proto") || "https";
    const callbackUrl = `${protocol}://${host}/api/payment/callback`;

    const payment = await moyasar.createPayment({
        amount: amountSar * 100, // Convert to halalas
        currency: "SAR",
        description: `LOD 400 Balance Top-up - ${amountSar} SAR`,
        callback_url: callbackUrl,
        metadata: {
            transactionId,
            userId,
            companyId: companyId || null,
        },
    });

    return c.json({
        transactionId,
        paymentId: payment.id,
        amount: payment.amount,
        formUrl: moyasar.buildPaymentFormUrl(payment.id),
    });
});

// Pay with balance (for orders)
const payWithBalanceSchema = z.object({
    orderId: z.string(),
    companyId: z.string().optional(),
});

balance.post("/pay", requireAuth, zValidator("json", payWithBalanceSchema), async (c) => {
    const userId = c.get("userId")!;
    const { orderId, companyId } = c.req.valid("json");

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

export { balance };
