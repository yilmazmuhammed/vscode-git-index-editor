# Git Index Editor

**English** | [Türkçe](README.tr.md)

Edit the Git staging area directly, the way the Eclipse EGit Staging view lets you. The Index opens as
a real editor: type in it, paste into it, and save. The saved text is what gets committed, and your
working tree stays exactly as it was.

The extension adds to VS Code's built-in Git support instead of replacing it: repositories, status
and pushing come from the built-in Git extension. The user interface is in English and Turkish,
following VS Code's display language.

## Git Staging view

The **Git Staging** icon in the activity bar opens a view with three parts:

| Part | Contents |
| --- | --- |
| **Unstaged Changes** | Changes in the working tree, untracked files and conflicts |
| **Staged Changes** | What the Index holds, that is, what the next commit records |
| **Commit Message** | Message, Amend, Sign-off, Author, Committer, Commit and Commit and Push |

- Drag files between the lists, one or several at a time.
- The inline `+` and `−` buttons stage and unstage a file.
- A file with both staged and unstaged changes is in both lists, marked *partially staged*.
- The title bar has Add All, Remove All, show or hide untracked files, Filter and Refresh. Its `…` menu has the presentation (list, tree, compact tree) and the sort order.
- The filter matches part of a path; `*` stands for any text and `?` for one character. The title shows how many files are shown out of how many.
- With several repositories open, the view follows the repository of the active editor. You can also pick one from the title bar.

**Context menu**, as in EGit: add to or remove from the Index, open the working tree version, compare
with HEAD, compare with each other, replace with the file in the Index, replace with the HEAD
revision, replace with ours or theirs, merge tool, ignore, ignore folder, delete, assume unchanged,
untrack, copy path, reveal in the Explorer.

- **No Assume Unchanged…** in the `…` menu of Unstaged Changes clears the assume-unchanged flag.
- Files with that flag show an `AU` badge in the Explorer.

## Editing the Index

Clicking a file opens a diff whose right side is the **editable Index**:

| List clicked | Left side | Right side |
| --- | --- | --- |
| **Unstaged** | Working tree (editable too) | Index |
| **Staged** | Base: HEAD or the upstream branch (read-only) | Index |

The Index is always the right side, so the arrow in the diff gutter always means "take this block
into the Index":

- In the unstaged diff the arrow **stages** a block.
- In the staged diff the arrow takes a block back from the base, which **unstages** it when the base is HEAD.
- Type anything you like into the Index side. <kbd>Ctrl</kbd>+<kbd>S</kbd> writes it to the Index; the working tree file does not change.

More commands:

- **Stage Hunk or Selected Lines / Unstage Hunk or Selected Lines** moves the hunk under the cursor, or the selected lines, into the Index. Use <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>, the `+`/`−` button in the editor title, or the context menu.
- **Discard Hunk or Selected Lines from Working Tree** undoes the change in the working tree document and leaves it unsaved.
- **Switch Base Between HEAD and Upstream** (the branch icon in the title) changes the base of the staged diff. The setting `indexEditor.staging.stagedCompareBase` sets the default. Without an upstream, HEAD is used.
- **Stage Whole File**, **Reset Index to Base** and **Reload Index** are in the `…` menu of the editor title.
- <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> switches between the two diffs of a file.

The same editors open from VS Code's own Source Control view: right-click a file and choose
**Edit Index: …**. The Explorer and the title menu of an open file have these commands too.

## Commit area

- **Message**
  - Below the message, the length of the summary line is shown, with a hint when the second line is not empty.
  - The box is filled in from, in this order: your unsaved draft, the message Git prepared for a merge, `commit.template`.
  - **Previous Messages** lists earlier commit messages.
- **Options**
  - **Amend** loads the message of the last commit, and warns when HEAD is already on a remote branch.
  - **Sign-off** adds a `Signed-off-by` line.
  - **Author** and **Committer** default to the identity in your git config, and suggest values used before.
- **Buttons**
  - **Commit** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) commits only what the Index holds.
  - **Commit and Push** then pushes the branch to its upstream, or publishes it to a remote when it has none.
  - With nothing to commit, that button becomes **Push HEAD**.
- **While a merge or rebase is in progress**, a banner shows above the box, with **Continue** (rebase) and **Abort**.
- With `indexEditor.commit.problemCheck` on, the commit asks first, or stops, when the staged files have errors or warnings.
- If an Index document has unsaved edits, the commit asks you to save them first.
- The **Commit** and **Commit (Amend)** commands also work from the Command Palette and key bindings, using the message in the commit area.

## Coming from 0.1.0

- Command IDs and settings are still named `indexEditor.*`, so key bindings made for 0.1.0 keep working.
- The separate **Git Index** entry in Source Control is gone; the Git Staging view takes its place.
- The `indexEditor.unstagedDiffLayout` setting is gone; the Index is always the right side.

## Side by side only

The Index editors work only in the side-by-side diff view. The extension sets these defaults, which
you can override:

```json
"diffEditor.renderSideBySide": true,
"diffEditor.useInlineViewWhenSpaceIsLimited": false
```

While the inline view is on:

- Diffs do not open.
- The Index side of an open diff becomes read-only.
- Unsaved edits are kept.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `indexEditor.staging.stagedCompareBase` | `HEAD` | What the Index of a staged file is compared with. The other value is `upstream`. |
| `indexEditor.staging.presentation` | `list` | How files are listed: `list`, `tree` or `compactTree`. |
| `indexEditor.staging.sortBy` | `name` | Order: `name` (by path) or `status` (by kind of change). |
| `indexEditor.staging.showUntracked` | `true` | Whether untracked files are shown. |
| `indexEditor.staging.followActiveEditor` | `true` | Whether the view follows the repository of the active editor. |
| `indexEditor.commit.signOffByDefault` | `false` | Whether Sign-off starts checked. |
| `indexEditor.commit.problemCheck` | `off` | Problem check before committing: `off`, `warn` or `block`. |
| `indexEditor.commit.problemSeverity` | `error` | The least severe problem that counts: `error` or `warning`. |
| `indexEditor.commit.messageHistorySize` | `20` | How many messages, authors and committers are remembered. |
| `indexEditor.decorations.assumeUnchanged` | `true` | Whether assume-unchanged files get an `AU` badge in the Explorer. |

## Good to know

- **Save actions run on Ctrl+S.** `files.trimTrailingWhitespace`, `editor.formatOnSave` and similar settings apply when you save an Index document. The stage and unstage commands write directly and are not affected.
- **With `files.autoSave` on**, an Index document is written to the Index on every automatic save.
- **Line endings.** The content of a file already in the Index is stored byte for byte, so with `core.autocrlf` the Index keeps its LF. A file new to the Index goes through Git's clean filters.
- **Conflicted files** open in the merge editor. Their Index cannot be edited: resolve the conflict and add the file to the Index.
- **Submodules and binary files** open read-only.
- **If you turn `diffEditor.useInlineViewWhenSpaceIsLimited` back on**, a narrow editor can switch to inline on its own. VS Code gives extensions no way to detect this, so the Index stays editable there.

## Requirements

- Git 2.25 or later.
- VS Code 1.100 or later, with the built-in Git extension enabled.

## Development

```powershell
npm install
npm run test:unit
$env:VSCODE_EXECUTABLE = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"; npm run test:integration
npx @vscode/vsce package
```

With `VSCODE_EXECUTABLE` set, the integration tests use the installed VS Code instead of downloading
one, which an offline network needs.

## Publishing

Every push to `main` runs [.github/workflows/publish.yml](.github/workflows/publish.yml). It runs the
unit tests and, when the version in `package.json` differs from the one on the Marketplace,
publishes the extension with Trusted Publishing (OIDC), without a personal access token. To release,
raise `version` in `package.json` and update `CHANGELOG.md`.
