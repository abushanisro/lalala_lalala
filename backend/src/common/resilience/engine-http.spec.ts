import { AxiosError, type AxiosResponse } from 'axios';

import { retryOnRateLimit } from './engine-http';

const rateLimited = (headers: Record<string, string> = {}) =>
  new AxiosError('Too many requests', 'ERR_BAD_REQUEST', undefined, undefined, { status: 429, headers } as unknown as AxiosResponse);

describe('retryOnRateLimit', () => {
  const noWait = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
  beforeEach(() => noWait.mockClear());

  it('returns the first answer without waiting', async () => {
    await expect(retryOnRateLimit(() => Promise.resolve('ok'), [10], noWait)).resolves.toBe('ok');
    expect(noWait).not.toHaveBeenCalled();
  });

  it('waits and tries again after a 429, using the configured delays in order', async () => {
    const attempt = jest.fn().mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(rateLimited()).mockResolvedValue('ok');
    await expect(retryOnRateLimit(attempt, [10, 20, 30], noWait)).resolves.toBe('ok');
    expect(noWait.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });

  it("prefers the engine's Retry-After, capped", async () => {
    const attempt = jest.fn().mockRejectedValueOnce(rateLimited({ 'retry-after': '7' })).mockRejectedValueOnce(rateLimited({ 'retry-after': '600' })).mockResolvedValue('ok');
    await retryOnRateLimit(attempt, [1, 1, 1], noWait);
    expect(noWait.mock.calls.map(([ms]) => ms)).toEqual([7_000, 60_000]);
  });

  it('gives up with the 429 once the delays are used', async () => {
    const attempt = jest.fn().mockRejectedValue(rateLimited());
    await expect(retryOnRateLimit(attempt, [1, 1], noWait)).rejects.toMatchObject({ response: { status: 429 } });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other failure', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(retryOnRateLimit(attempt, [1], noWait)).rejects.toThrow('boom');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
