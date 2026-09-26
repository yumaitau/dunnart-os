import { decodePortableValue, encodePortableValue } from "./recovery-value";

/** Capability provenance attestation generated only by trusted deployment workers. */
export interface SignedRecoveryCapability { payload: string; signature: string }

async function keyFor(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    throw new Error("Deployment capability recovery key is not configured.");
  }
  const bytes = Uint8Array.from(atob(secret), character => character.charCodeAt(0));
  if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== secret) {
    throw new Error("Deployment capability recovery key is not configured.");
  }
  return await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Authenticate JSON descriptor data before it crosses untrusted application capabilities. */
export async function sealCapabilityDescriptor(secret: string | undefined, descriptor: unknown): Promise<SignedRecoveryCapability> {
  const payload = JSON.stringify(await encodePortableValue(descriptor));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(secret), new TextEncoder().encode(payload)));
  return { payload, signature: Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("") };
}

/** Reject forged descriptors before a recovery adapter resolves any account or object identity. */
export async function verifyCapabilityDescriptor(secret: string | undefined, signed: SignedRecoveryCapability): Promise<unknown> {
  if (!signed || typeof signed.payload !== "string" || signed.payload.length > 16 * 1024 * 1024 ||
      typeof signed.signature !== "string" || !/^[a-f0-9]{64}$/.test(signed.signature)) {
    throw new Error("Invalid signed recovery capability descriptor.");
  }
  const signature = Uint8Array.from(signed.signature.match(/../g)!, part => parseInt(part, 16));
  if (!await crypto.subtle.verify("HMAC", await keyFor(secret), signature, new TextEncoder().encode(signed.payload))) {
    throw new Error("Recovery capability descriptor authentication failed.");
  }
  return await decodePortableValue(JSON.parse(signed.payload));
}
