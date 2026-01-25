import { verifyWebhookSignature, getPayment } from './moyasarClient';
import { storage } from './storage';
import { sendOrderPaidEmail } from './emailService';

export class WebhookHandlers {
  /**
   * Process Moyasar webhook event
   * @param rawBody - The raw request body as a string (used for signature verification)
   * @param payload - The parsed JSON payload
   * @param signature - The X-Moyasar-Signature header value
   */
  static async processWebhook(rawBody: string, payload: any, signature: string): Promise<void> {
    const webhookSecret = process.env.MOYASAR_WEBHOOK_SECRET;

    // In production, we must have a webhook secret
    if (!webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('MOYASAR_WEBHOOK_SECRET is not set');
        return;
      }
    }

    // Verify signature if secret is present
    // CRITICAL: Use rawBody (exact bytes received) for signature verification
    // JSON.stringify(payload) may produce different output due to key ordering, formatting, etc.
    if (webhookSecret && signature) {
      if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        throw new Error('Invalid webhook signature');
      }
    }

    const event = payload;

    // Moyasar events: payment.paid, payment.failed, etc.
    // The payload structure is { id: "...", type: "payment.paid", ... }

    console.log(`Received Moyasar webhook event: ${event.type}`);

    if (event.type === 'payment.paid') {
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
      // Prevents manipulation where attacker pays less than order price
      const expectedAmountHalala = order.totalPriceSar * 100; // Moyasar uses halala (1 SAR = 100 halala)
      if (payment.amount !== expectedAmountHalala) {
        console.error(`Payment amount mismatch for order ${orderId}: expected ${expectedAmountHalala} halala, got ${payment.amount} halala`);
        return;
      }

      await storage.updateOrder(orderId, {
        moyasarPaymentId: payment.id,
        moyasarInvoiceId: payment.invoice_id,
        status: "paid",
        paidAt: new Date()
      });

      console.log(`Order ${orderId} marked as paid`);

      // Send payment confirmation email (fetch full order with user relations)
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
