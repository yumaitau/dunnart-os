import { useEffect, useRef, useState } from "react";
import { Button, Select } from "@cloudflare/kumo";
import { useAuthenticatedApi } from "../../AuthContext";
import type {
  ChatChannelPairing,
  ChatChannelProvider,
  ChatChannelStatus,
} from "@gadgets/workshop-shared/chat-channels";
import type { GadgetMetadataWithTimestamps } from "@gadgets/workshop-shared/api";

export const ChatChannelsSettings = () => {
  const { authenticatedApi } = useAuthenticatedApi();
  const [loadedApi, setLoadedApi] = useState<typeof authenticatedApi | null>(null);
  const [status, setStatus] = useState<ChatChannelStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<GadgetMetadataWithTimestamps[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    provider: ChatChannelProvider;
    value: ChatChannelPairing;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setPairing(null);
    setWorkspace(null);
    setError(null);
    setBusy(false);
    Promise.all([authenticatedApi.getChatChannelStatus(), authenticatedApi.listGadgets()])
      .then(([next, gadgets]) => {
        if (current !== generation.current) return;
        setLoadedApi(authenticatedApi);
        setStatus(next);
        setWorkspaces(gadgets.filter((gadget) => !gadget.owner));
      })
      .catch(() => {
        if (current === generation.current)
          setError("Could not load chat channels. Try refreshing.");
      });
    return () => {
      generation.current++;
    };
  }, [authenticatedApi]);
  const run = async (operation: () => Promise<void>) => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch {
      if (current === generation.current)
        setError("Could not confirm the change. Refresh to check, or retry.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const refresh = async () => {
    const current = generation.current;
    const [next, gadgets] = await Promise.all([
      authenticatedApi.getChatChannelStatus(),
      authenticatedApi.listGadgets(),
    ]);
    if (current === generation.current) {
      setLoadedApi(authenticatedApi);
      setStatus(next);
      setWorkspaces(gadgets.filter((gadget) => !gadget.owner));
    }
  };
  return (
    <section
      aria-label="Chat channels"
      className="space-y-4 rounded-xl border border-kumo-line p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-kumo-strong">Chat channels</h2>
        <Button disabled={busy} onClick={() => run(refresh)}>
          Refresh channels
        </Button>
      </div>
      <p className="text-sm text-kumo-subtle">
        Chat with your workspace privately in Slack or Teams. Conversations keep their context.
        Actions still use Dunnart approvals. Shared-channel replies and attachments are not
        supported yet.
      </p>
      {error && <p role="alert">{error}</p>}
      {!status && !error && <p role="status">Loading chat channels…</p>}
      {status && loadedApi === authenticatedApi && (
        <>
          <div ref={container}>
            <Select<string>
              label="Workspace you own"
              value={workspace}
              disabled={busy}
              onValueChange={setWorkspace}
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
          {workspaces.length === 0 && <p>Create a workspace before linking a chat channel.</p>}
          <div className="flex flex-wrap gap-3">
            {status.providers.map(({ provider, available }) => (
              <div key={provider} className="space-y-2">
                <Button
                  disabled={busy || !available || !workspace}
                  onClick={() =>
                    run(async () => {
                      const current = generation.current;
                      const value = await authenticatedApi.pairChatChannel(provider, workspace!);
                      if (current === generation.current) setPairing({ provider, value });
                    })
                  }
                >
                  Connect {provider === "slack" ? "Slack" : "Teams"}
                </Button>
                {!available && (
                  <p className="max-w-64 text-sm text-kumo-subtle">
                    Deployment administrator must configure{" "}
                    {provider === "slack" ? "Slack app" : "Teams bot"} credentials first.
                  </p>
                )}
              </div>
            ))}
          </div>
          {pairing && (
            <div className="space-y-2 rounded-lg border border-kumo-line p-4" role="status">
              <p>
                Open the bot’s private chat, then paste this one-time command. Expires in ten
                minutes. Keep it private.
              </p>
              <code className="block break-all select-all">{pairing.value.command}</code>
              {pairing.value.openUrl && (
                <a
                  className="underline"
                  href={pairing.value.openUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {pairing.provider === "slack" ? "Install Slack bot" : "Open Teams bot"}
                </a>
              )}
              <p className="text-sm">
                After the bot confirms pairing, refresh channels below. Already installed Slack?
                Send the command directly to its bot.
              </p>
            </div>
          )}
          <ul className="space-y-3">
            {status.links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {link.provider === "slack" ? "Slack" : "Teams"} ·{" "}
                  {workspaces.find((w) => w.id === link.workspaceId)?.title ?? "Workspace"}
                </span>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await authenticatedApi.unlinkChatChannel(link.id);
                      await refresh();
                    })
                  }
                >
                  Unlink {link.provider}
                </Button>
              </li>
            ))}
          </ul>
          {status.links.length === 0 && (
            <p className="text-sm text-kumo-subtle">No private chats linked.</p>
          )}
          {status.deliveries.some((delivery) =>
            ["uncertain", "failed"].includes(delivery.status),
          ) && (
            <p role="alert">
              Some messages could not be confirmed. Check your provider chat and Dunnart workspace
              before resending; uncertain replies are not sent again automatically.
            </p>
          )}
        </>
      )}
    </section>
  );
};
