import type { ChatChannels } from "../chat-channels/channels";
import { EmailInputError, inboxToken, parseInboxMessage } from "./message";

/** Native Email Routing entrypoint. Private recipient possession grants intake, never read access. */
export async function handleInboxEmail(
  message: ForwardableEmailMessage,
  env: Pick<Cloudflare.Env, "EMAIL_INBOX_DOMAIN">,
  channels: Pick<ChatChannels, "acceptsInboxAddress" | "receiveInboxEmail">,
): Promise<void> {
  const token = inboxToken(message.to, env.EMAIL_INBOX_DOMAIN);
  if (!token || !(await channels.acceptsInboxAddress(token))) {
    message.setReject("This intake address is unavailable.");
    return;
  }
  try {
    const parsed = await parseInboxMessage(message);
    await channels.receiveInboxEmail(token, JSON.stringify(parsed));
  } catch (error) {
    if (error instanceof EmailInputError) {
      message.setReject(error.message);
      return;
    }
    // Temporary failures must reach Email Routing, not acknowledge mail that was never saved.
    // Provider exceptions can contain private addresses or document content.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Email intake is temporarily unavailable.");
  }
}
