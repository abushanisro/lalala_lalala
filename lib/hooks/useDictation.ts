import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { dictationProblem, transcriptOf, type HeardResults } from '@/lib/intake/dictation';

/** The browser's speech recognition, as far as dictation uses it (it is not in TypeScript's DOM types, and Chrome and Safari prefix it). */
interface Recognizer {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: HeardResults }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
}
type RecognizerClass = new () => Recognizer;
function recognizerClass(): RecognizerClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
const never = () => () => undefined;

/**
 * Dictation into a text box with the browser's own speech recognition, where it has one (`available`; the browser decides where the
 * audio is recognised). While it listens, everything heard so far is handed to `onHeard` each time it firms up. It stops on `stop`, when
 * the browser ends it, or on a failure, which `problem` says in plain words. `cancel` stops it and drops what was not handed over yet,
 * for a box that is emptied the moment its text is sent.
 */
export function useDictation(onHeard: (heard: string) => void) {
  // Known only in the browser: the server renders the box without the microphone, and the page adds it once it runs.
  const available = useSyncExternalStore(never, () => recognizerClass() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recognizer = useRef<Recognizer | null>(null);
  useEffect(() => () => { recognizer.current?.abort(); }, []);
  const stop = useCallback(() => { recognizer.current?.stop(); }, []);
  const cancel = useCallback(() => {
    const r = recognizer.current;
    if (!r) return;
    r.onresult = null;
    r.abort();
  }, []);
  const start = useCallback(() => {
    const Recognition = recognizerClass();
    if (!Recognition || recognizer.current) return;
    const r = new Recognition();
    r.lang = navigator.language;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => { onHeard(transcriptOf(event.results)); };
    r.onerror = (event) => { setProblem(dictationProblem(event.error)); };
    r.onend = () => { recognizer.current = null; setListening(false); };
    recognizer.current = r;
    setProblem(null);
    setListening(true);
    try { r.start(); } catch { recognizer.current = null; setListening(false); setProblem(dictationProblem('audio-capture')); }
  }, [onHeard]);
  return { available, listening, problem, start, stop, cancel };
}
