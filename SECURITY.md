# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
[Report a vulnerability](https://github.com/JackB2003/website-screenshot-crawler/security/advisories/new).

Do not open a public issue for a vulnerability. Include what you found, how to reproduce it, and the version or commit. You can expect a first reply within a few days.

## Scope

The crawler fetches URLs that users submit, so the areas that matter most are:

- reaching internal or private addresses (server-side request forgery), including through redirects, DNS tricks, or page content
- bypassing the token, rate limits, or concurrency limits
- reading or writing files outside a scan's folder

How these are handled is described in the [Security section of the README](README.md#security).

## Supported versions

Only the latest release on the `main` branch receives security fixes.
