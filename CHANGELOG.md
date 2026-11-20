# Changelog

## 0.3.5

- The commit area never scrolls. Author, Committer and the buttons stay at the bottom. When the view
  gets shorter, the message box shrinks to one line first; then the repository line, the summary hint,
  the Commit Message heading and Amend/Sign-off give way in that order, and come back when there is room.

## 0.3.4

- Fixed: the arrow did not save a block whose lines also differ in leading or trailing whitespace. The
  diff editor ignores that whitespace by default (`diffEditor.ignoreTrimWhitespace`), so its arrow
  leaves it as it is; such a block now counts as moved, as the diff shows it.

## 0.3.3

- The commit area keeps Author, Committer and the buttons in sight when the view gets shorter: the
  message box takes the height the rest leaves, down to one line, and only below that does the view
  scroll.

## 0.3.2

- Fixed: clicking the arrow in the diff gutter left the block unsaved. The arrow edits only the
  characters that differ, and 0.3.1 recognized only edits of whole lines. An edit now counts as a moved
  block when it makes whole blocks equal to the other side and leaves the rest alone, whatever its shape.
- The Markdown preview buttons have icons of their own: a split window with the previewed side shaded
  and a magnifier on it. Before, they used VS Code icons that did not tell which side they preview.

## 0.3.1

- **Markdown preview in the Index diffs**: a preview button for each side, the working tree file (or
  the base) on the left and the Index on the right. The previews are locked, and when both are open
  they are stacked so both stay visible. VS Code's own Open Preview button, which always previewed the
  Index, is hidden in these diffs.
- **The arrow in the diff gutter saves at once**: a block it moves into the Index is written without
  Ctrl+S, and so is undoing it. When the Index side already has unsaved edits, the block joins them
  and waits for the save.

## 0.3.0

- **Git Repositories view**, as in EGit: each repository with its branch, ahead/behind and merge or
  rebase state; local and remote-tracking branches, hierarchical or flat, optionally with their latest
  commit; HEAD, FETCH_HEAD, ORIG_HEAD and other references; remotes with their fetch and push setup.
  Link with Editor selects the repository of the active editor.
- **Branches**: check out (remote branches as tracking branches, references detached), Create Branch… from any branch, tag or
  commit with upstream and pull mode, Rename (F2), Delete (several, with a warning for unmerged
  branches), Configure Branch…, and Switch To… with recently used branches, in several repositories
  at once.
- **When local changes stop a checkout**: Smart Checkout takes them over to the other branch, staged
  and unstaged and untracked, after checking that they apply cleanly; if they would conflict, nothing
  changes and you stay on your branch. Also Commit First… and Discard Changes and Check Out.
- **Remotes**: Fetch with a summary of updated, new and deleted branches, Fetch From… a remote or URL,
  Pull (several repositories in parallel), Pull… with remote, branch, merge or rebase and upstream,
  Push to Upstream, Push Branch… with remote branch name, upstream and force-with-lease, Push… with
  refspecs and a dry run, Delete Branch on Remote, and Create, Configure (URL, push URLs, refspecs,
  tags, prune), Rename and Delete Remote.
- The Staging view follows the repository of any active editor tab and of the Source Control view's
  selection, shows the repository and branch it works on, and **Show in Git Staging** in the Explorer
  picks the repository of a file or folder.
- Fixed: the same repository could be listed twice, which made the extension act as if several
  repositories were open and kept closed repositories listed.
- Commands that change HEAD or the Index retry when Windows reports the file busy.

## 0.2.0

The extension now builds on the built-in Git extension instead of a Source Control provider of its
own, and adds an EGit-style Staging view. Its ID, name, command IDs and settings stay `indexEditor.*`.

- **Git Staging view** in its own activity bar container: Unstaged and Staged lists with list, tree
  and compact tree presentation, sorting, a file filter with counts, untracked files on or off,
  multi-selection, drag and drop between the lists, and EGit's context menu (add to and remove from
  the Index, replace with the Index or HEAD, ours and theirs, merge tool, ignore, ignore folder,
  delete, assume unchanged, untrack, compare, copy path, reveal).
- **Commit area**: message with summary length and second-line hints, `commit.template`, the message
  Git prepared for a merge, previous messages, Amend (with a warning when HEAD is already pushed),
  Sign-off, Author and Committer fields with history, Commit, Commit and Push (Push HEAD when there is
  nothing to commit), Continue and Abort while a merge or rebase is in progress, and an optional check
  for problems in the staged files. The `indexEditor.commit` and `indexEditor.commitAmend` commands
  commit what the commit area holds.
- **Index editors**: the staged diff compares with HEAD or with the upstream branch
  (`indexEditor.staging.stagedCompareBase` and a title button). A file the base lacks shows an empty
  base. New editor commands: Stage Whole File, Reset Index to Base, Reload Index. Submodules and
  binary files open read-only.
- Files marked assume-unchanged get an `AU` badge in the Explorer.
- Turkish and English user interface, and a Turkish README.
- The 0.1.0 commands `indexEditor.stageFile`, `unstageFile`, `discardFile`, `openFile`, `stageAll`,
  `unstageAll` and `refresh` keep their IDs and also accept file URIs.
- Removed: the separate "Git Index" Source Control provider and the `indexEditor.unstagedDiffLayout`
  setting.

## 0.1.0

First version: editable Working Tree ↔ Index and HEAD ↔ Index diffs, hunk and line staging,
a Source Control view with commit and amend, and side-by-side-only operation.
