# M1 audit — deferred findings

Findings from the two adversarial audits (security bypass + data loss) that were **judged real but not release-blocking** for M1. Recorded here because the JIRA MCP was disconnected when they were triaged; each becomes a ticket under **KAN-1** once it reconnects.

Triage bar: *does this hurt an honest user, and does it hurt them now?* Blocking items were fixed in the remediation pass. Everything below is real, reproducible, and deliberately deferred.

---

## Accepted by design — not defects

These were reported by the audit and are **not** being fixed, because they follow from the milestone's threat model rather than contradicting it.

**The policy layer is a guardrail against user error and AI mistakes, not a security boundary against a compromised renderer.**

The app intentionally exposes `ptySpawn({ shell: true })` — a full PowerShell reachable from the renderer, which is the product's entire reason to exist. Given that, hardening file operations against a hostile renderer is theater: anything that can call `fsDelete` can already call `ptyWrite`.

Consequently these are accepted, and documented in the spec rather than fixed:

| Reported | Why accepted |
|---|---|
| `settings:set` is ungated, so the renderer can flip itself to Developer mode | A renderer that can do this already has a shell |
| `gate()` accepts a caller-supplied `confirm` string; nothing proves a human typed it | Same. The verdict is re-derived on every call, but consent cannot be proven from main |
| `ptySpawn({shell:true})` + `ptyWrite` is an ungated mutation channel | Intended product feature |

The audit was right that the *literal* claim ("no mutation reaches disk without `gate()`") was false. The fix was to restate the claim honestly, not to chase an unreachable bar.

---

## Deferred — real, worth fixing, not blocking

### D-1 · Staged items are orphaned by an unclean exit
**`src/main/trash.ts`** — the `live` registry is process memory only, and the `will-quit` flush (`index.ts`) is the sole path that ever drains staging. There is no startup sweep and no on-disk record.

Kill the app from Task Manager after a delete and the files are: not in their original location, not in the Recycle Bin, not on the undo stack. They sit in `<drive>\.claude-explorer-trash\<uuid>\`, and `policy.classify` then **refuses to let the user move them back out** — recovery requires real File Explorer, which is precisely the dependency this project exists to remove.

*Fix:* a startup sweep that either restores or flushes orphaned buckets. Needs a small on-disk manifest so a bucket's original path survives the process.

### D-2 · Staging grows without bound where there is no Recycle Bin
**`src/main/trash.ts`** — `flush()` swallows `shell.trashItem` failures and then unconditionally splices the record out of `live`. On a network share or removable volume with no Recycle Bin, every delete permanently accumulates a staging bucket the user is never told about and cannot remove through the app.

*Fix:* on `trashItem` failure, either hard-delete the bucket or keep the record and surface it. Silently dropping the record is the one option that guarantees the leak.

### D-3 · Cross-volume moves reset timestamps and drop NTFS metadata
**`src/main/fsmutate.ts`**, **`src/main/trash.ts`** — the `EXDEV` fallbacks use `fs.cp` with the default `preserveTimestamps: false`, so a cross-volume move (and any delete/undo round trip that took the `userData` fallback) resets every file's mtime and drops alternate data streams and ACLs. A same-volume move via `rename` preserves all of it, so the behaviour is inconsistent with itself and with Explorer.

*Fix:* `preserveTimestamps: true` covers the timestamp half cheaply. ADS/ACL loss is inherent to `fs.cp` and deserves a `ponytail:` comment naming the ceiling rather than a rewrite.

### D-4 · Multi-select denials don't say which item was refused
**`src/main/policy.ts`** — `check()` returns on the first protected path in the array, so selecting twenty files where one is protected yields a reason naming the *class* but not the *path*. The renderer prints it verbatim. The user cannot tell which item to deselect.

*Fix:* include the offending basename in the reason. Cheap, and the difference between a usable refusal and a confusing one.

### D-5 · Dead branch in `gate()`
**`src/main/policy.ts`** — `const satisfied = v.typed ? confirm === CONFIRM_WORD : confirm !== undefined`. `check()` never returns a confirm verdict with `typed: false`, so the untyped half is unreachable and untested. Harmless today, but if a simple-confirm verdict is ever added, that branch accepts **any** defined string including `''`.

*Fix:* either delete the branch or pin it with a test when a simple-confirm path goes live.

### D-6 · `moveCmd`'s D3 site has no independent test
**`src/renderer/undo.ts`** — the D3 regression test added during verification covers `fsmutate.ts` (`mkdir`/`newFile`) only. `moveCmd`'s `srcDir` computation is not independently pinned; it would need a `window.api` stub like the one in `undo.test.ts`. Low risk, since `winDirname` is itself unit-tested — but "low risk" is what D3 looked like before it silently truncated a path.

---

## Process note worth keeping

D3 shipped with **zero** regression coverage. The implementation matched the plan exactly, and the plan asserted it was "exercised via fsmutate" — but no `test/fsmutate.test.ts` existed. With the bug reinstated at both call sites, the entire 66-test suite passed green.

Two lessons, both cheap to apply next milestone:

1. **A plan claiming existing coverage must name the file.** "Exercised via X" is unverifiable prose; `test/x.test.ts::name` is checkable.
2. **The revert-and-confirm-red step caught it.** Nothing else did — not the implementer, not type-checking, not the full suite. It is the only step that distinguishes a real regression test from a decorative one, and it belongs in every milestone's definition of done.
