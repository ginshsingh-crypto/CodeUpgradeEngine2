/**
 * Unit tests for Version Enforcement Middleware
 */

import { describe, it, expect } from 'vitest';

// Extract the compareVersions function logic for testing
function compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(n => parseInt(n, 10) || 0);
    const partsB = b.split('.').map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < 3; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA < numB) return -1;
        if (numA > numB) return 1;
    }
    return 0;
}

describe('Version Enforcement', () => {
    describe('compareVersions', () => {
        it('should return 0 for equal versions', () => {
            expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
            expect(compareVersions('2.5.3', '2.5.3')).toBe(0);
        });

        it('should return -1 when first version is older', () => {
            expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
            expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
            expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
            expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
        });

        it('should return 1 when first version is newer', () => {
            expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
            expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
            expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
            expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
        });

        it('should handle partial versions', () => {
            expect(compareVersions('1.0', '1.0.0')).toBe(0);
            expect(compareVersions('1', '1.0.0')).toBe(0);
            expect(compareVersions('2', '1.9.9')).toBe(1);
        });

        it('should handle versions with high numbers', () => {
            expect(compareVersions('1.0.100', '1.0.99')).toBe(1);
            expect(compareVersions('10.0.0', '9.9.9')).toBe(1);
        });
    });

    describe('version checking logic', () => {
        const MIN_ADDIN_VERSION = '1.0.0';

        it('should accept versions >= minimum', () => {
            const clientVersions = ['1.0.0', '1.0.1', '1.1.0', '2.0.0'];
            for (const version of clientVersions) {
                expect(compareVersions(version, MIN_ADDIN_VERSION) >= 0).toBe(true);
            }
        });

        it('should reject versions < minimum', () => {
            const clientVersions = ['0.9.9', '0.1.0', '0.0.1'];
            for (const version of clientVersions) {
                expect(compareVersions(version, MIN_ADDIN_VERSION) < 0).toBe(true);
            }
        });
    });
});
