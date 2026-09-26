# Offline release escrow

These dependency-free Node.js tools preserve the exact files needed to rebuild a
deployment after its source checkout or build service is lost. Retain these three
`.mjs` files with the offline recovery kit. Node.js 22 or later is sufficient.

## Seal a release

Create a private input manifest. Each logical archive path maps to one required
local file; relative sources resolve against the input manifest's directory.
Enumerate every compiled Worker module, frontend asset, private deployment
configuration, and application secret file needed by the release. The tool does
not infer completeness from source code or expand directories/globs. Keep source
files stable while sealing; every listed file must exist and be a regular file.

```json
{
  "version": 1,
  "releaseId": "release-abc123",
  "files": {
    "workers/backend/index.js": "/private/release/backend/index.js",
    "workers/backend/index.wasm": "/private/release/backend/index.wasm",
    "frontend/index.html": "/private/release/frontend/index.html",
    "frontend/assets/app.js": "/private/release/frontend/assets/app.js",
    "private/deployment.json": "/private/release/deployment.json",
    "private/application-secrets.json": "/private/release/secrets.json"
  }
}
```

The offline kit is JSON with `version: 1`, matching RSA JWK `publicKey` and
`privateKey`, `authenticationKey` (canonical base64, 32–64 random bytes), and a
nonempty string `capabilityKey`. RSA keys must be at least 3072 bits. These tools
read the kit locally, never print it, and never include it in escrow. The
capability key is not used by this file format. The kit itself, copies containing
its private JWK exponent, and source symlinks are rejected as archive inputs.

```sh
node scripts/recovery/seal-release.mjs \
  --input /private/release-input.json \
  --kit /offline/recovery-kit.json \
  --out /private/new-release-escrow
```

The output directory must not already exist; its parent must exist. The tool
creates it with mode `0700` and writes `artifact.bin` and `manifest.json` with mode
`0600`. A failure removes the new output directory. It never overwrites an
existing output directory. Retain the kit offline; upload only the two escrow
files to `BACKUPS` at `release/<deployment-release-sha>/artifact.bin` and
`release/<deployment-release-sha>/manifest.json`. Pin the expected `releaseId`
when verifying that location; a valid HMAC alone does not identify the intended
release. The provider must authenticate metadata and verify artifact length and
digest before copying escrow into a recovery archive.

## Format version 1

`artifact.bin` contains AES-256-GCM ciphertext followed by the 16-byte GCM tag.
The 32-byte data key and 12-byte nonce are generated afresh for each seal. The
plaintext is gzip-compressed UTF-8 JSON:

```json
{
  "version": 1,
  "releaseId": "release-abc123",
  "files": [
    { "path": "frontend/index.html", "bytes": 3, "data": "YWJj" }
  ]
}
```

`data` is canonical base64 of the exact original bytes. Files appear in sorted
logical path order when sealed. Logical paths use ASCII letters, digits, `.`,
`_`, `-`, and `/`, and are at most 256 characters. Absolute paths, empty/dot/dot-dot
segments, trailing dots, Windows device names, backslashes, case-insensitive
duplicates, and file/directory collisions are rejected. The archive contains
1–10,000 files and at most 64 MiB of original file bytes. Serialized archive and
ciphertext each have a 96 MiB bound; decompression enforces the same bound before
JSON parsing. Extracted files have mode `0600`; directories have mode `0700`.
Source mode bits and symbolic links are not retained.

The small manifest has exactly these generated fields:

```text
{
  version: 1,
  releaseId: string,
  bytes: integer,
  sha256: string,
  keyEnvelope: {
    version: 1,
    algorithm: "RSA-OAEP-256/A256GCM",
    keyId: string,
    wrappedKey: string
  },
  nonce: string,
  authentication: string
}
```

- `releaseId`: 1–128 ASCII characters; starts with a letter or digit; remaining
  characters are letters, digits, `.`, `_`, or `-`.
- `bytes`: exact artifact size, including GCM tag; 16–100663296 bytes.
- `sha256`: lowercase hexadecimal SHA-256 of the complete `artifact.bin`.
- `keyEnvelope.keyId`: lowercase hexadecimal SHA-256 of UTF-8
  `JSON.stringify(["RSA", publicKey.n, publicKey.e])`, matching recovery-archive's
  existing key identifier.
- `keyEnvelope.wrappedKey`: canonical base64 of RSA-OAEP/SHA-256 encryption of
  the raw AES key, using the public RSA key and the empty OAEP label.
- `nonce`: canonical base64 of the 12-byte GCM nonce.
- GCM additional authenticated data: UTF-8 `JSON.stringify([1, releaseId])`.
- `authentication`: canonical base64 HMAC-SHA-256 using the kit's decoded
  `authenticationKey` over these exact UTF-8 bytes, with JSON's normal compact
  array serialization and no trailing newline:

```js
JSON.stringify([
  1, manifest.releaseId, manifest.bytes, manifest.sha256,
  manifest.keyEnvelope.version, manifest.keyEnvelope.algorithm,
  manifest.keyEnvelope.keyId, manifest.keyEnvelope.wrappedKey, manifest.nonce
])
```

Manifest property order and whitespace are irrelevant. Array field order above
is fixed. The HMAC is symmetric authentication: holders of `authenticationKey`
can authenticate releases. Decryption additionally requires the offline RSA
private key.

`release-escrow.mjs` exports `releaseManifestPayload`, `verifyReleaseManifest`,
and `verifyReleaseArtifact` for Node.js callers. The verification helpers accept
the base64 authentication key and an optional expected release ID. Workers can
implement the same format with WebCrypto; Node.js imports are not needed there.

## Open a release

```sh
node scripts/recovery/open-release.mjs \
  --manifest /private/escrow/manifest.json \
  --artifact /private/escrow/artifact.bin \
  --kit /offline/recovery-kit.json \
  --release-id release-abc123 \
  --out /private/new-restored-release
```

Recovery verifies the manifest HMAC, optional expected release ID, ciphertext
length/digest, RSA key identity, GCM tag, bounded decompression, archive identity,
all paths, and every file size before creating the private extraction directory.
Run from a private parent directory. Restoring these files does not deploy
Workers or provision Cloudflare resources; the preserved deployment configuration
and separate state recovery flow supply that step. CLI failures emit a generic
message without secret-bearing input, file contents, or underlying exceptions.

Run the offline checks with:

```sh
node --test scripts/recovery/release-escrow.test.mjs
```
