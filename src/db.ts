/**
 * Database client for Cloudflare Workers using Neon HTTP driver
 * 
 * Uses @neondatabase/serverless with HTTP transport (not WebSocket)
 * for best compatibility with Cloudflare Workers edge runtime.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle, NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "../shared/schema";

/**
 * Create a database instance per request.
 * In Workers, we cannot share connections across requests.
 * 
 * @param databaseUrl - Neon connection string (use pooler URL for production)
 */
export function createDb(databaseUrl: string): NeonHttpDatabase<typeof schema> {
    const sql = neon(databaseUrl);
    return drizzle(sql, { schema });
}

// Re-export schema for convenience
export { schema };
export type Database = NeonHttpDatabase<typeof schema>;
