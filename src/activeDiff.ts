import * as vscode from 'vscode';
import { isInlineDiff, onDidChangeDiffMode } from './diffMode';
import { baseRefOf, INDEX_SCHEME, toFileUri } from './uris';

export interface ActiveDiff {
	/** `unstaged`: Working Tree ↔ Index. `staged`: base (HEAD or upstream) ↔ Index. */
	readonly kind: 'unstaged' | 'staged';
	/** The right side. */
	readonly index: vscode.Uri;
	/** The left side the Index is compared with: the working tree file, or the base at a ref. */
	readonly other: vscode.Uri;
	/** The file the Index side belongs to. */
	readonly file: vscode.Uri;
	/** For a staged diff, the ref of the base. */
	readonly baseRef?: string;
}

/** Describes the active tab if it is one of our two diffs, shown side by side. */
export function activeDiff(): ActiveDiff | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (isInlineDiff() || !(input instanceof vscode.TabInputTextDiff)) {
		return undefined;
	}
	const { original, modified } = input;
	if (modified.scheme !== INDEX_SCHEME) {
		return undefined;
	}
	const baseRef = baseRefOf(original);
	return {
		kind: baseRef !== undefined ? 'staged' : 'unstaged',
		index: modified,
		other: original,
		file: toFileUri(modified),
		baseRef
	};
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
