# Git Index Editor

Edit the Git staging area directly, the way the Eclipse EGit staging view lets you.

The Index is opened as a real editor. Type in it, paste into it, and save: the saved text is what
gets committed, and your working tree stays exactly as it was.

## Two diffs, both editable

| Group in Source Control | Diff that opens | What you can edit |
| --- | --- | --- |
| **Unstaged Changes** | Working Tree ↔ Index | Both sides |
| **Staged Changes** | HEAD ↔ Index | The Index (HEAD is read-only) |

The Index is always the right side, so the arrow in the diff gutter means "make the Index like the
left side":

- In the unstaged diff the arrow **stages** a block.
- In the staged diff the arrow **unstages** a block.

Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to write the result to the Index.

## Staging part of a file

Put the cursor in a change, or select some lines, and run **Stage Hunk or Selected Lines**
(<kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>, the `+` button in the editor
title, or the context menu). This writes to the Index immediately. The same key unstages in the
staged diff. The selection can be on either side.

**Discard Hunk or Selected Lines from Working Tree** works the same way on the other side: it edits
the working tree document and leaves it unsaved, so you can undo it.

<kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> switches between the two diffs of a file.

## Source Control view

The extension adds a **Git Index** entry next to the built-in Git one, with Unstaged and Staged
groups, per-file stage, unstage and discard buttons, a commit box, and Commit (Amend). Committing
warns you if an open Index document has unsaved edits.

The built-in Git view stays available. Its file context menu gains both comparison commands.

## Side-by-side only

The extension works only in the side-by-side diff view. It sets these two defaults, which also
apply to other diff editors unless you override them:

```json
"diffEditor.renderSideBySide": true,
"diffEditor.useInlineViewWhenSpaceIsLimited": false
```

While `diffEditor.renderSideBySide` is off:

- Diffs do not open. A notification offers to switch back to side by side.
- A diff that is already open loses its stage and unstage controls, and its Index becomes read-only.
- Unsaved Index edits are kept, and can be saved after switching back.

The per-file buttons in the Source Control view keep working, because they do not depend on a diff.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `indexEditor.unstagedDiffLayout` | `indexRight` | `indexLeft` puts the Index on the left of the unstaged diff. New lines then look green as usual, but the gutter arrow changes the working tree instead of staging. |

## Good to know

- **Save actions run on Ctrl+S.** `files.trimTrailingWhitespace`, `editor.formatOnSave` and similar
  settings apply when you save an Index document. The stage and unstage commands write directly and
  are not affected.
- **Line endings.** Existing Index content is stored byte for byte, so with `core.autocrlf` the Index
  keeps its LF. Content for a path new to the Index goes through Git's clean filters.
- **Renames** appear as a deletion and an addition.
- **Merge conflicts** are listed in their own group. Resolve them in the working tree and stage the
  file. The Index of a conflicted file cannot be edited.
- **If you turn `diffEditor.useInlineViewWhenSpaceIsLimited` back on**, a narrow editor can switch to
  inline on its own. The stage controls hide, but VS Code gives extensions no way to detect this, so
  the Index stays editable there.

## Requirements

Git 2.25 or later, and VS Code 1.100 or later.
