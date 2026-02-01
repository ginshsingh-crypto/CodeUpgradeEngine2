import { storage } from './storage';
import { sendOrderPaidEmail } from './emailService';
import crypto from 'crypto';

/**
 * Verify webhook signature using HMAC-SHA256
 * This is the standard webhook verification pattern
 */
function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody, 'utf8')
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

export class WebhookHandlers {
  /**
   * Process payment webhook event (generic handler)
   * @param rawBody - The raw request body as a string (used for signature verification)
   * @param payload - The parsed JSON payload
   * @param signature - The signature header value
   */
  static async processWebhook(rawBody: string, payload: any, signature: string): Promise<void> {
    const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;

    // In production, we must have a webhook secret
    if (!webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('PAYMENT_WEBHOOK_SECRET is not set');
        return;
      }
    }

    // Verify signature if secret is present
    if (webhookSecret && signature) {
      if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        throw new Error('Invalid webhook signature');
      }
    }

    const event = payload;

    console.log(`Received webhook event: ${event.type}`);

    if (event.type === 'payment.paid' || event.type === 'checkout.session.completed') {
      const payment = event.data;
      await WebhookHandlers.handlePaymentPaid(payment);
    }
  }


  static async handlePaymentPaid(payment: any): Promise<void> {
    // We store the orderId in the payment metadata
    const orderId = payment.metadata?.orderId;

    if (orderId) {
      console.log(`Processing payment for order ${orderId}`);

      const order = await storage.getOrder(orderId);
      if (!order) {
        console.error(`Order ${orderId} not found for payment ${payment.id}`);
        return;
      }

      // Idempotency check: don't process if already paid
      if (order.status === 'paid' || order.status === 'processing' || order.status === 'complete' || order.status === 'uploaded') {
        console.log(`Order ${orderId} is already paid`);
        return;
      }

      // Security: Verify payment amount matches order total
      const expectedAmount = order.totalPriceSar * 100; // Amount in smallest unit
      const receivedAmount = payment.amount || payment.amount_total;
      if (receivedAmount && receivedAmount !== expectedAmount) {
        console.error(`Payment amount mismatch for order ${orderId}: expected ${expectedAmount}, got ${receivedAmount}`);
        return;
      }

      await storage.updateOrder(orderId, {
        paymentId: payment.id,
        status: "paid",
        paidAt: new Date()
      });

      console.log(`Order ${orderId} marked as paid`);

      // Send payment confirmation email
      const fullOrder = await storage.getOrderWithFiles(orderId);
      if (fullOrder?.user?.email) {
        sendOrderPaidEmail(
          fullOrder.user.email,
          orderId,
          fullOrder.sheetCount,
          fullOrder.user.firstName || undefined
        ).catch(err => console.error('Failed to send paid email:', err));
      }
    } else {
      console.warn(`Payment ${payment.id} received without orderId in metadata`);
    }
  }
}
