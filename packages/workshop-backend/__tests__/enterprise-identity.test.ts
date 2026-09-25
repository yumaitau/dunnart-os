import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import type { IdentityDirectory } from "../src/auth/identity-directory.js";
import type { UserDurableObject } from "../src/user.js";
import { handleScimRequest } from "../src/auth/scim-http.js";
import { enterpriseProviders } from "../src/auth/enterprise-config.js";
import { isPasswordAuthEnabled } from "../src/auth/config.js";
import { SCIM_USER, SCIM_PATCH, parseScimUser, patchScimUser } from "../src/auth/scim-schema.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectory>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const token = "test-provisioning-token-with-at-least-32-characters";
const provider = { id: "example", displayName: "Example SSO", issuer: "https://identity.example",
  clientId: "workshop", clientSecret: "test-secret" };
const profile = { schemas: [SCIM_USER], userName: "ada@example.com", externalId: "subject-ada",
  displayName: "Ada", emails: [{ value: "ada@example.com", primary: true }], active: true };

async function setup() {
  const stub = env.TEST_IDENTITY_DIRECTORY.getByName(crypto.randomUUID());
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toHex();
  const config = { ...env, PUBLIC_BASE_URL: "https://workshop.example",
    OIDC_PROVIDERS: JSON.stringify([provider, { ...provider, id: "other" }]),
    SCIM_TOKENS: JSON.stringify([{ providerId: "example", sha256 }]),
  };
  const request = async (method: string, path: string, body?: unknown, bearer = token) => {
    const response = await runInDurableObject(stub, directory => handleScimRequest(new Request(
      `https://workshop.example/api/scim/v2/${path}`, { method,
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/scim+json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), config, directory));
    return { status: response.status, headers: response.headers,
      body: response.status === 204 ? null : await response.json() as Record<string, any> };
  };
  return { stub, request, config };
}

async function rejected(call: Promise<unknown>): Promise<void> {
  let didReject = false;
  try { await call; } catch { didReject = true; }
  expect(didReject).toBe(true);
}

describe("enterprise identity", { timeout: 30_000 }, () => {
  it("requires a scoped token even for discovery and rejects oversized bodies", async () => {
    const { request } = await setup();
    expect((await request("GET", "ServiceProviderConfig", undefined, "invalid")).status).toBe(401);
    expect((await request("GET", "ServiceProviderConfig")).body.patch.supported).toBe(true);
    expect((await request("GET", "ResourceTypes")).body.Resources.map((r: { name: string }) => r.name)).toEqual(["User"]);
    expect((await request("POST", "Users", { ...profile, displayName: "x".repeat(70_000) })).status).toBe(413);
  });

  it("provisions, filters, paginates and rejects duplicate identities", async () => {
    const { request } = await setup();
    const created = await request("POST", "Users", profile);
    expect(created.status).toBe(201);
    expect(created.headers.get("Location")).toContain(created.body.id);
    expect((await request("POST", "Users", profile)).status).toBe(409);
    const filtered = await request("GET", `Users?filter=${encodeURIComponent('userName eq "ADA@example.com"')}`);
    expect(filtered.body.totalResults).toBe(1);
    expect((await request("GET", "Users?count=0")).body).toMatchObject({ totalResults: 1, Resources: [] });
    expect((await request("GET", "Users?filter=userName%20pr")).body.scimType).toBe("invalidFilter");
    expect((await request("GET", "Users?startIndex=oops")).status).toBe(400);
  });

  it("keeps provider identities separate and preserves the account across email changes", async () => {
    const { request, stub } = await setup();
    const created = await request("POST", "Users", profile);
    const key = await stub.resolveIdentity("example", provider.issuer, "subject-ada", undefined, false, true);
    expect(key).toBe(`enterprise-${created.body.id}`);
    await rejected(stub.resolveIdentity("other", provider.issuer, "subject-ada", "ada@example.com", true, true));
    await rejected(stub.resolveIdentity("example", provider.issuer, "attacker", "ada@example.com", true, true));
    const changed = await request("PATCH", `Users/${created.body.id}`, { schemas: [SCIM_PATCH],
      Operations: [{ op: "Replace", path: "userName", value: "new@example.com" },
        { op: "replace", path: 'emails[type eq "work"].value', value: "new@example.com" }] });
    expect(changed.status).toBe(200);
    expect(await stub.resolveIdentity("example", provider.issuer, "subject-ada", "new@example.com", true, true)).toBe(key);
  });

  it("revokes sessions and denies login on disable; reactivation requires fresh login", async () => {
    const { request, stub } = await setup();
    const created = await request("POST", "Users", profile);
    const key = await stub.resolveIdentity("example", provider.issuer, "subject-ada", undefined, false, true);
    const user = env.TEST_USER.getByName(key);
    const secret = await user.loginOrCreateViaGatekeeper(key, false);
    expect(secret).toBeTruthy();
    await user.authenticate(secret!);
    expect((await request("PATCH", `Users/${created.body.id}`, { schemas: [SCIM_PATCH],
      Operations: [{ op: "replace", path: "active", value: false }] })).status).toBe(200);
    await rejected(user.authenticate(secret!));
    await rejected(user.loginOrCreateViaGatekeeper(key, false));
    await rejected(user.getChatContext(null));
    await rejected(stub.resolveIdentity("example", provider.issuer, "subject-ada", undefined, false, true));
    expect((await request("PATCH", `Users/${created.body.id}`, { schemas: [SCIM_PATCH],
      Operations: [{ op: "replace", value: { active: true } }] })).status).toBe(200);
    await rejected(user.authenticate(secret!));
    expect(await user.loginOrCreateViaGatekeeper(key, false)).toBeTruthy();
  });

  it("deletes without JIT resurrection, hides deleted users, and tolerates delete retries", async () => {
    const { request, stub } = await setup();
    const created = await request("POST", "Users", profile);
    expect((await request("DELETE", `Users/${created.body.id}`)).status).toBe(204);
    expect((await request("DELETE", `Users/${created.body.id}`)).status).toBe(204);
    expect((await request("GET", `Users/${created.body.id}`)).status).toBe(404);
    expect((await request("GET", "Users")).body.totalResults).toBe(0);
    await rejected(stub.resolveIdentity("example", provider.issuer, "subject-ada", "ada@example.com", true, false));
  });

  it("rejects unverified email linking and stale activation updates", async () => {
    const { request, stub } = await setup();
    await request("POST", "Users", { ...profile, externalId: "unrelated-external-id" });
    await rejected(stub.resolveIdentity("example", provider.issuer, "unknown", "ada@example.com", false, true));
    const user = env.TEST_USER.getByName(`enterprise-${crypto.randomUUID()}`);
    await user.provisionEnterpriseAccount("test", "Test", false, 5);
    await user.provisionEnterpriseAccount("test", "Test", true, 4);
    await rejected(user.loginOrCreateViaGatekeeper("test", false));
  });

  it("notifies retained native RPC connections when access is revoked", async () => {
    const key = `enterprise-${crypto.randomUUID()}`;
    const user = env.TEST_USER.getByName(key);
    await user.provisionEnterpriseAccount(key, "Test", true, 1);
    let revoked = false;
    using watch = await user.watchAccess(value => { revoked = value; });
    expect(watch).not.toBeNull();
    await user.provisionEnterpriseAccount(key, "Test", false, 2);
    expect(revoked).toBe(true);
  });

  it("closes the public WebSocket even after the authenticated capability is released", async () => {
    const key = `enterprise-${crypto.randomUUID()}`;
    const user = env.TEST_USER.getByName(key);
    await user.provisionEnterpriseAccount(key, "Test", true, 1);
    const secret = await user.loginOrCreateViaGatekeeper(key, false);
    const response = await SELF.fetch("https://workshop.example/api", { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    using rpc = newWebSocketRpcSession<PublicApi>(socket);
    const authenticated = await rpc.authenticate(`${key}:${secret}`);
    expect((await authenticated.whoami()).id).toBe(key);
    authenticated[Symbol.dispose]();
    await rpc.ping();
    const closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    await user.provisionEnterpriseAccount(key, "Test", false, 2);
    await closed;
    await rejected(rpc.ping());
  });

  it("rejects role updates and applies a patch atomically", () => {
    const parsed = parseScimUser(profile);
    expect(() => patchScimUser(parsed, { schemas: [SCIM_PATCH], Operations: [
      { op: "replace", path: "active", value: false }, { op: "add", path: "roles", value: ["admin"] },
    ] })).toThrow("Unsupported PATCH attribute");
    expect(parsed.active).toBe(true);
  });

  it("allows OIDC-only deployments without exposing client credentials", async () => {
    const { config } = await setup();
    expect(isPasswordAuthEnabled({ ...config, DISABLE_PASSWORD_AUTH: "true" })).toBe(false);
    expect(() => enterpriseProviders({ ...config, OIDC_PROVIDERS: JSON.stringify([{ ...provider, issuer: "http://bad.example" }]) })).toThrow();
  });
});

