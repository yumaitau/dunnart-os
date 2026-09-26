/** Maximum plaintext in one independently authenticated recovery chunk. */
export const RECOVERY_CHUNK_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The immutable identity authenticated with every encrypted chunk. */
export interface RecoveryChunkIdentity {
  deployment: string;
  run: string;
  component: string;
  ordinal: number;
}

/** An encrypted recovery chunk, safe to store in an untrusted object store. */
export interface RecoveryChunk {
  version: 1;
  identity: RecoveryChunkIdentity;
  nonce: string;
  ciphertext: string;
  sha256: string;
  bytes: number;
}

/** A per-run data key wrapped with the operator's public recovery key. */
export interface RecoveryKeyEnvelope {
  version: 1;
  algorithm: "RSA-OAEP-256/A256GCM";
  keyId: string;
  wrappedKey: string;
}

/** Encode binary data without placing key material in logs or URLs. */
export function recoveryBase64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result);
}

/** Decode bounded base64 input, rejecting non-canonical encodings. */
export function recoveryBytes(value: string, maxBytes = RECOVERY_CHUNK_BYTES + 16): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 ||
      value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error("Invalid recovery data encoding.");
  }
  const padding = value.indexOf("=");
  if (padding !== -1 && value.slice(padding) !== "=" && value.slice(padding) !== "==") {
    throw new Error("Invalid recovery data encoding.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==") && (alphabet.indexOf(value[value.length - 3]) & 15) !== 0 ||
      value.endsWith("=") && !value.endsWith("==") && (alphabet.indexOf(value[value.length - 2]) & 3) !== 0) {
    throw new Error("Invalid recovery data encoding.");
  }
  const decoded = atob(value);
  if (decoded.length > maxBytes) throw new Error("Invalid recovery data encoding.");
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

function additionalData(identity: RecoveryChunkIdentity): Uint8Array<ArrayBuffer> {
  for (const value of [identity.deployment, identity.run, identity.component]) {
    if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid recovery identity.");
  }
  if (!Number.isSafeInteger(identity.ordinal) || identity.ordinal < 0) throw new Error("Invalid recovery ordinal.");
  return new Uint8Array(encoder.encode(JSON.stringify([1, identity.deployment, identity.run, identity.component, identity.ordinal])));
}

/** SHA-256 digest for archive integrity records. */
export async function recoveryDigest(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Create a data key using only a public recovery key; scheduled backups need no private key. */
export async function createRecoveryKey(publicKey: JsonWebKey): Promise<{
  key: CryptoKey;
  envelope: RecoveryKeyEnvelope;
}> {
  if (publicKey.kty !== "RSA" || !publicKey.n || !publicKey.e || publicKey.d) {
    throw new Error("An RSA public recovery key is required.");
  }
  const wrapping = await crypto.subtle.importKey("jwk", publicKey,
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
  if (!("modulusLength" in wrapping.algorithm) || typeof wrapping.algorithm.modulusLength !== "number" ||
      wrapping.algorithm.modulusLength < 3072) {
    throw new Error("The recovery key must be at least 3072 bits.");
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  if ("publicKey" in key) throw new Error("Expected a symmetric recovery key.");
  const wrappedKey = new Uint8Array(await crypto.subtle.wrapKey("raw", key, wrapping, "RSA-OAEP"));
  const keyId = await recoveryDigest(encoder.encode(JSON.stringify([publicKey.kty, publicKey.n, publicKey.e])));
  return { key, envelope: { version: 1, algorithm: "RSA-OAEP-256/A256GCM", keyId,
    wrappedKey: recoveryBase64(wrappedKey) } };
}

/** Open a per-run key with operator-held private recovery material. */
export async function openRecoveryKey(envelope: RecoveryKeyEnvelope, privateKey: JsonWebKey): Promise<CryptoKey> {
  if (envelope.version !== 1 || envelope.algorithm !== "RSA-OAEP-256/A256GCM") {
    throw new Error("Unsupported recovery encryption version.");
  }
  const keyId = await recoveryDigest(encoder.encode(JSON.stringify([privateKey.kty, privateKey.n, privateKey.e])));
  if (keyId !== envelope.keyId) throw new Error("This recovery key does not match the archive.");
  const unwrapping = await crypto.subtle.importKey("jwk", privateKey,
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"]);
  return crypto.subtle.unwrapKey("raw", recoveryBytes(envelope.wrappedKey, 1024), unwrapping,
      "RSA-OAEP", { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

/** Encrypt one bounded archive chunk and authenticate its exact deployment/run/component position. */
export async function sealRecoveryChunk(key: CryptoKey, identity: RecoveryChunkIdentity,
    plaintext: Uint8Array): Promise<RecoveryChunk> {
  if (plaintext.byteLength > RECOVERY_CHUNK_BYTES) throw new Error("Recovery chunk exceeds the size limit.");
  const aad = additionalData(identity);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad }, key, new Uint8Array(plaintext)));
  return { version: 1, identity: { ...identity }, nonce: recoveryBase64(nonce),
    ciphertext: recoveryBase64(ciphertext), sha256: await recoveryDigest(plaintext), bytes: plaintext.byteLength };
}

/** Authenticate and decrypt a chunk only at its expected position in a verified archive. */
export async function openRecoveryChunk(key: CryptoKey, expected: RecoveryChunkIdentity,
    chunk: RecoveryChunk): Promise<Uint8Array> {
  if (chunk.version !== 1 || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 ||
      chunk.bytes > RECOVERY_CHUNK_BYTES || !/^[a-f0-9]{64}$/.test(chunk.sha256)) {
    throw new Error("Invalid recovery chunk metadata.");
  }
  const aad = additionalData(expected);
  if (decoder.decode(aad) !== decoder.decode(additionalData(chunk.identity))) {
    throw new Error("Recovery chunk belongs to another archive position.");
  }
  const nonce = recoveryBytes(chunk.nonce, 12);
  if (nonce.length !== 12) throw new Error("Invalid recovery nonce.");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad }, key, recoveryBytes(chunk.ciphertext)));
  if (plaintext.byteLength !== chunk.bytes || await recoveryDigest(plaintext) !== chunk.sha256) {
    throw new Error("Recovery chunk integrity check failed.");
  }
  return plaintext;
}
