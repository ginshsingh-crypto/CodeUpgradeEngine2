/**
 * KV Session Store - Replaces express-session with in-memory store
 * 
 * Uses Cloudflare KV for persistent, globally distributed session storage.
 */

import type { KVNamespace } from "@cloudflare/workers-types";
import { createHash, randomBytes } from "crypto";

// Session TTL: 30 days for add-in sessions
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// Rate limit window: 1 minute
const RATE_LIMIT_TTL_SECONDS = 60;

export interface SessionData {
    userId: string;
    createdAt: number;
    expiresAt: number;
    deviceLabel?: string;
}

export class KVSessionStore {
    constructor(private kv: KVNamespace) { }

    /**
     * Hash a token for storage (don't store raw tokens)
     */
    private hashToken(token: string): string {
        return createHash("sha256").update(token).digest("hex");
    }

    /**
     * Create a new session and return the raw token
     */
    async createSession(
        userId: string,
        deviceLabel?: string
    ): Promise<{ token: string; expiresAt: Date }> {
        const rawToken = randomBytes(32).toString("hex");
        const hashedToken = this.hashToken(rawToken);
        const now = Date.now();
        const expiresAt = now + SESSION_TTL_SECONDS * 1000;

        const session: SessionData = {
            userId,
            createdAt: now,
            expiresAt,
            deviceLabel,
        };

        await this.kv.put(`session:${hashedToken}`, JSON.stringify(session), {
            expirationTtl: SESSION_TTL_SECONDS,
        });

        return { token: rawToken, expiresAt: new Date(expiresAt) };
    }

    /**
     * Validate a session and return user ID if valid
     */
    async validateSession(rawToken: string): Promise<string | null> {
        const hashedToken = this.hashToken(rawToken);
        const sessionData = await this.kv.get(`session:${hashedToken}`);

        if (!sessionData) return null;

        const session: SessionData = JSON.parse(sessionData);

        // Check expiration (KV should auto-expire, but double-check)
        if (Date.now() > session.expiresAt) {
            await this.deleteSession(rawToken);
            return null;
        }

        return session.userId;
    }

    /**
     * Delete a session (logout)
     */
    async deleteSession(rawToken: string): Promise<boolean> {
        const hashedToken = this.hashToken(rawToken);
        const exists = await this.kv.get(`session:${hashedToken}`);
        if (exists) {
            await this.kv.delete(`session:${hashedToken}`);
            return true;
        }
        return false;
    }

    /**
     * Check rate limit for a given key
     * Returns true if request is allowed, false if rate limited
     */
    async checkRateLimit(
        key: string,
        maxAttempts: number = 10,
        windowSeconds: number = 60
    ): Promise<boolean> {
        const rateLimitKey = `ratelimit:${key}`;
        const currentData = await this.kv.get(rateLimitKey);

        if (!currentData) {
            // First request in window
            await this.kv.put(
                rateLimitKey,
                JSON.stringify({ count: 1, resetAt: Date.now() + windowSeconds * 1000 }),
                { expirationTtl: windowSeconds }
            );
            return true;
        }

        const data = JSON.parse(currentData);

        if (Date.now() > data.resetAt) {
            // Window expired, start new one
            await this.kv.put(
                rateLimitKey,
                JSON.stringify({ count: 1, resetAt: Date.now() + windowSeconds * 1000 }),
                { expirationTtl: windowSeconds }
            );
            return true;
        }

        if (data.count >= maxAttempts) {
            return false; // Rate limited
        }

        // Increment counter
        data.count++;
        await this.kv.put(rateLimitKey, JSON.stringify(data), {
            expirationTtl: Math.ceil((data.resetAt - Date.now()) / 1000),
        });

        return true;
    }

    /**
     * Store a password reset token
     */
    async createPasswordResetToken(userId: string): Promise<string> {
        const token = randomBytes(32).toString("hex");
        const hashedToken = this.hashToken(token);

        // Password reset tokens expire in 1 hour
        await this.kv.put(
            `pwreset:${hashedToken}`,
            JSON.stringify({ userId, createdAt: Date.now() }),
            { expirationTtl: 3600 }
        );

        return token;
    }

    /**
     * Validate and consume a password reset token
     */
    async usePasswordResetToken(token: string): Promise<string | null> {
        const hashedToken = this.hashToken(token);
        const data = await this.kv.get(`pwreset:${hashedToken}`);

        if (!data) return null;

        // Delete token after use (one-time use)
        await this.kv.delete(`pwreset:${hashedToken}`);

        const { userId } = JSON.parse(data);
        return userId;
    }
}

/**
 * Create a KV session store instance
 */
export function createSessionStore(kv: KVNamespace): KVSessionStore {
    return new KVSessionStore(kv);
}
