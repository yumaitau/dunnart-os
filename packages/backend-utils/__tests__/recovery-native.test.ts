import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { NativeRecoveryFixture } from './recovery-native-worker';

const namespace = (env as typeof env & { NATIVE_RECOVERY_TEST: DurableObjectNamespace<NativeRecoveryFixture> }).NATIVE_RECOVERY_TEST;
const fixture = () => namespace.get(namespace.newUniqueId());

describe('native Durable Object recovery', () => {
  it('restores all KV pages, SQL schema, int64, rowids, blobs and sequences with alarms paused', async () => {
    const source = fixture(); const target = fixture();
    await source.seed();
    const snapshot = await source.capture();
    expect(JSON.parse(snapshot).alarm).toBeGreaterThan(Date.now());
    expect(await target.restore(snapshot)).toBeNull();
    const state = await target.inspect();
    expect(state.count).toBe(1004); expect(state.last).toBe(1002); expect(state.cyclic).toBe(true);
    expect(state.bytes).toEqual(new Uint8Array([0, 255, 3])); expect(state.bigint).toBe(999999999999999999n);
    expect(state.alarm).toBeNull(); expect(state.row.rowid).toBe(77); expect(state.row.big).toBe('9223372036854775807');
    expect(state.row.computed).toBe('9223372036854775807'); expect(new Uint8Array(state.row.bytes as ArrayBuffer)).toEqual(new Uint8Array([0,128,255]));
    expect(state.labels).toEqual([{ tag: 'étiquette', value: 'preserved' }]);
    expect(state.sequence.seq).toBe(50); expect(state.audit).toEqual([]);
    expect(await target.insertParent()).toEqual({ id: 51 });
    expect((await target.inspect()).audit).toEqual([{ value: 'next' }]);
  });

  it.each(['kv','sql','alarm'])('rejects occupied %s targets', async kind => {
    const source = fixture(); const target = fixture();
    await target.occupied(kind);
    expect(await target.restore(await source.capture())).toContain(kind === 'alarm' ? 'active alarm' : 'empty');
  });

  it.each(['missing','sql','kv'])('rejects %s corruption without partially importing state', async kind => {
    const source = fixture(); const target = fixture(); await source.seed();
    const damaged = await source.corruption(await source.capture(), kind);
    expect(await target.restore(damaged)).toBeTypeOf("string");
    expect(await target.empty()).toEqual({ kv: 0, sql: [] });
  });

  it('stores and rebinds genuine native DurableObjectClass capabilities through trusted asynchronous capability hooks', async () => {
    const source = fixture(); const target = fixture();
    const snapshot = await source.capabilities() as string;
    expect(await source.unrecognized()).toContain('unrecognized capability');
    const state = await target.capabilities(snapshot) as { result: string };
    expect(state.result).toBe('native-rpc-ok');
  });
});
