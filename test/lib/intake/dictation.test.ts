import { describe, expect, it } from 'vitest';

import { dictationProblem, transcriptOf, withDictation, type HeardResults } from '@/lib/intake/dictation';

const results = (...heard: [string, boolean][]): HeardResults => heard.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));

describe('dictation into the prompt', () => {
  it('reads everything heard so far, settled and still firming up, as one line', () => {
    expect(transcriptOf(results(['brackets for ', true], [' the pump', true], [' fra', false]))).toBe('brackets for the pump fra');
    expect(transcriptOf(results())).toBe('');
  });

  it('adds what was heard after what the prompt already said, with one space', () => {
    expect(withDictation('', 'brackets for the pump frame')).toBe('brackets for the pump frame');
    expect(withDictation('Urgent:', ' brackets ')).toBe('Urgent: brackets');
    expect(withDictation('Urgent:  \n', 'brackets')).toBe('Urgent: brackets');
  });

  it('leaves the prompt as it was while nothing has been heard', () => {
    expect(withDictation('Urgent: ', '')).toBe('Urgent: ');
    expect(withDictation('', '   ')).toBe('');
  });

  it('says why it stopped in plain words, and says nothing when the person stopped it', () => {
    expect(dictationProblem('aborted')).toBeNull();
    expect(dictationProblem('not-allowed')).toContain('microphone is blocked');
    expect(dictationProblem('service-not-allowed')).toBe(dictationProblem('not-allowed'));
    expect(dictationProblem('audio-capture')).toBe('No microphone was found.');
    expect(dictationProblem('no-speech')).toContain('Nothing was heard');
    expect(dictationProblem('network')).toContain('could not be reached');
    expect(dictationProblem('something-new')).toBe('Dictation stopped (something-new). Type instead, or try again.');
  });
});
