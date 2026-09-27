import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UserDurableObject } from '../src/user';

const bindings = env as typeof env & { TEST_USER: DurableObjectNamespace<UserDurableObject> };

describe('account timezone', { timeout: 30_000 }, () => {
  it('defaults to Sydney, persists a selection and isolates accounts', async () => {
    const id = crypto.randomUUID();
    const user = bindings.TEST_USER.getByName(id);
    const other = bindings.TEST_USER.getByName(crypto.randomUUID());
    expect(await user.getTimeZone()).toBe('Australia/Sydney');
    await user.setTimeZone('Pacific/Auckland');
    expect(await bindings.TEST_USER.getByName(id).getTimeZone()).toBe('Pacific/Auckland');
    expect(await other.getTimeZone()).toBe('Australia/Sydney');
    await runInDurableObject(user, async (_instance, ctx) => {
      expect([...ctx.storage.kv.list()].some(([, value]) => value === 'Pacific/Auckland')).toBe(true);
    });
    let rejected = false;
    try { await user.setTimeZone('invalid/timezone'); } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(await user.getTimeZone()).toBe('Pacific/Auckland');
  });
});
