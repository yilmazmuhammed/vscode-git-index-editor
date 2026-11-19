import * as vscode from 'vscode';

/** The Index of a file, writable. */
export const INDEX_SCHEME = 'git-index';
/** A read-only empty document, standing in for a working tree file that does not exist. */
export const EMPTY_SCHEME = 'git-index-empty';
/** Resource URIs of the Staging view's items, which carry their list and kind for decorations. */
export const STAGING_SCHEME = 'git-index-staging';
/** The built-in Git extension's scheme for content at a ref. */
export const GIT_SCHEME = 'git';

export function toIndexUri(file: vscode.Uri): vscode.Uri {
	return file.with({ scheme: INDEX_SCHEME, query: '' });
}

/**
 * @param baseRef When the empty document stands for a base (HEAD or upstream) that lacks the file,
 * the ref of that base, so that the diff is still recognized as a staged diff.
 */
export function toEmptyUri(file: vscode.Uri, baseRef?: string): vscode.Uri {
	return file.with({ scheme: EMPTY_SCHEME, query: baseRef ? new URLSearchParams({ ref: baseRef }).toString() : '' });
}

export function isEmptyUri(uri: vscode.Uri): boolean {
	return uri.scheme === EMPTY_SCHEME;
}

export function toFileUri(uri: vscode.Uri): vscode.Uri {
	return uri.with({ scheme: 'file', query: '' });
}

/** The ref of a built-in `git:` URI, which keeps it as JSON in the query. */
export function gitUriRef(uri: vscode.Uri): string | undefined {
	if (uri.scheme !== GIT_SCHEME) {
		return undefined;
	}
	try {
		const ref = JSON.parse(uri.query)?.ref;
		return typeof ref === 'string' ? ref : undefined;
	} catch {
		return undefined;
	}
}

/** The ref of the base side of a staged diff: a `git:` URI, or an empty document standing for a base without the file. */
export function baseRefOf(uri: vscode.Uri): string | undefined {
	if (uri.scheme === EMPTY_SCHEME) {
		return new URLSearchParams(uri.query).get('ref') ?? undefined;
	}
	return gitUriRef(uri);
}
