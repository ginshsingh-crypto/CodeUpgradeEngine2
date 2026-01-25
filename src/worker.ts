/**
 * LOD400 Platform - Cloudflare Workers Entry Point
 * 
 * Main worker file that assembles all routes and handles requests.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/cloudflare-workers";
import type { HonoEnv } from "./types";

// Route imports
import { auth } from "./routes/auth";
import { orders } from "./routes/orders";
import { addin } from "./routes/addin";
import { webhooks } from "./routes/webhooks";
import { admin } from "./routes/admin";
import { balance } from "./routes/balance";
import { companies } from "./routes/companies";

// Create app
const app = new Hono<HonoEnv>();

// ============================================
// GLOBAL MIDDLEWARE
// ============================================

// Logging
app.use("*", logger());

// Security headers (like Helmet.js)
app.use("*", secureHeaders());

// CORS configuration
app.use("/api/*", cors({
    origin: (origin) => {
        // Allow same-origin and known domains
        const allowedOrigins = [
            "https://lod400.com",
            "https://www.lod400.com",
            "http://localhost:5173", // Vite dev server
            "http://localhost:8787", // Wrangler dev
        ];
        if (!origin || allowedOrigins.includes(origin)) {
            return origin || "*";
        }
        return null;
    },
    allowHeaders: ["Content-Type", "Authorization", "X-Client-Version"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
}));

// ============================================
// API ROUTES
// ============================================

// Authentication routes
app.route("/api/auth", auth);

// Order routes (web frontend)
app.route("/api/orders", orders);

// Add-in specific routes (Revit add-in)
app.route("/api/addin", addin);

// Webhook routes
app.route("/api/webhooks", webhooks);

// Admin routes (admin dashboard)
app.route("/api/admin", admin);

// Balance routes (top-ups, pay with balance)
app.route("/api/balance", balance);

// Company routes
app.route("/api/companies", companies);

// ============================================
// UTILITY ROUTES
// ============================================

// Health check
app.get("/api/health", (c) => {
    return c.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        version: c.env.MIN_ADDIN_VERSION || "1.0.0",
    });
});

// Contact form
app.post("/api/contact", async (c) => {
    const { name, email, message } = await c.req.json();

    if (!name || !email || !message) {
        return c.json({ message: "Name, email, and message are required" }, 400);
    }

    const { createEmailService } = await import("./services/email");
    const emailService = createEmailService(c.env.RESEND_API_KEY);

    const success = await emailService.sendContactFormEmail(name, email, message);

    if (success) {
        return c.json({ success: true, message: "Message sent successfully" });
    } else {
        return c.json({ message: "Failed to send message" }, 500);
    }
});

// Moyasar publishable key (for frontend)
app.get("/api/config", (c) => {
    return c.json({
        moyasarPublishableKey: c.env.MOYASAR_PUBLISHABLE_KEY,
        pricePerSheet: parseInt(c.env.PRICE_PER_SHEET_SAR) || 150,
        minAddinVersion: c.env.MIN_ADDIN_VERSION || "1.0.0",
    });
});

// Payment callback (redirect from Moyasar)
app.get("/api/payment/callback", async (c) => {
    const paymentId = c.req.query("id");
    const status = c.req.query("status");

    if (status === "paid") {
        return c.redirect("/?payment=success");
    } else {
        return c.redirect("/?payment=failed");
    }
});

// Moyasar checkout redirect - UI calls this to start payment flow
// Redirects to the order payment page
app.get("/api/moyasar/checkout/:orderId", async (c) => {
    const orderId = c.req.param("orderId");
    // Redirect to the frontend payment page which embeds Moyasar form
    return c.redirect(`/payment/${orderId}`);
});

// ============================================
// STATIC FILE SERVING
// ============================================

// Serve static files from the assets manifest
// This will be configured during build
app.get("/assets/*", serveStatic());

// ============================================
// SPA FALLBACK
// ============================================

// For client-side routing, return index.html for all non-API routes
app.get("*", serveStatic({ path: "./index.html" }));

// ============================================
// ERROR HANDLING
// ============================================

app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({
        error: "Internal server error",
        message: process.env.NODE_ENV === "development" ? err.message : undefined,
    }, 500);
});

app.notFound((c) => {
    return c.json({ error: "Not found" }, 404);
});

// Export for Cloudflare Workers
export default app;
