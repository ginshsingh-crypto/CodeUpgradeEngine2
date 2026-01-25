import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { WebhookHandlers } from "./webhookHandlers";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq, ne } from "drizzle-orm";

// Require ADMIN_EMAIL to be explicitly set - no hardcoded fallback for security
if (!process.env.ADMIN_EMAIL) {
  throw new Error("FATAL: ADMIN_EMAIL environment variable must be set");
}
const SUPER_ADMIN_EMAIL = process.env.ADMIN_EMAIL;

async function ensureSuperAdmin() {
  try {
    // Make the designated email the only admin (isAdmin is integer: 0 = false, 1 = true)
    await db.update(users).set({ isAdmin: 0 }).where(ne(users.email, SUPER_ADMIN_EMAIL));
    await db.update(users).set({ isAdmin: 1 }).where(eq(users.email, SUPER_ADMIN_EMAIL));
    log(`Super admin configured: ${SUPER_ADMIN_EMAIL}`, "auth");
  } catch (error: any) {
    log(`Error configuring super admin: ${error.message}`, "auth");
  }
}

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}


(async () => {
  try {
    // Log TEST_MODE status at startup
    if (process.env.TEST_MODE === "true") {
      log("TEST MODE ACTIVE - Payments are bypassed", "config");
    }

    // Register Moyasar webhook route FIRST (before json middleware)
    // Must use express.raw() to capture exact bytes for HMAC signature verification
    app.post(
      '/api/moyasar/webhook',
      express.raw({ type: 'application/json' }),
      async (req, res) => {
        const signature = req.headers['x-moyasar-signature'];

        if (!signature) {
          log('Webhook error: Missing X-Moyasar-Signature header', 'moyasar');
          return res.status(400).json({ error: 'Missing X-Moyasar-Signature' });
        }

        try {
          const sig = Array.isArray(signature) ? signature[0] : signature;

          if (!Buffer.isBuffer(req.body)) {
            log('Webhook error: req.body is not a Buffer', 'moyasar');
            return res.status(500).json({ error: 'Webhook processing error' });
          }

          // Convert Buffer to string for signature verification
          const rawBody = req.body.toString('utf8');
          const payload = JSON.parse(rawBody);

          await WebhookHandlers.processWebhook(rawBody, payload, sig);

          res.status(200).json({ received: true });
        } catch (error: any) {
          log(`Webhook error: ${error.message}`, 'moyasar');
          res.status(400).json({ error: 'Webhook processing error' });
        }
      }
    );


    app.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );

    app.use(express.urlencoded({ extended: false }));

    // Mask sensitive fields before logging
    function maskSensitiveFields(obj: any): any {
      if (!obj || typeof obj !== 'object') return obj;
      const masked = { ...obj };
      const sensitiveKeys = ['token', 'passwordHash', 'signedUrl', 'url', 'downloadUrl', 'uploadUrl', 'apiKey', 'secret'];
      for (const key of sensitiveKeys) {
        if (key in masked) masked[key] = '[REDACTED]';
      }
      return masked;
    }

    app.use((req, res, next) => {
      const start = Date.now();
      const path = req.path;
      let capturedJsonResponse: Record<string, any> | undefined = undefined;

      const originalResJson = res.json;
      res.json = function (bodyJson, ...args) {
        capturedJsonResponse = bodyJson;
        return originalResJson.apply(res, [bodyJson, ...args]);
      };

      res.on("finish", () => {
        const duration = Date.now() - start;
        if (path.startsWith("/api")) {
          let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
          if (capturedJsonResponse) {
            logLine += ` :: ${JSON.stringify(maskSensitiveFields(capturedJsonResponse))}`;
          }

          log(logLine);
        }
      });

      next();
    });

    await registerRoutes(httpServer, app);

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      res.status(status).json({ message });
      console.error(err);
    });

    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    } else {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }

    const port = parseInt(process.env.PORT || "5000", 10);

    // Start listening FIRST, then initialize external services
    httpServer.listen(
      {
        port,
        host: "0.0.0.0",
        reusePort: true,
      },
      () => {
        log(`serving on port ${port}`);

        // Ensure super admin is configured
        ensureSuperAdmin().catch((err) => {
          log(`Admin setup error: ${err.message}`, 'auth');
        });

        // Payments are handled via Moyasar - no Stripe initialization needed

        // Start cron jobs
        import("./cron").then(({ startOrderCleanupJob }) => {
          startOrderCleanupJob();
        }).catch(err => {
          log(`Failed to start cron jobs: ${err.message}`, 'cron');
        });
      },
    );
  } catch (error: any) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();
