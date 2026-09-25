import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { z } from "zod";
import { enterpriseProviders } from "./enterprise-config.js";
import { verifyCfAccessJwt } from "../access.js";

/** Auth is explicitly enabled; an incomplete deployment must fail closed. */
export const betterAuthEnabled = (env: Cloudflare.Env): boolean => env.BETTER_AUTH_ENABLED === "true";

/** Server-owned account mapping preserves existing workspace capabilities during migration. */
export const authUserFields = {
  workshopId: { type: "string", required: false, input: false, returned: false, unique: true },
} as const;

/** Better Auth owns credentials and ceremonies; the directory owns provisioned application access. */
export function createBetterAuth(env: Cloudflare.Env, execution: Pick<ExecutionContext, "exports">) {
  if (!env.AUTH_DB || !env.BETTER_AUTH_SECRET || !env.PUBLIC_BASE_URL) {
    throw new Error("Better Auth requires AUTH_DB, BETTER_AUTH_SECRET and PUBLIC_BASE_URL.");
  }
  const database = env.AUTH_DB;
  const origin = new URL(env.PUBLIC_BASE_URL).origin;
  const providers = enterpriseProviders(env);
  return betterAuth({
    appName: "Dunnart",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [origin, ...providers.flatMap(provider => [new URL(provider.issuer).origin, ...(provider.trustedOrigins ?? [])])],
    logger: { disabled: true },
    user: { additionalFields: authUserFields },
    emailAndPassword: { enabled: true, disableSignUp: true, requireEmailVerification: true,
      minPasswordLength: 12, maxPasswordLength: 128 },
    account: { accountLinking: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24, freshAge: 60 * 10, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    advanced: { useSecureCookies: origin.startsWith("https:"),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [
      twoFactor({ issuer: "Dunnart", allowPasswordless: true }),
      passkey({ rpName: "Dunnart", rpID: new URL(origin).hostname, origin,
        authenticatorSelection: { userVerification: "required" },
        registration: { afterVerification({ verification }) {
          if (!verification.registrationInfo?.userVerified) throw new APIError("FORBIDDEN");
        } },
        authentication: { afterVerification({ verification }) {
          if (!verification.authenticationInfo.userVerified) throw new APIError("FORBIDDEN");
        } },
      }),
      sso({
        trustEmailVerified: true,
        organizationProvisioning: { disabled: true },
        defaultSSO: providers.map(provider => ({
          providerId: provider.id,
          domain: provider.domain ?? new URL(provider.issuer).hostname,
          oidcConfig: { issuer: provider.issuer, clientId: provider.clientId,
            clientSecret: provider.clientSecret, pkce: true,
            tokenEndpointAuthentication: provider.tokenEndpointAuth,
            scopes: ["openid", "email", "profile"],
            discoveryEndpoint: `${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration` },
        })),
        provisionUserOnEveryLogin: true,
        async provisionUser({ user, userInfo, provider }) {
          const configured = providers.find(item => item.id === provider.providerId);
          if (!configured || typeof userInfo.id !== "string") throw new APIError("FORBIDDEN");
          const workshopId = await execution.exports.IdentityDirectory.getByName("").resolveIdentity(
            configured.id, configured.issuer, userInfo.id,
            typeof userInfo.email === "string" ? userInfo.email : undefined,
            userInfo.emailVerified === true, configured.requireProvisioning);
          const result = await database.prepare(`UPDATE user SET workshopId = ?
            WHERE id = ? AND (workshopId IS NULL OR workshopId = ?)`).bind(workshopId, user.id, workshopId).run();
          if (result.meta.changes !== 1) throw new APIError("FORBIDDEN");
        },
      }),
      {
        id: "access-migration",
        endpoints: {
          migrateAccessAccount: createAuthEndpoint("/access-migration", {
            method: "POST", body: z.object({ password: z.string().min(12).max(128) }),
          }, async ctx => {
            if (env.ACCESS_MIGRATION_ENABLED !== "true" || !ctx.request) throw new APIError("NOT_FOUND");
            const claims = await verifyCfAccessJwt(ctx.request, env);
            if (typeof claims?.email !== "string") throw new APIError("UNAUTHORIZED");
            const email = claims.email.toLowerCase();
            // Only existing Access accounts can migrate. A supplied email is never authority.
            await execution.exports.UserDurableObject.getByName(email).authenticateFromCfAccess(email, false);
            if (await ctx.context.internalAdapter.findUserByEmail(email)) {
              throw new APIError("CONFLICT", { message: "Account already migrated. Sign in with your password or passkey." });
            }
            const password = await ctx.context.password.hash(ctx.body.password);
            const user = await ctx.context.internalAdapter.createUser({
              name: email.split("@")[0], email, emailVerified: true, workshopId: email,
            }, { method: "email-password" });
            try {
              await ctx.context.internalAdapter.linkAccount({
                userId: user.id, providerId: "credential", accountId: user.id, password,
              });
              const session = await ctx.context.internalAdapter.createSession(user.id);
              await setSessionCookie(ctx, { session, user });
              return ctx.json({ migrated: true });
            } catch (error) {
              // D1 has no interactive transactions. Do not strand a half-migrated identity.
              await ctx.context.internalAdapter.deleteUser(user.id);
              throw error;
            }
          }),
        },
      },
    ],
  });
}

/** Public HTTP surface excludes provider management and account linking; configuration is deployment-owned. */
export async function handleBetterAuth(request: Request, env: Cloudflare.Env, ctx: Pick<ExecutionContext, "exports">): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("Origin") !== new URL(env.PUBLIC_BASE_URL!).origin) {
    return new Response("Cross-origin authentication request denied.", { status: 403 });
  }
  const path = new URL(request.url).pathname.slice("/api/auth".length);
  if ((path.startsWith("/sso/") && !path.startsWith("/sso/callback/"))
      || path.startsWith("/link-") || path === "/update-user" || path === "/change-email") {
    return new Response("Not found", { status: 404 });
  }
  if (path === "/access-entry" && env.ACCESS_MIGRATION_ENABLED === "true") {
    if (!await verifyCfAccessJwt(request, env)) return new Response("Unauthorized", { status: 401 });
    return Response.redirect(`${env.PUBLIC_BASE_URL}/?migrate=1`, 303);
  }
  const response = await createBetterAuth(env, ctx).handler(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  // The plugin currently advertises "preferred" for sign-in. Match the server's UV requirement.
  if (path === "/passkey/generate-authenticate-options" && response.ok) {
    return Response.json({ ...await response.json<Record<string, unknown>>(), userVerification: "required" }, { headers });
  }
  return new Response(response.body, { status: response.status, headers });
}
