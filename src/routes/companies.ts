/**
 * Company Routes for Cloudflare Workers
 * 
 * Company management endpoints.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { HonoEnv } from "../types";
import { createDb } from "../db";
import { createStorage } from "../storage/database";
import { createSessionStore } from "../storage/kv-sessions";

const companies = new Hono<HonoEnv>();

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

// Get user's companies
companies.get("/", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const companies = await storage.getUserCompanies(userId);
    return c.json(companies);
});

// Create new company
const createCompanySchema = z.object({
    name: z.string().min(2).max(100),
});

companies.post("/", requireAuth, zValidator("json", createCompanySchema), async (c) => {
    const userId = c.get("userId")!;
    const { name } = c.req.valid("json");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    // Check if company exists? (optional)

    const company = await storage.createCompany(name, userId);
    return c.json(company);
});

// Get company details
companies.get("/:companyId", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const companyId = c.req.param("companyId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const isMember = await storage.isUserCompanyMember(userId, companyId);
    if (!isMember) {
        return c.json({ message: "Not a member" }, 403);
    }

    const company = await storage.getCompany(companyId);
    if (!company) {
        return c.json({ message: "Company not found" }, 404);
    }

    // Add members list if needed
    const members = await storage.getCompanyMembers(companyId);

    return c.json({
        ...company,
        members,
    });
});

// Invite member (simple version - just adds if user exists by email)
const inviteSchema = z.object({
    email: z.string().email(),
    role: z.enum(["admin", "member"]).default("member"),
});

// Get company members
companies.get("/:companyId/members", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const companyId = c.req.param("companyId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const isMember = await storage.isUserCompanyMember(userId, companyId);
    if (!isMember) {
        return c.json({ message: "Not a member" }, 403);
    }

    const members = await storage.getCompanyMembers(companyId);
    return c.json(members);
});

companies.post("/:companyId/members", requireAuth, zValidator("json", inviteSchema), async (c) => {
    const userId = c.get("userId")!;
    const companyId = c.req.param("companyId");
    const { email, role } = c.req.valid("json");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const memberRole = await storage.getCompanyMemberRole(userId, companyId);
    if (memberRole !== "admin") {
        return c.json({ message: "Admin access required" }, 403);
    }

    const result = await storage.addCompanyMemberByEmail(companyId, email, role);
    if (!result.success) {
        return c.json({ message: result.error }, 400);
    }

    return c.json({ success: true });
});

// Remove member
companies.delete("/:companyId/members/:memberUserId", requireAuth, async (c) => {
    const userId = c.get("userId")!;
    const companyId = c.req.param("companyId");
    const memberUserId = c.req.param("memberUserId");

    const db = createDb(c.env.DATABASE_URL);
    const storage = createStorage(db);

    const memberRole = await storage.getCompanyMemberRole(userId, companyId);
    if (memberRole !== "admin") {
        return c.json({ message: "Admin access required" }, 403);
    }

    await storage.removeCompanyMember(companyId, memberUserId);
    return c.json({ success: true });
});

export { companies };
