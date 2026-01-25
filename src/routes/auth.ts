/**
 * Authentication Routes for Cloudflare Workers
 * 
 * Handles registration, login, and password management.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { hash } from "bcryptjs";
import type { HonoEnv } from "../types";
import { createDb } from "../db";
import { createStorage } from "../storage/database";
import { createSessionStore } from "../storage/kv-sessions";
import { createEmailService } from "../services/email";

const auth = new Hono<HonoEnv>();

// Schemas
const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
    deviceLabel: z.string().optional(),
});

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
});

const forgotPasswordSchema = z.object({
    email: z.string().email(),
});

const resetPasswordSchema = z.object({
    token: z.string(),
    password: z.string().min(8),
});

// Helper to get IP for rate limiting
function getClientIP(c: any): string {
    return c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0] || "unknown";
}

// Helper to extract Bearer token
function extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    return authHeader.slice(7);
}

// Safe user info (no password)
function safeUserInfo(user: any) {
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
    };
}

// Register new user
auth.post("/register", zValidator("json", registerSchema), async (c) => {
    const { email, password, firstName, lastName } = c.req.valid("json");
    const ip = getClientIP(c);

    const sessions = createSessionStore(c.env.SESSIONS);

    // Rate limiting
    const allowed = await sessions.checkRateLimit(`register:${ip}`, 5, 60);
    if (!allowed) {
        return c.json({ message: "Too many requests. Please try again later." }, 429);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    // Check existing user
    const existing = await storage.getUserByEmail(email);
    if (existing) {
        return c.json({ message: "User with this email already exists" }, 409);
    }

    // Hash password and create user
    const passwordHash = await hash(password, 12);
    const user = await storage.createUserWithPassword(email, passwordHash, firstName, lastName);

    return c.json({
        message: "User registered successfully",
        user: safeUserInfo(user),
    }, 201);
});

// Add-in login (returns Bearer token)
auth.post("/login", zValidator("json", loginSchema), async (c) => {
    const { email, password, deviceLabel } = c.req.valid("json");
    const ip = getClientIP(c);

    const sessions = createSessionStore(c.env.SESSIONS);

    // Rate limiting
    const allowed = await sessions.checkRateLimit(`login:${ip}:${email.toLowerCase()}`, 10, 60);
    if (!allowed) {
        return c.json({ message: "Too many login attempts. Please try again later." }, 429);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    // Validate credentials
    const user = await storage.validateUserPassword(email, password);
    if (!user) {
        return c.json({ message: "Invalid email or password" }, 401);
    }

    // Create session
    const { token, expiresAt } = await sessions.createSession(user.id, deviceLabel);

    return c.json({
        message: "Login successful",
        token,
        expiresAt: expiresAt.toISOString(),
        user: safeUserInfo(user),
    });
});

// Web login (same as add-in login for now, could use cookies later)
auth.post("/web-login", zValidator("json", loginSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    const ip = getClientIP(c);

    const sessions = createSessionStore(c.env.SESSIONS);

    // Rate limiting
    const allowed = await sessions.checkRateLimit(`login:${ip}:${email.toLowerCase()}`, 10, 60);
    if (!allowed) {
        return c.json({ message: "Too many login attempts. Please try again later." }, 429);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const user = await storage.validateUserPassword(email, password);
    if (!user) {
        return c.json({ message: "Invalid email or password" }, 401);
    }

    const { token, expiresAt } = await sessions.createSession(user.id);

    return c.json({
        message: "Login successful",
        token,
        expiresAt: expiresAt.toISOString(),
        user: safeUserInfo(user),
    });
});

// Logout
auth.post("/logout", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token) {
        return c.json({ message: "Authorization token required" }, 401);
    }

    const sessions = createSessionStore(c.env.SESSIONS);
    const deleted = await sessions.deleteSession(token);

    if (!deleted) {
        return c.json({ message: "Invalid or expired session" }, 401);
    }

    return c.json({ message: "Logged out successfully" });
});

// Validate session
auth.get("/validate", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token) {
        return c.json({ message: "Authorization token required" }, 401);
    }

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

    return c.json({
        valid: true,
        user: safeUserInfo(user),
    });
});

// Get current user
auth.get("/user", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token) {
        return c.json({ message: "Authorization required" }, 401);
    }

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

    return c.json({
        ...safeUserInfo(user),
        hasPassword: !!user.passwordHash,
    });
});

// Change password
auth.post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token) {
        return c.json({ message: "Authorization required" }, 401);
    }

    const sessions = createSessionStore(c.env.SESSIONS);
    const userId = await sessions.validateSession(token);

    if (!userId) {
        return c.json({ message: "Invalid or expired session" }, 401);
    }

    const { currentPassword, newPassword } = c.req.valid("json");
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const newPasswordHash = await hash(newPassword, 12);
    const result = await storage.changeUserPassword(userId, currentPassword, newPasswordHash);

    if (!result.success) {
        return c.json({ message: result.error }, 400);
    }

    return c.json({ message: "Password changed successfully" });
});

// Forgot password
auth.post("/forgot-password", zValidator("json", forgotPasswordSchema), async (c) => {
    const { email } = c.req.valid("json");
    const ip = getClientIP(c);

    const sessions = createSessionStore(c.env.SESSIONS);

    // Rate limiting
    const allowed = await sessions.checkRateLimit(`forgot:${ip}`, 5, 60);
    if (!allowed) {
        return c.json({ message: "Too many requests. Please try again later." }, 429);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const user = await storage.getUserByEmail(email);

    // Always return same response to prevent email enumeration
    if (!user) {
        console.log(`Password reset requested for non-existent email: ${email}`);
        return c.json({ message: "If an account exists, a reset link has been sent." });
    }

    const token = await sessions.createPasswordResetToken(user.id);

    // Build reset URL
    const protocol = c.req.header("X-Forwarded-Proto") || "https";
    const host = c.req.header("Host") || "lod400.com";
    const resetUrl = `${protocol}://${host}/reset-password?token=${token}`;

    // Send email
    const emailService = createEmailService(c.env.RESEND_API_KEY);
    await emailService.sendPasswordResetEmail(email, resetUrl, user.firstName || undefined);

    return c.json({ message: "If an account exists, a reset link has been sent." });
});

// Reset password
auth.post("/reset-password", zValidator("json", resetPasswordSchema), async (c) => {
    const { token, password } = c.req.valid("json");

    const sessions = createSessionStore(c.env.SESSIONS);
    const userId = await sessions.usePasswordResetToken(token);

    if (!userId) {
        return c.json({ message: "Invalid or expired token" }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const passwordHash = await hash(password, 12);
    await storage.setUserPassword(userId, passwordHash);

    return c.json({ message: "Password reset successfully" });
});

export { auth };
