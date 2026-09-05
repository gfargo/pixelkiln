# Security policy

## Supported versions

Security fixes target `main` and the latest npm release. Older versions may
need to upgrade before a fix is backported.

## Reporting a vulnerability

Please use GitHub's private vulnerability report for this repository when it is
available under the **Security** tab. If that option is unavailable, open a
minimal issue asking for a private contact channel and do not include exploit
steps, credentials, private URLs, or affected user data in the issue.

Useful reports include:

- the affected version or commit;
- the smallest safe reproduction;
- expected and observed behavior;
- impact and whether provider quota, local files, credentials, or account
  objects are at risk;
- suggested mitigation, if known.

Please allow the maintainer time to reproduce and coordinate a fix before
public disclosure. Credit and disclosure timing will be coordinated with the
reporter.

## Sensitive areas

PixelKiln handles provider credentials, paid API actions, remote object deletion,
local output paths, a localhost review server, and generated HTML containing
provider data. Temporary provider result URLs can also contain signing
credentials in their query string. Reports involving authentication leakage, path traversal,
cross-origin review actions, HTML/script injection, unsafe overwrite/delete
behavior, lockfile corruption, or budget bypass are security relevant.

Never attach a real `PIXELLAB_API_KEY`, `RD_API_KEY`, `SCENARIO_SDK_API_KEY`,
`SCENARIO_SDK_API_SECRET`, `.env` file, private
provider URL, or unredacted lockfile from a confidential project to a public
report.

PixelKiln keeps durable provider references in lockfiles when an adapter can
refresh an expiring result. After successful ingestion it removes signed URLs,
inline data URLs, and local file URLs from settled lock entries. A failed
download may retain its source locally so `fetch` can retry, but that in-flight
lockfile should not be committed. `npm run test:security` checks every tracked
JSON file for credential-bearing URLs and reports only the file and JSON path,
never the sensitive value.
