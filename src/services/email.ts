/**
 * Email Service for Cloudflare Workers
 * Uses Resend HTTP API (no changes needed from Express version)
 */

interface ResendEmailRequest {
    from: string;
    to: string[];
    subject: string;
    html: string;
}

export class EmailService {
    private apiKey: string;
    private fromEmail: string;

    constructor(apiKey: string, fromEmail: string = "LOD 400 <noreply@lod400.com>") {
        this.apiKey = apiKey;
        this.fromEmail = fromEmail;
    }

    private async sendEmail(request: ResendEmailRequest): Promise<boolean> {
        if (!this.apiKey) {
            console.warn("RESEND_API_KEY not configured, email not sent");
            return false;
        }

        try {
            const response = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                const error = await response.text();
                console.error("Resend API error:", error);
                return false;
            }

            return true;
        } catch (error) {
            console.error("Email send error:", error);
            return false;
        }
    }

    async sendPasswordResetEmail(
        toEmail: string,
        resetUrl: string,
        firstName?: string
    ): Promise<boolean> {
        const greeting = firstName ? `Hi ${firstName},` : "Hi,";

        return this.sendEmail({
            from: this.fromEmail,
            to: [toEmail],
            subject: "Reset Your LOD 400 Password",
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">Password Reset Request</h2>
          <p>${greeting}</p>
          <p>We received a request to reset your LOD 400 account password.</p>
          <p>Click the button below to reset your password. This link expires in 1 hour.</p>
          <p style="margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #0066cc; color: white; padding: 12px 24px; 
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Reset Password
            </a>
          </p>
          <p style="color: #666; font-size: 14px;">
            If you didn't request this, you can safely ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">
            &copy; ${new Date().getFullYear()} LOD 400 BIM Shop Drawings
          </p>
        </div>
      `,
        });
    }

    async sendOrderPaidEmail(
        toEmail: string,
        orderId: string,
        sheetCount: number,
        firstName?: string
    ): Promise<boolean> {
        const greeting = firstName ? `Hi ${firstName},` : "Hi,";

        return this.sendEmail({
            from: this.fromEmail,
            to: [toEmail],
            subject: `Order Confirmed - ${sheetCount} Sheet${sheetCount > 1 ? "s" : ""} Ready for Processing`,
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">Payment Confirmed! ✅</h2>
          <p>${greeting}</p>
          <p>Your order has been confirmed and is ready for processing.</p>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Order ID:</strong> ${orderId}</p>
            <p style="margin: 10px 0 0;"><strong>Sheets:</strong> ${sheetCount}</p>
          </div>
          <p>Please upload your Revit model package. Our team will begin processing once we receive your files.</p>
          <p><strong>Expected delivery:</strong> Within 24 hours of upload</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">
            &copy; ${new Date().getFullYear()} LOD 400 BIM Shop Drawings
          </p>
        </div>
      `,
        });
    }

    async sendOrderCompleteEmail(
        toEmail: string,
        orderId: string,
        sheetCount: number,
        firstName?: string
    ): Promise<boolean> {
        const greeting = firstName ? `Hi ${firstName},` : "Hi,";

        return this.sendEmail({
            from: this.fromEmail,
            to: [toEmail],
            subject: `Your Shop Drawings Are Ready! - ${sheetCount} Sheet${sheetCount > 1 ? "s" : ""} Complete`,
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">Shop Drawings Complete! 🎉</h2>
          <p>${greeting}</p>
          <p>Great news! Your LOD 400 shop drawings are ready for download.</p>
          <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Order ID:</strong> ${orderId}</p>
            <p style="margin: 10px 0 0;"><strong>Sheets Completed:</strong> ${sheetCount}</p>
          </div>
          <p>Log in to your account or use the Revit add-in to download your upgraded model with detailed shop drawings.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">
            &copy; ${new Date().getFullYear()} LOD 400 BIM Shop Drawings
          </p>
        </div>
      `,
        });
    }

    async sendContactFormEmail(
        fromName: string,
        fromEmail: string,
        message: string
    ): Promise<boolean> {
        return this.sendEmail({
            from: this.fromEmail,
            to: ["support@lod400.com"], // Your support inbox
            subject: `Contact Form: ${fromName}`,
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>New Contact Form Submission</h2>
          <p><strong>From:</strong> ${fromName} (${fromEmail})</p>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; white-space: pre-wrap;">${message}</p>
          </div>
        </div>
      `,
        });
    }
}

/**
 * Create email service instance
 */
export function createEmailService(
    apiKey: string,
    fromEmail?: string
): EmailService {
    return new EmailService(apiKey, fromEmail);
}
