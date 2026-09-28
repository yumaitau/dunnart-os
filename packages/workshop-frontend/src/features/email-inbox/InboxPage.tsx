import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@cloudflare/kumo";
import { EnvelopeSimple } from "@phosphor-icons/react";
import type { EmailInboxPage, EmailInboxStatus } from "@gadgets/workshop-shared/email-inbox";
import { useAuthenticatedApi, useTimeZone } from "../../AuthContext";
import { useDocumentTitle } from "../../useDocumentTitle";
import { formatFullTimestamp } from "../../utils/formatTimestamp";
import { InboxMessagePreview } from "./InboxMessagePreview";

export const InboxPage = () => {
  useDocumentTitle("Inbox");
  const { authenticatedApi } = useAuthenticatedApi();
  const timeZone = useTimeZone();
  const [loaded, setLoaded] = useState<{
    api: typeof authenticatedApi;
    page: EmailInboxPage;
    status: EmailInboxStatus;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const current = loaded?.api === authenticatedApi ? loaded : null;

  useEffect(() => {
    const active = ++generation.current;
    setSelected(null);
    setQuery("");
    setError(null);
    setBusy(true);
    Promise.all([authenticatedApi.listInboxMessages(), authenticatedApi.getEmailInboxStatus()])
      .then(([page, status]) => {
        if (active === generation.current) setLoaded({ api: authenticatedApi, page, status });
      })
      .catch(() => {
        if (active === generation.current) setError("Could not load your inbox. Refresh to retry.");
      })
      .finally(() => {
        if (active === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [authenticatedApi]);

  const load = async (older = false) => {
    if (busy) return;
    const active = generation.current;
    setBusy(true);
    setError(null);
    try {
      const before = older ? (current?.page.nextBefore ?? undefined) : undefined;
      const [page, status] = await Promise.all([
        authenticatedApi.listInboxMessages(before),
        authenticatedApi.getEmailInboxStatus(),
      ]);
      if (active !== generation.current) return;
      setLoaded({
        api: authenticatedApi,
        status,
        page:
          older && current
            ? { ...page, messages: [...current.page.messages, ...page.messages] }
            : page,
      });
      setRevision((value) => value + 1);
    } catch {
      if (active === generation.current) setError("Could not load your inbox. Refresh to retry.");
    } finally {
      if (active === generation.current) setBusy(false);
    }
  };
  const messages =
    current?.page.messages.filter((message) =>
      `${message.subject} ${message.sender}`.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 text-kumo-default sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-strong">Inbox</h1>
          <p className="text-sm text-kumo-subtle">
            Information received by email, and the conversations it started.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <a href="/profile#email-intake" className="text-sm underline underline-offset-4">
            Email settings
          </a>
          <Button disabled={busy} onClick={() => load()}>
            {busy ? "Refreshing…" : "Refresh inbox"}
          </Button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {!current && !error && <p role="status">Loading inbox…</p>}
      {current && (
        <>
          <div className="min-w-0 rounded-xl border border-kumo-line p-4 text-sm">
            {current.status.configuration ? (
              <>
                <p className="font-medium text-kumo-strong">Your private intake address</p>
                <code className="mt-1 block break-all whitespace-normal select-all">
                  {current.status.configuration.address}
                </code>
                <p className="mt-2 text-kumo-subtle">
                  Anyone with this address can add information. Keep it private.
                </p>
              </>
            ) : (
              <p>
                {current.status.available
                  ? "Email intake is disabled. Enable it in Email settings to receive messages."
                  : "Your administrator needs to configure an email domain before intake can be enabled."}
              </p>
            )}
          </div>
          <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <section
              aria-label="Received emails"
              className={`${selected ? "hidden lg:block" : ""} min-w-0 overflow-hidden rounded-xl border border-kumo-line`}
            >
              <div className="space-y-3 border-b border-kumo-line p-4">
                <h2 className="font-semibold text-kumo-strong">
                  Received emails{" "}
                  <span className="text-sm font-normal text-kumo-subtle">
                    ({current.page.messages.length} loaded)
                  </span>
                </h2>
                <Input
                  aria-label="Search loaded emails"
                  placeholder="Search loaded emails"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-full"
                />
              </div>
              {messages.length === 0 ? (
                <div className="space-y-3 px-5 py-12 text-center">
                  <EnvelopeSimple
                    size={32}
                    className="mx-auto text-kumo-subtle"
                    aria-hidden="true"
                  />
                  <p className="font-medium text-kumo-strong">
                    {query ? "No matching emails" : "No emails received yet"}
                  </p>
                  <p className="text-sm text-kumo-subtle">
                    {query
                      ? "Try another subject or sender, or load older emails."
                      : "Send information to your private address, then refresh this inbox."}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-kumo-line">
                  {messages.map((message) => (
                    <li key={message.id}>
                      <button
                        type="button"
                        aria-pressed={selected === message.id}
                        onClick={() => setSelected(message.id)}
                        className={`w-full space-y-2 p-4 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand ${selected === message.id ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
                      >
                        <span className="flex flex-wrap items-start justify-between gap-2">
                          <span className="min-w-0 flex-1 break-words font-medium text-kumo-strong">
                            {message.subject || "(No subject)"}
                          </span>
                          <span className="rounded-md border border-kumo-line px-2 py-0.5 text-xs capitalize">
                            {message.status}
                          </span>
                        </span>
                        <span className="block truncate text-sm text-kumo-subtle">
                          {message.sender}
                        </span>
                        <span className="block text-xs text-kumo-subtle">
                          {formatFullTimestamp(new Date(message.receivedAt), timeZone)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {current.page.nextBefore !== null && (
                <div className="border-t border-kumo-line p-4">
                  <Button disabled={busy} onClick={() => load(true)}>
                    Load older emails
                  </Button>
                </div>
              )}
            </section>
            {selected ? (
              <InboxMessagePreview
                key={`${selected}:${revision}`}
                id={selected}
                canRetry={!!current.status.configuration}
                onBack={() => setSelected(null)}
                onRetried={() => load()}
              />
            ) : (
              <div className="hidden rounded-xl border border-dashed border-kumo-line px-6 py-20 text-center text-sm text-kumo-subtle lg:block">
                Select an email to read its contents and open its chat.
              </div>
            )}
          </div>
          <p className="text-xs text-kumo-subtle">
            Emails are retained for 30 days. Chats remain in your workspace. Sender details come
            from email headers and are not verified identities.
          </p>
        </>
      )}
    </div>
  );
};
