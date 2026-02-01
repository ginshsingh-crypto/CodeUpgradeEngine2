export function getMoyasarPublishableKey(): string {
  throw new Error("Payment system not configured. Please contact support.");
}

export async function createPayment(_options: {
  amount: number;
  currency: string;
  description: string;
  callback_url: string;
  metadata?: Record<string, string>;
}): Promise<{ id: string; source?: { transaction_url?: string } }> {
  throw new Error("Payment system not configured. Please contact support.");
}

export function buildPaymentFormUrl(_paymentId: string): string {
  throw new Error("Payment system not configured. Please contact support.");
}
