// Dictation into the prompt: what the browser's speech recognition hears, as text for the prompt, and its failures in plain words. Pure.

/** A speech recognition result list, as far as dictation reads it: each result's best alternative and whether it is settled. */
export interface HeardResults {
  readonly length: number;
  readonly [index: number]: { readonly isFinal: boolean; readonly 0: { readonly transcript: string } };
}

/** Everything heard so far in one listening session, settled and still firming up, as one line of text. */
export function transcriptOf(results: HeardResults): string {
  // The browser's list is array-like, and not iterable everywhere.
  return Array.from(results, (result) => result[0].transcript).join('').replace(/\s+/g, ' ').trim();
}

/** The prompt with what was heard added after what it already said (`before`), one space between them. */
export function withDictation(before: string, heard: string): string {
  const said = heard.trim();
  if (said === '') return before;
  return before.trim() === '' ? said : `${before.replace(/\s+$/, '')} ${said}`;
}

/**
 * Why dictation stopped, for the person, from the recognition error's code; null when it is not a failure to report (the person
 * stopped it, or it was replaced).
 */
export function dictationProblem(error: string): string | null {
  switch (error) {
    case 'aborted': return null;
    case 'not-allowed':
    case 'service-not-allowed': return "The microphone is blocked for this page. Allow it in the browser's site settings, then try again.";
    case 'audio-capture': return 'No microphone was found.';
    case 'no-speech': return 'Nothing was heard. Press the microphone and speak.';
    case 'network': return 'Speech recognition could not be reached. Check the connection, or type instead.';
    case 'language-not-supported': return "The browser's speech recognition does not take this language. Type instead.";
    default: return `Dictation stopped (${error}). Type instead, or try again.`;
  }
}
