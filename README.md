# Shingon

A sovereign multi-agent software-development harness: it turns a client's meeting notes into a working,
tested, shipped web app, with AI models doing the building and people approving each step.

The repository holds its two parts:

| Folder | What it is |
|---|---|
| [`conductor/`](conductor/) | **The harness.** Conductor runs the factory: brief from meeting notes, build by a team of AI models (local models first), full council review, the operator's approval, release, shipping to the client's box, change requests and foundation upgrades. Clients never receive it. |
| [`foundation/`](foundation/) | **The starter kit every client app is built from.** The Highland foundation: a tested web app with sign-in, permissions, files, backups, safe updates, monitoring, and optional modules (receipt reading, PDF and spreadsheet export, scheduled jobs). Conductor copies it at a release tag and adds only the client's own features. |

Foundation releases are tagged `v0.1.0`, `v0.2.0`, … (those tags point at the foundation's own history,
before it moved into `foundation/`). Each part has its own README with how to run and test it.
