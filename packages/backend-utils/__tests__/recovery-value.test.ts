import { RpcTarget } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { decodePortableValue, encodePortableValue, type RecoveryValueCodec, type PortableValue } from '../src/recovery-value';

const roundtrip = async (value: unknown, codec?: RecoveryValueCodec) => decodePortableValue(JSON.parse(JSON.stringify(await encodePortableValue(value, codec))), codec);

describe('portable native value codec', () => {
  it('preserves cycles, shared references, collections, sparse arrays and special values', async () => {
    const shared = { label: 'shared' };
    const sparse = new Array(4); sparse[2] = undefined;
    const root = { shared, second: shared, map: new Map<unknown, unknown>(), set: new Set<unknown>(),
      sparse, date: new Date('2026-01-01'), invalidDate: new Date(NaN), nullObject: Object.assign(Object.create(null), { ok: true }),
      values: [undefined, 4n, -9n, NaN, Infinity, -Infinity, -0] };
    root.map.set(root, shared); root.set.add(root);
    const result = await roundtrip(root) as typeof root;
    expect(result.shared).toBe(result.second);
    expect(result.map.get(result)).toBe(result.shared);
    expect(result.set.has(result)).toBe(true);
    expect(result.sparse.length).toBe(4); expect(0 in result.sparse).toBe(false); expect(2 in result.sparse).toBe(true);
    expect(result.values).toEqual(root.values);
    expect(Object.is(result.values[6], -0)).toBe(true);
    expect(result.date).toEqual(root.date); expect(Number.isNaN(result.invalidDate.getTime())).toBe(true);
    expect(Object.getPrototypeOf(result.nullObject)).toBe(null);
  });

  it('preserves typed array offsets and shared backing buffers', async () => {
    const buffer = new ArrayBuffer(32);
    new Uint8Array(buffer).set([0, 1, 254, 255]);
    const value = { buffer, bytes: new Uint8Array(buffer, 2, 8), view: new DataView(buffer, 1, 12), integers: new BigInt64Array(buffer, 8, 2), floats: new Float32Array(buffer, 4, 3) };
    const restored = await roundtrip(value) as typeof value;
    expect(restored.bytes.buffer).toBe(restored.buffer);
    expect(restored.view.buffer).toBe(restored.buffer);
    expect(restored.integers.buffer).toBe(restored.buffer);
    expect(restored.bytes.byteOffset).toBe(2);
    expect(new Uint8Array(restored.buffer)).toEqual(new Uint8Array(buffer));
  });

  it('calls trusted hooks for plain parent records before encoding their capability', async () => {
    class Capability extends RpcTarget { value() { return 42; } }
    const source = new Capability();
    const target = new Capability();
    const registered = new WeakMap<object, string>();
    let restored = 0;
    const codec: RecoveryValueCodec = {
      async describe(value) {
        if ('cap' in value && value.cap === source) registered.set(source, 'cap-1');
        const id = registered.get(value);
        return id ? { id } : undefined;
      },
      async restore(value) { expect(value).toEqual({ id: 'cap-1' }); restored++; return target; },
    };
    const value = await roundtrip({ cap: source, duplicate: source }, codec) as { cap: Capability; duplicate: Capability };
    expect(value.cap).toBe(target); expect(value.cap).toBe(value.duplicate); expect(value.cap.value()).toBe(42); expect(restored).toBe(1);
  });

  it('lets trusted hooks recognize callable capabilities while preserving their aliases', async () => {
    const source = () => 'source';
    const target = () => 'destination';
    const recognizedPaths: string[] = [];
    let restores = 0;
    const codec: RecoveryValueCodec = {
      async describe(value, path) {
        if (value !== source) return undefined;
        recognizedPaths.push(path);
        return { type: 'callback', id: 'trusted' };
      },
      async restore(value) {
        expect(value).toEqual({ type: 'callback', id: 'trusted' });
        restores++;
        return target;
      },
    };
    const result = await roundtrip({ nested: { callback: source }, duplicate: source }, codec) as {
      nested: { callback: typeof target }; duplicate: typeof target;
    };
    expect(recognizedPaths).toEqual(['$["nested"]["callback"]']);
    expect(restores).toBe(1);
    expect(result.nested.callback).toBe(target);
    expect(result.duplicate).toBe(result.nested.callback);
    expect(result.duplicate()).toBe('destination');
    await expect(encodePortableValue({ callback: () => 'unrecognized' }, codec))
      .rejects.toThrow('Recovery value at $["callback"]: unsupported function');
  });

  it('rejects unrecognized capabilities and unsupported values with their exact paths', async () => {
    class Capability extends RpcTarget {}
    await expect(encodePortableValue({ nested: { cap: new Capability() } })).rejects.toThrow('$["nested"]["cap"]');
    await expect(encodePortableValue({ callback: () => {} })).rejects.toThrow('$["callback"]');
    await expect(encodePortableValue({ regex: /x/ })).rejects.toThrow('$["regex"]');
    await expect(encodePortableValue({ get secret() { throw new Error('must not execute'); } })).rejects.toThrow('unsupported property secret');
    await expect(encodePortableValue(Object.assign(new Date(), { lost: true }))).rejects.toThrow('extended Date');
  });

  it('refuses malformed references and capabilities without restore authority', async () => {
    await expect(decodePortableValue({ version: 1, root: { ref: 3 }, nodes: [] })).rejects.toThrow('invalid atom');
    const encoded = await encodePortableValue({}, { describe: () => ({ id: 'cap' }), restore: () => ({}) });
    await expect(decodePortableValue(encoded)).rejects.toThrow('trusted restore adapter');
    const malformed = { version: 1, root: { ref: 0 }, nodes: [{ kind: 'view', type: 'DataView', buffer: { ref: 0 }, offset: 0, length: 0 }] } as PortableValue;
    await expect(decodePortableValue(malformed)).rejects.toThrow('cyclic scalar');
  });

  it('preserves own __proto__ data without altering object prototype', async () => {
    const restored = await roundtrip(JSON.parse('{"__proto__":{"polluted":true}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, '__proto__')).toBe(true);
    expect(restored.polluted).toBeUndefined();
  });
});
