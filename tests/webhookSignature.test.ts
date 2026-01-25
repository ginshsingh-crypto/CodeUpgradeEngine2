/**
 * Unit tests for Webhook Signature Verification
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

// Replicate the verifyWebhookSignature function for testing
function verifyWebhookSignature(
    payload: string,
    signature: string,
    webhookSecret: string
): boolean {
    const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(payload)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch {
        return false;
    }
}

describe('Webhook Signature Verification', () => {
    const webhookSecret = 'test_webhook_secret_key';

    describe('verifyWebhookSignature', () => {
        it('should return true for valid signature', () => {
            const payload = JSON.stringify({ type: 'payment.paid', id: '123' });
            const validSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(payload)
                .digest('hex');

            expect(verifyWebhookSignature(payload, validSignature, webhookSecret)).toBe(true);
        });

        it('should return false for invalid signature', () => {
            const payload = JSON.stringify({ type: 'payment.paid', id: '123' });
            const invalidSignature = 'invalid_signature_here';

            expect(verifyWebhookSignature(payload, invalidSignature, webhookSecret)).toBe(false);
        });

        it('should return false for tampered payload', () => {
            const originalPayload = JSON.stringify({ type: 'payment.paid', id: '123' });
            const tamperedPayload = JSON.stringify({ type: 'payment.paid', id: '456' });

            const signatureForOriginal = crypto
                .createHmac('sha256', webhookSecret)
                .update(originalPayload)
                .digest('hex');

            // Signature was for original, but we're checking against tampered
            expect(verifyWebhookSignature(tamperedPayload, signatureForOriginal, webhookSecret)).toBe(false);
        });

        it('should return false for wrong secret', () => {
            const payload = JSON.stringify({ type: 'payment.paid', id: '123' });
            const signatureWithDifferentSecret = crypto
                .createHmac('sha256', 'different_secret')
                .update(payload)
                .digest('hex');

            expect(verifyWebhookSignature(payload, signatureWithDifferentSecret, webhookSecret)).toBe(false);
        });

        it('should handle empty payload', () => {
            const payload = '';
            const validSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(payload)
                .digest('hex');

            expect(verifyWebhookSignature(payload, validSignature, webhookSecret)).toBe(true);
        });

        it('should be case-sensitive for signatures', () => {
            const payload = JSON.stringify({ type: 'payment.paid' });
            const validSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(payload)
                .digest('hex');

            // Uppercase the signature
            const uppercaseSignature = validSignature.toUpperCase();

            expect(verifyWebhookSignature(payload, uppercaseSignature, webhookSecret)).toBe(false);
        });
    });
});
