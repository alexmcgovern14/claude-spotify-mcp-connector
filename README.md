# Spotify MCP Server for Claude

A Cloudflare Worker that acts as a remote MCP connector, letting Claude create
Spotify playlists and add tracks directly from any conversation — phone, laptop,
anywhere.

## Tools available to Claude

| Tool | What it does |
|------|-------------|
| `search_tracks` | Search Spotify's catalogue by query |
| `create_playlist` | Create a new playlist (never deletes) |
| `add_tracks_to_playlist` | Add tracks to a playlist by URI |
| `get_my_playlists` | List your existing playlists |

---

## Setup (one-time, ~10 minutes)

### 1. Regenerate your Spotify client secret

Your old secret was exposed in a chat. Go to:
https://developer.spotify.com/dashboard

Open your app → Settings → Client Secret → click "ROTATE SECRET".
Note the **new** Client ID and Client Secret.

While you're there, add this Redirect URI:
```
https://spotify-mcp.<YOUR-CF-SUBDOMAIN>.workers.dev/callback
```
(You'll know the exact subdomain after step 3. You can come back and add it.)

### 2. Install dependencies

```bash
cd spotify-mcp-server
npm install
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create "OAUTH_KV"
```

This will output something like:
```
{ binding = "OAUTH_KV", id = "abc123def456" }
```

Open `wrangler.jsonc` and replace `<REPLACE_WITH_KV_ID>` with that id value.

### 4. Set your secrets

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID
# Paste your Client ID when prompted

npx wrangler secret put SPOTIFY_CLIENT_SECRET
# Paste your NEW Client Secret when prompted

npx wrangler secret put COOKIE_ENCRYPTION_KEY
# Paste a random string — you can generate one with:
# openssl rand -hex 32
```

### 5. Deploy

```bash
npx wrangler deploy
```

This will output your worker URL, something like:
```
https://spotify-mcp.<your-subdomain>.workers.dev
```

### 6. Update Spotify redirect URI

Go back to your Spotify Developer Dashboard and make sure this redirect URI
is added to your app:
```
https://spotify-mcp.<your-subdomain>.workers.dev/callback
```

### 7. Add to Claude

1. Go to https://claude.ai/settings/connectors
2. Click "Add custom connector"
3. Enter the URL: `https://spotify-mcp.<your-subdomain>.workers.dev/mcp`
4. Click "Add"
5. Click "Connect" — you'll be redirected to Spotify to authorize

**Done.** From now on, in any Claude conversation (phone or laptop), you can
say things like:

- "Create a Spotify playlist called 'Outlaw Muscle Shoals' and add those tracks we discussed"
- "Search Spotify for Bloody Mary Morning by Willie Nelson and add it to my playlist"
- "Show me my Spotify playlists"

---

## Local development (optional)

If you want to test locally before deploying:

1. Create a `.dev.vars` file:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
COOKIE_ENCRYPTION_KEY=any_random_string
```

2. Add `http://localhost:8788/callback` as a redirect URI in your Spotify app.

3. Run: `npm start`

4. Test with MCP Inspector: `npx @modelcontextprotocol/inspector@latest`
   Enter `http://localhost:8788/mcp` as the server URL.
