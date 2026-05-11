# Major — User Guide

How to use Major to get engineering work done. This guide is for the two operators (Jonathan and Paul) who use the Major UI day-to-day.

For architecture and primitives see `SPEC.md`. For failure recovery see `failure-modes.md`. For Brief status meanings see `brief-lifecycle.md`.

---

## What Major does

You write a Brief — a crafted engineering task — and Major dispatches it to a Shell, which spins up a Tachikoma (Claude Code) to implement the work, open a PR, and post a review. You confirm QA and merge. Major logs everything.

The normal path from idea to merged PR:

```
you write → Triage Session → Brief in queue → Shell claims it → Tachikoma implements
→ PR opened + reviewed → you confirm QA → PR merged → Brief done
```

---

## 1. Starting a Triage Session

A Triage Session is a conversation where you describe the work, get grilled by an AI, and end up with a structured Brief ready for the queue.

1. Go to **Triage** in the nav.
2. Click **New Triage Session**.
3. Describe what you want built. Be specific: which repo, what the problem is, rough scope.
4. The Triage AI will ask clarifying questions — answer them. It's building a PRD (the Brief's Content) and filling in metadata (expected file paths, classification, queue rank).
5. When grilling is done, click **Apply**. This runs the path-blocker check and either auto-applies the Change Set or queues it for your manual apply (see §5 below).

**Tips:**
- Include Acceptance Criteria in your description ("the fix should pass all existing tests and handle the case where X").
- Include Scope Boundaries ("don't touch the auth flow, only change the meals query").
- Name the files you expect to change if you know them — this is `expected_paths` and affects path-blocker routing.

---

## 2. Watching a Brief move through the queue

After a Triage Session applies, the Brief appears in the **Briefs View** (the `/` home page).

Useful filters:
- **`ready-for-triage`** — Brief exists but hasn't been triaged yet. Shouldn't linger here long.
- **`ready-for-agent`** — queued, waiting for a Shell to pick it up.
- **`agent-running`** — a Shell is working on it right now.
- **`ready-for-review`** — implementer done, PR open, reviewer pass done. Your turn.
- **`ready-for-human`** — something went wrong; needs your attention.

Click any row to open **Brief Detail**.

---

## 3. Reviewing and confirming QA

When a Brief reaches `ready-for-review`:

1. Go to **Pending QA** in the nav (or filter Briefs View to `ready-for-review`).
2. Click **PR ↗** on the card to open the GitHub PR.
3. Review the diff. The reviewer Tachikoma has already posted comments — read them.
4. If the work looks good: click **QA Confirmed**. The Brief transitions to `done`. If the source Brief came from a GitHub issue, that issue closes automatically.
5. If the work is wrong or incomplete: click **Reject** in Brief Detail. The Brief moves to `wontfix`. You can then open a new Triage Session to create a revised Brief.

You cannot merge a PR directly and skip QA Confirmed — but if you merge the PR via GitHub, the webhook fires and transitions the Brief to `done` automatically, with your GitHub login as the acceptance Actor.

---

## 4. Handling `ready-for-human`

A Brief lands at `ready-for-human` when a Run failed and the Shell couldn't auto-recover. This is not a crisis — it's the pressure release valve.

**To diagnose:**
1. Open Brief Detail.
2. Click the **Events** tab — look for the most recent `run-ended` event; its payload has `cancellationReason` or a `summary`.
3. Click the **Runs** tab — find the failed Run; check its outcome.
4. Click the **Verification** tab — see which checks failed.

**Common causes and responses:**

| What you see | What to do |
|---|---|
| Tachikoma ran out of turns without finishing | Brief Content may lack enough detail. Add more guidance via Triage, which creates a new Content Revision and re-routes to `ready-for-agent`. Or just Re-arm if you think a retry will succeed. |
| `tsc` errors the Tachikoma couldn't fix | The Brief scope may be too large or the PRD unclear. Edit Content, or take over the branch manually. |
| Sandbox couldn't clone the repo | Transient infrastructure issue. Hit **Re-arm** to retry. |
| Lease expired (heartbeat lapse) | Shell was too slow or crashed. Hit **Re-arm** — a fresh Shell will pick it up. |

**Re-arm** button appears on Brief Detail when the Brief is in `ready-for-human`. It resets the Brief to `ready-for-agent` and records the action as an Event.

---

## 5. Path-blocker and manual Change Set apply

When a Triage Session tries to apply a Change Set that touches protected paths (like `supabase/migrations/**` or `.claude/rules/**`), the Change Set is queued for manual apply instead of auto-applying.

You'll see a **Needs Human Apply** badge in the Briefs View.

To manually apply:
1. Open the Triage Session that produced the Change Set.
2. Review the proposed operations — each one is listed with its type and affected paths.
3. Click **Apply** if it looks correct.

To edit the protected glob list: **Settings → Path-Blocker**. Add or remove globs; the new list takes effect on the next Change Set apply.

---

## 6. Managing the queue

Briefs are dispatched in ascending `queue_rank` order (lower number = higher priority). Queue rank is set during Triage and can be adjusted via a new Triage Session on an existing Brief.

**When to re-rank:** if a new Brief is urgent and should jump the queue, set a lower `queue_rank` during triage. A re-rank affecting more than 5 Briefs at once is caught by the path-blocker and requires manual apply.

**When to wontfix:** if a queued Brief is no longer needed, click **Reject** in Brief Detail. This moves it to `wontfix` (terminal). No Run will ever start on a `wontfix` Brief.

---

## 7. Settings

**Settings** covers three areas:

| Setting | Purpose |
|---|---|
| Path-Blocker globs | Protected file patterns that require human apply of any Change Set touching them. Default list covers migrations, eval, Claude rules, and `app.config.ts`. |
| Mass-rerank threshold | How many Briefs a single Change Set can re-rank before requiring manual apply. Default: 5. |
| Shell pool hint | Informational — how many Shells you intend to run. Does not start or stop containers. |
| Auto-triage toggles | Whether Auto Triage Runs are enabled for incoming GitHub issues. |

---

## 8. UI at a glance

| Route | What it is |
|---|---|
| `/` | **Briefs View** — all Briefs, filterable by status and classification, sorted by queue rank |
| `/briefs/[id]` | **Brief Detail** — Content, Events, Runs, Verification, Artifacts, Telemetry, Relationships |
| `/triage` | **Triage** — list of Triage Sessions; start a new one here |
| `/triage/[id]` | **Triage Session** — chat surface, Apply button, PRD draft pane |
| `/qa` | **Pending QA** — Briefs in `ready-for-review`; QA Confirmed action |
| `/settings` | **Settings** — path-blocker config, Shell pool, auto-triage toggles |
