# Authentication and provisioning

Dunnart supports Better Auth on Cloudflare Workers with a dedicated D1 database.
Application data remains in existing Durable Objects. Authentication configuration stays in
Worker bindings and secrets, separate from the admin settings UI.

## Enable Better Auth

1. Create a D1 database and bind it as `AUTH_DB` on the Workshop backend.
2. Apply `packages/workshop-backend/migrations/0001_better_auth.sql` before enabling auth.
3. Set `BETTER_AUTH_ENABLED=true` and `PUBLIC_BASE_URL` to the public HTTPS origin.
4. Generate a random `BETTER_AUTH_SECRET` of at least 32 bytes and install it with Wrangler secrets.
5. Configure `AUTH_ADMINS` as a private JSON array of existing account keys. Never commit real identities.

The frontend discovers this mode from the backend. Password sign-in requires a verified account;
public password signup and automatic account linking are disabled. Cookies are HTTP-only and secure
on HTTPS. RPC connections validate the session cookie and enforce same-origin requests. Session
expiry and remote revocation close existing RPC connections within 30 seconds. Directory deactivation
also closes subscribed connections immediately; failed cross-service synchronization retries.

### Existing Cloudflare Access accounts

Existing email-keyed accounts can migrate without moving their workspaces:

1. Retain the existing Access issuer and audience privately. Set `ACCESS_MIGRATION_ENABLED=true`.
2. Scope the existing Access application to `/api/auth/access-*`. Keep its authorized-user policy.
3. Select **Migrate an existing account**, verify identity with Access, and set a password.
4. Add a passkey and authenticator MFA under **Profile → Security**.
5. Disable `ACCESS_MIGRATION_ENABLED` after all existing users migrate, then retire that Access route.

Migration accepts only a verified Access assertion for an existing account and refuses accounts
already migrated. It cannot replace an existing Better Auth account or bypass enrolled MFA.
An administrator must not manually pre-verify an email merely because somebody requested it.

## MFA and passkeys

Authenticator MFA protects password sign-in, with enrollment verification and one-use recovery
codes. Passkeys require device user verification. SSO providers enforce their own MFA policies.
These are distinct authentication methods; enabling TOTP does not add a second prompt to passkeys
or to SSO. Recovery codes must be saved privately during enrollment. The Security panel also
supports passkey removal, password changes and signing out other sessions.

## SSO providers

Set `OIDC_PROVIDERS` as a JSON secret containing entries such as:

```json
[{
  "id": "workforce",
  "displayName": "Workforce SSO",
  "domain": "example.com",
  "issuer": "https://identity.example.com",
  "clientId": "APPLICATION_CLIENT_ID",
  "clientSecret": "APPLICATION_CLIENT_SECRET",
  "tokenEndpointAuth": "client_secret_basic",
  "requireProvisioning": true
}]
```

Register the redirect URI `https://workshop.example/api/auth/sso/callback/workforce` with the
provider. Better Auth handles discovery, authorization-code exchange and PKCE. Configure the
provider to return a stable `sub`, email and name. Provider registration and account linking APIs
are not public administration surfaces. Connections are deployment-owned. No provider is enabled
until its credentials are installed. This integration currently exposes OIDC providers; SAML is
not configured by this application.

## SCIM 2.0

The existing small SCIM provisioner handles `/api/scim/v2`, independently of Better Auth's SCIM
plugin. That plugin requires interactive database transactions, which D1 does not support.

Configure `SCIM_TOKENS` as a JSON secret containing `providerId` and a SHA-256 `sha256` digest for
each random bearer token. Issue at least 32 random bytes per token; keep plaintext only at the IdP.
Each token is scoped to one configured provider. Rotation can overlap multiple digests.

Provision Users with `externalId` equal to the OIDC subject. Supported operations are discovery,
Users create/read/update/PATCH/delete, equality filters and bounded pagination. Groups and role
assignment are not implemented; provisioning cannot grant admin privileges. Enterprise accounts
use isolated immutable application keys, so a matching email cannot claim a local administrator.
Deactivation removes application sessions and Better Auth sessions. Reactivation requires sign-in.
Deleted identities cannot return through just-in-time signup.

## Knowledge and models

The Context Library now indexes uploaded text and supported document extraction for retrieval.
See [Knowledge & Context](../packages/gatekeeper-context/README.md) for limits and formats.
GLM 4.7 Flash is the default for new Workers AI model selections. Saved model choices are preserved.

## Deployment privacy

Keep production Wrangler configurations, credentials, resource identifiers, real admin identities,
and operator runbooks outside Git. Use the checked-in generic configuration as a template. Scan
both staged changes and commit history before publication; deleting a file does not erase history.
