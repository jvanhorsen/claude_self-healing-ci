# self-heal-ci

**Self-healing CI powered by Claude Code Channels.**

When your GitHub Actions build fails, Claude automatically pulls the logs, diagnoses the issue, applies a fix, verifies it locally, and opens a PR — all reported back to your Discord channel.

> **Note:** Claude Code Channels are in [research preview](https://code.claude.com/docs/en/channels) and require Claude Code v2.1.80+.

---

## How It Works

```
GitHub Actions (failure webhook)
        │
        ▼
  self-heal-ci (MCP channel server)
        │
   ┌────┴────┐
   ▼         ▼
Claude     Discord
Code       #ci-autopilot
```

1. GitHub Actions completes a workflow run and sends a webhook
2. This channel server filters for failures and forwards them to Claude Code
3. Claude checks out the branch, reads the logs, diagnoses the error, and applies a fix
4. If local tests pass, Claude commits, pushes, and opens a PR
5. The full cycle is reported to Discord — and destructive actions (like `git push`) require your approval via Discord's permission relay

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Claude Code](https://code.claude.com) v2.1.80+ (logged in via claude.ai)
- [gh CLI](https://cli.github.com/) authenticated (`gh auth login`)
- A Discord bot ([create one here](https://discord.com/developers/applications))

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/self-heal-ci.git
cd self-heal-ci
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `DISCORD_CHANNEL_ID` | Yes | Channel ID for CI reports |
| `ALLOWED_DISCORD_USERS` | Yes | Comma-separated Discord user IDs |
| `GITHUB_WEBHOOK_SECRET` | No | HMAC secret for webhook verification |
| `WEBHOOK_PORT` | No | HTTP port (default: 9090) |

### 3. Set up Discord bot

1. Create an application at [discord.com/developers](https://discord.com/developers/applications)
2. Go to **Bot** → copy the token → paste into `.env`
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to **OAuth2** → URL Generator → select `bot` scope → permissions: Send Messages, Read Messages, Add Reactions
5. Open the generated URL to invite the bot to your server
6. Create a `#ci-autopilot` channel (or use an existing one)
7. Copy the channel ID (Developer Mode → right-click → Copy ID)

### 4. Set up GitHub webhook

1. Go to your repo → **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL**: your tunnel URL + `/github` (see below)
3. **Content type**: `application/json`
4. **Secret**: the value from your `.env` (generate one with `openssl rand -hex 20`)
5. **Events**: select **Workflow runs** only

Since this runs locally, you need a tunnel to receive webhooks:

```bash
# Option A: ngrok
ngrok http 9090

# Option B: cloudflared (no account needed)
cloudflared tunnel --url http://localhost:9090
```

### 5. Launch

Navigate to the root of the repo you want to monitor, then copy the `.mcp.json` from this project into it (or merge with your existing one):

```bash
cp /path/to/self-heal-ci/.mcp.json ./
```

Start Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:self-heal-ci
```

### 6. Test it

Send a simulated failure webhook:

```bash
bun run test:webhook
```

Or trigger a real failure:

```bash
git checkout -b test-self-heal
echo "const x: number = 'oops'" >> src/index.ts
git add src/index.ts && git commit -m "test: break the build"
git push origin test-self-heal
```

Check your Discord channel — you should see Claude investigating and (hopefully) fixing the issue.

## Project Structure

```
self-heal-ci/
├── src/
│   ├── server.ts          # Main entry point — wires everything together
│   ├── config.ts          # Environment variable loader with validation
│   ├── discord.ts         # Discord bot (implements ChatPlatform interface)
│   ├── webhook.ts         # GitHub webhook HTTP server
│   └── instructions.ts    # Claude's system prompt (diagnosis + fix strategy)
├── test/
│   └── fixtures/
│       └── failure.json   # Sample webhook payload for testing
├── .env.example           # Environment variable template
├── .mcp.json              # MCP server configuration for Claude Code
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

### Modular chat platform

The Discord integration implements a `ChatPlatform` interface (`send`, `onMessage`, `connect`, `disconnect`). To use Slack or Telegram instead, create a new module that implements the same interface and swap the import in `server.ts`. The MCP layer and Claude's instructions don't change.

### Permission relay

When Claude wants to run a destructive command (like `git push`), Claude Code sends a permission request to the channel server. The server forwards it to Discord as a formatted message with a 5-letter approval code. You reply `yes abcde` or `no abcde` in Discord, and the verdict is relayed back. You can also approve from the local terminal — whichever arrives first is applied.

### Safety guardrails

Claude's instructions enforce strict boundaries:

- Never force pushes
- Never modifies main/master directly
- Only touches files related to the failure
- Always verifies fixes locally before pushing
- Always reports back to Discord, even on failure

### Escalation

If Claude can't fix an issue, it reports its diagnosis, what it tried, and what a human should look at. You can reply in Discord with follow-up instructions ("try reverting the last commit", "check the lockfile") and Claude will execute them.

## Limitations

- **Research preview**: Custom channels require `--dangerously-load-development-channels` until added to the approved allowlist
- **Local execution**: The repo must be cloned locally — this isn't a cloud service
- **Tunnel required**: GitHub needs a public URL to send webhooks to your local port
- **Single repo per session**: Run multiple Claude Code sessions for multiple repos
- **Auth**: Requires claude.ai login (not API keys). Team/Enterprise orgs must enable channels in admin settings

## Contributing

PRs welcome. Some areas that would be great to expand:

- **Slack integration** — implement `ChatPlatform` for Slack
- **Telegram integration** — implement `ChatPlatform` for Telegram
- **Multi-repo support** — route webhooks to different local clones based on `repository.full_name`
- **Fix history** — log diagnoses and fixes to build a pattern database
- **Metrics dashboard** — track auto-fix success rate, mean-time-to-fix, etc.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

This tool writes code and pushes to git branches on your behalf. It is designed as a **first responder**, not a replacement for code review. All fixes go through your normal PR process. Use at your own risk.
