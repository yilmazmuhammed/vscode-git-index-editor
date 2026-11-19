# Changelog

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
