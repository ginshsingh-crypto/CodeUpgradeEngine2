/**
 * Worker types for Cloudflare bindings
 * Used across the application for type-safe access to env
 */

export interface Bindings {
    // R2 Bucket for file storage (direct binding for Worker operations)
    FILES_BUCKET: R2Bucket;

    // KV namespace for sessions and rate limiting
    SESSIONS: KVNamespace;

    // Environment variables
    DATABASE_URL: string;
    MOYASAR_SECRET_KEY: string;
    MOYASAR_PUBLISHABLE_KEY: string;
    MOYASAR_WEBHOOK_SECRET: string;
    RESEND_API_KEY: string;
    PRICE_PER_SHEET_SAR: string;
    MIN_ADDIN_VERSION: string;

    // R2 credentials for presigned URL generation (S3-compatible API)
    R2_ACCOUNT_ID: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_BUCKET_NAME?: string; // Defaults to "lod400-files"

    // Optional - for email service
    FROM_EMAIL?: string;
}

export interface Variables {
    // Set by middleware
    userId?: string;
    user?: {
        id: string;
        email: string | null;
        firstName: string | null;
        lastName: string | null;
        isAdmin: number | null;
    };
}

export type HonoEnv = {
    Bindings: Bindings;
    Variables: Variables;
};
