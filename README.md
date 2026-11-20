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
- With several repositories open, the view follows the repository of the active editor (any kind of editor tab, diffs included) and the repository you select in the Source Control view. Both lists and the commit area show the repository and branch they work on.
- VS Code does not tell extensions which file or folder is selected in the Explorer, so a folder counts only when you right-click it and choose **Show in Git Staging**. Clicking a file in the Explorer opens it, so the view follows it. You can also pick a repository from the title bar.

**Context menu**, as in EGit: add to or remove from the Index, open the working tree version, compare
with HEAD, compare with each other, replace with the file in the Index, replace with the HEAD
revision, replace with ours or theirs, merge tool, ignore, ignore folder, delete, assume unchanged,
untrack, copy path, reveal in the Explorer.

- **No Assume Unchanged…** in the `…` menu of Unstaged Changes clears the assume-unchanged flag.
- Files with that flag show an `AU` badge in the Explorer.

## Git Repositories view

The first part of the Git Staging container lists the open repositories, as EGit's Git Repositories
view does:

| Node | Shows | Actions |
| --- | --- | --- |
| **Repository** | Branch, ↑ahead ↓behind, and MERGING / REBASING | Fetch, Fetch From…, Pull, Pull…, Push to Upstream, Push Branch…, Push…, Switch To…, Create Branch…, Configure Branch…, Create Remote…, Show in Git Staging, Copy Path |
| **Branches › Local** | Branches, in folders at each `/` or as a list; upstream and ↑↓ | Check Out, Create Branch…, Rename (F2), Delete (Del, several at once), Configure Branch…, Push Branch… |
| **Branches › Remote Tracking** | Remote-tracking branches | Check Out (as a local branch that tracks it), Create Branch…, Delete Branch on Remote |
| **References** | HEAD, FETCH_HEAD, ORIG_HEAD, MERGE_HEAD… | Check Out (detached), Create Branch… |
| **Remotes** | Each remote with its Fetch and Push URLs and refspecs | Fetch, Push…, Configure Remote…, Rename, Delete |

- **Selecting several repositories** lets Fetch, Pull and Switch To work on all of them; Pull runs a few at a time (`indexEditor.repositories.pullConcurrency`).
- **Switch To…** lists recently checked out branches first, read from the reflog.
- **Create Branch…** starts from any branch, tag or commit, suggests a name, and can track a remote branch with merge or rebase.
- **Configure Branch…** sets the upstream remote and branch and the pull mode, or removes the upstream.
- **When local changes stop a checkout**, you can choose:
  - **Smart Checkout** takes your changes, staged and unstaged and untracked files included, over to the other branch. It checks first: if they would conflict with that branch, nothing changes and you stay on your branch with your changes.
  - **Commit First…** stops and opens the commit area.
  - **Discard Changes and Check Out** throws the changes away.
- **Fetch** reports which remote-tracking branches were updated, created or deleted.
- **Pull…** fetches a branch of a remote, merges or rebases onto it, and can make it the upstream. When Git stops on conflicts, the Staging view shows them.
- **Push Branch…** asks for the remote, the remote branch name, the upstream mode and whether to force push with lease. **Push…** takes refspecs; a refspec like `:refs/heads/old` deletes a remote branch, and **Dry Run** shows the result in the terminal.
- **Configure Remote…** opens an editor for the URL, push URLs, fetch and push refspecs, tag fetching and pruning, with Save, Save and Fetch, Save and Push and Dry Run.
- Fetch, pull and push go through the built-in Git extension, so VS Code asks for credentials as usual.
- The title bar switches between hierarchical and flat branches; its `…` menu shows the latest commit of each branch and turns Link with Editor on or off.

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
- **The arrow saves at once.**
  - The block goes to the Index without <kbd>Ctrl</kbd>+<kbd>S</kbd>, and so does undoing it.
  - If the Index side already has unsaved edits, the block joins them and everything is written when you save.
  - With a selection, the arrow moves only the selected characters; that edit waits for <kbd>Ctrl</kbd>+<kbd>S</kbd> too.
  - An edit is saved this way when it makes whole blocks equal to the other side and leaves the rest alone. So is a single edit you type that does the same.
  - Leading and trailing whitespace counts only if the diff shows it (`diffEditor.ignoreTrimWhitespace`). By default it does not, and the arrow leaves a line's indentation as it is.
- Type anything you like into the Index side. <kbd>Ctrl</kbd>+<kbd>S</kbd> writes it to the Index; the working tree file does not change.

More commands:

- **Stage Hunk or Selected Lines / Unstage Hunk or Selected Lines** moves the hunk under the cursor, or the selected lines, into the Index. Use <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>, the `+`/`−` button in the editor title, or the context menu.
- **Discard Hunk or Selected Lines from Working Tree** undoes the change in the working tree document and leaves it unsaved.
- **Switch Base Between HEAD and Upstream** (the branch icon in the title) changes the base of the staged diff. The setting `indexEditor.staging.stagedCompareBase` sets the default. Without an upstream, HEAD is used.
- **Stage Whole File**, **Reset Index to Base** and **Reload Index** are in the `…` menu of the editor title.
- <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> switches between the two diffs of a file.
- **Markdown files get a preview button for each side:**
  - The left button previews the working tree file in the unstaged diff, and the base in the staged diff.
  - The right button previews the Index.
  - Each icon is a split window with the previewed side shaded and a magnifier on it.
  - A preview is locked: it keeps showing its side when the cursor moves to the other side.
  - When both previews are open, they are stacked so both stay visible.
  - VS Code's own **Open Preview** button would always preview the Index here, so these diffs hide it.

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
| `indexEditor.staging.followActiveEditor` | `true` | Whether the view follows the repository of the active editor and of the Source Control selection. |
| `indexEditor.repositories.hierarchicalBranches` | `true` | Branches in folders at each `/`, or as a list. |
| `indexEditor.repositories.showLatestCommit` | `false` | Whether the latest commit is shown next to each branch. |
| `indexEditor.repositories.linkWithEditor` | `true` | Whether the Git Repositories view selects the repository of the active editor. |
| `indexEditor.repositories.pullConcurrency` | `3` | How many repositories Pull updates at the same time. |
| `indexEditor.commit.signOffByDefault` | `false` | Whether Sign-off starts checked. |
| `indexEditor.commit.problemCheck` | `off` | Problem check before committing: `off`, `warn` or `block`. |
| `indexEditor.commit.problemSeverity` | `error` | The least severe problem that counts: `error` or `warning`. |
| `indexEditor.commit.messageHistorySize` | `20` | How many messages, authors and committers are remembered. |
| `indexEditor.decorations.assumeUnchanged` | `true` | Whether assume-unchanged files get an `AU` badge in the Explorer. |

## Good to know

- **Save actions run when an Index document is saved**, by <kbd>Ctrl</kbd>+<kbd>S</kbd> or by the arrow. `files.trimTrailingWhitespace`, `editor.formatOnSave` and similar settings apply then. The stage and unstage commands write directly and are not affected.
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
one, which an offline network needs. `INDEX_EDITOR_TEST` set to part of a test name runs only the
tests whose name contains it.

## Publishing

Every push to `main` runs [.github/workflows/publish.yml](.github/workflows/publish.yml). It runs the
unit tests and, when the version in `package.json` differs from the one on the Marketplace,
publishes the extension with Trusted Publishing (OIDC), without a personal access token. To release,
raise `version` in `package.json` and update `CHANGELOG.md`.
