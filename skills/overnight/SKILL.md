---
name: overnight
description: Migrate a CommonJS JavaScript package to native ES modules in seconds and prove it with the package's own test suite. Use when asked to convert, migrate or modernize require/module.exports code to import/export.
---

# Overnight: CommonJS to ES modules

You run the migration; you do not rewrite files by hand. The tool splits every file at
top-level boundaries, sends each piece to Kimi K3.1 Pro on Cerebras at the same time,
checks that every line that should be copied came back, writes the ES-module version,
and runs the package's own tests against it.

## Steps

1. From the Overnight directory, run exactly one command with your exec tool:
   `node migrate.mjs --json`
   It prints one JSON object when it finishes (about 10-30 seconds).
2. Reply from that JSON, in three short lines and nothing else:
   - files and pieces migrated, lines, and wall-clock seconds (`summary.wallMs`)
   - combined speed (`summary.combinedTps`, tok/s) and fastest stream (`summary.peakTps`)
   - the test result: `tests.passes` passing, `tests.failures` failing

Do not open or edit the migrated files, and do not run the command twice. If the
command fails, quote its last error line.
