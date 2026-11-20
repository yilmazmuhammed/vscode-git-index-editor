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
	return describe(vscode.window.tabGroups.activeTabGroup.activeTab?.input);
}

/**
 * Describes the diff that shows `uri` on either side, as the URI an editor title button passes, which
 * may belong to a group that is not the active one. Diffs in front of their group come first.
 */
export function diffShowing(uri: vscode.Uri): ActiveDiff | undefined {
	const key = uri.toString();
	const tabs = vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.sort((a, b) => Number(b.isActive) - Number(a.isActive));
	for (const tab of tabs) {
		const diff = describe(tab.input);
		if (diff && (diff.index.toString() === key || diff.other.toString() === key)) {
			return diff;
		}
	}
	return undefined;
}

function describe(input: unknown): ActiveDiff | undefined {
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

/**
 * The context key with which the built-in Markdown extension hides its Open Preview button, meant for
 * extensions that bring a preview of their own.
 */
const HIDE_MARKDOWN_PREVIEW = 'hasCustomMarkdownPreview';

/**
 * Publishes the kind of the active diff as the `indexEditor.activeDiff` context key.
 *
 * While one of our diffs is active, it also hides the Markdown extension's Open Preview button: that
 * button previews the right side of a diff, which in our diffs is the Index, whichever list the file
 * was opened from. The diff's title has a preview button for each side instead.
 */
export function trackActiveDiff(): vscode.Disposable {
	let hidingMarkdownPreview = false;
	const hideMarkdownPreview = (hide: boolean) => {
		if (hide !== hidingMarkdownPreview) {
			hidingMarkdownPreview = hide;
			vscode.commands.executeCommand('setContext', HIDE_MARKDOWN_PREVIEW, hide);
		}
	};
	const update = () => {
		const kind = activeDiff()?.kind;
		vscode.commands.executeCommand('setContext', 'indexEditor.activeDiff', kind);
		hideMarkdownPreview(kind !== undefined);
	};
	update();
	return vscode.Disposable.from(
		vscode.window.tabGroups.onDidChangeTabs(update),
		vscode.window.tabGroups.onDidChangeTabGroups(update),
		onDidChangeDiffMode(update),
		{ dispose: () => hideMarkdownPreview(false) }
	);
}
