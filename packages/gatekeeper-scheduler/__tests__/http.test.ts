import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('returns an HTTP 404 for the branded router fallback without affecting RPC entrypoints', async () => {
  const response = await SELF.fetch('https://example.com/gatekeeper/scheduler/missing');
  expect(response.status).toBe(404);
  expect(await response.text()).toBe('Not found');
});
