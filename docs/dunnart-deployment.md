# Dunnart production deployment — 2026-09-24

Live: https://dunnart.yumait.au
Account: Yuma IT (`3eed46cc48f123cdff00d116df5e5070`).
Deployed source: `https://github.com/yumaitau/dunnart-os.git`, commit `64f51edef8f114633cd1223037ecd85d4f00dfd2`.

## Deployment

This instance replaces the previous landing page at the same hostname.

| Worker | Active version |
| --- | --- |
| dunnart-os (router) | 2ea29949-c63e-4f20-b2ce-8578c80475d6 |
| dunnart-os-workshop | 1e45813c-8ec6-4340-998a-cc18a37a87e8 |
| dunnart-os-context | efac9229-cbc5-4254-9a78-b38540bda77d |
| dunnart-os-scheduler | d5937adf-f4ba-4e0d-b977-bfd2e182bd55 |

Only the router has a public custom domain. All four Workers disable workers.dev and preview URLs. Backend has Workers AI, Browser Rendering, dynamic Worker loader, Context and Scheduler service bindings.

Production configurations are saved in `wrangler.prod.jsonc` under each of `packages/router`, `packages/workshop-backend`, `packages/gatekeeper-context`, and `packages/gatekeeper-scheduler`. These four credential-free configs are tracked explicitly; other site-specific configs remain ignored. Never add credentials to these files.

## Access and routing

- Access app: Dunnart OS, `fe48525d-5aa5-47b3-9b93-2f84db04b136`.
- Issuer: `https://yumait.cloudflareaccess.com`.
- Audience: `6c618e46001c9081fd37d6487455aeb3f4db19bbc6388890a642aa982a7140dd`.
- Policy: Dunnart - Authorised users, `f1bc97a1-a4ff-480e-934c-4738bee3af30`; exact email allow for `justin@yumait.com.au` and `josh@yumait.com.au`, no bypass rules.
- Login: email one-time PIN only; 24-hour application session.
- OTP provider: `58dd712c-96fc-4dd4-82a0-97acc9873e05`.
- Existing account-wide Google provider returned `401 deleted_client`. Removed it only from this app's allowed providers; global provider unchanged.
- Backend `ADMINS`: `["justin@yumait.com.au"]`.
- Custom domain: `686fdf5bc16786b3b2576a48d4320f2cec1b90e9`.
- Zone: `5c685c6e0ca646fd6ddae37ed099652c`.
- Managed DNS record: `c160978a7ff29e060103834d0c8d2961`, AAAA `100::`.
- Original proxied CNAME was `kiss-company.pages.dev` (TTL auto). Original Pages project `dunnart` retained. Local DNS backup: `output/dunnart-dns-before.json`.

## Storage and AI

- BLUEPRINTS KV: `4315c948485a4e8bbc4029848adabd8b`.
- AVATARS KV: `8dcdd00cb4e0408ea278ced138d907fb`.
- Context KV: `103b941983a94ca6ba439505bd85dde3`.
- Blueprint content R2: `dunnart-os-blueprint-content`.
- AI Gateway: `dunnart-os-ai`; authenticated, prompt/response logging off, caching off, fixed 30 requests per 60 seconds, standard Workers AI postpaid billing.
- Default user model: Kimi K2.7 Code (Workers AI), `@cf/moonshotai/kimi-k2.7-code`.
- Existing Dunnart branding retained. Justin profile configured.
- Context and Scheduled Tasks connected for Justin; deployment modes remain optional.

## Verification completed

- Full `pnpm build` passed; Access-mode frontend rebuilt with `VITE_CF_ACCESS_MODE=true` and cache bypassed.
- Four Wrangler dry runs passed; four active deployments verified.
- HTTPS domain serves Cloudflare Access, replacing old landing page.
- Email-code sign-in completed successfully as sole admin; authenticated home and `/admin` work.
- Live AI generated a Deployment Counter gadget, accepted into workspace.
- Sandbox gadget RPC incremented 0 to 1; full browser reload retained 1; Reset returned 0.
- App reported 7,915 tokens and estimated $0.0131 for the smoke test (not a billing reconciliation).
- Context Library and Scheduled Tasks accounts provisioned successfully; both management UIs loaded.
- Anonymous `/`, `/api`, and `/admin` each returned HTTP 302 to `yumait.cloudflareaccess.com`.
- Saved Access configuration re-read through API: OTP only; exact Justin and Josh email rules verified after Josh was added.

## Limits

Third-party OAuth gatekeepers are not deployed or connected. Scheduler execution and Context document CRUD were not exercised; account provisioning and management UI were verified. Smoke-test workspace remains available with count reset to zero.

## Redeploy

Run from the repository root using the tracked production configs and pinned Wrangler 4.128.0 / pnpm 11.17.0. Preserve resource IDs and Access settings.

```sh
pnpm build
env VITE_CF_ACCESS_MODE=true pnpm exec vp run -F @gadgets/workshop-frontend --no-cache build
pnpm --dir packages/gatekeeper-context exec wrangler deploy --config wrangler.prod.jsonc
pnpm --dir packages/gatekeeper-scheduler exec wrangler deploy --config wrangler.prod.jsonc
pnpm --dir packages/workshop-backend exec wrangler deploy --config wrangler.prod.jsonc
pnpm --dir packages/router exec wrangler deploy --config wrangler.prod.jsonc
```

Authenticate Wrangler to the Yuma IT account before deploying. Verify live login and a stored gadget after future releases. Access policy and AI Gateway settings are managed separately in Cloudflare; Wrangler does not recreate them. A Git push alone does not deploy these production configs. No credentials are contained in this report.

## Follow-up: Josh and AI — 2026-09-24

Josh is an authorized regular user. Saved Access policy was re-read through API and contains exactly Justin and Josh. Backend ADMINS remains Justin only. Josh must complete email-code login and first-run onboarding himself; his session has not been tested.

Live backend Workers AI binding and Cloudflare AI Gateway settings re-verified. Existing live chat showed a successful AI reply. Kimi K2.7 Code selected for new conversations; GLM 5.2, GLM 5.3 Flash, and DeepSeek V4 Pro 0813 are also offered. Prior gadget creation and persistence smoke test passed. No external API key is needed for this Workers AI configuration.
