# Signing-key operations runbook

This runbook applies to the protected GitHub environment `release-signing`.
No signing credential may be exposed to pull-request workflows, repository
variables, build logs, artifacts, or developer workstations used for ordinary
builds.

## Ownership and least privilege

- The release-security owner controls Apple and Windows signing identities;
  the repository owner controls workflow and environment policy. They should
  be different people where staffing permits.
- Two maintainers approve each protected-environment deployment. No approver
  may approve their own release.
- Grant certificate/key portal access only to the release-security owner and
  one sealed recovery custodian. Repository maintainers do not receive raw
  private keys.
- The workflow imports identities into an ephemeral keychain/file, uses them
  only after unsigned validation, and destroys those temporary files.

## Inventory and monitoring

Track, outside the repository, the certificate fingerprint, Apple team and key
IDs, Windows certificate subject/serial, issuer, creation date, expiry date,
owner, recovery custodian, and last successful signing verification. Review
expiry monthly and alert at 90, 60, 30, 14, and 7 days. Review environment
access quarterly and after every personnel change.

## Rotation

Rotate App Store Connect API keys at least annually and code-signing
certificates before their issuer expiry. Create the replacement under
dual-control, verify its fingerprint out-of-band, update the exact environment
secret, and publish a new RC. Never change identity beneath an existing tag.

The trusted consumer catalog can adopt a replacement identity only through a
reviewed `llm-now` change that pins a helper release signed by the replacement,
records the old/new fingerprints and effective RC, and passes clean-host
signature plus catalog verification. The main `llm-now` release containing
that catalog establishes trust in the replacement.

## Timestamp and notarization policy

- Windows uses the HTTPS RFC3161 service named by
  `WINDOWS_RFC3161_TIMESTAMP_URL`, SHA-256 file digests, and SHA-256 timestamp
  digests. A missing or unverifiable timestamp blocks publication.
- Apple signing requires a secure timestamp and hardened runtime. Notarization
  uses the App Store Connect private key and waits for an accepted result.
  The submission ZIP is build-only; individually released files are not
  described as stapled.
- Timestamp or notarization service outages are stop conditions, not reasons
  to publish unsigned files.

## Revocation and compromise

Stop all releases immediately for suspected key disclosure, unexpected signing
events, lost custodian control, portal-account compromise, unverifiable
timestamps, revoked/expired identities, or a workflow/environment policy
bypass. Disable the environment, revoke the affected certificate/API key at
the issuer, preserve audit logs, notify repository and release-security owners,
and inventory every possibly affected tag and asset.

Do not delete or replace an immutable release. Mark affected releases
unsupported, publish remediation, rotate under dual-control, issue a new RC,
and update the consumer trust catalog through review. Offline installed old
binaries cannot be remotely revoked; communicate removal and patched-version
instructions explicitly.

## Dual-control recovery

The recovery custodian and repository owner jointly restore access. They verify
the incident is closed, create fresh credentials rather than reusing an unknown
key, compare fingerprints over a second channel, update the protected
environment, review all required reviewers and branch restrictions, and run a
non-publishing signature verification exercise. A real release resumes only
after a second maintainer reviews the exercise evidence and every release gate
passes.
