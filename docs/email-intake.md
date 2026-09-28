# Email intake

Dunnart accepts information through Cloudflare Email Routing and processes it with the selected workspace's existing agent, memory, and action approvals. This integration follows the inbound-email pattern demonstrated by [Cloudflare agentic-inbox](https://github.com/cloudflare/agentic-inbox); it does not install a second chat or mailbox application.

## Use

Open **Profile → Email intake**, choose a workspace you own, and enable intake. Copy the private address, such as `inbox+<random-secret>@mail.example.com`.

Anyone possessing this address can submit information to that workspace. It grants no ability to read chats. The displayed sender is an unverified email header, not an authenticated Dunnart identity. Share the address only with trusted senders. Replace it if disclosed; replacing, disabling, or changing workspace revokes the previous address. Already submitted agent turns cannot be recalled.

- Replies with matching `References` or `In-Reply-To` continue the same conversation within that private mailbox.
- With **Continue strongly related conversations** enabled, a strong, unambiguous match in the workspace's recent completed conversation memory continues that chat. Matching requires embeddings; failure, missing memory, or ambiguity starts a new chat.
- Otherwise, a new email starts a chat. Put `[new]` at the beginning of its subject to bypass both matching paths.
- Thread matching is retained for 30 days. Topic matching considers recent completed memory, not every historical message.
- Answers and approvals stay in Dunnart. This feature sends no automatic email replies.

Recent receipts show queue state, routing choice, extraction notices and a chat link. Refresh to update them. Failed messages can be retried while their original address remains enabled; retries reuse the original submission identity.

## Content and limits

Each email may be at most 1 MiB of raw MIME, with up to 10 attachments totalling 512 KiB. Plain text is preferred; HTML is converted to inert text without loading remote resources. Text, Markdown, CSV, JSON and XML attachments are decoded directly. PDF, DOCX, XLSX, ODT and ODS use the configured Workers AI document converter. Unsupported attachments are listed rather than silently omitted. Original binary attachments are not offered as downloads or automatically published to the knowledge library.

Body and combined extracted attachments are each limited to 32,000 characters, with visible truncation notices. Automated replies are rejected. The account limit is 100 accepted messages per rolling day. The shared dispatcher accepts up to 200 pending receipts and 8 MiB of stored intake JSON; saturation fails intake instead of acknowledging unsaved mail.

Receipts expire after 30 days. Completed or cancelled receipts retain their bounded text body and attachment names, but discard the extracted prompt and attachment bytes. Failed receipts keep those bytes for retry until expiry. Chat content follows workspace retention.

## Deployment

1. Enable Cloudflare Email Routing on a dedicated receiving domain or subdomain. Do not replace an existing business mail domain's MX records.
2. Enable Email Routing **subaddressing**. Cloudflare preserves the `+detail` portion in the Worker's `message.to`.
3. Route the literal address `inbox@your-receiving-domain` to the Dunnart router Worker, or directly to the workshop backend Worker. A subdomain does not require a catch-all.
4. Set the backend's `EMAIL_INBOX_DOMAIN` to that exact domain and deploy. Leave it unset to disable the feature.
5. The native `email()` handler must be present on the target Worker. With Wrangler 4.113 or later, the router's private deployment configuration can contain `"addresses": ["inbox@your-receiving-domain"]`; deployment reconciles that routing rule. Keep instance domains out of public source.
6. Configure a workspace model before intake. The agent uses the same configured model and approvals as browser chat.

See Cloudflare's [subdomain setup](https://developers.cloudflare.com/email-service/configuration/subdomains/) and [subaddressing/routing rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/).

The backend saves bounded MIME-derived data before acknowledging receipt, then processes it through a persistent alarm. Message IDs are deduplicated within each private address. Missing IDs use a digest of the raw email. Sender headers and subjects never select an application account. Access and account activation are checked again before dispatch.

## Recovery and failure handling

Email state lives in the existing `ChatChannels` Durable Object and participates in deployment admission draining, native snapshots, mutation fences, and isolated recovery pauses. Workspace references retained by intake are included in backup discovery. Restored dispatch remains paused. Private addresses and queued content are covered by the deployment's encrypted archives.

An interrupted submission retries with the same identity. A completion arriving before the submission acknowledgement still records the original chat. Busy conversations wait; uncertain or exhausted processing is shown as failed and can be retried explicitly. SMTP/provider errors are surfaced rather than claiming that an unsaved message was accepted. Cloudflare's delivery policy still governs mail before the Worker has accepted it.

## Inbox view

Open **Inbox** in the sidebar (or `/inbox`) to browse received emails. The list is
account-scoped, newest first, with 30 messages per page and **Load older emails**.
Search filters the loaded subjects and senders. **Refresh inbox** checks for new
messages and processing changes. Selecting a message shows its plain-text body,
reported sender, received time in the account timezone, status, attachment names,
processing notices and conversation link. Failed deliveries can be retried while
intake remains enabled. Intake configuration remains in Profile → Email intake.

Bounded text bodies and attachment names are retained with receipts for 30 days.
Raw attachment bytes are discarded after completion or cancellation; extracted
information remains in the chat. Completed receipts from releases before the inbox
view may have already discarded their bodies. The UI explicitly marks these bodies
unavailable instead of presenting an empty email. Expired receipts are excluded
from listing and detail reads even before the cleanup alarm runs.
