// Files pasted into the prompt from the clipboard (a copied picture, a copied file): whether a paste is of files at all, and what each is
// called beside the files already there. Pure.

const EXTENSION_OF_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
};

/**
 * Whether a paste is the clipboard's files rather than its text. A copied picture or a copied file is; so is a file copied in a file
 * manager, which also puts the file's name on the clipboard as text. A copied table cell or paragraph that comes with a picture of
 * itself is not: its text is what the person means to paste.
 */
export function pasteIsOfFiles(fileNames: readonly string[], plainText: string): boolean {
  if (fileNames.length === 0) return false;
  const text = plainText.trim();
  if (text === '') return true;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // A file manager writes each file's name, or its whole path.
  return lines.length === fileNames.length && lines.every((line, i) => { const name = fileNames[i] ?? ''; return line === name || line.endsWith(`/${name}`) || line.endsWith(`\\${name}`); });
}

/**
 * What a pasted file is called. A copied picture arrives as "image.png" every time, and the prompt keeps one file of each name, so a
 * file with no name of its own (or one already there) is given the next free "Pasted image N"; a file with its own name keeps it.
 */
export function pastedName(name: string, type: string, taken: readonly string[]): string {
  const own = name.trim();
  const generic = own === '' || /^image\.[a-z0-9]+$/i.test(own);
  if (!generic && !taken.includes(own)) return own;
  const dot = own.lastIndexOf('.');
  const extension = EXTENSION_OF_TYPE[type] ?? (dot > 0 ? own.slice(dot + 1).toLowerCase() : '');
  const stem = generic ? 'Pasted image' : own.slice(0, dot > 0 ? dot : own.length);
  // Numbered apart whatever the kind: "Pasted image 1.png" and "Pasted image 1.jpg" would read as one file.
  const stems = new Set(taken.map((have) => have.replace(/\.[^.]+$/, '')));
  for (let n = 1; ; n += 1) {
    if (!stems.has(`${stem} ${n}`)) return `${stem} ${n}${extension ? `.${extension}` : ''}`;
  }
}

/** Each pasted file's name, in order, none the same as a file already there or as each other. */
export function pastedNames(files: readonly { name: string; type: string }[], taken: readonly string[]): string[] {
  const names: string[] = [];
  for (const file of files) names.push(pastedName(file.name, file.type, [...taken, ...names]));
  return names;
}
