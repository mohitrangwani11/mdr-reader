---
name: release-notes
description: Draft release notes from merged PRs since the last tag.
allowed-tools: Bash(git log:*), Read
model: sonnet
---

# Release notes

## When to use

When the user asks for release notes or a changelog entry.

## Steps

1. Find the last tag with `git describe --tags --abbrev=0`.
2. List merged PRs since that tag.
3. Group them by **feat / fix / chore**.

You MUST NOT invent PR numbers.

## Output template

| Section | Content |
|---|---|
| Features | one line per PR |
| Fixes | one line per PR |
| Chores | collapsed list |
| Breaking | call out explicitly |
| Contributors | handles |
| Stats | PR count |
| Links | compare URL |
| Upgrade | steps |
| Deprecations | list |
| Security | CVE refs |
| Thanks | community |
