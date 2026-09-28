import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo";
import type { EmailInboxMessage } from "@gadgets/workshop-shared/email-inbox";
import { useAuthenticatedApi, useTimeZone } from "../../AuthContext";
import { formatFullTimestamp } from "../../utils/formatTimestamp";

export const InboxMessagePreview = ({
  id,
  canRetry,
  onBack,
  onRetried,
}: {
  id: string;
  canRetry: boolean;
  onBack: () => void;
  onRetried: () => void;
}) => {
  const { authenticatedApi } = useAuthenticatedApi();
  const timeZone = useTimeZone();
  const [loaded, setLoaded] = useState<{
    api: typeof authenticatedApi;
    id: string;
    message: EmailInboxMessage | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const current = loaded?.api === authenticatedApi && loaded.id === id ? loaded : null;
  useEffect(() => {
    const active = ++generation.current;
    setLoaded(null);
    setError(null);
    setBusy(false);
    authenticatedApi
      .getInboxMessage(id)
      .then((message) => {
        if (active === generation.current) setLoaded({ api: authenticatedApi, id, message });
      })
      .catch(() => {
        if (active === generation.current) setError("Could not load this email. Try again.");
      });
    heading.current?.focus();
    return () => {
      generation.current++;
    };
  }, [authenticatedApi, id, attempt]);
  const retry = async () => {
    const active = generation.current;
    setBusy(true);
    setError(null);
    try {
      await authenticatedApi.retryInboxMessage(id);
      if (active === generation.current) {
        setAttempt((value) => value + 1);
        onRetried();
      }
    } catch {
      if (active === generation.current)
        setError("Could not retry this email. Refresh its status before trying again.");
    } finally {
      if (active === generation.current) setBusy(false);
    }
  };
  const message = current?.message;
  return (
    <section
      aria-label="Email preview"
      className="min-w-0 space-y-5 rounded-xl border border-kumo-line p-5 sm:p-6"
    >
      <Button onClick={onBack}>Back to emails</Button>
      <h2
        ref={heading}
        tabIndex={-1}
        className="break-words text-xl font-semibold text-kumo-strong"
      >
        {message?.subject || "Email details"}
      </h2>
      {error && (
        <div className="space-y-3">
          <p role="alert">{error}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>Reload email</Button>
        </div>
      )}
      {!current && !error && <p role="status">Loading email…</p>}
      {current && !message && (
        <p>This email is no longer available. Receipts expire after 30 days.</p>
      )}
      {message && (
        <>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-kumo-subtle">Reported sender</dt>
              <dd className="break-all">{message.sender}</dd>
            </div>
            <div>
              <dt className="text-kumo-subtle">Received</dt>
              <dd>{formatFullTimestamp(new Date(message.receivedAt), timeZone)}</dd>
            </div>
            <div>
              <dt className="text-kumo-subtle">Status</dt>
              <dd className="capitalize">{message.status}</dd>
            </div>
            {message.routing && (
              <div>
                <dt className="text-kumo-subtle">Conversation</dt>
                <dd>
                  {message.routing === "thread"
                    ? "Continued email thread"
                    : message.routing === "related"
                      ? "Continued related conversation"
                      : "Started a new conversation"}
                </dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap items-center gap-4">
            {message.chatPath && (
              <a
                className="text-sm font-medium underline underline-offset-4"
                href={message.chatPath}
              >
                Open chat
              </a>
            )}
            {canRetry && message.status === "failed" && (
              <Button disabled={busy} onClick={retry}>
                {busy ? "Retrying…" : "Retry email"}
              </Button>
            )}
          </div>
          {message.notices.length > 0 && (
            <ul aria-label="Processing notices" className="list-inside list-disc space-y-1 text-sm">
              {message.notices.map((notice, index) => (
                <li key={index}>{notice}</li>
              ))}
            </ul>
          )}
          <div className="border-t border-kumo-line pt-5">
            <h3 className="mb-3 text-sm font-semibold text-kumo-strong">Message</h3>
            <p className="break-words whitespace-pre-wrap text-sm leading-relaxed">
              {message.body === null
                ? "This older email no longer retains its body. Open the chat to see the information it supplied."
                : message.body || "This email has no text body."}
            </p>
          </div>
          {message.attachments.length > 0 && (
            <div className="border-t border-kumo-line pt-5">
              <h3 className="mb-3 text-sm font-semibold text-kumo-strong">
                Attachments ({message.attachments.length})
              </h3>
              <ul className="space-y-2 text-sm">
                {message.attachments.map((attachment, index) => (
                  <li key={index} className="break-all">
                    <span className="font-medium">{attachment.name}</span>
                    <span className="block text-xs text-kumo-subtle">{attachment.type}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-kumo-subtle">
                Extracted information appears in the chat. Original attachment downloads are not
                retained here.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
};
