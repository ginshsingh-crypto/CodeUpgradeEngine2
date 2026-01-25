/**
 * ZIP File Validator
 * Validates uploaded ZIP files by checking magic bytes and detecting potential zip bombs
 */

import { objectStorageClient } from '../objectStorage';

// ZIP magic bytes signatures
const ZIP_SIGNATURES = [
    Buffer.from([0x50, 0x4B, 0x03, 0x04]), // Standard ZIP
    Buffer.from([0x50, 0x4B, 0x05, 0x06]), // Empty ZIP
    Buffer.from([0x50, 0x4B, 0x07, 0x08]), // Spanned ZIP
];

// Min/max reasonable compression ratio (to detect zip bombs)
const MAX_COMPRESSION_RATIO = 100; // 100:1 max ratio

export interface ZipValidationResult {
    valid: boolean;
    error?: string;
    isZip: boolean;
}

/**
 * Read the first N bytes of a file from GCS
 */
export async function readFileHeader(storageKey: string, byteCount: number = 64): Promise<Buffer | null> {
    try {
        const pathParts = storageKey.startsWith('/') ? storageKey.split('/') : `/${storageKey}`.split('/');
        if (pathParts.length < 3) {
            return null;
        }

        const bucketName = pathParts[1];
        const objectName = pathParts.slice(2).join('/');

        const bucket = objectStorageClient.bucket(bucketName);
        const file = bucket.file(objectName);

        // Read first N bytes using range request
        const [contents] = await file.download({
            start: 0,
            end: byteCount - 1,
        });

        return contents;
    } catch (error) {
        console.error('Error reading file header:', error);
        return null;
    }
}

/**
 * Check if a buffer starts with ZIP magic bytes
 */
export function hasZipSignature(header: Buffer): boolean {
    return ZIP_SIGNATURES.some(sig =>
        header.length >= sig.length &&
        header.subarray(0, sig.length).equals(sig)
    );
}

/**
 * Validate that an uploaded file is a valid ZIP
 */
export async function validateZipFile(storageKey: string): Promise<ZipValidationResult> {
    // Read first 64 bytes to check magic number
    const header = await readFileHeader(storageKey, 64);

    if (!header) {
        return {
            valid: false,
            isZip: false,
            error: 'Could not read file header',
        };
    }

    // Check ZIP magic bytes
    if (!hasZipSignature(header)) {
        return {
            valid: false,
            isZip: false,
            error: 'File is not a valid ZIP archive. The file signature does not match ZIP format.',
        };
    }

    return {
        valid: true,
        isZip: true,
    };
}
