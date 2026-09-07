declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    MCP_TOKEN_ZHC?: string;
    MCP_TOKEN_YWT?: string;
    MCP_TOKEN_MANAGER?: string;
  }
}
