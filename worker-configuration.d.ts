declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    SPOTIFY_CLIENT_ID: string;
    SPOTIFY_CLIENT_SECRET: string;
    COOKIE_ENCRYPTION_KEY: string;
    MCP_OBJECT: DurableObjectNamespace<import("./src/index").SpotifyMCP>;
  }
}

interface Env extends Cloudflare.Env {}
