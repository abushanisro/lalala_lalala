// How a part of the app that has just spent AI tells the usage display to read the figures again, without either knowing the other.

const AI_USAGE_EVENT = "emithran:ai-usage";

/** Call after an AI call has finished (or one step of it): the usage on show is read again at once, not at its next poll. */
export function notifyAiUsage(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_USAGE_EVENT));
}

/** Runs `listener` each time AI was spent somewhere in this window; returns the function that stops it. */
export function onAiUsage(listener: () => void): () => void {
  window.addEventListener(AI_USAGE_EVENT, listener);
  return () => { window.removeEventListener(AI_USAGE_EVENT, listener); };
}

/** `call` spends AI: the usage display is told once it has finished, whether it succeeded or not (a failed call can still have spent). */
export function spendingAi<T>(call: Promise<T>): Promise<T> {
  return call.finally(notifyAiUsage);
}

