// The HTTP client for the Python CAD engine. Its transport runs every request through the process-wide cad-engine
// circuit breaker, so a call site only swaps `axios` for `cadEngineHttp` and keeps its own timeout, headers and error
// handling. A 4xx answer still reaches the caller as before; only an outage (no answer, timeout, 5xx) opens the breaker.
//
// The engine allows a few calls a minute per caller and answers 429 beyond that. The backend is its only caller, so a burst
// (a zip of parts, each converted and analysed) must wait for the window to reopen, not fail: a rate-limited call is retried.
import { setTimeout as sleep } from 'node:timers/promises';

import axios, { isAxiosError, type AxiosAdapter } from 'axios';

import { breakerFor, CAD_ENGINE, isServiceUnavailable } from './circuit-breaker';

const transport: AxiosAdapter = axios.getAdapter(axios.defaults.adapter);

/** The waits before each retry. The engine's limit is a fixed minute and it sends no Retry-After, so together they must outlast it. */
const RETRY_DELAYS_MS = [15_000, 20_000, 30_000];
const MAX_RETRY_AFTER_MS = 60_000;

/** Runs `attempt`, and again after a wait each time the engine answers 429 (its Retry-After when it sends one). Any other failure is the caller's. */
export async function retryOnRateLimit<T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isAxiosError(error) || error.response?.status !== 429 || retry >= delaysMs.length) throw error;
      const retryAfterS = Number(error.response.headers['retry-after']);
      await wait(retryAfterS > 0 ? Math.min(retryAfterS * 1000, MAX_RETRY_AFTER_MS) : delaysMs[retry]);
    }
  }
}

interface MultipartBody {
  getBuffer(): Buffer;
  getHeaders(): Record<string, string>;
}

const isMultipart = (data: unknown): data is MultipartBody =>
  typeof data === 'object' && data !== null && typeof (data as MultipartBody).getBuffer === 'function';

export const cadEngineHttp = axios.create({
  adapter: (config) => {
    const send = () => breakerFor(CAD_ENGINE).exec(() => transport(config), isServiceUnavailable);
    if (!isMultipart(config.data)) return retryOnRateLimit(send);
    // A multipart body is a one-shot stream. As a Buffer (same boundary) it can be sent again; the form's own headers
    // are set first because axios only adds them for a form object. A part that is a stream cannot be buffered: send once.
    try {
      const form = config.data;
      config.headers.set(form.getHeaders());
      config.data = form.getBuffer();
    } catch {
      return send();
    }
    return retryOnRateLimit(send);
  },
});
