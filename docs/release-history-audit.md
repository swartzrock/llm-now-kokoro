# Prototype history audit

The repository was bootstrapped non-destructively from both the new remote's
initial commit and the local `kokoro-cli` prototype history. No force-push,
history replacement, or discarded initial commit was used.

Before the feature branch was first pushed, all reachable prototype commits
and text blobs were inspected. The imported lineage contains 13 prototype
commits, no tags, no Git LFS objects, no tracked binary blobs, and no oversized
tracked blob (the largest was 26,150 bytes). A pattern scan of 100 reachable
text blobs found no private-key, common provider-token, credentialed-URL, JWT,
or assigned-secret match. Eleven unreachable loose objects reported by Git
filesystem checks were not part of the transferred history. Secret values are
never recorded in this report.

Automated scanners such as Gitleaks, TruffleHog, git-secrets, and detect-secrets
were not installed, so the audit used repository-object enumeration and
explicit high-signal patterns. Provenance and licensing review identified the
phonemizer/eSpeak discrepancy documented in `THIRD_PARTY_NOTICES.md`; that is a
release blocker, not a reason to discard the preserved source history.
