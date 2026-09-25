import { z } from "zod";

const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search;
}, "Identity provider URLs must use HTTPS without credentials, query, or fragment.");

const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  displayName: z.string().min(1).max(80),
  issuer: httpsUrl,
  trustedOrigins: z.array(httpsUrl).max(5).optional(),
  domain: z.string().min(1).max(253).optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tokenEndpointAuth: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
  subjectClaim: z.literal("sub").default("sub"),
  requireProvisioning: z.boolean().default(true),
}).strict();

export type EnterpriseProvider = z.infer<typeof providerSchema>;

/** Deployment secret; never returned through the admin or public configuration APIs. */
export function enterpriseProviders(env: Cloudflare.Env): EnterpriseProvider[] {
  if (!env.OIDC_PROVIDERS) return [];
  const providers = z.array(providerSchema).max(10).parse(JSON.parse(env.OIDC_PROVIDERS));
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) {
    throw new Error("OIDC provider IDs must be unique.");
  }
  return providers;
}

/** SHA-256 digests of independently rotatable, provider-scoped SCIM tokens. */
export function scimTokens(env: Cloudflare.Env): { providerId: string; sha256: string }[] {
  if (!env.SCIM_TOKENS) return [];
  return z.array(z.object({
    providerId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(20).parse(JSON.parse(env.SCIM_TOKENS));
}
