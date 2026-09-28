import { expect, it } from 'vitest';
import worker from '../src/index';

it('keeps root health available and rejects unknown HTTP routes for the branded router fallback', async () => {
  expect((await worker.fetch(new Request('https://example.com/'))).status).toBe(200);
  for (const path of ['/missing', '/gatekeeper/context/missing']) {
    expect((await worker.fetch(new Request('https://example.com' + path))).status).toBe(404);
  }
});
