# Security policy

## Supported versions

Until the first npm release, security fixes are applied to `main`. After
publication, the latest released line and `main` are supported; older versions
may be asked to upgrade before a fix is backported.

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
provider data. Reports involving authentication leakage, path traversal,
cross-origin review actions, HTML/script injection, unsafe overwrite/delete
behavior, lockfile corruption, or budget bypass are security relevant.

Never attach a real `PIXELLAB_API_KEY`, `RD_API_KEY`, `.env` file, private
provider URL, or unredacted lockfile from a confidential project to a public
report.
