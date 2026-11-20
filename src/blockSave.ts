import * as vscode from 'vscode';
import { diffShowing } from './activeDiff';
import { isBlockMove } from './blockMove';
import { INDEX_SCHEME } from './uris';

/**
 * Saves the Index document of a diff as soon as the diff editor's arrow moves a block into it, so the
 * arrow stages (or, in the staged diff, unstages) the block at once, as the stage commands do. Undo and
 * redo of such a move are saved too.
 *
 * Only a document without other unsaved edits is saved: when it has some, the moved block joins them
 * and waits for a save, so that edits in progress are never written behind the user's back.
 *
 * VS Code reports a change first, with the document still clean, and then, in an event without
 * changes, that the document became dirty. So the change decides, and the save waits for that second
 * event, which never comes for a document that already had unsaved edits, or that was reloaded from
 * the Index.
 */
export function saveBlockMoves(log: (error: unknown) => void): vscode.Disposable {
	/** The text of each open Index document, as of its last change. */
	const texts = new Map<string, string>();
	/** Documents whose last change is to be saved once they turn dirty. */
	const toSave = new Set<string>();
	/** Documents we are saving. */
	const saving = new Set<string>();
	/** Documents whose last save was ours, so that undoing it follows suit. */
	const savedByUs = new Set<string>();

	const track = (document: vscode.TextDocument) => {
		if (document.uri.scheme === INDEX_SCHEME) {
			texts.set(document.uri.toString(), document.getText());
		}
	};
	vscode.workspace.textDocuments.forEach(track);

	const save = (document: vscode.TextDocument) => {
		const key = document.uri.toString();
		saving.add(key);
		document.save().then(saved => {
			if (!saved) {
				saving.delete(key);
			}
		}, error => {
			saving.delete(key);
			log(error);
		});
	};

	/** Whether a change of a clean Index document moves blocks from the other side of its diff, or undoes or redoes such a move. */
	const isMove = (event: vscode.TextDocumentChangeEvent, before: string): boolean => {
		const { document } = event;
		const key = document.uri.toString();
		const diff = diffShowing(document.uri);
		if (diff?.index.toString() !== key) {
			return false;
		}
		if (event.reason !== undefined) {
			return savedByUs.has(key);
		}
		const other = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === diff.other.toString());
		const ignoreTrimWhitespace = vscode.workspace.getConfiguration('diffEditor', document).get<boolean>('ignoreTrimWhitespace', true);
		return !!other && isBlockMove(other.getText(), before, document.getText(), ignoreTrimWhitespace);
	};

	const onChange = (event: vscode.TextDocumentChangeEvent) => {
		const { document } = event;
		if (document.uri.scheme !== INDEX_SCHEME) {
			return;
		}
		const key = document.uri.toString();
		if (event.contentChanges.length === 0) {
			if (document.isDirty && toSave.has(key)) {
				save(document);
			}
			toSave.delete(key);
			return;
		}
		const before = texts.get(key);
		track(document);
		// isDirty still tells how the document was before this change.
		if (before !== undefined && !document.isDirty && isMove(event, before)) {
			toSave.add(key);
		} else {
			toSave.delete(key);
		}
	};

	return vscode.Disposable.from(
		vscode.workspace.onDidOpenTextDocument(track),
		vscode.workspace.onDidCloseTextDocument(document => {
			const key = document.uri.toString();
			texts.delete(key);
			toSave.delete(key);
			savedByUs.delete(key);
		}),
		vscode.workspace.onDidChangeTextDocument(onChange),
		vscode.workspace.onDidSaveTextDocument(document => {
			const key = document.uri.toString();
			track(document);
			if (saving.delete(key)) {
				savedByUs.add(key);
			} else {
				savedByUs.delete(key);
			}
		})
	);
}
