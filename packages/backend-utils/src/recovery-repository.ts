import { createRecoveryKey, openRecoveryChunk, openRecoveryKey, RECOVERY_CHUNK_BYTES,
  recoveryBase64, recoveryBytes, recoveryDigest, sealRecoveryChunk, type RecoveryChunk, type RecoveryKeyEnvelope } from "./recovery-archive";

const encoder = new TextEncoder();
const MAX_CHUNKS = 10_000;
const MAX_METADATA = 8 * 1024 * 1024;

/** A component participating in a coherent deployment snapshot. */
export interface RecoverySource {
  /** Stable component name from the authoritative deployment inventory. */
  id: string;
  /** Version of this component's portable export format. */
  version: number;
  /** Stream a frozen component snapshot; never silently omit unsupported values. */
  export(): Promise<ReadableStream<Uint8Array>>;
}

/** One component's encrypted object inventory. */
export interface RecoveryComponentManifest {
  id: string;
  version: number;
  chunks: Array<{ key: string; sha256: string; bytes: number }>;
}

/** The encrypted, authoritative inventory of a complete deployment snapshot. */
export interface RecoveryManifest {
  version: 1;
  deployment: string;
  run: string;
  capturedAt: string;
  components: RecoveryComponentManifest[];
}

/** A sealed snapshot's bootstrap metadata, which contains no plaintext component contents. */
export interface RecoveryHead {
  version: 1;
  deployment: string;
  run: string;
  key: RecoveryKeyEnvelope;
  manifest: RecoveryChunk;
  /** Authentication tag verified with independently held recovery material. */
  signature: string;
}

/** A target must stage into isolated storage before any component is activated. */
export interface RecoveryTarget {
  id: string;
  version: number;
  /** Stage verified bytes in an inactive target, without mutating the live deployment. */
  stage(stream: ReadableStream<Uint8Array>): Promise<void>;
}

function segment(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid recovery identifier.");
  return value;
}
function prefix(deployment: string, run: string): string {
  return `recovery/v1/${segment(deployment)}/${segment(run)}/`;
}
function validateInventory<T extends { id: string; version: number }>(items: T[], required: string[]): Map<string, T> {
  if (!items.length || items.length > 256 || new Set(required).size !== required.length || required.length !== items.length) {
    throw new Error("Recovery coverage does not match the deployment inventory.");
  }
  const byId = new Map<string, T>();
  for (const item of items) {
    segment(item.id);
    if (item.id === "manifest") throw new Error("Reserved recovery component identifier.");
    if (!Number.isSafeInteger(item.version) || item.version < 1 || byId.has(item.id)) throw new Error("Invalid recovery component.");
    byId.set(item.id, item);
  }
  if (required.some(id => !byId.has(id))) throw new Error("Recovery coverage does not match the deployment inventory.");
  return byId;
}

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(RECOVERY_CHUNK_BYTES);
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("Recovery source must stream bytes.");
      let consumed = 0;
      while (consumed < next.value.length) {
        const take = Math.min(buffer.length - offset, next.value.length - consumed);
        buffer.set(next.value.subarray(consumed, consumed + take), offset);
        consumed += take;
        offset += take;
        if (offset === buffer.length) { yield buffer; buffer = new Uint8Array(RECOVERY_CHUNK_BYTES); offset = 0; }
      }
    }
    if (offset) yield buffer.slice(0, offset);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function readJson(bucket: R2Bucket, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  if (!object || object.size > MAX_METADATA) throw new Error("Recovery object missing or oversized.");
  return JSON.parse(await object.text());
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery metadata.");
  return value as Record<string, unknown>;
}
function chunk(value: unknown): RecoveryChunk {
  const item = record(value);
  const identity = record(item.identity);
  if (item.version !== 1 || typeof item.nonce !== "string" || typeof item.ciphertext !== "string" ||
      typeof item.sha256 !== "string" || typeof item.bytes !== "number" || typeof identity.deployment !== "string" ||
      typeof identity.run !== "string" || typeof identity.component !== "string" || typeof identity.ordinal !== "number") {
    throw new Error("Invalid encrypted recovery chunk.");
  }
  return { version: 1, nonce: item.nonce, ciphertext: item.ciphertext, sha256: item.sha256, bytes: item.bytes,
    identity: { deployment: identity.deployment, run: identity.run, component: identity.component, ordinal: identity.ordinal } };
}
function validateAuthenticationKey(key: CryptoKey, usage: "sign" | "verify"): void {
  const algorithm = key.algorithm;
  if (key.type !== "secret" || algorithm.name !== "HMAC" ||
      !("hash" in algorithm) || !algorithm.hash || typeof algorithm.hash !== "object" ||
      !("name" in algorithm.hash) || algorithm.hash.name !== "SHA-256" ||
      !("length" in algorithm) || typeof algorithm.length !== "number" || algorithm.length < 256 ||
      !key.usages.includes(usage)) throw new Error("Recovery authentication requires an HMAC-SHA256 key of at least 256 bits.");
}
function signedHeadBytes(header: Omit<RecoveryHead, "signature">): Uint8Array<ArrayBuffer> {
  const key = header.key, sealed = header.manifest, identity = sealed.identity;
  return new Uint8Array(encoder.encode(JSON.stringify([header.version, header.deployment, header.run,
    key.version, key.algorithm, key.keyId, key.wrappedKey, sealed.version,
    identity.deployment, identity.run, identity.component, identity.ordinal,
    sealed.nonce, sealed.ciphertext, sealed.sha256, sealed.bytes])));
}
function head(value: unknown, deployment: string, run: string): RecoveryHead {
  const item = record(value), key = record(item.key);
  if (item.version !== 1 || item.deployment !== deployment || item.run !== run || typeof item.signature !== "string" || key.version !== 1 ||
      key.algorithm !== "RSA-OAEP-256/A256GCM" || typeof key.keyId !== "string" || typeof key.wrappedKey !== "string") {
    throw new Error("Recovery head does not match this snapshot.");
  }
  return { version: 1, deployment, run, key: { version: 1, algorithm: key.algorithm,
    keyId: key.keyId, wrappedKey: key.wrappedKey }, manifest: chunk(item.manifest), signature: item.signature };
}
function manifest(value: unknown, deployment: string, run: string): RecoveryManifest {
  const item = record(value);
  if (item.version !== 1 || item.deployment !== deployment || item.run !== run || typeof item.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(item.capturedAt)) || !Array.isArray(item.components) || item.components.length > 256) {
    throw new Error("Invalid recovery manifest.");
  }
  let count = 0;
  const components = item.components.map(componentValue => {
    const component = record(componentValue);
    if (typeof component.id !== "string" || typeof component.version !== "number" || !Array.isArray(component.chunks)) {
      throw new Error("Invalid recovery component inventory.");
    }
    const id = segment(component.id);
    const listed = component.chunks.map((chunkValue, ordinal) => {
      const entry = record(chunkValue);
      if (++count > MAX_CHUNKS || entry.key !== `${prefix(deployment, run)}${id}/${ordinal}.json` ||
          typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.bytes !== "number" ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > RECOVERY_CHUNK_BYTES) {
        throw new Error("Invalid recovery object reference.");
      }
      return { key: entry.key, sha256: entry.sha256, bytes: entry.bytes };
    });
    return { id, version: component.version, chunks: listed };
  });
  validateInventory(components, components.map(component => component.id));
  return { version: 1, deployment, run, capturedAt: item.capturedAt, components };
}

/**
 * Archive every required component from a caller-held coherent snapshot. Publishes the head last;
 * a failed export leaves no completed snapshot. The caller must fence concurrent use of a run ID.
 */
export async function writeRecoverySnapshot(options: {
  bucket: R2Bucket; deployment: string; run: string; publicKey: JsonWebKey; authenticationKey: CryptoKey;
  required: string[]; sources: RecoverySource[]; capturedAt: string;
  /** Revalidate source fences after all bytes are saved, before publishing the completed head. */
  beforePublish?: () => Promise<void>;
}): Promise<RecoveryManifest> {
  const { bucket, deployment, run } = options;
  validateAuthenticationKey(options.authenticationKey, "sign");
  const root = prefix(deployment, run);
  validateInventory(options.sources, options.required);
  if (!Number.isFinite(Date.parse(options.capturedAt))) throw new Error("Invalid snapshot timestamp.");
  if (await bucket.head(`${root}head.json`)) throw new Error("Recovery snapshot already exists.");
  const { key, envelope } = await createRecoveryKey(options.publicKey);
  const result: RecoveryManifest = { version: 1, deployment, run, capturedAt: options.capturedAt, components: [] };
  const objects: Array<{ key: string; digest: string }> = [];
  let count = 0;
  for (const source of options.sources) {
    const component: RecoveryComponentManifest = { id: source.id, version: source.version, chunks: [] };
    for await (const bytes of chunks(await source.export())) {
      if (++count > MAX_CHUNKS) throw new Error("Recovery snapshot exceeds the object limit.");
      const ordinal = component.chunks.length;
      const sealed = await sealRecoveryChunk(key, { deployment, run, component: source.id, ordinal }, bytes);
      const objectKey = `${root}${source.id}/${ordinal}.json`;
      const encoded = JSON.stringify(sealed);
      // Immutable writes make a retried/conflicting run fail rather than corrupt its existing chunks.
      if (!await bucket.put(objectKey, encoded, { onlyIf: { etagDoesNotMatch: "*" } })) {
        throw new Error("Recovery object already exists; use a fresh run ID.");
      }
      objects.push({ key: objectKey, digest: await recoveryDigest(encoder.encode(encoded)) });
      const reread = chunk(await readJson(bucket, objectKey));
      await openRecoveryChunk(key, sealed.identity, reread);
      component.chunks.push({ key: objectKey, sha256: sealed.sha256, bytes: bytes.length });
    }
    result.components.push(component);
  }
  const encoded = encoder.encode(JSON.stringify(result));
  if (encoded.length > RECOVERY_CHUNK_BYTES) throw new Error("Recovery manifest exceeds the size limit.");
  const sealedManifest = await sealRecoveryChunk(key, { deployment, run, component: "manifest", ordinal: 0 }, encoded);
  const unsigned = { version: 1 as const, deployment, run, key: envelope, manifest: sealedManifest };
  const signature = recoveryBase64(new Uint8Array(await crypto.subtle.sign(
      "HMAC", options.authenticationKey, signedHeadBytes(unsigned))));
  const header: RecoveryHead = { ...unsigned, signature };
  const encodedHead = JSON.stringify(header);
  objects.push({ key: `${root}head.json`, digest: await recoveryDigest(encoder.encode(encodedHead)) });
  // Authenticate expected ciphertext, not a later untrusted listing. Scheduled integrity checks
  // need no private recovery key and cannot silently accept a substituted encrypted object.
  const payload = JSON.stringify({ version: 1, deployment, run, objects,
    components: result.components.map(c => ({ id: c.id, version: c.version })),
    bytes: result.components.reduce((total, c) => total + c.chunks.reduce((n, chunk) => n + chunk.bytes, 0), 0) });
  const receiptSignature = recoveryBase64(new Uint8Array(await crypto.subtle.sign(
    "HMAC", options.authenticationKey, encoder.encode(payload))));
  await options.beforePublish?.();
  if (!await bucket.put(`${root}receipt.json`, JSON.stringify({ payload, signature: receiptSignature }),
    { onlyIf: { etagDoesNotMatch: "*" } })) throw new Error("Recovery receipt already exists.");
  if (!await bucket.put(`${root}head.json`, encodedHead, { onlyIf: { etagDoesNotMatch: "*" } })) {
    throw new Error("Recovery snapshot already exists.");
  }
  return result;
}

/**
 * Verify all chunks before staging any component in an isolated target. This never activates a
 * deployment; cutover is a separate operation after application-level verification.
 */
export async function stageRecoverySnapshot(options: {
  bucket: R2Bucket; deployment: string; run: string; privateKey: JsonWebKey; authenticationKey: CryptoKey;
  required: string[]; targets: RecoveryTarget[];
}): Promise<RecoveryManifest> {
  const { bucket, deployment, run } = options;
  validateAuthenticationKey(options.authenticationKey, "verify");
  const targets = validateInventory(options.targets, options.required);
  const header = head(await readJson(bucket, `${prefix(deployment, run)}head.json`), deployment, run);
  if (!await crypto.subtle.verify("HMAC", options.authenticationKey,
      recoveryBytes(header.signature, 32), signedHeadBytes(header))) {
    throw new Error("Recovery snapshot authentication failed.");
  }
  const key = await openRecoveryKey(header.key, options.privateKey);
  const decoded = await openRecoveryChunk(key, { deployment, run, component: "manifest", ordinal: 0 }, header.manifest);
  const inventory = manifest(JSON.parse(new TextDecoder().decode(decoded)), deployment, run);
  validateInventory(inventory.components, options.required);
  const read = async (component: RecoveryComponentManifest, ordinal: number): Promise<Uint8Array> => {
    const entry = component.chunks[ordinal];
    const bytes = await openRecoveryChunk(key, { deployment, run, component: component.id, ordinal },
        chunk(await readJson(bucket, entry.key)));
    if (bytes.length !== entry.bytes || await recoveryDigest(bytes) !== entry.sha256) throw new Error("Recovery inventory checksum mismatch.");
    return bytes;
  };
  for (const component of inventory.components) {
    if (targets.get(component.id)?.version !== component.version) throw new Error("Unsupported component recovery version.");
    for (let ordinal = 0; ordinal < component.chunks.length; ordinal++) await read(component, ordinal);
  }
  for (const component of inventory.components) {
    let ordinal = 0;
    let consumed = false;
    await targets.get(component.id)!.stage(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ordinal === component.chunks.length) { consumed = true; controller.close(); return; }
        controller.enqueue(await read(component, ordinal++));
      },
    }));
    if (!consumed) throw new Error("Recovery target did not consume its complete archive.");
  }
  return inventory;
}

/** Authenticate every encrypted object against the write-time receipt without decrypting it. */
export async function verifyRecoverySnapshot(options: {
  bucket: R2Bucket; deployment: string; run: string; authenticationKey: CryptoKey;
}): Promise<{ components: Array<{ id: string; version: number }>; bytes: number }> {
  const { bucket, deployment, run, authenticationKey } = options;
  validateAuthenticationKey(authenticationKey, "verify");
  const root = prefix(deployment, run);
  const receipt = record(await readJson(bucket, `${root}receipt.json`));
  if (typeof receipt.payload !== "string" || typeof receipt.signature !== "string" ||
      !await crypto.subtle.verify("HMAC", authenticationKey, recoveryBytes(receipt.signature, 32),
        encoder.encode(receipt.payload))) throw new Error("Recovery receipt authentication failed.");
  const payload = record(JSON.parse(receipt.payload));
  if (payload.version !== 1 || payload.deployment !== deployment || payload.run !== run ||
      !Array.isArray(payload.objects) || payload.objects.length > MAX_CHUNKS + 1 ||
      !Array.isArray(payload.components) || typeof payload.bytes !== "number" ||
      !Number.isSafeInteger(payload.bytes) || payload.bytes < 0) throw new Error("Invalid recovery receipt.");
  const components = payload.components.map(value => {
    const item = record(value);
    if (typeof item.id !== "string" || typeof item.version !== "number") throw new Error("Invalid recovery receipt component.");
    return { id: item.id, version: item.version };
  });
  validateInventory(components, components.map(c => c.id));
  const seen = new Set<string>();
  for (const value of payload.objects) {
    const item = record(value);
    if (typeof item.key !== "string" || !item.key.startsWith(root) || seen.has(item.key) ||
        typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest)) throw new Error("Invalid recovery receipt object.");
    seen.add(item.key);
    const object = await bucket.get(item.key);
    if (!object || object.size > MAX_METADATA ||
        await recoveryDigest(new Uint8Array(await object.arrayBuffer())) !== item.digest) {
      throw new Error("Recovery archive integrity check failed.");
    }
  }
  if (!seen.has(`${root}head.json`)) throw new Error("Recovery archive is not complete.");
  return { components, bytes: payload.bytes };
}

/** Remove only the named archive after a newer archive has been verified by the coordinator. */
export async function deleteRecoverySnapshot(bucket: R2Bucket, deployment: string, run: string): Promise<void> {
  const root = prefix(deployment, run);
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: root, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
