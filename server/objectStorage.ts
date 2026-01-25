import { Storage, File } from "@google-cloud/storage";
import { Response } from "express";
import { randomUUID } from "crypto";

// ============================================
// GCS CLIENT INITIALIZATION
// ============================================

/**
 * Creates GCS client with portable authentication.
 * 
 * Priority:
 * 1. GCS_SERVICE_ACCOUNT_JSON env var (for Cloudflare, Docker, etc.)
 * 2. GOOGLE_APPLICATION_CREDENTIALS file path (standard GCP)
 * 3. Replit sidecar (legacy, for Replit deployments only)
 */
function createStorageClient(): Storage {
  // Option 1: Service account JSON in environment variable (recommended for Cloudflare)
  if (process.env.GCS_SERVICE_ACCOUNT_JSON) {
    try {
      const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON);
      return new Storage({
        credentials,
        projectId: credentials.project_id,
      });
    } catch (error) {
      console.error("Failed to parse GCS_SERVICE_ACCOUNT_JSON:", error);
      throw new Error("Invalid GCS_SERVICE_ACCOUNT_JSON format. Must be valid JSON.");
    }
  }

  // Option 2: Standard GCP credentials file (works in GCE, Cloud Run, local dev)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new Storage();
  }

  // Option 3: Replit sidecar (legacy - only works in Replit environment)
  const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
  console.log("Using Replit sidecar for GCS authentication (only works in Replit)");
  return new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });
}

export const objectStorageClient = createStorageClient();

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() { }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
        "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    // Support both PRIVATE_OBJECT_DIR and Replit's DEFAULT_OBJECT_STORAGE_BUCKET_ID
    const dir = process.env.PRIVATE_OBJECT_DIR || process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR (or DEFAULT_OBJECT_STORAGE_BUCKET_ID) not set. Create a bucket in 'Object Storage' " +
        "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const { bucketName, objectName } = this.parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }
    return null;
  }

  async downloadObject(file: File, res: Response, cacheTtlSec: number = 3600) {
    try {
      const [metadata] = await file.getMetadata();
      res.set({
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": metadata.size,
        "Cache-Control": `private, max-age=${cacheTtlSec}`,
      });
      const stream = file.createReadStream();
      stream.on("error", (err) => {
        console.error("Stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming file" });
        }
      });
      stream.pipe(res);
    } catch (error) {
      console.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error downloading file" });
      }
    }
  }

  async getUploadURL(orderId: string, fileName: string): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error("PRIVATE_OBJECT_DIR not set.");
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/orders/${orderId}/${objectId}_${fileName}`;
    const { bucketName, objectName } = this.parseObjectPath(fullPath);

    // Important: Include contentType to prevent GCS 403 signature mismatch
    // The C# client MUST send exactly this Content-Type header
    return this.signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 14400, // 4 hours - allows large files on slow connections
      contentType: "application/zip",
    });
  }

  /**
   * Initiates a resumable upload session with GCS.
   * Returns the resumable session URI that the client can use for chunked uploads.
   * The session URI is valid for 7 days.
   */
  async initiateResumableUpload(orderId: string, fileName: string, fileSize: number): Promise<{ sessionUri: string; storageKey: string }> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error("PRIVATE_OBJECT_DIR not set.");
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/orders/${orderId}/${objectId}_${fileName}`;
    const { bucketName, objectName } = this.parseObjectPath(fullPath);

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    // Create a resumable upload session
    const [sessionUri] = await file.createResumableUpload({
      metadata: {
        contentType: "application/zip",
      },
    });

    return {
      sessionUri,
      storageKey: fullPath,
    };
  }

  /**
   * Checks the status of a resumable upload session.
   * Returns the number of bytes already uploaded, or -1 if the session is complete/invalid.
   */
  async checkResumableUploadStatus(sessionUri: string): Promise<{ bytesUploaded: number; isComplete: boolean }> {
    try {
      // Query the session URI with a Content-Range header to check status
      const response = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "Content-Range": "bytes */*",
        },
      });

      if (response.status === 200 || response.status === 201) {
        // Upload is complete
        return { bytesUploaded: -1, isComplete: true };
      } else if (response.status === 308) {
        // Incomplete - parse Range header to get bytes uploaded
        const rangeHeader = response.headers.get("Range");
        if (rangeHeader) {
          // Format: "bytes=0-12345"
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) {
            return { bytesUploaded: parseInt(match[1], 10) + 1, isComplete: false };
          }
        }
        // No bytes uploaded yet
        return { bytesUploaded: 0, isComplete: false };
      } else if (response.status === 404) {
        // Session expired or invalid
        return { bytesUploaded: -1, isComplete: false };
      }

      return { bytesUploaded: -1, isComplete: false };
    } catch (error) {
      console.error("Error checking resumable upload status:", error);
      return { bytesUploaded: -1, isComplete: false };
    }
  }

  async getDownloadURL(storageKey: string): Promise<string> {
    const { bucketName, objectName } = this.parseObjectPath(storageKey);

    return this.signObjectURL({
      bucketName,
      objectName,
      method: "GET",
      ttlSec: 3600, // 1 hour
    });
  }

  async getFile(storageKey: string): Promise<File> {
    const { bucketName, objectName } = this.parseObjectPath(storageKey);
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return file;
  }

  /**
   * Verifies that a file exists in GCS and returns its metadata.
   * Used to prevent "fake upload" attacks where client claims upload complete without data.
   */
  async verifyFileExists(storageKey: string): Promise<{ exists: boolean; size?: number }> {
    try {
      const { bucketName, objectName } = this.parseObjectPath(storageKey);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);
      const [exists] = await file.exists();

      if (!exists) {
        return { exists: false };
      }

      const [metadata] = await file.getMetadata();
      return {
        exists: true,
        size: metadata.size ? parseInt(String(metadata.size), 10) : undefined
      };
    } catch (error) {
      console.error("Error verifying file exists:", error);
      return { exists: false };
    }
  }

  normalizeStorageKey(uploadURL: string): string {
    if (!uploadURL.startsWith("https://storage.googleapis.com/")) {
      return uploadURL;
    }
    const url = new URL(uploadURL);
    return url.pathname.slice(1); // Remove leading /
  }

  parseObjectPath(path: string): { bucketName: string; objectName: string } {
    if (!path.startsWith("/")) {
      path = `/${path}`;
    }
    const pathParts = path.split("/");
    if (pathParts.length < 3) {
      throw new Error("Invalid path: must contain at least a bucket name");
    }
    const bucketName = pathParts[1];
    const objectName = pathParts.slice(2).join("/");
    return { bucketName, objectName };
  }

  /**
   * Generate signed URL using GCS client library (portable).
   * Works with any GCS authentication method.
   */
  async signObjectURL({
    bucketName,
    objectName,
    method,
    ttlSec,
    contentType,
  }: {
    bucketName: string;
    objectName: string;
    method: "GET" | "PUT" | "DELETE" | "HEAD";
    ttlSec: number;
    contentType?: string;
  }): Promise<string> {
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    const options: any = {
      version: "v4" as const,
      action: method.toLowerCase() as "read" | "write" | "delete",
      expires: Date.now() + ttlSec * 1000,
    };

    // Map HTTP methods to GCS actions
    if (method === "GET" || method === "HEAD") {
      options.action = "read";
    } else if (method === "PUT") {
      options.action = "write";
    } else if (method === "DELETE") {
      options.action = "delete";
    }

    // Include content-type in signature if provided
    if (contentType) {
      options.contentType = contentType;
    }

    const [signedUrl] = await file.getSignedUrl(options);
    return signedUrl;
  }
}
