/**
 * Webhook Routes for Cloudflare Workers
 * 
 * Handles Moyasar payment webhooks with signature verification.
 */

import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createDb } from "../db";
import { createStorage } from "../storage/database";
import { MoyasarClient } from "../services/moyasar";
import { createEmailService } from "../services/email";

const webhooks = new Hono<HonoEnv>();

// Moyasar payment webhook
webhooks.post("/moyasar", async (c) => {
    const webhookSecret = c.env.MOYASAR_WEBHOOK_SECRET;

    // Get raw body for signature verification
    const rawBody = await c.req.text();
    const signature = c.req.header("X-Moyasar-Signature") || "";

    // Verify signature in production
    if (!webhookSecret) {
        console.error("MOYASAR_WEBHOOK_SECRET is not set");
        return c.json({ error: "Webhook secret not configured" }, 500);
    }

    const isValid = await MoyasarClient.verifyWebhookSignatureAsync(
        rawBody,
        signature,
        webhookSecret
    );

    if (!isValid) {
        console.error("Invalid webhook signature");
        return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse payload
    let payload: any;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    console.log(`Received Moyasar webhook event: ${payload.type}`);

    // Handle payment.paid event
    if (payload.type === "payment.paid") {
        const payment = payload.data;
        const { orderId, userId, companyId, transactionId } = payment.metadata || {};

        const db = createDb(c.env.DATABASE_URL);
        const storage = createStorage(db);

        // Determine if this is an order payment or balance top-up
        if (orderId) {
            // Order payment flow
            console.log(`Processing order payment for ${orderId}`);

            const order = await storage.getOrder(orderId);
            if (!order) {
                console.error(`Order ${orderId} not found for payment ${payment.id}`);
                return c.json({ error: "Order not found" }, 404);
            }

            // Idempotency: Don't process if already paid
            if (["paid", "processing", "complete", "uploaded"].includes(order.status)) {
                console.log(`Order ${orderId} is already paid`);
                return c.json({ received: true });
            }

            // Security: Verify payment amount matches order total
            const expectedAmountHalala = order.totalPriceSar * 100;
            if (payment.amount !== expectedAmountHalala) {
                console.error(
                    `Payment amount mismatch for order ${orderId}: expected ${expectedAmountHalala}, got ${payment.amount}`
                );
                return c.json({ error: "Amount mismatch" }, 400);
            }

            // Update order
            await storage.updateOrder(orderId, {
                moyasarPaymentId: payment.id,
                moyasarInvoiceId: payment.invoice_id,
                status: "paid",
                paidAt: new Date(),
            });

            console.log(`Order ${orderId} marked as paid`);

            // Send confirmation email
            const fullOrder = await storage.getOrderWithFiles(orderId);
            if (fullOrder?.user?.email) {
                const emailService = createEmailService(c.env.RESEND_API_KEY);
                emailService.sendOrderPaidEmail(
                    fullOrder.user.email,
                    orderId,
                    fullOrder.sheetCount,
                    fullOrder.user.firstName || undefined
                ).catch((err) => console.error("Failed to send paid email:", err));
            }
        } else if (transactionId && userId) {
            // Balance top-up flow
            console.log(`Processing balance top-up for user ${userId}, transaction ${transactionId}`);

            // IDEMPOTENCY: Check if this payment was already processed
            const existingTransaction = await storage.getBalanceTransactionByMoyasarId(payment.id);
            if (existingTransaction) {
                console.log(`Balance payment ${payment.id} already processed, skipping duplicate`);
                return c.json({ received: true });
            }

            const amountSar = Math.floor(payment.amount / 100);

            if (companyId) {
                await storage.updateCompanyBalance(companyId, amountSar);
            } else {
                await storage.updateUserBalance(userId, amountSar);
            }

            // Log the transaction with moyasarPaymentId for idempotency
            await storage.createBalanceTransaction({
                userId,
                companyId: companyId || undefined,
                type: "topup",
                amountSar,
                moyasarPaymentId: payment.id,
                status: "completed",
            });

            console.log(`Balance top-up completed: ${amountSar} SAR for user ${userId}`);
        } else {
            console.warn(`Payment ${payment.id} received without orderId or transactionId in metadata`);
        }
    }

    return c.json({ received: true });
});

// Note: Removed duplicate /moyasar/balance endpoint.
// All payments (orders and balance top-ups) are now handled by the single /moyasar webhook
// which routes based on metadata.orderId vs metadata.transactionId.

export { webhooks };

