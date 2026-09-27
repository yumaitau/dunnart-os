import type { ChatChannels } from "./channels";
import {
  channelAvailable,
  installSlack,
  slackEvent,
  teamsEvent,
  verifySlack,
  verifyTeams,
  type ChannelEnv,
} from "./providers";

/** Signed provider endpoints; browser pairing is exposed separately through authenticated RPC. */
export async function handleChatChannelRequest(
  request: Request,
  env: ChannelEnv,
  channels: DurableObjectStub<ChatChannels>,
): Promise<Response> {
  const url = new URL(request.url);
  const provider = url.pathname.includes("/slack/")
    ? "slack"
    : url.pathname.endsWith("/teams/events")
      ? "teams"
      : null;
  if (!provider || !channelAvailable(env, provider))
    return new Response("Chat provider not configured.", { status: 404 });
  if (provider === "slack" && url.pathname.endsWith("/oauth") && request.method === "GET") {
    if (!(await channels.consumeOAuth(url.searchParams.get("state") ?? "")))
      return new Response("Installation expired. Start again in Dunnart settings.", {
        status: 400,
      });
    try {
      const code = url.searchParams.get("code");
      if (!code || code.length > 2000) throw new Error("Missing authorization code.");
      await channels.install(await installSlack(code, env));
      return new Response(
        "Slack installed. Return to Dunnart Settings > Chat channels and paste your pairing command in a private message to the bot.",
        {
          headers: {
            "content-type": "text/plain",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        },
      );
    } catch {
      return new Response(
        "Slack installation failed. Check app scopes and token rotation settings, then generate a new pairing command.",
        { status: 400 },
      );
    }
  }
  if (request.method !== "POST" || !url.pathname.endsWith("/events"))
    return new Response("Not found", { status: 404 });
  // Stream-bound rather than trusting Content-Length (which webhook clients may omit).
  const reader = request.body?.getReader();
  if (!reader) return new Response("Missing body", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 65536) {
      await reader.cancel();
      return new Response("Body too large", { status: 413 });
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder().decode(bytes);
  let body: any;
  try {
    if (provider === "slack") await verifySlack(request, raw, env.SLACK_CHAT_SIGNING_SECRET!);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid event object.");
    if (provider === "teams") await verifyTeams(request, body, env);
  } catch {
    return new Response("Invalid provider request", { status: 401 });
  }
  if (
    provider === "slack" &&
    body.type === "url_verification" &&
    typeof body.challenge === "string"
  )
    return Response.json({ challenge: body.challenge });
  const bot =
    provider === "slack" && typeof body.team_id === "string"
      ? await channels.slackBot(body.team_id)
      : null;
  const event = provider === "slack" ? (bot ? slackEvent(body, bot) : null) : teamsEvent(body);
  if (event) {
    try {
      await channels.receive(event);
    } catch {
      return new Response("Temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "15" },
      });
    }
  }
  return new Response(null, { status: 200 });
}
