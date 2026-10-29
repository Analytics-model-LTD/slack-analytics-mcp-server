# slack-analytics-mcp-server

MCP server that lets Analytics Model workflows send Slack messages: dashboard links, alerts, and
"something new happened" notifications. It delivers messages only. The workflow decides *what* to send.

- **One process = one Slack workspace** (one bot token).
- Transport: stdio. Node 18+.
- Messages go to a channel, to people by work email (DM), or both.

---

## 1. Slack app setup (once per workspace)

1. Go to <https://api.slack.com/apps> → **Create New App** → *From scratch*.
2. **OAuth & Permissions → Bot Token Scopes**, add:

   | Scope | Why |
   |---|---|
   | `chat:write` | post messages |
   | `chat:write.public` | post in public channels without inviting the bot |
   | `users:read` | find users |
   | `users:read.email` | find a user by email (needed for DMs) |
   | `im:write` | open a DM |
   | `channels:read` | list public channels (channel picker) |

3. **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`).
4. For private channels, invite the bot (`/invite @YourApp`).

## 2. Run

```bash
SLACK_BOT_TOKEN=xoxb-your-token npx slack-analytics-mcp-server
```

| Env var | Required | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot token of the workspace |
| `SLACK_API_URL` | no | Override the Slack API base URL (tests only) |

MCP client config example:

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "slack-analytics-mcp-server"],
      "env": { "SLACK_BOT_TOKEN": "xoxb-your-token" }
    }
  }
}
```

## 3. Tools

All tools return JSON as text. Failures return `isError: true` with a readable message.

### `get_workspace`
Checks the token. Call it right after a user saves a connection.
Input: none. Output: `{ ok, workspace, workspaceId, url, botUserId, botName }`.

### `lookup_user_by_email`
Input: `{ email }`. Output: `{ id, name, email, deleted, isBot }`.

### `list_channels`
Public channels, for a channel picker.
Input: `{ limit?: 1-200, query?: string }`. Output: `{ channels: [{ id, name, isMember }] }`.

### `send_dm`
Input: `{ email, text }`. Output: `{ email, userId, channel, ts }`.

### `post_to_channel`
Input: `{ channel, text }` (name with or without `#`, or id). Output: `{ channel, ts }`.

### `send_dashboard_link`
A card with a title, optional summary and an **Open dashboard** button.

```json
{
  "url": "https://app.example.com/dashboard/42",
  "title": "Churn analysis",
  "message": "Churn rose 3% this week.",
  "emails": ["priya@acme.com"],
  "channel": "growth"
}
```

### `send_notification`
Generic alert, e.g. "new record in MongoDB". Several items are sent as **one** message (first 10 shown, then "and N more").

```json
{
  "title": "New dashboard created",
  "text": "Created in the last 5 minutes",
  "items": [
    { "title": "Churn v2", "url": "https://app.example.com/d/9",
      "fields": { "Owner": "Priya", "Type": "trend", "Created": "2026-10-29 09:10" } }
  ],
  "url": "https://app.example.com/dashboards",
  "url_label": "Open dashboards",
  "channel": "growth",
  "emails": []
}
```

Rules for both send tools:
- Give at least one of `channel` or `emails`.
- One failed recipient does not stop the others. The result is
  `{ sent, failed, results: [{ to, sent, error? }] }`, and the call is an error only if **every** recipient failed.
- Text is escaped, so names containing `<`, `>` or `&` are safe.
- Slack rate limits (HTTP 429) are retried automatically, up to 3 tries.

## 4. How it fits the platform

```
Frontend ──(saves connection + node settings)──▶ Backend (FastAPI)
                                                    │ on schedule
                                                    ├─ runs Mongo fetch (new records since last run)
                                                    ├─ skips Slack if nothing is new
                                                    └─ starts this MCP with the workspace's token
                                                         └─ calls send_notification / send_dashboard_link
```

- The frontend never talks to the MCP and never keeps the token. It stores a `connectionId`.
- The **backend** must remember the last-seen value per workflow (e.g. `createdAt` or `_id`) so nothing is announced twice. This server is stateless.

**Slack connection** (created once): display name + bot token.
**Slack node settings:** connection, channel and/or emails, title, fields to show, optional button link.

## 5. Troubleshooting

| Error | Meaning / fix |
|---|---|
| `invalid_auth`, `not_authed` | Token wrong or revoked. |
| `missing_scope` | Add the scope in the Slack app and reinstall it. |
| `users_not_found` | No one in that workspace has that email. |
| `channel_not_found` | Wrong channel name or id, or a private channel the bot isn't in. |
| `not_in_channel` | Invite the bot, or add `chat:write.public`. |
| `is_archived` | The channel is archived. |

## 6. Develop and publish

```bash
npm install
npm test        # builds, then runs the server against a fake Slack API (12 checks)
npm publish     # prepublishOnly runs the build
```

Source: `src/index.ts` (tools), `src/slack.ts` (Slack client, message blocks).

## Changelog
- **0.2.0** – added `send_notification`.
- **0.1.0** – `get_workspace`, `lookup_user_by_email`, `list_channels`, `send_dm`, `post_to_channel`, `send_dashboard_link`.
