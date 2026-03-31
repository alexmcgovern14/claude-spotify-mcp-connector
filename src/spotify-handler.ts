/**
 * Spotify OAuth Handler
 *
 * Handles the OAuth 2.0 flow with Spotify as the third-party provider.
 * Adapted from the Cloudflare GitHub OAuth MCP template.
 */

import { Hono } from "hono";
import {
  type AuthRequest,
  OAuthHelpers,
  type OAuthHelpersPKCE,
} from "workers-oauth-provider";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

// Scopes we need for playlist creation, track search, and library management
const SPOTIFY_SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
  "user-read-private",
  "user-read-email",
  "user-library-modify",
  "user-library-read",
].join(" ");

type SpotifyEnv = {
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_PROVIDER: OAuthHelpersPKCE;
};

const app = new Hono<{ Bindings: SpotifyEnv }>();

/**
 * GET /authorize — show the consent screen, then redirect to Spotify
 */
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request", 400);
  }

  // Generate CSRF token
  const csrfToken = crypto.randomUUID();
  const setCookie = `csrf=${csrfToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;

  const state = btoa(JSON.stringify({ oauthReqInfo, csrfToken }));

  // Redirect directly to Spotify's authorize endpoint
  const spotifyAuthUrl = new URL(SPOTIFY_AUTHORIZE_URL);
  spotifyAuthUrl.searchParams.set("client_id", c.env.SPOTIFY_CLIENT_ID);
  spotifyAuthUrl.searchParams.set("response_type", "code");
  spotifyAuthUrl.searchParams.set(
    "redirect_uri",
    new URL("/callback", c.req.url).toString()
  );
  spotifyAuthUrl.searchParams.set("scope", SPOTIFY_SCOPES);
  spotifyAuthUrl.searchParams.set("state", state);
  spotifyAuthUrl.searchParams.set("show_dialog", "false");

  return c.redirect(spotifyAuthUrl.toString(), 302);
});

/**
 * GET /callback — Spotify redirects back here with an auth code
 */
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.text(`Spotify authorization error: ${error}`, 400);
  }

  if (!code || !stateParam) {
    return c.text("Missing code or state", 400);
  }

  // Decode state
  let state: { oauthReqInfo?: AuthRequest; csrfToken?: string };
  try {
    state = JSON.parse(atob(stateParam));
  } catch {
    return c.text("Invalid state", 400);
  }

  if (!state.oauthReqInfo) {
    return c.text("Missing OAuth request info in state", 400);
  }

  // Exchange Spotify auth code for tokens
  const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${c.env.SPOTIFY_CLIENT_ID}:${c.env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL("/callback", c.req.url).toString(),
    }),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    return c.text(`Spotify token exchange failed: ${errText}`, 500);
  }

  const spotifyTokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  // Get Spotify user profile
  const profileResponse = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${spotifyTokens.access_token}` },
  });

  const profile = (await profileResponse.json()) as {
    id: string;
    display_name: string;
    email: string;
  };

  // Complete the MCP OAuth flow — issue our own token to the MCP client
  // We store the Spotify tokens as props so tools can use them
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: state.oauthReqInfo,
    userId: profile.id,
    metadata: {
      label: profile.display_name || profile.id,
    },
    scope: state.oauthReqInfo.scope,
    props: {
      spotifyAccessToken: spotifyTokens.access_token,
      spotifyRefreshToken: spotifyTokens.refresh_token,
      spotifyTokenExpiresAt: Date.now() + spotifyTokens.expires_in * 1000,
      spotifyUserId: profile.id,
      spotifyDisplayName: profile.display_name,
    },
  });

  return c.redirect(redirectTo);
});

export default app;
