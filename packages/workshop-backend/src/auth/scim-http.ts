import { scimTokens, enterpriseProviders } from "./enterprise-config.js";
import { ScimError, SCIM_LIST, SCIM_USER } from "./scim-schema.js";
import type { IdentityDirectory } from "./identity-directory.js";

/** Bounded body reads for machine endpoints and identity-provider responses. */
export async function boundedJson(request: Request | Response, maximum = 65_536): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ScimError(400, "JSON body required.", "invalidSyntax");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new ScimError(413, "Request too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ScimError(400, "Invalid JSON.", "invalidSyntax"); }
}

const userSchema = {
  id: SCIM_USER, name: "User", description: "Provisioned sign-in identity",
  attributes: [
    { name: "userName", type: "string", required: true, uniqueness: "server" },
    { name: "displayName", type: "string" },
    { name: "active", type: "boolean" },
    { name: "name", type: "complex", subAttributes: [
      { name: "givenName", type: "string" }, { name: "familyName", type: "string" },
    ] },
    { name: "emails", type: "complex", multiValued: true, subAttributes: [
      { name: "value", type: "string" }, { name: "primary", type: "boolean" }, { name: "type", type: "string" },
    ] },
  ].map(attribute => ({ multiValued: false, required: false, caseExact: false,
    mutability: "readWrite", returned: "default", uniqueness: "none", ...attribute })),
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/scim+json", "Cache-Control": "no-store",
    ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) },
});

/** Authenticate every SCIM route, including discovery; tokens grant no browser/admin capability. */
export async function handleScimRequest(request: Request, env: Cloudflare.Env,
    directory: IdentityDirectory): Promise<Response> {
  try {
    const token = /^Bearer ([\x21-\x7e]{32,1024})$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) throw new ScimError(401, "Invalid provisioning token.");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toHex();
    const matches = scimTokens(env).filter(candidate => {
      let difference = 0;
      for (let i = 0; i < hash.length; i++) difference |= hash.charCodeAt(i) ^ candidate.sha256.charCodeAt(i);
      return difference === 0;
    });
    if (matches.length !== 1 || !enterpriseProviders(env).some(p => p.id === matches[0].providerId)) {
      throw new ScimError(401, "Invalid provisioning token.");
    }
    const path = new URL(request.url).pathname;
    const base = new URL("/api/scim/v2", env.PUBLIC_BASE_URL).href;
    if (path === "/api/scim/v2/Users" || path.startsWith("/api/scim/v2/Users/")) {
      const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await boundedJson(request) : undefined;
      return await directory.scim(matches[0].providerId, request, base, body);
    }
    if (request.method !== "GET") throw new ScimError(405, "Method not allowed.");
    if (path === "/api/scim/v2/ServiceProviderConfig") return json({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 }, changePassword: { supported: false },
      sort: { supported: false }, etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "Provider-scoped provisioning token", primary: true }],
    });
    const resourceType = { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User", name: "User", endpoint: "/Users", schema: SCIM_USER,
      meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` } };
    const schema = { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], ...userSchema };
    if (path === "/api/scim/v2/ResourceTypes/User") return json(resourceType);
    if (path === `/api/scim/v2/Schemas/${SCIM_USER}`) return json(schema);
    if (path === "/api/scim/v2/ResourceTypes" || path === "/api/scim/v2/Schemas") return json({
      schemas: [SCIM_LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1,
      Resources: [path.endsWith("Schemas") ? schema : resourceType],
    });
    throw new ScimError(404, "Resource not found.");
  } catch (error) {
    const known = error instanceof ScimError;
    return json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(known ? error.status : 500), detail: known ? error.message : "Provisioning failed. Retry the request.",
      ...(known && error.scimType ? { scimType: error.scimType } : {}),
    }, known ? error.status : 500);
  }
}
