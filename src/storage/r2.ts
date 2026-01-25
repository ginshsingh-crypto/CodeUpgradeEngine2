/**
 * R2 Storage Service - Replaces Google Cloud Storage
 * 
 * Provides upload/download functionality using Cloudflare R2.
 * R2 is S3-compatible and has no egress fees.
 */

import type { R2Bucket, R2Object } from "@cloudflare/workers-types";

export class R2StorageService {
    constructor(private bucket: R2Bucket) { }

    /**
     * Get the private object path for an order
     */
    private getObjectPath(orderId: string, fileName: string): string {
        return `orders/${orderId}/${fileName}`;
    }

    /**
     * Get the output path for completed shop drawings
     */
    private getOutputPath(orderId: string, fileName: string): string {
        return `orders/${orderId}/output/${fileName}`;
    }

    /**
     * Generate a presigned URL for uploading to R2
     * Note: R2 presigned URLs work differently than GCS - we use PUT with the URL
     */
    async getUploadUrl(orderId: string, fileName: string): Promise<string> {
        // R2 in Workers requires direct put, not presigned URLs from the Worker itself
        // For client uploads, we'll use a signed upload endpoint instead
        // This returns the key path that the client should use
        return this.getObjectPath(orderId, fileName);
    }

    /**
     * Store a file directly in R2 (used for server-side operations)
     */
    async putObject(
        key: string,
        body: ReadableStream | ArrayBuffer | string,
        options?: { contentType?: string; metadata?: Record<string, string> }
    ): Promise<R2Object> {
        return await this.bucket.put(key, body, {
            httpMetadata: options?.contentType
                ? { contentType: options.contentType }
                : undefined,
            customMetadata: options?.metadata,
        });
    }

    /**
     * Get a file from R2
     */
    async getObject(key: string): Promise<R2Object | null> {
        return await this.bucket.get(key);
    }

    /**
     * Check if a file exists
     */
    async objectExists(key: string): Promise<{ exists: boolean; size?: number }> {
        const head = await this.bucket.head(key);
        if (head) {
            return { exists: true, size: head.size };
        }
        return { exists: false };
    }

    /**
     * Delete a file from R2
     */
    async deleteObject(key: string): Promise<void> {
        await this.bucket.delete(key);
    }

    /**
     * List objects with a prefix (for orders)
     */
    async listObjects(prefix: string): Promise<R2Object[]> {
        const listed = await this.bucket.list({ prefix });
        return listed.objects;
    }

    /**
     * Generate a URL for downloading (creates a temporary signed URL)
     * For Workers, we typically stream directly rather than redirect
     */
    async getDownloadStream(key: string): Promise<ReadableStream | null> {
        const object = await this.bucket.get(key);
        if (!object) return null;
        return object.body;
    }

    /**
     * Get object metadata without downloading
     */
    async getObjectMetadata(key: string): Promise<{
        size: number;
        etag: string;
        uploaded: Date;
        contentType?: string;
    } | null> {
        const head = await this.bucket.head(key);
        if (!head) return null;
        return {
            size: head.size,
            etag: head.etag,
            uploaded: head.uploaded,
            contentType: head.httpMetadata?.contentType,
        };
    }

    /**
     * Create download URL for output files
     * Uses a signed token approach for security
     */
    async createDownloadUrl(orderId: string, fileName: string): Promise<string> {
        // In Workers, we typically handle downloads through our API endpoint
        // rather than presigned URLs. Return the API path.
        return `/api/orders/${orderId}/download/${encodeURIComponent(fileName)}`;
    }

    /**
     * Validate a ZIP file by checking magic bytes
     * R2 version - reads first 4 bytes to check for ZIP signature
     */
    async validateZipFile(key: string): Promise<{ valid: boolean; error?: string }> {
        const object = await this.bucket.get(key, {
            range: { offset: 0, length: 4 },
        });

        if (!object) {
            return { valid: false, error: "File not found" };
        }

        const bytes = new Uint8Array(await object.arrayBuffer());

        // ZIP magic bytes: 0x50 0x4B (PK)
        // Full ZIP signature could be: 50 4B 03 04 (standard) or 50 4B 05 06 (empty) or 50 4B 07 08 (spanned)
        if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            return {
                valid: false,
                error: "Invalid file format. Expected a ZIP archive.",
            };
        }

        return { valid: true };
    }
}

/**
 * Create an R2 storage service instance
 */
export function createStorageService(bucket: R2Bucket): R2StorageService {
    return new R2StorageService(bucket);
}
