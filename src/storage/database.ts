/**
 * Database Storage Layer for Cloudflare Workers
 * 
 * Adapted from server/storage.ts to work with per-request database instances.
 * Uses Neon HTTP driver via drizzle-orm.
 */

import { eq, desc, and, sql } from "drizzle-orm";
import type { Database } from "../db";
import {
    users,
    orders,
    files,
    orderSheets,
    companies,
    companyMembers,
    balanceTransactions,
    userBalances,
    type User,
    type Order,
    type InsertOrder,
    type OrderWithFiles,
} from "../../shared/schema";
import { hash, compare } from "bcryptjs";

export interface SheetInfo {
    sheetElementId: string;
    sheetNumber: string;
    sheetName: string;
}

/**
 * Storage class that accepts a database instance per request
 */
export class DatabaseStorage {
    constructor(private db: Database) { }

    // ============================================
    // USER OPERATIONS
    // ============================================

    async getUser(id: string): Promise<User | undefined> {
        const result = await this.db.select().from(users).where(eq(users.id, id));
        return result[0];
    }

    async getUserByEmail(email: string): Promise<User | null> {
        const result = await this.db
            .select()
            .from(users)
            .where(eq(users.email, email.toLowerCase()));
        return result[0] || null;
    }

    async createUserWithPassword(
        email: string,
        passwordHash: string,
        firstName?: string,
        lastName?: string
    ): Promise<User> {
        const result = await this.db
            .insert(users)
            .values({
                email: email.toLowerCase(),
                passwordHash,
                firstName,
                lastName,
            })
            .returning();
        return result[0];
    }

    async validateUserPassword(email: string, password: string): Promise<User | null> {
        const user = await this.getUserByEmail(email);
        if (!user || !user.passwordHash) return null;

        const valid = await compare(password, user.passwordHash);
        return valid ? user : null;
    }

    async setUserPassword(userId: string, passwordHash: string): Promise<User | null> {
        const result = await this.db
            .update(users)
            .set({ passwordHash, updatedAt: new Date() })
            .where(eq(users.id, userId))
            .returning();
        return result[0] || null;
    }

    async changeUserPassword(
        userId: string,
        currentPassword: string,
        newPasswordHash: string
    ): Promise<{ success: boolean; error?: string }> {
        const user = await this.getUser(userId);
        if (!user || !user.passwordHash) {
            return { success: false, error: "User not found or no password set" };
        }

        const valid = await compare(currentPassword, user.passwordHash);
        if (!valid) {
            return { success: false, error: "Current password is incorrect" };
        }

        await this.db
            .update(users)
            .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
            .where(eq(users.id, userId));

        return { success: true };
    }

    async getAllUsers(): Promise<User[]> {
        return this.db.select().from(users).orderBy(desc(users.createdAt));
    }

    // ============================================
    // ORDER OPERATIONS
    // ============================================

    async createOrder(order: InsertOrder): Promise<Order> {
        const result = await this.db.insert(orders).values(order).returning();
        return result[0];
    }

    async createOrderWithSheets(order: InsertOrder, sheets: SheetInfo[]): Promise<Order> {
        // In Neon HTTP driver, we use multiple queries
        // For atomicity, we rely on the HTTP transaction support
        const orderResult = await this.db.insert(orders).values(order).returning();
        const newOrder = orderResult[0];

        if (sheets.length > 0) {
            await this.db.insert(orderSheets).values(
                sheets.map((sheet) => ({
                    orderId: newOrder.id,
                    sheetElementId: sheet.sheetElementId,
                    sheetNumber: sheet.sheetNumber,
                    sheetName: sheet.sheetName,
                }))
            );
        }

        return newOrder;
    }

    async getOrder(id: string): Promise<Order | undefined> {
        const result = await this.db.select().from(orders).where(eq(orders.id, id));
        return result[0];
    }

    async getOrderWithFiles(id: string): Promise<OrderWithFiles | undefined> {
        const order = await this.getOrder(id);
        if (!order) return undefined;

        const user = await this.getUser(order.userId);
        const orderFiles = await this.db
            .select()
            .from(files)
            .where(eq(files.orderId, id));
        const sheets = await this.db
            .select()
            .from(orderSheets)
            .where(eq(orderSheets.orderId, id));

        return {
            ...order,
            user: user
                ? {
                    id: user.id,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    profileImageUrl: user.profileImageUrl,
                }
                : undefined,
            files: orderFiles,
            sheets,
        };
    }

    async getOrdersByUserId(userId: string): Promise<OrderWithFiles[]> {
        const userOrders = await this.db
            .select()
            .from(orders)
            .where(eq(orders.userId, userId))
            .orderBy(desc(orders.createdAt));

        const result: OrderWithFiles[] = [];
        for (const order of userOrders) {
            const orderWithFiles = await this.getOrderWithFiles(order.id);
            if (orderWithFiles) result.push(orderWithFiles);
        }
        return result;
    }

    async getAllOrders(): Promise<OrderWithFiles[]> {
        const allOrders = await this.db
            .select()
            .from(orders)
            .orderBy(desc(orders.createdAt));

        const result: OrderWithFiles[] = [];
        for (const order of allOrders) {
            const orderWithFiles = await this.getOrderWithFiles(order.id);
            if (orderWithFiles) result.push(orderWithFiles);
        }
        return result;
    }

    async updateOrder(id: string, data: Partial<Order>): Promise<Order | undefined> {
        const result = await this.db
            .update(orders)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(orders.id, id))
            .returning();
        return result[0];
    }

    async updateOrderStatus(
        id: string,
        status: Order["status"]
    ): Promise<Order | undefined> {
        return this.updateOrder(id, { status });
    }

    // ============================================
    // FILE OPERATIONS
    // ============================================

    async createFile(file: {
        orderId: string;
        fileType: "input" | "output";
        fileName: string;
        fileSize: number | null;
        storageKey: string;
        mimeType: string | null;
    }) {
        const result = await this.db.insert(files).values(file).returning();
        return result[0];
    }

    async getFile(id: string) {
        const result = await this.db.select().from(files).where(eq(files.id, id));
        return result[0];
    }

    async getFilesByOrderId(orderId: string) {
        return this.db.select().from(files).where(eq(files.orderId, orderId));
    }

    // ============================================
    // BALANCE OPERATIONS
    // ============================================

    async getUserBalance(userId: string): Promise<number> {
        const result = await this.db
            .select()
            .from(userBalances)
            .where(eq(userBalances.userId, userId));
        return result[0]?.balanceSar ?? 0;
    }

    async updateUserBalance(userId: string, amountDelta: number): Promise<void> {
        const existing = await this.db
            .select()
            .from(userBalances)
            .where(eq(userBalances.userId, userId));

        if (existing.length === 0) {
            await this.db.insert(userBalances).values({
                userId,
                balanceSar: amountDelta,
            });
        } else {
            await this.db
                .update(userBalances)
                .set({
                    balanceSar: sql`${userBalances.balanceSar} + ${amountDelta}`,
                    updatedAt: new Date(),
                })
                .where(eq(userBalances.userId, userId));
        }
    }

    async getCompanyBalance(companyId: string): Promise<number> {
        const result = await this.db
            .select()
            .from(companies)
            .where(eq(companies.id, companyId));
        return result[0]?.balanceSar ?? 0;
    }

    async updateCompanyBalance(companyId: string, amountDelta: number): Promise<void> {
        await this.db
            .update(companies)
            .set({
                balanceSar: sql`${companies.balanceSar} + ${amountDelta}`,
                updatedAt: new Date(),
            })
            .where(eq(companies.id, companyId));
    }

    async isUserCompanyMember(userId: string, companyId: string): Promise<boolean> {
        const result = await this.db
            .select()
            .from(companyMembers)
            .where(
                and(
                    eq(companyMembers.userId, userId),
                    eq(companyMembers.companyId, companyId)
                )
            );
        return result.length > 0;
    }

    async getUserCompanies(userId: string) {
        return this.db
            .select({
                id: companies.id,
                name: companies.name,
                balanceSar: companies.balanceSar,
                role: companyMembers.role,
            })
            .from(companyMembers)
            .innerJoin(companies, eq(companyMembers.companyId, companies.id))
            .where(eq(companyMembers.userId, userId));
    }

    async createCompany(name: string, ownerUserId: string) {
        // Create company
        const companyResult = await this.db.insert(companies).values({
            name,
            balanceSar: 0,
        }).returning();

        const company = companyResult[0];

        // Add owner as admin member
        await this.db.insert(companyMembers).values({
            companyId: company.id,
            userId: ownerUserId,
            role: "admin",
        });

        return company;
    }

    async getCompany(companyId: string) {
        const result = await this.db.select().from(companies).where(eq(companies.id, companyId));
        return result[0];
    }

    async getCompanyMembers(companyId: string) {
        return this.db
            .select({
                userId: users.id,
                email: users.email,
                firstName: users.firstName,
                lastName: users.lastName,
                role: companyMembers.role,
                createdAt: companyMembers.createdAt,
            })
            .from(companyMembers)
            .innerJoin(users, eq(companyMembers.userId, users.id))
            .where(eq(companyMembers.companyId, companyId));
    }

    async getCompanyMemberRole(userId: string, companyId: string): Promise<string | null> {
        const result = await this.db
            .select({ role: companyMembers.role })
            .from(companyMembers)
            .where(
                and(
                    eq(companyMembers.userId, userId),
                    eq(companyMembers.companyId, companyId)
                )
            );
        return result[0]?.role || null;
    }

    async addCompanyMemberByEmail(companyId: string, email: string, role: "admin" | "member") {
        const user = await this.getUserByEmail(email);
        if (!user) {
            return { success: false, error: "User not found" };
        }

        const existing = await this.db
            .select()
            .from(companyMembers)
            .where(
                and(
                    eq(companyMembers.userId, user.id),
                    eq(companyMembers.companyId, companyId)
                )
            );

        if (existing.length > 0) {
            return { success: false, error: "User is already a member" };
        }

        await this.db.insert(companyMembers).values({
            companyId,
            userId: user.id,
            role,
        });

        return { success: true, userId: user.id };
    }

    async removeCompanyMember(companyId: string, userId: string) {
        await this.db
            .delete(companyMembers)
            .where(
                and(
                    eq(companyMembers.companyId, companyId),
                    eq(companyMembers.userId, userId)
                )
            );
    }

    // ============================================
    // TRANSACTION LOGGING
    // ============================================

    async createBalanceTransaction(transaction: {
        companyId?: string;
        userId: string;
        type: string;
        amountSar: number;
        orderId?: string;
        moyasarPaymentId?: string;
        status?: string;
        note?: string;
    }) {
        const result = await this.db
            .insert(balanceTransactions)
            .values({
                ...transaction,
                status: transaction.status ?? "completed",
            })
            .returning();
        return result[0];
    }

    async getBalanceTransactions(userId: string, companyId?: string) {
        if (companyId) {
            return this.db
                .select()
                .from(balanceTransactions)
                .where(eq(balanceTransactions.companyId, companyId))
                .orderBy(desc(balanceTransactions.createdAt));
        }
        return this.db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.userId, userId))
            .orderBy(desc(balanceTransactions.createdAt));
    }

    /**
     * Look up a balance transaction by Moyasar payment ID for idempotency.
     * Returns the existing transaction if this payment was already processed.
     */
    async getBalanceTransactionByMoyasarId(moyasarPaymentId: string) {
        const result = await this.db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.moyasarPaymentId, moyasarPaymentId));
        return result[0] || null;
    }

    /**
     * Get all pending refund requests
     */
    async getRefundRequests() {
        return this.db
            .select({
                id: balanceTransactions.id,
                amountSar: balanceTransactions.amountSar,
                status: balanceTransactions.status,
                createdAt: balanceTransactions.createdAt,
                note: balanceTransactions.note,
                user: {
                    firstName: users.firstName,
                    lastName: users.lastName,
                    email: users.email,
                },
                order: {
                    sheetCount: orders.sheetCount,
                    totalPriceSar: orders.totalPriceSar,
                },
            })
            .from(balanceTransactions)
            .innerJoin(users, eq(balanceTransactions.userId, users.id))
            .leftJoin(orders, eq(balanceTransactions.orderId, orders.id))
            .where(eq(balanceTransactions.type, "refund_request"))
            .orderBy(desc(balanceTransactions.createdAt));
    }

    /**
     * Approve a refund request
     */
    async approveRefund(transactionId: string, adminUserId: string): Promise<{ success: boolean; error?: string }> {
        const transaction = await this.db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.id, transactionId));

        if (!transaction[0]) {
            return { success: false, error: "Transaction not found" };
        }

        if (transaction[0].type !== "refund_request" || transaction[0].status !== "pending") {
            return { success: false, error: "Transaction is not a pending refund request" };
        }

        await this.db
            .update(balanceTransactions)
            .set({
                status: "completed",
                type: "refund_approved",
                approvedBy: adminUserId,
            })
            .where(eq(balanceTransactions.id, transactionId));

        return { success: true };
    }

    /**
     * Reject a refund request
     */
    async rejectRefund(transactionId: string, adminUserId: string, reason?: string): Promise<{ success: boolean; error?: string }> {
        const transaction = await this.db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.id, transactionId));

        if (!transaction[0]) {
            return { success: false, error: "Transaction not found" };
        }

        if (transaction[0].type !== "refund_request" || transaction[0].status !== "pending") {
            return { success: false, error: "Transaction is not a pending refund request" };
        }

        await this.db
            .update(balanceTransactions)
            .set({
                status: "rejected",
                approvedBy: adminUserId,
                note: reason || "Refund rejected",
            })
            .where(eq(balanceTransactions.id, transactionId));

        return { success: true };
    }
}

/**
 * Create storage instance for a request
 */
export function createStorage(db: Database): DatabaseStorage {
    return new DatabaseStorage(db);
}

