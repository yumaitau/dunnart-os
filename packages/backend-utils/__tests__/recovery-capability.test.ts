import { describe, expect, it } from "vitest";
import { sealCapabilityDescriptor, verifyCapabilityDescriptor } from "../src/recovery-capability";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));

describe("recovery capability provenance", () => {
  it("authenticates and preserves complete structured descriptor props", async () => {
    const value = { kind: "fixture", props: { optional: undefined, date: new Date(123), bytes: new Uint8Array([0,255]) } };
    expect(await verifyCapabilityDescriptor(key, await sealCapabilityDescriptor(key, value))).toEqual(value);
  });

  it("rejects forged identities and wrong deployment keys", async () => {
    const signed = await sealCapabilityDescriptor(key, { kind: "account", accountId: "owned" });
    await expect(verifyCapabilityDescriptor(key, { ...signed, payload: signed.payload.replace("owned", "foreign") })).rejects.toThrow("authentication");
    await expect(verifyCapabilityDescriptor(btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), signed)).rejects.toThrow("authentication");
  });

  it("requires canonical base64 256-bit keys and rejects unserializable descriptors", async () => {
    await expect(sealCapabilityDescriptor(undefined, {})).rejects.toThrow("not configured");
    await expect(sealCapabilityDescriptor("a".repeat(64), {})).rejects.toThrow("not configured");
    await expect(sealCapabilityDescriptor(key, { callback() {} })).rejects.toThrow("unsupported function");
  });
});
