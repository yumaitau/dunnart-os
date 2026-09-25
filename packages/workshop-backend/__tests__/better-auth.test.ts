import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createBetterAuth, handleBetterAuth } from "../src/auth/better-auth.js";
import type { UserDurableObject } from "../src/user.js";
import type { AuthSession } from "../src/auth/session-watch.js";
import { SCIM_USER, SCIM_PATCH } from "../src/auth/scim-schema.js";
import { makeAuthenticator } from "./webauthn-fixture.js";
import schema from "../migrations/0001_better_auth.sql?raw";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_AUTH_SESSION: DurableObjectNamespace<AuthSession>;
  }
}

const origin = "https://workshop.example";
const config = () => ({ ...env, AUTH_DB: env.AUTH_DB!, BETTER_AUTH_ENABLED: "true",
  PUBLIC_BASE_URL: origin, BETTER_AUTH_SECRET: "unit-tests-only-never-a-deployment-secret" });

beforeEach(async () => {
  const statements = schema.replace(/^--.*$/gm, "").split(";").map(sql => sql.trim()).filter(Boolean);
  await env.AUTH_DB!.batch(statements.map(sql => env.AUTH_DB!.prepare(sql.replace("create table ", "create table if not exists ")
    .replace("create index ", "create index if not exists "))));
  await env.AUTH_DB!.prepare("DELETE FROM rateLimit").run();
});
afterEach(() => vi.unstubAllGlobals());

const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");

async function totp(secret: string): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char.toUpperCase()).toString(2).padStart(5, "0");
  const bytes = Uint8Array.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30_000)));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1] & 15;
  const value = new DataView(digest.buffer).getUint32(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}

describe("Better Auth integration", () => {
  it("registers and signs in with a passkey, requiring verified user presence and rejecting replay", async () => {
    await runInDurableObject(env.TEST_USER.getByName(crypto.randomUUID()), async (_user, state) => {
      const settings = config();
      const auth = createBetterAuth(settings, state);
      const context = await auth.$context;
      const email = `${crypto.randomUUID()}@example.com`;
      const password = "test-passkey-enrollment-password";
      const user = await context.internalAdapter.createUser({ email, name: "Test", emailVerified: true }, { method: "email-password" });
      await context.internalAdapter.linkAccount({ userId: user.id, accountId: user.id, providerId: "credential",
        password: await context.password.hash(password) });
      const request = (path: string, body?: unknown, cookie = "") => handleBetterAuth(new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), settings, state);
      const login = await request("/sign-in/email", { email, password });
      const options = await request("/passkey/generate-register-options", undefined, cookies(login));
      const data = await options.json<{ challenge: string }>();
      const authenticator = await makeAuthenticator(origin);
      const enrollment = await request("/passkey/verify-registration", { response: authenticator.registration(data.challenge), name: "Test device" },
        `${cookies(login)}; ${cookies(options)}`);
      expect(enrollment.status, await enrollment.clone().text()).toBe(200);
      const challenge = await request("/passkey/generate-authenticate-options");
      const challengeData = await challenge.json<{ challenge: string; userVerification: string }>();
      expect(challengeData.userVerification).toBe("required");
      const unverified = await authenticator.authentication(challengeData.challenge, false);
      expect((await request("/passkey/verify-authentication", { response: unverified }, cookies(challenge))).status).not.toBe(200);
      const fresh = await request("/passkey/generate-authenticate-options");
      const assertion = await authenticator.authentication((await fresh.json<{ challenge: string }>()).challenge, true);
      const result = await request("/passkey/verify-authentication", { response: assertion }, cookies(fresh));
      expect(result.status, await result.clone().text()).toBe(200);
      expect((await auth.api.getSession({ headers: new Headers({ Cookie: cookies(result) }) }))?.user.id).toBe(user.id);
      expect((await request("/passkey/verify-authentication", { response: assertion }, cookies(fresh))).status).not.toBe(200);
    });
  });
  it("uses Better Auth PKCE SSO and keeps a directory identity isolated from an email-keyed admin", async () => {
    await runInDurableObject(env.TEST_USER.getByName(crypto.randomUUID()), async (_user, state) => {
      const providerId = `test-${crypto.randomUUID().slice(0, 30)}`;
      const email = `${crypto.randomUUID()}@example.com`;
      const subject = crypto.randomUUID();
      const issuer = "https://identity.example";
      const settings = { ...config(), OIDC_PROVIDERS: JSON.stringify([{ id: providerId,
        displayName: "Example", issuer, clientId: "client", clientSecret: "test-client-secret" }]) };
      const directory = state.exports.IdentityDirectory.getByName("");
      const base = `${origin}/api/scim/v2`;
      const resource = await directory.scim(providerId, new Request(`${base}/Users`, { method: "POST" }), base, {
        schemas: [SCIM_USER], userName: email, externalId: subject, displayName: "Example",
        emails: [{ value: email, primary: true }], active: true,
      });
      const identity = await resource.json<{ id: string }>();
      const keys = await generateKeyPair("RS256");
      const jwk = await exportJWK(keys.publicKey);
      const token = await new SignJWT({ email, email_verified: true, name: "Example" })
        .setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject(subject).setIssuer(issuer)
        .setAudience("client").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
      let verifier = "";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer,
          authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"],
          subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"] });
        if (url === `${issuer}/jwks`) return Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
        if (url === `${issuer}/token`) {
          verifier = new URLSearchParams(String(init?.body)).get("code_verifier") ?? "";
          return Response.json({ access_token: "test-access", token_type: "Bearer", id_token: token });
        }
        throw new Error(`Unexpected identity request: ${url}`);
      });
      const auth = createBetterAuth(settings, state);
      const start = await auth.handler(new Request(`${origin}/api/auth/sign-in/sso`, { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ providerId, callbackURL: "/" }) }));
      expect(start.status, await start.clone().text()).toBe(200);
      const authorization = new URL((await start.json<{ url: string }>()).url);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "test-code");
      const response = await auth.handler(new Request(callback, { headers: { Cookie: cookies(start) } }));
      expect(new URL(response.headers.get("location")!, origin).href).toBe(`${origin}/`);
      expect(verifier.length).toBeGreaterThan(30);
      const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookies(response) }) });
      expect(session).not.toBeNull();
      const mapping = await env.AUTH_DB!.prepare('SELECT workshopId FROM user WHERE id = ?').bind(session!.user.id)
        .first<{ workshopId: string }>();
      expect(mapping?.workshopId).toBe(`enterprise-${identity.id}`);
      expect(mapping?.workshopId).not.toBe(email);
      const replay = await auth.handler(new Request(callback, { headers: { Cookie: cookies(start) } }));
      expect(cookies(replay)).not.toContain("session_token=");
      await directory.scim(providerId, new Request(`${base}/Users/${identity.id}`, { method: "PATCH" }), base,
        { schemas: [SCIM_PATCH], Operations: [{ op: "replace", path: "active", value: false }] });
      // Directory state is the live authority even if an auth database update is unavailable.
      let denied = false;
      try { using _watch = await state.exports.UserDurableObject.getByName(mapping!.workshopId).watchAccess(() => {}); }
      catch { denied = true; }
      expect(denied).toBe(true);
    });
  });

  it("enforces MFA before a session, rejects wrong codes and consumes recovery codes once", async () => {
    await runInDurableObject(env.TEST_USER.getByName(crypto.randomUUID()), async (_user, state) => {
      const auth = createBetterAuth(config(), state);
      const context = await auth.$context;
      const email = `${crypto.randomUUID()}@example.com`;
      const password = "a-long-test-password-only";
      const user = await context.internalAdapter.createUser({ name: "Example", email, emailVerified: true,
        workshopId: `test-${crypto.randomUUID()}` }, { method: "email-password" });
      await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id,
        password: await context.password.hash(password) });
      const request = (path: string, body?: unknown, cookie = "") => auth.handler(new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const login = await request("/sign-in/email", { email, password });
      expect(login.status).toBe(200);
      const enrolled = await request("/two-factor/enable", { password }, cookies(login));
      expect(enrolled.status).toBe(200);
      const enrollment = await enrolled.json<{ totpURI: string; backupCodes: string[] }>();
      const code = await totp(new URL(enrollment.totpURI).searchParams.get("secret")!);
      const verified = await request("/two-factor/verify-totp", { code }, cookies(enrolled) || cookies(login));
      expect(verified.status).toBe(200);
      const challenge = await request("/sign-in/email", { email, password });
      expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
      const pendingCookie = cookies(challenge);
      expect(await (await request("/get-session", undefined, pendingCookie)).json()).toBeNull();
      expect((await request("/two-factor/verify-totp", { code: "invalid" }, pendingCookie)).status).not.toBe(200);
      const recovered = await request("/two-factor/verify-backup-code", { code: enrollment.backupCodes[0] }, pendingCookie);
      expect(recovered.status).toBe(200);
      const second = await request("/sign-in/email", { email, password });
      expect((await request("/two-factor/verify-backup-code", { code: enrollment.backupCodes[0] }, cookies(second))).status).not.toBe(200);
      // The real D1 date encoding must be understood by the long-lived RPC watcher.
      const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookies(recovered) }) });
      expect(session?.user.id).toBe(user.id);
      const watcher = env.TEST_AUTH_SESSION.getByName(crypto.randomUUID());
      let revoked = false;
      using _watch = await watcher.watch(session!.session.id, () => { revoked = true; });
      await env.AUTH_DB!.prepare('DELETE FROM session WHERE id = ?').bind(session!.session.id).run();
      await runDurableObjectAlarm(watcher);
      expect(revoked).toBe(true);
    });
  });

  it("blocks public signup, cross-origin mutations, unverified migration and provider registration", async () => {
    await runInDurableObject(env.TEST_USER.getByName(crypto.randomUUID()), async (_user, state) => {
      const auth = createBetterAuth(config(), state);
      const request = (path: string, body: unknown, from = origin) => new Request(`${origin}/api/auth${path}`, {
        method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await auth.handler(request("/sign-up/email", { name: "Test", email: "nobody@example.com", password: "long-test-password" }))).status).toBe(400);
      expect((await auth.handler(request("/sign-in/email", { email: "nobody@example.com", password: "long-test-password" }, "https://evil.example"))).status).toBe(403);
      expect((await auth.handler(request("/access-migration", { password: "long-test-password" }))).status).toBe(404);
      const migrationDisabled = { ...config(), ACCESS_MIGRATION_ENABLED: "false" };
      expect((await handleBetterAuth(request("/access-migration", { password: "long-test-password" }), migrationDisabled, state)).status).toBe(404);
      expect((await handleBetterAuth(new Request(`${origin}/api/auth/access-entry`), migrationDisabled, state)).status).toBe(404);
      expect((await handleBetterAuth(request("/sso/register", {}), config(), state)).status).toBe(404);
    });
  });
});
