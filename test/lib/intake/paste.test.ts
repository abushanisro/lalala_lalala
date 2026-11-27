import { describe, expect, it } from 'vitest';

import { pastedName, pastedNames, pasteIsOfFiles } from '@/lib/intake/paste';

describe('a paste into the prompt', () => {
  it('is of files when the clipboard holds a picture and no text (a copied image)', () => {
    expect(pasteIsOfFiles(['image.png'], '')).toBe(true);
    expect(pasteIsOfFiles(['image.png'], '  \n')).toBe(true);
  });

  it('is of files when the text is only the files\' own names or paths (a file copied in a file manager)', () => {
    expect(pasteIsOfFiles(['bracket.pdf'], 'bracket.pdf')).toBe(true);
    expect(pasteIsOfFiles(['bracket.pdf', 'housing.step'], '/Users/a/Drawings/bracket.pdf\n/Users/a/Drawings/housing.step')).toBe(true);
    expect(pasteIsOfFiles(['bracket.pdf'], 'C:\\Drawings\\bracket.pdf')).toBe(true);
  });

  it('is of text when the clipboard has words of its own with a picture of them (a copied table cell)', () => {
    expect(pasteIsOfFiles(['image.png'], 'Brackets for the pump frame')).toBe(false);
    expect(pasteIsOfFiles(['image.png'], '120\t60\t12')).toBe(false);
  });

  it('is not of files when there are none', () => {
    expect(pasteIsOfFiles([], '')).toBe(false);
    expect(pasteIsOfFiles([], 'brackets')).toBe(false);
  });

  it('names a copied picture "Pasted image N", by what kind of picture it is', () => {
    expect(pastedName('image.png', 'image/png', [])).toBe('Pasted image 1.png');
    expect(pastedName('image.png', 'image/jpeg', [])).toBe('Pasted image 1.jpg');
    expect(pastedName('', 'image/webp', [])).toBe('Pasted image 1.webp');
    expect(pastedName('image.png', 'image/png', ['Pasted image 1.png', 'Pasted image 2.png'])).toBe('Pasted image 3.png');
    // Numbered apart whatever the kind of picture.
    expect(pastedName('image.png', 'image/jpeg', ['Pasted image 1.png'])).toBe('Pasted image 2.jpg');
  });

  it('keeps a pasted file\'s own name, and numbers it only when that name is already there', () => {
    expect(pastedName('bracket rev B.pdf', 'application/pdf', [])).toBe('bracket rev B.pdf');
    expect(pastedName('bracket.pdf', 'application/pdf', ['bracket.pdf'])).toBe('bracket 1.pdf');
    expect(pastedName('housing.step', '', ['housing.step', 'housing 1.step'])).toBe('housing 2.step');
  });

  it('names several pasted at once apart from each other and from the files already there', () => {
    expect(pastedNames([{ name: 'image.png', type: 'image/png' }, { name: 'image.png', type: 'image/png' }, { name: 'plate.pdf', type: 'application/pdf' }], ['Pasted image 1.png']))
      .toEqual(['Pasted image 2.png', 'Pasted image 3.png', 'plate.pdf']);
  });
});
