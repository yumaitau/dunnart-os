# Connector recovery

Context and Scheduled Tasks expose a recovery participant only through their trusted vendor service
binding. Connected accounts, agent sessions and management UIs never receive this participant.

The deployment inventory must include every retained account capability, including dormant and
disconnected accounts. Context also exports its sharing domain when there are no remaining users.
Coverage is current reachable logical deployment state. Physically orphaned Durable Objects left by
aborted or deleted operations are excluded; recovery does not crawl other deployments' namespaces.

## Capture

`beginRecovery(accountIds, run)` installs persistent mutation fences on account and domain objects.
Each newly fenced actor commits the fence and restarts, terminating operations and capabilities that
started before the fence. The participant retries acquisition through a fresh object stub. Source
mutations fail explicitly while fenced; Scheduler delivery alarms cannot run.

`exportAccount` and `exportDomain` return versioned JSON snapshots. Structured values inside them use
the portable recovery codec, preserving binary values, dates, maps and other supported storage types.
Context includes collection KV rows, extracted search passages, semantic vectors, private library
indexes, public registry rows, and the bound domain's public-collection KV snapshot. Scheduler includes
every driver row, pending-run state, native initiator identities and the original alarm time.

`validateRecovery` checks fence ownership and reexports captured components to detect changes before
archive completion. `endRecovery` releases only the named run's fences and replans source alarms.
The deployment coordinator must journal acquisition and release fences after failures or interruption.

## Native capabilities and restore

Account, verifier, gatekeeper-class and hook-controller descriptors are authenticated with
`BACKUP_CAPABILITY_KEY`. Descriptor consumers verify the attestation before trusting an identity.
The key authenticates provenance and is separate from archive decryption material. Scheduler verifies
its stored Workshop initiator descriptors before exporting them; unknown capabilities fail capture.

Restoration requires empty targets. Context remaps its sharing domain to
`recovery:<scope>:<original-domain>`. Scheduler remaps its account ID to
`recovery:<scope>:<original-account>`. Context verifiers keep the account boundary within that isolated
domain. A trusted Workshop resolver remaps each scheduled hook to its isolated Overseer without
invoking the callback.

Restored Context collections retain an offline marker that suppresses artifact refresh, artifact
deletion, semantic API calls and external document extraction. Restored Scheduler drivers retain all
records under a persistent disabled marker, delete their alarm, reject activation, and suppress alarm
delivery. Pending runs are preserved for inspection; no run is replayed during restore.
