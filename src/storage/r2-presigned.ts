/**
 * R2 Presigned URL Service for Cloudflare Workers
 * 
 * Generates presigned URLs for direct client uploads to R2.
 * This bypasses the Workers body size limit (100MB-500MB).
 * 
 * Uses AWS SDK v3 S3Client which is compatible with R2.
 */

import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Presigned URL expiry times
const UPLOAD_URL_EXPIRY = 3600; // 1 hour for uploads
const DOWNLOAD_URL_EXPIRY = 3600; // 1 hour for downloads

export interface R2Credentials {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
}

/**
 * Create S3 client configured for R2
 */
function createR2Client(credentials: R2Credentials): S3Client {
    return new S3Client({
        region: "auto",
        endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
        },
    });
}

/**
 * Generate a presigned URL for uploading a file to R2
 * 
 * Client should use this URL with a PUT request.
 * The URL includes the signature so no auth headers needed.
 */
export async function generateUploadUrl(
    credentials: R2Credentials,
    key: string,
    options?: {
        contentType?: string;
        maxSizeBytes?: number;
        expiresIn?: number;
    }
): Promise<{
    uploadUrl: string;
    key: string;
    expiresAt: Date;
}> {
    const client = createR2Client(credentials);

    const command = new PutObjectCommand({
        Bucket: credentials.bucketName,
        Key: key,
        ContentType: options?.contentType || "application/zip",
    });

    const expiresIn = options?.expiresIn || UPLOAD_URL_EXPIRY;
    const uploadUrl = await getSignedUrl(client, command, { expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return {
        uploadUrl,
        key,
        expiresAt,
    };
}

/**
 * Generate a presigned URL for downloading a file from R2
 */
export async function generateDownloadUrl(
    credentials: R2Credentials,
    key: string,
    options?: {
        expiresIn?: number;
        responseContentDisposition?: string;
    }
): Promise<{
    downloadUrl: string;
    expiresAt: Date;
}> {
    const client = createR2Client(credentials);

    const command = new GetObjectCommand({
        Bucket: credentials.bucketName,
        Key: key,
        ResponseContentDisposition: options?.responseContentDisposition,
    });

    const expiresIn = options?.expiresIn || DOWNLOAD_URL_EXPIRY;
    const downloadUrl = await getSignedUrl(client, command, { expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return {
        downloadUrl,
        expiresAt,
    };
}

/**
 * Generate storage key for an order's input file
 */
export function getOrderInputKey(orderId: string, fileName: string): string {
    return `orders/${orderId}/input/${fileName}`;
}

/**
 * Generate storage key for an order's output file
 */
export function getOrderOutputKey(orderId: string, fileName: string): string {
    return `orders/${orderId}/output/${fileName}`;
}

/**
 * Multipart upload session for very large files (>5GB)
 * 
 * For files larger than 5GB, we need to use multipart upload.
 * This returns the parameters needed to start a multipart upload.
 */
export async function createMultipartUpload(
    credentials: R2Credentials,
    key: string,
    contentType: string = "application/zip"
): Promise<{
    uploadId: string;
    key: string;
}> {
    const { CreateMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    const client = createR2Client(credentials);

    const command = new CreateMultipartUploadCommand({
        Bucket: credentials.bucketName,
        Key: key,
        ContentType: contentType,
    });

    const response = await client.send(command);

    if (!response.UploadId) {
        throw new Error("Failed to create multipart upload");
    }

    return {
        uploadId: response.UploadId,
        key,
    };
}

/**
 * Generate presigned URL for uploading a part in a multipart upload
 */
export async function generatePartUploadUrl(
    credentials: R2Credentials,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = 3600
): Promise<string> {
    const { UploadPartCommand } = await import("@aws-sdk/client-s3");
    const client = createR2Client(credentials);

    const command = new UploadPartCommand({
        Bucket: credentials.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
    });

    return getSignedUrl(client, command, { expiresIn });
}

/**
 * Complete a multipart upload after all parts are uploaded
 */
export async function completeMultipartUpload(
    credentials: R2Credentials,
    key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>
): Promise<void> {
    const { CompleteMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    const client = createR2Client(credentials);

    const command = new CompleteMultipartUploadCommand({
        Bucket: credentials.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
    });

    await client.send(command);
}

/**
 * Abort a multipart upload if something goes wrong
 */
export async function abortMultipartUpload(
    credentials: R2Credentials,
    key: string,
    uploadId: string
): Promise<void> {
    const { AbortMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    const client = createR2Client(credentials);

    const command = new AbortMultipartUploadCommand({
        Bucket: credentials.bucketName,
        Key: key,
        UploadId: uploadId,
    });

    await client.send(command);
}

/**
 * List uploaded parts for a multipart upload (used for resume)
 */
export async function listMultipartUploadParts(
    credentials: R2Credentials,
    key: string,
    uploadId: string
): Promise<Array<{ PartNumber: number; ETag: string; Size?: number }>> {
    const { ListPartsCommand } = await import("@aws-sdk/client-s3");
    const client = createR2Client(credentials);

    const parts: Array<{ PartNumber: number; ETag: string; Size?: number }> = [];
    let partNumberMarker: number | undefined;
    let isTruncated = true;

    while (isTruncated) {
        const command = new ListPartsCommand({
            Bucket: credentials.bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
        });

        const response = await client.send(command);
        if (response.Parts) {
            for (const part of response.Parts) {
                if (part.PartNumber && part.ETag) {
                    parts.push({
                        PartNumber: part.PartNumber,
                        ETag: part.ETag,
                        Size: part.Size,
                    });
                }
            }
        }

        isTruncated = !!response.IsTruncated;
        partNumberMarker = response.NextPartNumberMarker;
    }

    return parts;
}
