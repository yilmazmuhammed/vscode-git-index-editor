/** Removes the lines Git would treat as comments, for messages pre-filled from Git's files. */
export function stripComments(message: string, commentChar = '#'): string {
	return message.split(/\r?\n/).filter(line => !line.startsWith(commentChar)).join('\n').replace(/\s+$/, '');
}
