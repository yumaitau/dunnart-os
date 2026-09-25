import { z } from "zod";

export const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export class ScimError extends Error {
  constructor(public status: number, message: string, public scimType?: string) { super(message); }
}

const email = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const userSchema = z.object({
  schemas: z.array(z.string()).refine(value => value.includes(SCIM_USER)),
  userName: z.string().trim().min(1).max(254),
  externalId: z.string().min(1).max(255).optional(),
  displayName: z.string().trim().max(200).optional(),
  name: z.object({ givenName: z.string().max(100).optional(), familyName: z.string().max(100).optional(),
    formatted: z.string().max(200).optional() }).optional(),
  emails: z.array(z.object({ value: email, primary: z.boolean().optional(), type: z.string().optional() })).max(10).optional(),
  active: z.boolean().default(true),
});

export type ProvisionedProfile = {
  userName: string; email: string; externalId?: string; displayName: string;
  givenName?: string; familyName?: string; active: boolean;
};

/** Parse the supported SCIM profile; clients cannot supply roles, passwords, or local account IDs. */
export function parseScimUser(body: unknown): ProvisionedProfile {
  const result = userSchema.safeParse(body);
  if (!result.success) throw new ScimError(400, "Invalid SCIM User resource.", "invalidValue");
  const value = result.data;
  const selected = value.emails?.find(entry => entry.primary) ?? value.emails?.[0];
  const address = email.safeParse(selected?.value ?? value.userName);
  if (!address.success) throw new ScimError(400, "A valid primary email is required.", "invalidValue");
  return {
    userName: value.userName, email: address.data, externalId: value.externalId,
    displayName: value.displayName || value.name?.formatted ||
      [value.name?.givenName, value.name?.familyName].filter(Boolean).join(" ") || value.userName,
    givenName: value.name?.givenName, familyName: value.name?.familyName, active: value.active,
  };
}

export function scimProfile(profile: ProvisionedProfile) {
  return {
    schemas: [SCIM_USER], userName: profile.userName, externalId: profile.externalId,
    displayName: profile.displayName, name: { givenName: profile.givenName, familyName: profile.familyName },
    emails: [{ value: profile.email, primary: true, type: "work" }], active: profile.active,
  };
}

/** Apply supported attribute updates atomically; reject unknown paths instead of silently losing them. */
export function patchScimUser(profile: ProvisionedProfile, body: unknown): ProvisionedProfile {
  const patch = z.object({ schemas: z.array(z.string()).refine(value => value.includes(SCIM_PATCH)),
    Operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() })).min(1).max(50),
  }).safeParse(body);
  if (!patch.success) throw new ScimError(400, "Invalid SCIM PATCH document.", "invalidSyntax");
  const resource: Record<string, unknown> = scimProfile(profile);
  for (const operation of patch.data.Operations) {
    const op = operation.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, "Unsupported PATCH operation.", "invalidSyntax");
    if (!operation.path) {
      if (op === "remove" || typeof operation.value !== "object" || !operation.value || Array.isArray(operation.value)) {
        throw new ScimError(400, "PATCH value must be an object.", "invalidValue");
      }
      for (const [key, value] of Object.entries(operation.value)) apply(key, value, op);
    } else apply(operation.path, operation.value, op);
  }
  return parseScimUser(resource);

  function apply(rawPath: string, value: unknown, op: string) {
    const path = rawPath.replace(SCIM_USER + ":", "").toLowerCase();
    const keys: Record<string, string> = {
      username: "userName", externalid: "externalId", displayname: "displayName", active: "active", name: "name", emails: "emails",
    };
    if (path === 'emails[type eq "work"].value' || path === 'emails[primary eq true].value') {
      if (op === "remove") throw new ScimError(400, "Email is required.", "mutability");
      resource.emails = [{ value, primary: true, type: "work" }];
    } else if (path === "name.givenname" || path === "name.familyname") {
      const key = path === "name.givenname" ? "givenName" : "familyName";
      const name = { ...(resource.name as Record<string, unknown>) };
      if (op === "remove") delete name[key]; else name[key] = value;
      resource.name = name;
    } else if (keys[path]) {
      const key = keys[path];
      if (op === "remove") {
        if (["userName", "emails", "active"].includes(key)) throw new ScimError(400, "Required attribute cannot be removed.", "mutability");
        delete resource[key];
      } else resource[key] = value;
    } else throw new ScimError(400, "Unsupported PATCH attribute.", "invalidPath");
  }
}

export function scimFilter(filter: string | null): { field: string; value: string } | null {
  if (!filter) return null;
  if (filter.length > 1024) throw new ScimError(400, "Filter too long.", "invalidFilter");
  const match = /^(userName|externalId|id|emails\.value)\s+eq\s+("(?:[^"\\]|\\.)*")$/i.exec(filter.trim());
  if (!match) throw new ScimError(400, "Supported filters: userName, externalId, id, emails.value eq string.", "invalidFilter");
  try { return { field: match[1].toLowerCase(), value: JSON.parse(match[2]) }; }
  catch { throw new ScimError(400, "Malformed filter string.", "invalidFilter"); }
}
