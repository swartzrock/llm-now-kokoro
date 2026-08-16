# Security policy

## Supported status

This repository is pre-release. No helper artifact is currently supported for
end-user installation. Report vulnerabilities through this repository's
private GitHub Security Advisory flow; do not include credentials, provider
answers, or other sensitive text in a public issue.

## Security boundary

The helper is trusted native code run as the current user after `llm-now`
verifies the complete installed pack. It is not a sandbox. The v1 protocol
accepts answer text only as one bounded UTF-8 JSON value on stdin. Answer text
must never appear in argv, environment variables, filenames, diagnostics, or
protocol metadata. The installed helper has no model download, update, remote
fallback, shell, or PATH-resolved player behavior.

Operating systems may still create crash reports outside the application's
control. The release build must minimize core dumps where the platform allows,
must not install a custom dump handler, and must document the residual
OS-managed crash-report risk. Do not use private/provider-derived text when
reporting crashes.

Publication remains blocked until the native payload license, signing,
notarization, runtime dependency, and clean-host checks in
[`docs/RELEASING.md`](docs/RELEASING.md) pass.
