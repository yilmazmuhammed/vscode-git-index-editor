import * as vscode from 'vscode';
import { isInlineDiff, onDidChangeDiffMode } from './diffMode';
import { HEAD_SCHEME, INDEX_SCHEME, isEmptyUri, toFileUri } from './uris';

export interface ActiveDiff {
	readonly kind: 'unstaged' | 'staged';
	readonly index: vscode.Uri;
	/** The side the Index is compared with: the working tree file, or HEAD. */
	readonly other: vscode.Uri;
	readonly file: vscode.Uri;
}

/** Describes the active tab if it is one of our two diffs, shown side by side. */
export function activeDiff(): ActiveDiff | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (isInlineDiff() || !(input instanceof vscode.TabInputTextDiff)) {
		return undefined;
	}
	const { original, modified } = input;
	const index = [original, modified].find(uri => uri.scheme === INDEX_SCHEME);
	if (!index) {
		return undefined;
	}
	const other = index === original ? modified : original;
	const kind = other.scheme === HEAD_SCHEME && !isEmptyUri(other) ? 'staged' : 'unstaged';
	return { kind, index, other, file: toFileUri(index) };
}

/** Publishes the kind of the active diff as the `indexEditor.activeDiff` context key. */
export function trackActiveDiff(): vscode.Disposable {
	const update = () => vscode.commands.executeCommand('setContext', 'indexEditor.activeDiff', activeDiff()?.kind);
	update();
	return vscode.Disposable.from(
		vscode.window.tabGroups.onDidChangeTabs(update),
		vscode.window.tabGroups.onDidChangeTabGroups(update),
		onDidChangeDiffMode(update)
	);
}
