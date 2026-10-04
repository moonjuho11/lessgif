# Security

## Reporting a problem

Please report security problems privately, not in a public issue: open this repository's
**Security** tab and choose **Report a vulnerability**. Say what you found and how to reproduce
it (a sample file helps), and which version of the app, the library or the website you used.

Please give a fix time to be released before sharing the details anywhere else.

## What this covers

- the lessgif library and command-line app (the Rust code here) and the files on the
  [releases page](../../releases);
- the browser build (`web/`) and the website (`site/`).

The website works on the visitor's device and never uploads their files. Anything that gets a
page to send a file or its contents somewhere else counts as a security problem.

## Supported versions

Fixes go into the latest release.
