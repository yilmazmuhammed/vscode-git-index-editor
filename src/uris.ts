import * as vscode from 'vscode';

export const INDEX_SCHEME = 'git-index';
export const HEAD_SCHEME = 'git-head';

const EMPTY_QUERY = 'empty';

export function toIndexUri(file: vscode.Uri): vscode.Uri {
	return file.with({ scheme: INDEX_SCHEME, query: '' });
}

export function toHeadUri(file: vscode.Uri): vscode.Uri {
	return file.with({ scheme: HEAD_SCHEME, query: '' });
}

/** A read-only empty document, standing in for a working tree file that no longer exists. */
export function toEmptyUri(file: vscode.Uri): vscode.Uri {
	return file.with({ scheme: HEAD_SCHEME, query: EMPTY_QUERY });
}

export function isEmptyUri(uri: vscode.Uri): boolean {
	return uri.scheme === HEAD_SCHEME && uri.query === EMPTY_QUERY;
}

export function toFileUri(uri: vscode.Uri): vscode.Uri {
	return uri.with({ scheme: 'file', query: '' });
}
