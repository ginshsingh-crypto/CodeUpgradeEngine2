/**
 * Unit tests for ZIP Validator
 */

import { describe, it, expect } from 'vitest';
import { hasZipSignature } from '../server/utils/zipValidator';

describe('ZIP Validator', () => {
    describe('hasZipSignature', () => {
        it('should return true for valid ZIP magic bytes (PK standard)', () => {
            // Standard ZIP header: PK\x03\x04
            const zipHeader = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
            expect(hasZipSignature(zipHeader)).toBe(true);
        });

        it('should return true for empty ZIP (PK\\x05\\x06)', () => {
            // Empty ZIP header
            const emptyZipHeader = Buffer.from([0x50, 0x4B, 0x05, 0x06, 0x00, 0x00]);
            expect(hasZipSignature(emptyZipHeader)).toBe(true);
        });

        it('should return true for spanned ZIP (PK\\x07\\x08)', () => {
            // Spanned ZIP header
            const spannedZipHeader = Buffer.from([0x50, 0x4B, 0x07, 0x08, 0x00, 0x00]);
            expect(hasZipSignature(spannedZipHeader)).toBe(true);
        });

        it('should return false for PDF file', () => {
            // PDF header: %PDF
            const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E]);
            expect(hasZipSignature(pdfHeader)).toBe(false);
        });

        it('should return false for PNG file', () => {
            // PNG header
            const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A]);
            expect(hasZipSignature(pngHeader)).toBe(false);
        });

        it('should return false for plain text file', () => {
            // Plain text
            const textHeader = Buffer.from('Hello, World!', 'utf8');
            expect(hasZipSignature(textHeader)).toBe(false);
        });

        it('should return false for empty buffer', () => {
            const emptyBuffer = Buffer.from([]);
            expect(hasZipSignature(emptyBuffer)).toBe(false);
        });

        it('should return false for buffer shorter than signature', () => {
            // Only 2 bytes, not enough to match signature
            const shortBuffer = Buffer.from([0x50, 0x4B]);
            expect(hasZipSignature(shortBuffer)).toBe(false);
        });
    });
});
