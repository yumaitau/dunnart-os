# Deployment backups and isolated recovery

The implementation includes durable backup orchestration, daily/weekly schedules,
admin controls, deployment inventory, encrypted release escrow, archive integrity
checks, and restore into isolated storage with a separately routed application
runtime for verification. Production activation and
Cloudflare resource provisioning remain separate operator steps. This guide
describes the implementation; it is not evidence of a production restore drill.

## Operator setup

Deploy the backend migrations and exports for `DeploymentBackups` and
`NativeRecoveryObject`, then configure the deployment-specific bindings below.
Keep private account identifiers and secrets out of public example configuration.

| Binding or secret | Purpose |
| --- | --- |
| `BACKUPS` | Private R2 archive bucket, separate from live content. |
| `BACKUP_DEPLOYMENT_ID` | Stable archive identity: 1–128 ASCII letters, digits, `_`, or `-`. Preserve it with the recovery kit. |
| `BACKUP_PUBLIC_KEY` | Public RSA JWK JSON, at least 3072 bits, without private fields. |
| `BACKUP_AUTHENTICATION_KEY` | Base64 HMAC-SHA256 key shared with the offline kit; use 32–64 random bytes for release escrow compatibility. |
| `BACKUP_CAPABILITY_KEY` | Key authenticating trusted native/connector recovery descriptors. Preserve it in the kit and configure participating connector workers consistently. |
| `BACKUP_RELEASE_ID` | Expected deployed release ID; must equal the authenticated escrow manifest's `releaseId`. |
| `BACKUP_RESTORE` | Newly provisioned empty private R2 bucket for isolated content and recovery material. |
| `BLUEPRINTS_RESTORE`, `AVATARS_RESTORE` | Newly provisioned empty KV namespaces, distinct from production bindings. |
| `AUTH_DB_RESTORE` | Newly provisioned empty D1 database when the archive includes `AUTH_DB`. |

Keep an offline JSON kit containing `version: 1`, matching RSA JWK `publicKey`
and `privateKey`, base64 `authenticationKey`, and `capabilityKey`. Retain the
deployment identity, resource inventory, deployment instructions, and offline
recovery tools alongside it. Scheduled capture uses the public RSA key and
authentication key; no private recovery key is configured on the worker. The
private key is supplied only for a requested restore. Possession of the HMAC key
allows authenticating archives; decryption also requires the RSA private key.

Every installed connector must expose a complete recovery participant, including
connectors with no currently connected accounts. Context Library and Scheduled
Tasks have participants. An unsupported installed connector, retained account
whose connector is no longer installed, or capability without a trusted recovery
descriptor blocks capture. The provider does not silently omit these records.

## Preserve the deployed release

State alone does not reconstruct application code or deployment secrets. Use the
dependency-free tools in [scripts/recovery](../scripts/recovery/README.md) to seal
an explicit inventory of exact compiled Worker modules, frontend assets, private
deployment configuration, and application secret files. Every listed file is
required; directories and globs are not expanded. Source completeness is the
operator's responsibility. Keep the recovery kit outside that inventory.

```sh
node scripts/recovery/seal-release.mjs \
  --input /private/release-input.json \
  --kit /offline/recovery-kit.json \
  --out /private/new-release-escrow
```

Upload `artifact.bin` and `manifest.json` to:

```text
release/<releaseId>/artifact.bin
release/<releaseId>/manifest.json
```

Publish the same authenticated manifest as `release/current.json` after the
artifact is available, and set `BACKUP_RELEASE_ID` to that release ID. A commit
SHA can be used as `releaseId`; the manifest and object path must agree. Refresh
escrow when deployed executable files, assets, configuration, or secrets change.
The provider checks the manifest HMAC, pinned release identity, recovery
public-key fingerprint, artifact length, and SHA-256 before accepting it. It
rechecks release stability before publishing a backup.

Each deployment backup includes both the authenticated manifest and encrypted
artifact as archive components. The artifact remains independently encrypted
inside the deployment archive. Offline tools create new private directories
(`0700`) and files (`0600`), refuse existing output directories, and reject
traversal, path collisions, symlinks, missing required files, excessive sizes,
and inclusion of the kit or its private JWK material. The linked README defines
the exact input, encryption, HMAC, and extraction formats.

## Admin workflow and scheduling

Open **Backups** in the deployment admin panel. The optional bundled **Backups**
blueprint (`format.backups`) opens these trusted controls; the gadget does not
receive backup authority or private recovery material. Operations are exposed
through the admin API capability.

The panel reports configuration, recovery public-key fingerprint, required
coverage, next scheduled run, and durable run history. Resolve every coverage
blocker before capture. **Run backup now** queues work durably; leaving the page
does not discard the request. Only one capture runs at a time. Completed runs
show component count, archive bytes, and last integrity-verification time;
failures retain an actionable category without exposing provider exceptions or
customer data.

`AdminApi.rescanBackupArchives()` rebuilds archive history and component
inventories when coordinator state is lost. It scans up to 1,000 run prefixes
under the stable deployment identity, authenticates published receipts and every
listed object hash, and imports valid runs with trigger `recovered`. Their
recorded timestamp comes from the R2 head upload time. Corrupt published heads
become failed rows; incomplete prefixes without a published head are ignored.
The rescan retains up to 100 completed and 100 failed rows. It requires the
archive bucket, stable deployment ID, authentication key, and public key, but no
private recovery key. Reconfigure these from the offline inventory before
rescanning a replacement coordinator.

Schedules support daily or weekly capture at an integer UTC hour, with weekday
`0` meaning Sunday. Default: disabled, daily at 03:00 UTC, retaining seven
successful archives. Retention accepts 1–100 successful recovery points. Saving
the schedule persists it and adjusts the Durable Object alarm directly; backup
scheduling does not require activating a Scheduled Tasks connector hook.
Disabling the schedule stops future scheduled captures. Manual capture remains
available. Failed-run history is separately bounded to 100 entries.

Older successful archives are removed only after another successful capture and
a fresh integrity check of the newest retained archive. A failed capture does
not replace a previous successful recovery point. Interrupted work uses a
15-minute durable watchdog: it retries fence cleanup and checks whether a fully
published, authenticated archive exists before recovering completion. Otherwise
the run fails and a new capture is required.

## Component coverage and capture consistency

The provider persists the exact required inventory for each run. Archive
publication and later verification require an exact inventory match. Coverage is
the reachable logical application inventory: directory/authentication users,
their retained workspaces, gadget facets, and connected accounts. Physically
orphaned Durable Objects outside those references are excluded; the provider
does not enumerate every historical object in a Cloudflare namespace.

| Component | Preserved state |
| --- | --- |
| Root Durable Objects | Admin settings, user directory, identity directory. |
| Users and workspaces | Users discovered from the directory and authentication database; retained workspace references; native KV and application SQL; dynamic gadget facets and stored values. |
| Native capabilities | Versioned, authenticated descriptors for supported classes, gadget facets, connector accounts, and callback identities, resolved into isolated authority on restore. Unknown capabilities fail capture. |
| Workers KV | `BLUEPRINTS` and `AVATARS`: binary values, JSON metadata, absolute expirations. |
| R2 | `BLUEPRINT_CONTENT`: bodies, HTTP/custom metadata, and storage class. |
| D1 | `AUTH_DB` when bound: tables, indexes, views, triggers, foreign keys, binary values, generated columns, and autoincrement high-water marks. Required when Better Auth is enabled. |
| Context Library | Domain registry, public and account-private collections, account indexes, collection content, extracted passages, semantic vectors, and public snapshot metadata. |
| Scheduled Tasks | Account rows, schedules, callback descriptors, and alarm metadata. Restored drivers remain disabled. |
| Deployment configuration | String environment configuration and admin identities, excluding `BACKUP_*` settings; required executable/configuration/secret files also come from explicit release escrow. |
| Backup control and release | Schedule, completed/failed history excluding the current running record, session policy, authenticated release manifest, and encrypted release artifact. |

With archive storage and keys configured, HTTP requests and public,
authenticated, and admin RPC calls acquire durable admission leases; tracked
`waitUntil` work retains its lease until completion. Capture first closes
admission and drains existing leases for up to 30 seconds. New HTTP requests
receive maintenance status `503` with `Retry-After: 30`; new ordinary RPC calls
receive a maintenance error. Uncertain leases do not silently expire: a drain
timeout fails the capture, and an unresolved orphan lease blocks later capture.

After the drain, capture installs persistent fences on root directories, admin
settings, users, workspaces, and participating connectors. Actor restarts
invalidate existing WebSockets and RPC handles so
stale handles cannot bypass new fences. All workspaces are fenced and prepared
before native snapshots and capability descriptors are collected. A persisted
journal identifies every fence to release after success, failure, or restart.
Cleanup reopens admission only after those source fences are released.

Root objects and external KV/D1/R2 stores have baseline content hashes, checked
during export and again before archive publication. Changes invalidate the run;
they are not accepted as a partial backup. Native snapshots are compared by
canonical content rather than changing point-in-time bookmarks. This combines
write fencing with explicit validation; Cloudflare's independent stores do not
provide a deployment-wide transaction. Capture can briefly interrupt connected
sessions or make writes return a retry error. Concurrent changes to unfenced
stores may require another run during a quieter interval.

Workers KV remains eventually consistent. An archive contains the quiesced
values observed by the capture reads, including observed avatar and blueprint
values. Repeated matching hashes do not prove an atomic global timestamp or that
the latest write has replicated everywhere. Recently written but unreplicated
KV values may be absent even after application requests have drained.

## Archive verification and isolated restore

Each run gets a fresh AES-256-GCM data key wrapped with RSA-OAEP/SHA-256. The
repository writes immutable encrypted R2 objects and publishes its
HMAC-authenticated head last, after coherent-capture validation. A published
receipt binds the exact encrypted objects and their digests.

**Verify archive** authenticates that receipt and checks all required ciphertext
objects without a private key. It proves integrity and inventory completeness,
not decryption success or restored application behavior.

For a completed archive:

1. Choose **Preview isolated restore**. The service verifies integrity and checks
   required isolated bindings, target emptiness, and connector availability.
2. Supply a private RSA JWK JSON file or the offline kit JSON. The UI extracts
   only the private JWK, sends it to the trusted restore service for this call,
   and clears the file input. It does not persist the key in browser state or
   storage. Preview does not require the key.
3. Choose **Stage isolated restore**. The repository verifies all ciphertext
   before staging components and decrypts with the supplied private key. Native
   imports are read back and compared before session invalidation. After every
   component has imported, finalization builds and activates the isolated native
   graph and verifies each recovered root's identity and usable runtime behavior.
4. Inspect restored state and retained executable/configuration material. Open
   the separately encrypted release artifact with `open-release.mjs` and the
   matching offline kit as documented in the escrow README.

Runtime finalization requires the archive's escrow release ID to equal the
currently deployed `BACKUP_RELEASE_ID`. When restoring an older release, first
deploy its matching escrowed code/configuration to the recovery environment.
Otherwise restored data and escrow remain unexposed and finalization fails.
Successful import alone is insufficient for the coordinator to report a
successful stage.

Targets are named/scoped for recovery: native state goes into
`NativeRecoveryObject` instances; Context Library uses separate recovery sharing
domains; Scheduled Tasks uses separate recovery account identities. KV, D1, and
R2 targets must be newly provisioned, empty, and distinct from production.
Recovery configuration, backup control, and escrow files are staged under
`recovery-material/<runId>/` in `BACKUP_RESTORE`.

After verified finalization, an administrator can call
`AdminApi.openRestoredWorkspace(runId, originalWorkspaceId)` to receive the
restored workspace's `Overseer` RPC capability. The original workspace ID must
appear in both the authenticated archive inventory and the verified runtime
receipt. This is an admin-held capability, not a public recovery URL. Original
User/Overseer code and gadget facets run over restored storage, with original
identities mapped through recovery-scoped namespace and loopback routing.
Archived name-to-ID mappings resolve original names even when the original
namespace no longer exists; missing mappings fail rather than deriving IDs in
the replacement namespace. Dynamic gadget code uses an isolated loader cache.
The runtime maps blueprint content to the existing `BACKUP_RESTORE` bucket;
no additional content-bucket alias is required. An original ID does not
authorize a lookup into the live object graph.

Restored alarms remain inactive. Context collections remain offline. Scheduled
Tasks drivers cannot dispatch or accept activation while isolated, and recovered
backup scheduling is disabled. Existing native user sessions, pending handoff
tickets, and pending connect flows are removed after restore; D1 `session` and
`verification` rows are cleared. Users must authenticate again. AI work and
pending application actions remain paused; inspect and
explicitly resolve their disposition before any activation.

Isolated runtime activation does not switch production routing or constitute
cutover. It does not resume restored alarms, redeploy Workers, or provision a new
Cloudflare account. An operator must separately restore deployment bindings and
secrets, validate recovered application behavior and capability mapping, decide
which background work may resume, and explicitly perform production cutover.
A successful isolated stage is not a claim that production activation or a
production recovery drill has been completed.

## Failure behavior and limits

Missing coverage, unsupported capabilities, modified source snapshots, release
escrow mismatch, missing/corrupt archive objects, and exceeded limits fail the
operation. Data is never silently truncated. A failed stage can leave partial
data in isolated targets; allocation is recorded before writes. Do not retry
against occupied targets: provision clean targets and a fresh restore run.
No production data is activated by a failed stage.

- Archive: at most 256 components and 10,000 encrypted data chunks, each with up
  to 4 MiB plaintext. The archive manifest is bounded to 4 MiB.
- Native/connector restore components: at most 32 MiB serialized text per
  component. Native SQL preserves signed 64-bit integers through decimal-text
  encoding. Virtual tables and unsupported portable/native values fail.
- KV: 100,000 entries; values up to 25 MiB, buffering one entry at a time.
  Already expired entries are skipped. A still-valid expiration too close to
  restore exactly causes failure rather than extending its lifetime.
- D1: 8 MiB serialized archive, 256 schema objects, and 5,000 restore statements.
  Virtual tables and integers outside JavaScript's safe range need a dedicated
  adapter. Import uses a transaction.
- R2: 100,000 objects; at most 10,000 multipart parts of 5 MiB per object. The
  archive chunk limit may apply first. Restored objects get new upload times,
  versions, and potentially different multipart ETags.
- Release escrow: 10,000 explicit files, 64 MiB total original bytes, and 96 MiB
  serialized/encrypted artifact bounds. Paths are limited to 256 safe ASCII
  characters. Larger deployments require another versioned adapter or format.

Readiness checks validate configuration and available adapters. They are not a
promise that every live component fits these bounds; capture can discover a
size, capability, or consistency blocker.

## Verification commands

```sh
pnpm --filter @gadgets/backend-utils test:run
pnpm --filter @gadgets/workshop-backend test:run
pnpm exec vp run -F @gadgets/backend-utils build
pnpm exec vp run -F @gadgets/workshop-backend build
node --test scripts/recovery/release-escrow.test.mjs
```

The suites exercise cryptographic tampering, exact inventory, durable scheduling,
target isolation, native storage/capability round trips, connector restoration,
and release escrow. Passing local or workerd tests establishes those tested
behaviors. Production readiness additionally requires the intended deployment's
configured coverage, a completed archive, and a separately recorded restore
drill with observed application behavior.
