import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Select } from "@cloudflare/kumo";
import type { EmailInboxStatus } from "@gadgets/workshop-shared/email-inbox";
import type { GadgetMetadataWithTimestamps } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi, useTimeZone } from "../../AuthContext";
import { formatFullTimestamp } from "../../utils/formatTimestamp";

export const EmailInboxSettings = () => {
  const { authenticatedApi } = useAuthenticatedApi();
  const timeZone = useTimeZone();
  const [loadedApi, setLoadedApi] = useState<{ api: typeof authenticatedApi } | null>(null);
  const [status, setStatus] = useState<EmailInboxStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<GadgetMetadataWithTimestamps[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [continueRelated, setContinueRelated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setWorkspace(null);
    setError(null);
    setBusy(false);
    setCopied(false);
    Promise.all([authenticatedApi.getEmailInboxStatus(), authenticatedApi.listGadgets()])
      .then(([next, gadgets]) => {
        if (current !== generation.current) return;
        setLoadedApi({ api: authenticatedApi });
        setStatus(next);
        setWorkspaces(gadgets.filter((item) => !item.owner));
        setWorkspace(next.configuration?.workspaceId ?? null);
        setContinueRelated(next.configuration?.continueRelated ?? true);
      })
      .catch(() => {
        if (current === generation.current)
          setError("Could not load email intake. Refresh to retry.");
      });
    return () => {
      generation.current++;
    };
  }, [authenticatedApi]);

  const run = async (operation: () => Promise<EmailInboxStatus>) => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const next = await operation();
      if (current !== generation.current) return;
      setLoadedApi({ api: authenticatedApi });
      setStatus(next);
    } catch {
      if (current === generation.current)
        setError("Could not confirm the change. Refresh to check, then retry.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const refresh = async () => {
    const current = generation.current;
    const [next, gadgets] = await Promise.all([
      authenticatedApi.getEmailInboxStatus(),
      authenticatedApi.listGadgets(),
    ]);
    if (current === generation.current) {
      setWorkspaces(gadgets.filter((item) => !item.owner));
      if (loadedApi?.api !== authenticatedApi || !status) {
        setWorkspace(next.configuration?.workspaceId ?? null);
        setContinueRelated(next.configuration?.continueRelated ?? true);
      }
    }
    return next;
  };
  const current = loadedApi?.api === authenticatedApi ? status : null;

  return (
    <section
      id="email-intake"
      aria-label="Email intake"
      className="min-w-0 space-y-4 rounded-xl border border-kumo-line p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-kumo-strong">Email intake</h2>
        <Button disabled={busy} onClick={() => run(refresh)}>
          Refresh inbox
        </Button>
      </div>
      <p className="text-sm text-kumo-subtle">
        Email information into your workspace. Replies follow their conversation; new topics start a
        chat.
      </p>
      {error && <p role="alert">{error}</p>}
      {!current && !error && <p role="status">Loading email intake…</p>}
      {current && !current.available && (
        <p>
          The deployment administrator needs to configure an Email Routing domain before intake can
          be enabled.
        </p>
      )}
      {current?.available && (
        <>
          <div ref={container}>
            <Select<string>
              label="Email destination workspace"
              value={workspace}
              onValueChange={setWorkspace}
              disabled={busy}
              container={container}
              className="w-full"
              placeholder="Choose a workspace"
              renderValue={(value) =>
                workspaces.find((item) => item.id === value)?.title ?? "Choose a workspace"
              }
            >
              {workspaces.map((item) => (
                <Select.Option key={item.id} value={item.id}>
                  {item.title}
                </Select.Option>
              ))}
            </Select>
          </div>
          {workspaces.length === 0 && <p>Create a workspace before enabling email intake.</p>}
          <Checkbox
            checked={continueRelated}
            onCheckedChange={setContinueRelated}
            disabled={busy}
            label="Continue strongly related conversations"
          />
          <p className="text-sm text-kumo-subtle">
            Topic matching stays within the selected workspace. Uncertain matches start fresh. Begin
            the subject with [new] to force a new chat.
          </p>
          <Button
            disabled={busy || !workspace}
            onClick={() =>
              run(() => authenticatedApi.configureEmailInbox(workspace!, continueRelated))
            }
          >
            {busy
              ? "Saving…"
              : current.configuration
                ? "Save intake settings"
                : "Enable email intake"}
          </Button>
          {current.configuration && (
            <div className="space-y-3 border-t border-kumo-line pt-4">
              <p className="text-sm font-medium">Your private intake address</p>
              <code className="block break-all whitespace-normal text-sm select-all">
                {current.configuration.address}
              </code>
              <p className="text-sm">
                Anyone with this address can add information to this workspace. Share it only with
                trusted senders. Email headers do not verify a person’s identity.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={async () => {
                    const active = generation.current;
                    try {
                      await navigator.clipboard.writeText(current.configuration!.address);
                      if (active === generation.current) setCopied(true);
                    } catch {
                      if (active === generation.current)
                        setError("Could not copy. Select the address above and copy it manually.");
                    }
                  }}
                >
                  Copy address
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => run(() => authenticatedApi.rotateEmailInboxAddress())}
                >
                  Replace address
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await authenticatedApi.disableEmailInbox();
                      return authenticatedApi.getEmailInboxStatus();
                    })
                  }
                >
                  Disable intake
                </Button>
              </div>
              {copied && (
                <p role="status" className="text-sm">
                  Address copied.
                </p>
              )}
              <p className="text-sm text-kumo-subtle">
                Replacing the address or changing workspace revokes the old address. Submitted chats
                remain in your workspace. Answers and approvals stay in Dunnart; no automatic email
                replies are sent.
              </p>
            </div>
          )}
        </>
      )}
      {current && (
        <div className="space-y-3 border-t border-kumo-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Recent emails</h3>
            <a href="/inbox" className="text-sm underline underline-offset-4">
              Open inbox
            </a>
          </div>
          {current.messages.length === 0 && (
            <p className="text-sm text-kumo-subtle">
              No emails received yet. Send a message to your private address, then refresh here.
            </p>
          )}
          <ul className="divide-y divide-kumo-line">
            {current.messages.map((message) => (
              <li key={message.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">{message.subject}</p>
                    <p className="break-all text-sm text-kumo-subtle">
                      Reported sender: {message.sender}
                    </p>
                  </div>
                  <span className="text-sm capitalize">{message.status}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {formatFullTimestamp(new Date(message.receivedAt), timeZone)}
                  {message.routing
                    ? ` · ${message.routing === "thread" ? "Email thread" : message.routing === "related" ? "Related conversation" : "New conversation"}`
                    : ""}
                </p>
                {message.notices.map((notice, index) => (
                  <p key={index} className="text-sm">
                    {notice}
                  </p>
                ))}
                <div className="flex flex-wrap items-center gap-3">
                  {message.chatPath && (
                    <a className="text-sm underline" href={message.chatPath}>
                      Open chat
                    </a>
                  )}
                  {message.status === "failed" && current.configuration && (
                    <Button
                      disabled={busy}
                      onClick={() => run(() => authenticatedApi.retryInboxMessage(message.id))}
                    >
                      Retry email
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-kumo-subtle">
            Up to 1 MiB per email, with 10 attachments totalling 512 KiB. Text, PDF and Office
            documents are extracted when supported; unread attachments are listed. Receipts expire
            after 30 days; chats remain.
          </p>
        </div>
      )}
    </section>
  );
};
