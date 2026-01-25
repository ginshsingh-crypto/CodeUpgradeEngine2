/**
 * File Validation Utilities
 * Prevents malicious file uploads by validating extensions and content
 */

import path from 'path';

// Maximum file size: 2 GB
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

// Allowed file extensions for upload
const ALLOWED_EXTENSIONS = new Set([
    // Revit files
    '.rvt', '.rfa', '.rte', '.rft',
    // AutoCAD files  
    '.dwg', '.dxf',
    // IFC/BIM
    '.ifc', '.nwc', '.nwd',
    // Archives
    '.zip',
    // Data files
    '.json', '.xml',
    // Images (for reference)
    '.png', '.jpg', '.jpeg', '.pdf',
]);

// File magic bytes for content verification
const FILE_SIGNATURES: Record<string, Buffer[]> = {
    '.zip': [Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from([0x50, 0x4B, 0x05, 0x06])],
    '.pdf': [Buffer.from([0x25, 0x50, 0x44, 0x46])], // %PDF
    '.png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
    '.jpg': [Buffer.from([0xFF, 0xD8, 0xFF])],
    '.jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
};

/**
 * Check if file extension is allowed
 */
export function isAllowedExtension(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Validate file size against maximum limit
 */
export function isValidFileSize(fileSize: number): boolean {
    return fileSize > 0 && fileSize <= MAX_FILE_SIZE_BYTES;
}

/**
 * Get human-readable file size limit
 */
export function getMaxFileSizeDisplay(): string {
    return `${MAX_FILE_SIZE_BYTES / (1024 * 1024 * 1024)} GB`;
}

/**
 * Validate file by checking magic bytes (first few bytes of file)
 * Returns true if file signature matches expected type, or if type has no signature check
 */
export function validateFileSignature(fileName: string, headerBytes: Buffer): boolean {
    const ext = path.extname(fileName).toLowerCase();
    const expectedSignatures = FILE_SIGNATURES[ext];

    // If no signature defined for this type, skip check (Revit files don't have standard signatures)
    if (!expectedSignatures) {
        return true;
    }

    // Check if any expected signature matches
    return expectedSignatures.some(sig =>
        headerBytes.length >= sig.length &&
        headerBytes.subarray(0, sig.length).equals(sig)
    );
}

/**
 * Validate that a file name doesn't contain path traversal attacks
 */
export function isSafeFileName(fileName: string): boolean {
    // Block path traversal
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
        return false;
    }

    // Block hidden files
    if (fileName.startsWith('.')) {
        return false;
    }

    // Block executables and scripts
    const dangerousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.msi'];
    const ext = path.extname(fileName).toLowerCase();
    if (dangerousExtensions.includes(ext)) {
        return false;
    }

    return true;
}

/**
 * Comprehensive file validation
 */
export function validateUploadFile(fileName: string, fileSize: number): { valid: boolean; error?: string } {
    // Check file name safety
    if (!isSafeFileName(fileName)) {
        return { valid: false, error: `Invalid file name: ${fileName}` };
    }

    // Check extension
    if (!isAllowedExtension(fileName)) {
        return { valid: false, error: `File type not allowed: ${path.extname(fileName)}` };
    }

    // Check size
    if (!isValidFileSize(fileSize)) {
        return { valid: false, error: `File size exceeds maximum of ${getMaxFileSizeDisplay()}` };
    }

    return { valid: true };
}
