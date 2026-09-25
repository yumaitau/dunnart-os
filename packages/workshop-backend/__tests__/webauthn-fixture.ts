// A software authenticator for exercising real WebAuthn verification without registering a device.
const encoder = new TextEncoder();
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const b64 = (bytes: Uint8Array) => bytes.toBase64({ alphabet: "base64url", omitPadding: true });
const head = (major: number, length: number) => length < 24 ? Uint8Array.of(major * 32 + length)
  : length < 256 ? Uint8Array.of(major * 32 + 24, length) : Uint8Array.of(major * 32 + 25, length >> 8, length & 255);
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
const cbor = (value: Cbor): Uint8Array => {
  if (typeof value === "number") return head(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value);
  if (typeof value === "string") { const data = encoder.encode(value); return join(head(3, data.length), data); }
  if (value instanceof Uint8Array) return join(head(2, value.length), value);
  return join(head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]));
};
const derInteger = (bytes: Uint8Array) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const value = bytes[start] & 128 ? join(Uint8Array.of(0), bytes.subarray(start)) : bytes.subarray(start);
  return join(Uint8Array.of(2, value.length), value);
};

export const makeAuthenticator = async (origin: string) => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const id = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(new URL(origin).hostname)));
  const clientData = (challenge: string, type: string) => encoder.encode(JSON.stringify({ challenge, type, origin, crossOrigin: false }));
  return {
    registration(challenge: string) {
      const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, publicKey.slice(1, 33)], [-3, publicKey.slice(33)]]));
      const authData = join(rpHash, Uint8Array.of(0x45, 0, 0, 0, 0), new Uint8Array(16), Uint8Array.of(0, id.length), id, cose);
      return { id: b64(id), rawId: b64(id), type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: b64(clientData(challenge, "webauthn.create")), transports: ["internal"],
        attestationObject: b64(cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
      } };
    },
    async authentication(challenge: string, verified: boolean) {
      const data = clientData(challenge, "webauthn.get");
      const authData = join(rpHash, Uint8Array.of(verified ? 5 : 1, 0, 0, 0, 1));
      const signed = join(authData, new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
      const sequence = join(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32)));
      return { id: b64(id), rawId: b64(id), type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(join(Uint8Array.of(48, sequence.length), sequence)),
      } };
    },
  };
};
