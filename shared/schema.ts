import { sql, relations } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  integer,
  bigint,
  text,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Order status enum
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "uploaded",
  "processing",
  "complete",
  "expired",
  "cancelled",
]);

// File type enum
export const fileTypeEnum = pgEnum("file_type", ["input", "output"]);

// Session storage table for Replit Auth
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// Users table for Replit Auth
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  isAdmin: integer("is_admin").default(0),
  passwordHash: varchar("password_hash"),
  passwordSalt: varchar("password_salt"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Orders table
export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  sheetCount: integer("sheet_count").notNull(),
  totalPriceSar: integer("total_price_sar").notNull(),
  status: orderStatusEnum("status").notNull().default("pending"),
  paymentId: varchar("moyasar_payment_id"),
  invoiceId: varchar("moyasar_invoice_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  paidAt: timestamp("paid_at"),
  uploadedAt: timestamp("uploaded_at"),
  completedAt: timestamp("completed_at"),
});

// Files table - stores input and output files for orders
export const files = pgTable("files", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull().references(() => orders.id),
  fileType: fileTypeEnum("file_type").notNull(),
  fileName: varchar("file_name").notNull(),
  fileSize: bigint("file_size", { mode: "number" }),
  storageKey: varchar("storage_key").notNull(),
  mimeType: varchar("mime_type"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [index("IDX_files_order_id").on(table.orderId)]);

// Order sheets - individual sheets within an order
export const orderSheets = pgTable("order_sheets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull().references(() => orders.id),
  sheetElementId: varchar("sheet_element_id").notNull(),
  sheetNumber: varchar("sheet_number").notNull(),
  sheetName: varchar("sheet_name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [index("IDX_order_sheets_order_id").on(table.orderId)]);

// API Keys for external integrations (deprecated, kept for compatibility)
export const apiKeys = pgTable("api_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  keyHash: varchar("key_hash").notNull(),
  name: varchar("name").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [index("IDX_api_keys_user_id").on(table.userId)]);

// Add-in sessions for Revit add-in authentication
export const addinSessions = pgTable("addin_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  tokenHash: varchar("token_hash").notNull().unique(),
  deviceLabel: varchar("device_label"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_addin_sessions_user_id").on(table.userId),
  index("IDX_addin_sessions_token_hash").on(table.tokenHash),
]);

// Password reset tokens
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  tokenHash: varchar("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [index("IDX_password_reset_tokens_token_hash").on(table.tokenHash)]);

// Insert schemas for new tables
export const insertFileSchema = createInsertSchema(files).omit({
  id: true,
  createdAt: true,
});

export const insertOrderSheetSchema = createInsertSchema(orderSheets).omit({
  id: true,
  createdAt: true,
});

// Types for new tables
export type File = typeof files.$inferSelect;
export type OrderSheet = typeof orderSheets.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AddinSession = typeof addinSessions.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// Create order request schema (used by both web and add-in)
export const createOrderRequestSchema = z.object({
  sheetCount: z.number().int().positive(),
  sheets: z.array(z.object({
    sheetElementId: z.string(),
    sheetNumber: z.string(),
    sheetName: z.string(),
  })),
});

export type InsertOrder = typeof orders.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type User = typeof users.$inferSelect;

export const orderWithFilesSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sheetCount: z.number(),
  totalPriceSar: z.number(),
  status: z.enum(["pending", "paid", "uploaded", "processing", "complete", "expired", "cancelled"]),
  paymentId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
  paidAt: z.date().nullable(),
  uploadedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
  user: z.object({
    id: z.string(),
    email: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    profileImageUrl: z.string().nullable(),
  }).optional(),
  files: z.array(z.object({
    id: z.string(),
    orderId: z.string(),
    fileType: z.enum(["input", "output"]),
    fileName: z.string(),
    fileSize: z.number().nullable(),
    storageKey: z.string(),
    mimeType: z.string().nullable(),
    createdAt: z.date().nullable(),
  })).optional(),
  sheets: z.array(z.object({
    id: z.string(),
    orderId: z.string(),
    sheetElementId: z.string(),
    sheetNumber: z.string(),
    sheetName: z.string(),
    createdAt: z.date().nullable(),
  })).optional(),
});

export type OrderWithFiles = z.infer<typeof orderWithFilesSchema>;

// ============================================
// ACCOUNT BALANCE & COMPANY SCHEMA
// ============================================

// Company accounts
export const companies = pgTable("companies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  balanceSar: integer("balance_sar").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Company membership (many-to-many: users ↔ companies)
export const companyMembers = pgTable("company_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: varchar("company_id").notNull().references(() => companies.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  role: varchar("role").notNull().default("member"), // 'admin' | 'member'
  createdAt: timestamp("created_at").defaultNow(),
});

// Balance transactions (for both personal and company)
export const balanceTransactions = pgTable("balance_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // If companyId is null, it's a personal transaction
  companyId: varchar("company_id").references(() => companies.id),
  // The user who initiated the transaction
  userId: varchar("user_id").notNull().references(() => users.id),
  type: varchar("type").notNull(), // 'topup' | 'debit' | 'refund_request' | 'refund_approved'
  amountSar: integer("amount_sar").notNull(), // Positive for credit, negative for debit
  orderId: varchar("order_id").references(() => orders.id),
  paymentId: varchar("moyasar_payment_id").unique(), // Unique for webhook idempotency
  status: varchar("status").notNull().default("completed"), // 'pending' | 'completed' | 'rejected'
  note: text("note"),
  approvedBy: varchar("approved_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// Personal balance table (1:1 with users)
// Ideally this could be on the user table, but separate table is cleaner for migration
export const userBalances = pgTable("user_balances", {
  userId: varchar("user_id").primaryKey().references(() => users.id),
  balanceSar: integer("balance_sar").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Relations
export const companiesRelations = relations(companies, ({ many }) => ({
  members: many(companyMembers),
  transactions: many(balanceTransactions),
}));

export const companyMembersRelations = relations(companyMembers, ({ one }) => ({
  company: one(companies, {
    fields: [companyMembers.companyId],
    references: [companies.id],
  }),
  user: one(users, {
    fields: [companyMembers.userId],
    references: [users.id],
  }),
}));

export const balanceTransactionsRelations = relations(balanceTransactions, ({ one }) => ({
  user: one(users, {
    fields: [balanceTransactions.userId],
    references: [users.id],
  }),
  company: one(companies, {
    fields: [balanceTransactions.companyId],
    references: [companies.id],
  }),
  order: one(orders, {
    fields: [balanceTransactions.orderId],
    references: [orders.id],
  }),
}));

export const userBalancesRelations = relations(userBalances, ({ one }) => ({
  user: one(users, {
    fields: [userBalances.userId],
    references: [users.id],
  }),
}));

// Insert schemas
export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCompanyMemberSchema = createInsertSchema(companyMembers).omit({
  id: true,
  createdAt: true,
});

export const insertBalanceTransactionSchema = createInsertSchema(balanceTransactions).omit({
  id: true,
  createdAt: true,
});

// Types
export type Company = typeof companies.$inferSelect;
export type CompanyMember = typeof companyMembers.$inferSelect;
export type BalanceTransaction = typeof balanceTransactions.$inferSelect;
export type UserBalance = typeof userBalances.$inferSelect;

// Price per sheet in SAR
export const PRICE_PER_SHEET_SAR = 150;
