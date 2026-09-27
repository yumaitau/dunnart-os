# Slack and Teams private chat

Dunnart includes optional Slack and Teams bot adapters. They are disabled until the
operator configures the corresponding provider credentials. The existing read-only
Slack connector is independent: connecting it does not install this chat bot.

## User setup

1. Open **Profile > Chat channels** and select a workspace you own.
2. Choose **Connect Slack** or **Connect Teams**.
3. Install the Slack bot if needed, or open the Teams bot already installed by your
   organization. In its **private conversation**, paste the one-time `link …` command.
4. The bot confirms pairing. Refresh channels to see the link, then send ordinary text.

Pairing expires after ten minutes, is single-use, and belongs to the authenticated
Dunnart account and selected workspace. Keep the command private. No email/display-name
matching is used. Each provider identity is scoped by its installation/tenant and
private conversation. A new pairing for the same account/conversation starts a new
Dunnart chat; ordinary subsequent messages resume the linked chat.

Answers return to the originating Slack thread or Teams activity. Responses include a
workspace/approval link and are limited to 2,800 characters; open Dunnart for the full
answer. The existing model selection, context library, semantic recall, and action
approval system run the turn. Plain text only: provider attachments are not imported.
Shared-channel mentions receive only private-chat setup instructions, never workspace
output. Workspaces containing restricted data cannot be paired or sent to providers.

**Unlink** blocks new submissions and queued responses. An already dispatched provider
request cannot be recalled. An agent turn already running may finish in Dunnart; unlinking
does not delete workspace history or pending actions. Account deactivation also blocks
new submissions and publication of pending answers.

## Deployment settings

Use Worker secrets, not checked-in vars, for all keys. The backend worker owns these:

| Setting | Required for | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | Both | Canonical HTTPS product origin |
| `CHANNEL_ENCRYPTION_KEY` | Both | Base64-encoded random 32-byte AES key |
| `SLACK_CHAT_CLIENT_ID` | Slack | Slack app client ID |
| `SLACK_CHAT_CLIENT_SECRET` | Slack | OAuth client secret |
| `SLACK_CHAT_SIGNING_SECRET` | Slack | Events signature verification |
| `TEAMS_CHAT_APP_ID` | Teams | Microsoft Entra application/bot ID |
| `TEAMS_CHAT_CLIENT_SECRET` | Teams | Bot client secret |
| `TEAMS_CHAT_TENANT_ID` | Teams | Allowed tenant and token endpoint tenant |

Generate the encryption key using `openssl rand -base64 32` and store it in your private
operator recovery kit. Preserve the key when redeploying; replacing it without re-encrypting
installations makes their tokens unreadable. Slack bot tokens are encrypted with AES-GCM
and team-bound authenticated data before entering the ChatChannels Durable Object. They
never travel through browser RPC responses or query strings. Teams credentials remain
Worker secrets. Do not reuse the independent read-only Slack connector's user tokens.

Base wrangler config includes the `v6` SQLite Durable Object migration for `ChatChannels`.
Custom deployment configs must include that migration too. No additional queue or
external database service is required. The class is reached through `ctx.exports`.

### Public callback routing

The router already forwards `/api/*` to the backend. Providers must reach exactly these
endpoints without an interactive Access/login challenge:

- `POST /api/chat-channels/slack/events`
- `GET /api/chat-channels/slack/oauth`
- `POST /api/chat-channels/teams/events`

If an outer Cloudflare Access policy protects the origin, configure a narrowly scoped
exception for these callback paths. Keep the rest of the application protected. Provider
requests are authenticated by Slack signatures or Microsoft Connector JWTs; OAuth uses
an expiring, single-use state minted through authenticated Dunnart RPC. Do not bypass
Access for `/api` generally.

### Slack app

Create a Slack app and configure:

- Bot OAuth scopes: `chat:write`, `im:history`, `app_mentions:read`.
- OAuth redirect: `https://YOUR_ORIGIN/api/chat-channels/slack/oauth`.
- Events request URL: `https://YOUR_ORIGIN/api/chat-channels/slack/events`.
- Bot events: `message.im`, `app_mention`.
- Enable the App Home Messages tab and allow users to send messages.
- **Disable token rotation for this bot app.** This adapter currently accepts persistent
  bot tokens; it rejects expiring/rotating grants rather than storing an unusable token.

Store the client/signing secrets, deploy, then let Slack verify the Events URL. Install
through Dunnart's **Connect Slack** flow so OAuth state is bound to a signed-in account.
A Slack workspace administrator may need to approve installation. Other members of an
installed workspace can generate their own pairing commands and DM the existing bot.

### Teams app

Create a **single-tenant** Microsoft Entra application and an Azure Bot registration
using its application ID. Configure the bot's Teams channel and messaging endpoint:
`https://YOUR_ORIGIN/api/chat-channels/teams/events`.

Create/upload a Teams app package referencing that bot ID with the `personal` bot scope.
Use the same ID as the package's app ID if you want one identity for app and bot. Provide
the required color/outline icons and tenant-approved app metadata. Publish it through
your organization's app catalog or approved custom-app upload. Users must install the
app before opening its bot conversation. Teams tenant app policies may require admin
approval. This initial implementation supports the public Microsoft cloud and one tenant
per Dunnart deployment, with a client-secret bot credential.

Only activities bearing valid Connector JWTs with the configured audience, issuer,
lifetime, `msteams` key endorsement, matching service URL, and allowed tenant are accepted.
The reply host is additionally limited to Microsoft's public Teams connector hosts.
Emulator, sovereign-cloud and arbitrary service URLs are deliberately unsupported.

## Delivery and recovery

Verified inbound messages are written before returning HTTP 200. Durable IDs suppress
replays for seven days. Queues allow at most 200 outstanding events deployment-wide and
20 events per provider actor/tenant per minute. Text is limited to 12,000 characters;
HTTP bodies to 64 KiB. Conversations run serially. Account/workspace authorization is
checked before starting a turn and before publishing a result.

Agent completion writes a durable outbox entry. Before provider dispatch it is marked
`sending`. A network timeout or restart during dispatch is **uncertain** and is not
resent automatically; Profile shows a warning. Check the provider conversation and
Dunnart history before manually resending. Provider errors are not logged with message
contents, credentials or raw error bodies. Terminal event records (including inbound
text needed for delivery diagnostics/deduplication) expire after seven days. Stalled
agent submissions are marked failed after fifteen minutes; their answer may still
appear in the web workspace.

Deployment backups include the ChatChannels native storage, encrypted installation
tokens, links and queue state. Recovery freezes the dispatcher. Isolated restored runtimes
keep channel setup, dispatch and replies paused; no live messages are sent during a drill.
Restore the matching deployment secrets from your private operator kit for a real cutover.

## Verification

Automated checks cover signature tampering/replay, Teams audience/tenant/destination
verification, token encryption, single-use pairing, account isolation, private-vs-shared
routing, ordered turns, duplicate responses, uncertain sends, revocation and paused
recovery. UI tests cover configuration blockers, workspace selection, pairing/retry,
unlinking and stale account responses.

A live Slack/Teams round trip additionally requires configured provider apps, installation
approval and a test conversation. A successful build or webhook HTTP 200 is not evidence
of provider delivery.

References: [Slack Events](https://docs.slack.dev/apis/events-api/),
[Slack signatures](https://docs.slack.dev/authentication/verifying-requests-from-slack/),
[Slack OAuth](https://docs.slack.dev/reference/methods/oauth.v2.access/),
[Microsoft Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication),
[Teams personal bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/conversation-basics).
