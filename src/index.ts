/**
 * Spotify MCP Server
 *
 * A remote MCP server deployed on Cloudflare Workers that lets Claude
 * manage Spotify playlists and library. Uses Spotify OAuth for auth.
 *
 * Tools:
 *   - search_tracks: Search Spotify for tracks
 *   - search_albums: Search Spotify for albums
 *   - search_playlists: Search Spotify for playlists
 *   - create_playlist: Create a new playlist on the user's account
 *   - add_tracks_to_playlist: Add tracks to an existing playlist
 *   - get_my_playlists: List the user's playlists
 *   - save_albums: Save albums to the user's library
 *   - save_tracks: Save tracks to the user's library
 *   - follow_playlist: Follow/save a playlist to the user's library
 *   - get_album_tracks: Get all tracks from an album (for adding to playlists)
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OAuthProvider } from "workers-oauth-provider";
import SpotifyHandler from "./spotify-handler";

// ─── Spotify API helpers ─────────────────────────────────────────────

type SpotifyProps = {
  spotifyAccessToken: string;
  spotifyRefreshToken: string;
  spotifyTokenExpiresAt: number;
  spotifyUserId: string;
  spotifyDisplayName: string;
};

async function refreshTokenIfNeeded(
  props: SpotifyProps,
  env: Env
): Promise<string> {
  // If token is still valid (with 60s buffer), return it
  if (Date.now() < props.spotifyTokenExpiresAt - 60_000) {
    return props.spotifyAccessToken;
  }

  // Refresh the token
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: props.spotifyRefreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  // Update props in-place for this session
  props.spotifyAccessToken = data.access_token;
  props.spotifyTokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) {
    props.spotifyRefreshToken = data.refresh_token;
  }

  return data.access_token;
}

async function spotifyFetch(
  url: string,
  props: SpotifyProps,
  env: Env,
  options: RequestInit = {}
): Promise<Response> {
  const token = await refreshTokenIfNeeded(props, env);
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

// ─── MCP Server ──────────────────────────────────────────────────────

export class SpotifyMCP extends McpAgent<Env, unknown, SpotifyProps> {
  server = new McpServer({
    name: "Spotify Playlist Manager",
    version: "1.0.0",
  });

  async init() {
    // ── search_tracks ──────────────────────────────────────────────
    this.server.tool(
      "search_tracks",
      "Search Spotify for tracks. Returns track name, artist, album, and Spotify URI.",
      {
        query: z.string().describe("Search query (e.g. 'Bloody Mary Morning Willie Nelson')"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return (default 10)"),
      },
      async ({ query, limit }) => {
        const params = new URLSearchParams({
          q: query,
          type: "track",
          limit: String(limit),
        });

        const res = await spotifyFetch(
          `https://api.spotify.com/v1/search?${params}`,
          this.props,
          this.env
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Search failed: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        const data = (await res.json()) as {
          tracks: {
            items: Array<{
              name: string;
              uri: string;
              artists: Array<{ name: string }>;
              album: { name: string };
              external_urls: { spotify: string };
            }>;
          };
        };

        const tracks = data.tracks.items.map((t, i) => ({
          index: i + 1,
          name: t.name,
          artist: t.artists.map((a) => a.name).join(", "),
          album: t.album.name,
          uri: t.uri,
          url: t.external_urls.spotify,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(tracks, null, 2),
            },
          ],
        };
      }
    );

    // ── create_playlist ────────────────────────────────────────────
    this.server.tool(
      "create_playlist",
      "Create a new playlist on the authenticated user's Spotify account. Returns the playlist ID and URL.",
      {
        name: z.string().describe("Playlist name"),
        description: z
          .string()
          .default("")
          .describe("Playlist description (optional)"),
        public: z
          .boolean()
          .default(true)
          .describe("Whether the playlist is public (default true)"),
      },
      async ({ name, description, public: isPublic }) => {
        const res = await spotifyFetch(
          `https://api.spotify.com/v1/users/${this.props.spotifyUserId}/playlists`,
          this.props,
          this.env,
          {
            method: "POST",
            body: JSON.stringify({
              name,
              description,
              public: isPublic,
            }),
          }
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create playlist: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        const playlist = (await res.json()) as {
          id: string;
          name: string;
          external_urls: { spotify: string };
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: playlist.id,
                  name: playlist.name,
                  url: playlist.external_urls.spotify,
                  message: `Playlist "${playlist.name}" created successfully!`,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // ── add_tracks_to_playlist ─────────────────────────────────────
    this.server.tool(
      "add_tracks_to_playlist",
      "Add tracks to an existing Spotify playlist. Provide track URIs (spotify:track:...). Will NOT delete any existing tracks.",
      {
        playlist_id: z.string().describe("Spotify playlist ID"),
        uris: z
          .array(z.string())
          .describe(
            "Array of Spotify track URIs (e.g. ['spotify:track:abc123'])"
          ),
        position: z
          .number()
          .optional()
          .describe(
            "Position to insert tracks (0-indexed). Omit to append at end."
          ),
      },
      async ({ playlist_id, uris, position }) => {
        // Spotify API accepts max 100 tracks per request
        const chunks: string[][] = [];
        for (let i = 0; i < uris.length; i += 100) {
          chunks.push(uris.slice(i, i + 100));
        }

        let totalAdded = 0;
        for (const chunk of chunks) {
          const body: { uris: string[]; position?: number } = {
            uris: chunk,
          };
          if (position !== undefined) {
            body.position = position + totalAdded;
          }

          const res = await spotifyFetch(
            `https://api.spotify.com/v1/playlists/${playlist_id}/tracks`,
            this.props,
            this.env,
            {
              method: "POST",
              body: JSON.stringify(body),
            }
          );

          if (!res.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to add tracks: ${res.status} ${await res.text()}. Added ${totalAdded} tracks before failure.`,
                },
              ],
            };
          }

          totalAdded += chunk.length;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully added ${totalAdded} tracks to playlist.`,
            },
          ],
        };
      }
    );

    // ── get_my_playlists ───────────────────────────────────────────
    this.server.tool(
      "get_my_playlists",
      "List the authenticated user's Spotify playlists.",
      {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of playlists to return (default 20)"),
        offset: z
          .number()
          .default(0)
          .describe("Offset for pagination (default 0)"),
      },
      async ({ limit, offset }) => {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        });

        const res = await spotifyFetch(
          `https://api.spotify.com/v1/me/playlists?${params}`,
          this.props,
          this.env
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to get playlists: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        const data = (await res.json()) as {
          items: Array<{
            id: string;
            name: string;
            tracks: { total: number };
            external_urls: { spotify: string };
            public: boolean;
          }>;
          total: number;
        };

        const playlists = data.items.map((p) => ({
          id: p.id,
          name: p.name,
          trackCount: p.tracks.total,
          public: p.public,
          url: p.external_urls.spotify,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { total: data.total, playlists },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // ── search_albums ──────────────────────────────────────────────
    this.server.tool(
      "search_albums",
      "Search Spotify for albums. Returns album name, artist, release date, and Spotify ID/URI.",
      {
        query: z.string().describe("Search query (e.g. 'Phases and Stages Willie Nelson')"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return (default 10)"),
      },
      async ({ query, limit }) => {
        const params = new URLSearchParams({
          q: query,
          type: "album",
          limit: String(limit),
        });

        const res = await spotifyFetch(
          `https://api.spotify.com/v1/search?${params}`,
          this.props,
          this.env
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Search failed: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        const data = (await res.json()) as {
          albums: {
            items: Array<{
              id: string;
              name: string;
              uri: string;
              artists: Array<{ name: string }>;
              release_date: string;
              total_tracks: number;
              external_urls: { spotify: string };
            }>;
          };
        };

        const albums = data.albums.items.map((a, i) => ({
          index: i + 1,
          name: a.name,
          artist: a.artists.map((ar) => ar.name).join(", "),
          releaseDate: a.release_date,
          totalTracks: a.total_tracks,
          id: a.id,
          uri: a.uri,
          url: a.external_urls.spotify,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(albums, null, 2),
            },
          ],
        };
      }
    );

    // ── search_playlists ───────────────────────────────────────────
    this.server.tool(
      "search_playlists",
      "Search Spotify for public playlists. Returns playlist name, owner, track count, and Spotify ID.",
      {
        query: z.string().describe("Search query (e.g. 'outlaw country southern rock')"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return (default 10)"),
      },
      async ({ query, limit }) => {
        const params = new URLSearchParams({
          q: query,
          type: "playlist",
          limit: String(limit),
        });

        const res = await spotifyFetch(
          `https://api.spotify.com/v1/search?${params}`,
          this.props,
          this.env
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Search failed: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        const data = (await res.json()) as {
          playlists: {
            items: Array<{
              id: string;
              name: string;
              description: string;
              owner: { display_name: string };
              tracks: { total: number };
              external_urls: { spotify: string };
            }>;
          };
        };

        const playlists = data.playlists.items.map((p, i) => ({
          index: i + 1,
          name: p.name,
          description: p.description,
          owner: p.owner.display_name,
          trackCount: p.tracks.total,
          id: p.id,
          url: p.external_urls.spotify,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(playlists, null, 2),
            },
          ],
        };
      }
    );

    // ── save_albums ────────────────────────────────────────────────
    this.server.tool(
      "save_albums",
      "Save one or more albums to the user's Spotify library (the 'Your Library' section). This is like clicking the heart/save button on an album.",
      {
        ids: z
          .array(z.string())
          .describe("Array of Spotify album IDs (e.g. ['4aawyAB9vmqN3uQ7FjRGTy'])"),
      },
      async ({ ids }) => {
        // Spotify API accepts max 20 albums per request
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 20) {
          chunks.push(ids.slice(i, i + 20));
        }

        let totalSaved = 0;
        for (const chunk of chunks) {
          const res = await spotifyFetch(
            `https://api.spotify.com/v1/me/albums`,
            this.props,
            this.env,
            {
              method: "PUT",
              body: JSON.stringify({ ids: chunk }),
            }
          );

          if (!res.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to save albums: ${res.status} ${await res.text()}. Saved ${totalSaved} before failure.`,
                },
              ],
            };
          }

          totalSaved += chunk.length;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully saved ${totalSaved} album(s) to your library.`,
            },
          ],
        };
      }
    );

    // ── save_tracks ────────────────────────────────────────────────
    this.server.tool(
      "save_tracks",
      "Save one or more tracks to the user's Spotify Liked Songs.",
      {
        ids: z
          .array(z.string())
          .describe("Array of Spotify track IDs (e.g. ['1dGr1c8CrMLDpV6mPbImSI'])"),
      },
      async ({ ids }) => {
        // Spotify API accepts max 50 tracks per request
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 50) {
          chunks.push(ids.slice(i, i + 50));
        }

        let totalSaved = 0;
        for (const chunk of chunks) {
          const res = await spotifyFetch(
            `https://api.spotify.com/v1/me/tracks`,
            this.props,
            this.env,
            {
              method: "PUT",
              body: JSON.stringify({ ids: chunk }),
            }
          );

          if (!res.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to save tracks: ${res.status} ${await res.text()}. Saved ${totalSaved} before failure.`,
                },
              ],
            };
          }

          totalSaved += chunk.length;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully saved ${totalSaved} track(s) to your Liked Songs.`,
            },
          ],
        };
      }
    );

    // ── follow_playlist ────────────────────────────────────────────
    this.server.tool(
      "follow_playlist",
      "Follow (save) a playlist to the user's library. This adds it to 'Your Library' so it appears alongside their own playlists.",
      {
        playlist_id: z.string().describe("Spotify playlist ID to follow"),
        public: z
          .boolean()
          .default(true)
          .describe("Whether to follow publicly (default true)"),
      },
      async ({ playlist_id, public: isPublic }) => {
        const res = await spotifyFetch(
          `https://api.spotify.com/v1/playlists/${playlist_id}/followers`,
          this.props,
          this.env,
          {
            method: "PUT",
            body: JSON.stringify({ public: isPublic }),
          }
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to follow playlist: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully followed playlist. It's now in your library.`,
            },
          ],
        };
      }
    );

    // ── get_album_tracks ───────────────────────────────────────────
    this.server.tool(
      "get_album_tracks",
      "Get all tracks from a Spotify album. Useful for getting track URIs to add an entire album to a playlist.",
      {
        album_id: z.string().describe("Spotify album ID"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(50)
          .describe("Number of tracks to return (default 50)"),
      },
      async ({ album_id, limit }) => {
        const res = await spotifyFetch(
          `https://api.spotify.com/v1/albums/${album_id}/tracks?limit=${limit}`,
          this.props,
          this.env
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to get album tracks: ${res.status} ${await res.text()}`,
              },
            ],
          };
        }

        const data = (await res.json()) as {
          items: Array<{
            name: string;
            uri: string;
            track_number: number;
            artists: Array<{ name: string }>;
            duration_ms: number;
          }>;
          total: number;
        };

        const tracks = data.items.map((t) => ({
          trackNumber: t.track_number,
          name: t.name,
          artist: t.artists.map((a) => a.name).join(", "),
          uri: t.uri,
          durationMs: t.duration_ms,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { total: data.total, tracks },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}

// ─── OAuth Provider (entrypoint) ─────────────────────────────────────

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: SpotifyMCP.serve("/mcp"),
  defaultHandler: SpotifyHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
