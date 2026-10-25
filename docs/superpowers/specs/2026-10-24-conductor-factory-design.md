# Conductor Factory — Product Design

- **Date:** 2026-10-24
- **Status:** Approved by operator 2026-10-25
- **Builds on:** `2026-10-18-conductor-mvp-design.md` (Plans 1–3, merged to master 2026-10-24)
- **Research input:** Babel doc "Research: LLM councils and specialist review agents for software (Oct 2026)" (project `code`)
- **Author:** drafted with Claude Code (Opus 5.5), with Malcolm McLeod

Below, **[operator]** marks a decision Malcolm made, and **[call]** marks a decision made in drafting that the operator can overrule.

---

## 1. Intent

Conductor grows from "change this repo" into a **software factory**. The operator describes the software a client needs. Conductor builds it, and a **council** of specialist reviewers checks the finished product, approving it or bouncing specific issues back. The operator gives final approval. The output is a **working, deployable web application**.

**Why now [operator]:**
- Malcolm runs Highland Automations, which builds web software for small businesses.
- The first real job is an upcoming contract: an **expenses tracker for a 40–50 person company**. Staff upload receipts, OCR reads them, and the system produces expense reports.
- There is no deadline yet. **The factory comes first**, and the expenses tracker becomes its first real job and acceptance test.

**Who uses it [operator]:**
- **The operator (Malcolm) is the only user.** He meets clients, then feeds Conductor what they need.
- Clients never touch the factory. They see previews and the finished site.
- The operator understands the business problem but should never need to read or write code. Everything the factory says to him is plain English, like a consultant's report.
- The long-term vision is that a tech-illiterate person could drive the factory directly. That is a direction, not a goal for this design (see §9).

**Why the council:**
- The existing three-headed loop (frontier author, cross-vendor reviewer, local grunt) is good at "does this code do what the plan said".
- It is not built to ask whether the product is secure, legal under the client's data policy, correct in its numbers, professional-looking and operable.
- The research (Babel doc above) says the council works best when:
  - each specialist is a **deterministic tool plus an LLM that interprets it**;
  - specialists review **independently**, with no debate;
  - specialists come from a **different vendor** than the author where possible.

---

## 2. The quality bar

These come straight from the operator. Failing any of them is a failure of the product even if the software technically works.

1. **Access control is a hard line [operator: "disaster"].** No user may ever see data they are not entitled to.
   - Every app ships with automated **role-crossing tests**: log in as each role and attempt to read, edit and list other users' and other roles' data.
   - A failure **blocks shipping**. The operator can override only after being shown, in plain English, exactly what failed and why it is safe.
2. **Numbers must be correct [operator].** Any output people rely on (reports, totals, VAT, exports) has tests built from **known worked examples** before the feature counts as done. The council bounces anything whose numbers are not proven.
3. **It must look professional [operator: "I'm charging like a pro"].**
   - One consistent, polished visual system.
   - Every page works well on a phone, since receipts are photographed on phones.
   - A design reviewer checks screenshots of every page at desktop and mobile widths.
4. **It must not break, except in exceptional circumstances [operator].** Every shipped app includes, as standard **[call]**:
   - automatic backups and a restore that has actually been tested;
   - health monitoring that alerts the **operator** before the client notices;
   - updates that take a backup first and roll back automatically if health checks fail.

   An app without these is not finished.
5. **Low friction, with a human check [operator].** Automation does the work and people confirm. For example, OCR pre-fills a receipt and the staff member confirms or corrects it. Taking friction away is the point of the product.

---

## 3. Goals, non-goals, anti-goals

**Goals**
- Build a complete web app from a brief: accounts, roles, data, files, email, reports.
- Run every finished build or change past the council, with a bounce-back loop to Conductor.
- Ship it as a self-contained bundle that runs on any ordinary Linux machine.
- Handle later change requests through the same factory, with operator approval **[operator]**.
- Treat the client's data policy as an input that shapes the build and is checked by the council.

**Non-goals (for this design)**
- Self-serve use by clients or non-technical people. The operator is the only user.
- Native phone apps, desktop installers or app-store distribution. Web apps only, which must work on phones.
- Letting the models choose the technology per project. There is one house stack (§5).
- Hosting a multi-client SaaS platform. Each client gets their own deployment.
- Public distribution of Conductor itself. This is still gated: the operator is told before Conductor ever goes public as a product (MVP spec §10).

**Anti-goals** (failures even if everything "works"):
- Cross-user data exposure.
- Wrong numbers in anything a client relies on.
- An amateur look or a clunky phone experience.
- Silent breakage that the client discovers before the operator.
- Client data leaving where the client's data policy allows. For example, receipts sent to a cloud OCR API when the policy forbids it.
- Surprise paid-API bills. The existing rule stands: paid API is opt-in only.
- Lock-in to one host or cloud vendor.

---

## 4. The pipeline

```
 meeting notes ─▶ 1. BRIEF ─▶ 2. BUILD ─▶ 3. COUNCIL ──approve──▶ 4. OPERATOR ─▶ 5. SHIP ─▶ 6. RUN
                     ▲            ▲            │                   APPROVAL                    │
                     │            └──bounce────┘                                              │
                     └──────────────── change request (same pipeline) ◀─────────────────────────┘
```

### 4.1 Brief
- **Input:** the operator's notes from a client meeting, in any form.
- **Process:**
  - A frontier model turns the notes into a **structured brief**: who the users and roles are, what each role does, data and files, outputs and reports, integrations, and a **data policy profile** (§6).
  - It asks the operator plain-English follow-up questions until nothing important is guessed, the same way this design was produced.
- **Output:** a brief the operator approves. That brief is the contract the council later checks against.
- **[call]** The brief includes **acceptance examples**: concrete worked cases (for example "a £12.40 receipt with £2.07 VAT appears in March's report under Travel") that become tests.

### 4.2 Build
- Uses the existing loop: plan, chunk, local grunt, cross-vendor review, fallback ladder and routing (Plans 1–3).
- **New: building from nothing.** Each build starts from the **house foundation** (§5) rather than an empty folder. So the factory only writes what is specific to the client, never authentication, roles, backups or styling.
- **New: multi-feature builds.** A whole app is too big for one plan. The author splits the brief into **features**, each built and reviewed in turn. The council runs once the whole build is complete (§4.3).
- **New: preview.** The operator can bring up a running preview of the app with demo data at any point, to look at it and show the client.
- **Workers are woken before a run starts [operator request, 2026-10-24]:**
  - The factory remembers which workers earlier runs used (for example the .109 desktop worker) and checks or wakes them first.
  - If one can't be woken, the operator is told plainly before any money is spent on a frontier fallback.
  - **[call]** "Before any money is spent" includes subscription usage, not only the paid API. If the local model is down, the factory asks the operator before falling back to Claude or Codex.
  - **[call]** "Waking" means whatever the worker allows: a health check, Wake-on-LAN, or remotely starting the model server. If a mechanism or credentials don't exist yet, Phase 1 adds them with the operator's approval and otherwise falls back to a clear warning.
- **Previews [call]:** at first the operator opens previews on his own network and shows them in meetings. Remote client links are later work, and need their own security review.

### 4.3 Council
- Runs on the **finished build** (or on the finished change, see §4.8), reviewing the whole app against the brief and the data policy.
- **Members** [call, from the research and the quality bar]:

| Member | Tool (the source of truth) | LLM's job | Can block? |
|---|---|---|---|
| **Security** | SAST scanner, secret scanner, dependency vulnerability check, the role-crossing tests | Discard false alarms, explain real issues, propose fixes | Yes |
| **Legal / data** | Licence scanner (code fingerprints and dependency licences); data-flow check of outbound network destinations against the data policy | Explain risks in plain English; check retention and personal-data handling against the policy and UK GDPR basics | Yes for a licence conflict or a policy breach; otherwise warns |
| **Correctness** | The full test suite, including the acceptance examples from the brief | Check the brief is fully covered; look for untested paths around money or permissions | Yes |
| **Design** | Screenshots of every page at desktop and mobile widths, plus an automated accessibility scan | Judge against the house visual system; flag clunky flows | Yes for broken or unusable layouts; otherwise warns |
| **Reliability** | Deploy into a fresh throwaway machine (see §4.7), run backup then restore, kill and restart services, check that health alerts fire | Explain any gap | Yes |
| **Efficiency** | Timed tests or load checks, before and after | Flag regressions, always with numbers | **Advisory only** |

- **Rules** [call, from the research]:
  - Each member reviews **once, independently**. Members don't see each other's verdicts, and there is no debate.
  - Where possible a member runs on a **different vendor** from the build's author.
  - A member with no tool evidence behind a finding may only warn, never block.
  - Every finding is graded **blocking / warning / note**.
- **Bounce-back:**
  - Blocking findings go back to Conductor as concrete fix tasks. Conductor fixes them and the council reviews again.
  - **[call]** The council re-runs fully after each fix, because a fix can break something elsewhere. Reruns are capped at 3 rounds.
  - Whatever is still stuck after the cap becomes a plain-English escalation to the operator, as today.
- **Output:** a **council report**: overall verdict, blocking items resolved, outstanding warnings, and notes. It is written for the operator, not as a scanner dump.

### 4.4 Operator approval
- The operator sees:
  - the council report;
  - the preview;
  - a plain-English summary of what was built;
  - the frontier cost.
- He approves, rejects, or sends specific feedback back to Conductor.
- Nothing ships without this approval. It replaces today's final gate.
- **[call]** Client sign-off happens outside the factory (the operator shows them the preview). The factory does not model the client as a user.

### 4.5 Ship
- The output is a **deployment bundle** (Docker Compose) that runs on any ordinary Linux machine **[call]**.
- Hosting is chosen **per client, according to their data policy [operator]**: either a box on the client's own network or a rented server the operator runs.
- Shipping is the same everywhere: copy the bundle to the target, start it, and verify health.
- The operator's only inputs are the target machine's address and access, plus any secrets the app needs. The factory asks for them in plain English.

### 4.6 Run
- **The operator keeps remote access to every deployment [operator: "as part of my service I have to be able to fix things in flight or add features"].**
  - Applies whether the box is on the client's network or rented. **[call]** Access is an outbound-only secure tunnel from the box, so no inbound firewall holes are needed on the client's network.
  - Clients must agree to this as a condition of the service, and it is recorded in the data policy profile.
- Every deployment reports health to the operator, through an alert channel the operator chooses. **[call]** The default is the operator's existing Matrix setup.
- Backups run automatically, and **restores are tested on a schedule**, not just on paper.
- **The backup destination varies by project [operator].** It is a field in the data policy profile (§6): client-owned storage, operator-run storage, or a cloud bucket. Backups are always encrypted, and never kept only on the same box. **[call]** Client-owned storage is the default suggestion. The Legal/data member checks the destination against the policy.
- Operating-system and dependency security updates are surfaced to the operator, who approves them, and they go out through the safe-update path (§2.4).

### 4.7 Test machines [operator: approved]
- The factory **may create and destroy its own throwaway machines** (Proxmox VMs/LXCs) without asking each time. This is for builds, previews, council deploy tests and pre-ship test deploys.
- **[call]** This permission is confined to a set-aside area: a dedicated Proxmox pool, a range of IDs, a resource cap, and a token with rights only inside that pool. Everything outside it (the operator's existing containers, the network and firewall) stays off-limits and still needs the operator.
- Every machine the factory creates is labelled with its run, cleaned up when the run ends, and swept if a run crashes.

### 4.8 Change requests [operator]
- A client change ("add mileage claims") becomes a change brief, and goes through Build, Council, Operator approval and Ship as an **update**.
- **[call]** The council reviews the **whole app** again, not only the diff.
- Every update takes a backup first and rolls back automatically if the health checks fail.
- Today's Conductor (change an existing repo, review, gate) is in effect the core of this path already.

---

## 5. The house stack and the foundation [call — operator: "leave it to you"]

- **One stack for every client app.** This is what makes the quality bar reachable: security, permission tests, backups, monitoring and styling are built and proven **once**, then reused for every client.
- **Stack:**
  - TypeScript end to end;
  - PostgreSQL;
  - one polished component library;
  - Docker Compose for packaging.

  All are mainstream, which matters because both the frontier and local models write them well. Specific framework and library choices are left to the builder (§10).
- **The foundation** is a ready-made, fully tested starter app that every build begins from. It includes:
  - accounts and sign-in, with password reset;
  - roles and a permission system;
  - the role-crossing test harness;
  - file uploads to storage;
  - transactional email;
  - an audit log;
  - the visual system and layout shell, including mobile;
  - backups and restore;
  - health monitoring;
  - safe-update and rollback scripts;
  - a demo-data seeder for previews.
- **[call]** The foundation is built and maintained as **its own project** through careful, reviewed work, not generated per build. It is the factory's most important asset.
- **[call]** The operator and Claude Code build the foundation in hand-steered sessions, because the factory can't build from nothing until Phase 5.
- **[call]** The foundation is **versioned**. Each client app records the version it was built on. Security and bug fixes to the foundation reach live apps through the normal change-request path (§4.8): council review, operator approval, and a safe update. The factory tells the operator which live apps are behind on a security fix.
- **Optional modules** are added per brief when needed: **OCR** with both local and cloud engines (the data policy decides which), PDF and spreadsheet report export, and scheduled jobs.
- **[call]** Local OCR must work acceptably on a modest CPU-only machine: no graphics card is assumed on a client box. Staff confirm every reading anyway (§2.5).

## 5a. Ownership and licences [call — operator asked what's normal; check with a solicitor before the first contract]
- This follows the common consultancy model.
  - **The client owns** the work done specifically for them (their app's own code and their data).
  - **Highland Automations keeps** the foundation and other reusable tooling as background IP. The client gets a permanent, non-exclusive licence to use it as part of their app.
- **The client receives the full source code** with each delivery, so they are never stranded.
- **Licence rule:** because source is handed over, shipped apps use only permissively licensed dependencies (for example MIT, Apache-2.0, BSD, ISC).
  - GPL, AGPL and other copyleft licences are a **blocking** finding for the Legal/data member, unless the operator explicitly accepts one for a specific project.
  - Unknown or missing licences are also blocking.

---

## 6. Data policy profile

Each brief carries a short, plain-English **data policy profile**, captured from the client meeting:
- **Hosting:** the client's own box, or a server the operator runs.
- **Where data may go:** which outside services are allowed, if any (for example "no third-party processing of receipts").
- **Data residency:** UK, UK and EU, or anywhere.
- **Retention:** how long records and files are kept, and what happens when staff leave.
- **Who can see what:** roles and their visibility, which feeds the role-crossing tests.
- **Backups:** where they go (§4.6).
- **Operator access:** confirmation that the client accepts the operator's remote access for support (§4.6).

The profile drives the build (for example local OCR versus cloud OCR) and is what the Legal/data council member checks the finished app against.

---

## 7. Constraints

- Conductor itself stays as it is: Node ESM, zero dependencies, frontier models through the operator's Claude and Codex **subscriptions**, and the local model on CT110 and the .109 worker. Paid API stays opt-in.
- The foundation and client apps may use dependencies, unlike Conductor itself. Every dependency is licence-checked by the council.
- Council tools must be free and run locally where possible (for example Semgrep and ScanCode), so a council run costs as few frontier tokens as possible.
- **Client data never goes to the factory's models.** The factory works with code and demo data only. Real client data lives only in the deployment.
- Everything must work on the operator's existing homelab (Proxmox) for building and previews.

---

## 8. Suggested build order [call]

Each phase is its own plan, and each delivers something usable on its own.
1. **Wake workers and readiness:** small, and fixes the run-2 smoke finding.
2. **Council v1 on today's flow:** add the council stage to the existing "change a repo" pipeline, with the security, legal and correctness members first. This gives value immediately on any repo.
   - **[call]** It is **opt-in** (a flag) on ordinary repos, so existing runs don't pay for it by default.
   - It runs after today's final review.
   - On a repo with no brief or data policy, the members cut down to what they can check: Security fully; Legal for licences only; Correctness against the tests and the request.
3. **Foundation:** the house starter app, built to the full quality bar, including role-crossing tests, backups and monitoring.
4. **Brief intake:** from meeting notes to an approved brief, with the data policy profile and acceptance examples.
5. **Building from nothing:** multi-feature builds on top of the foundation, plus previews.
6. **Full council:** add the design and reliability members, run the full-app review, and add the bounce-back cap.
7. **Ship and run:** deployment bundles, deploy to a target, alerts, scheduled restore tests, safe updates.
8. **Change requests on live apps:** connect the change path end to end.
9. **Acceptance test:** build the expenses tracker through the factory, from real meeting notes.

---

## 9. Long-term direction (not in scope)

- Self-serve use by a tech-illiterate person, without an operator in the loop.
- A friendlier interface than the terminal.
- Public distribution of Conductor (this needs the operator's go-ahead first, plus security hardening).
- **"Ask me anything" [operator, 2026-10-25]:** the factory should eventually build almost anything, up to and including complex agentic software and video games. The planned route keeps the same core (three-headed build loop, council, operator approval) and adds:
  - **one foundation per kind of software**, for example a game-engine starter or an agent-framework starter, each its own project like the web foundation;
  - **council members per kind**, for example a playtester agent for games, and for agentic software an adversarial-prompt and runaway-cost reviewer;
  - **a "what kind of thing is this?" step** at the brief, which picks the foundation and the council.

  Unsupported kinds are refused rather than built badly.
  - **[call] Suggested order:** web apps proven first, through the expenses tracker; then agentic software; then games, which need the most operator playtesting because "is it fun" isn't tool-checkable.
- **Near-term widening (web):** more optional modules, for example payments, Xero/QuickBooks, calendar sync, SMS, and connectors to client systems.

---

## 10. Left to the builder

- Specific web framework, component library, authentication library and OCR engines within the house stack.
- Which SAST, secret, licence and accessibility tools the council uses, as long as they are free and local where possible.
- The monitoring and alerting mechanism, and the backup tooling.
- The exact council prompts, how findings are formatted internally, and how the council report is laid out.
- How the author splits a brief into features.
- The format of the brief and the data policy profile on disk.
