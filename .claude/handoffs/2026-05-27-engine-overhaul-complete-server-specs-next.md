# Handoff — #209 engine overhaul complete; next = implement server specs

**Date**: 2026-05-27
**Project**: major (`~/Projects/major`) driving healthbite (`MioMarker/healthbite`)
**Branch**: major `dev` @ `494f79d` (#182 merged). No uncommitted code this session.

## TL;DR
The #209 "Route 1 insight engine" overhaul is **14/14 briefs terminal — 100% complete**; all healthbite PRs merged to `dev`. Also shipped the recurring **#180 heartbeat-wedge fix** (major PR #182, merged to `dev`, **not yet deployed**) and **client-side PDF export** (#253, needs an EAS build). **Key reality:** the engine is server-first and **mostly dormant** — only `sleep_duration` is implemented server-side; the other ~100 re-expressed specs are classified+cited but not yet firing. Next epic = implement those server specs.

## What landed
**healthbite (all merged → `dev`):** #243 (74 enrichment), #245 (77 correlation explorer), #246 (79 eval coverage), #247 (86 strength/bloodwork), #248 (90 cross-domain C), #249 (84 sleep), #250 (83 heart/BP), #251 (88 cross-domain fitness/cardio), #252 (76 rendering cutover), #253 (78 PDF export). (74/77/85/87/89 done before/early session.)
**major:** #182 — `Fix #180: attribute heartbeat lease-loss to the Run it was sent for` (ADR 024 + `shell/main.ts callHeartbeat` guard + `shell/main.test.ts` F-10/ADR-024 cases, 103 pass).

## Deployed / live state
- **healthbite `dev`** has the full overhaul. **NOT** deployed to prod, **no EAS build** triggered.
- **Engine is DORMANT**: client rules `detect()→null` (e.g. `sleepRules.ts` emptied); server `supabase/functions/generate-health-findings/` implements **only `sleep_duration`** (`specs/sleepDuration.ts`). The ~100 specs in `src/services/insights/rules/sources.ts` are scaffolded, not evaluated. Plumbing (`useFindings`→edge fn→`findings` table→`RuleInsightCard`→`CitationFooter`) is proven by that one spec.
- **#180 fix (#182) merged but UNDEPLOYED** — live Shells still run pre-fix code (self-heal through spurious-abort blips). Needs Shell image rebuild + restart to go live.
- **PDF export (#253)** code-complete but native modules (`expo-print`/`expo-sharing`) need an EAS rebuild to run on-device.

## Open threads (concrete next actions)
1. **NEXT EPIC — implement the dormant server specs.** Port ~100 re-expressed specs into `supabase/functions/generate-health-findings/specs/*.ts` (reference: `sleepDuration.ts` → `SpecResult {citation_id, confidence, data_sufficient, first_pass_surface}`). Batch by domain (heart/BP, nutrition-micro, strength, bloodwork, sleep-lifestyle, fitness-cardio). **Natural Major-driven batch like #209.** User asked me to consider scoping this.
2. Make `generate-health-findings/index.ts` iterate **all** specs (today sleep-only) + add per-domain signal RPCs.
3. Flip eval gate (`src/engine/evaluation_pipeline.js`, ADR 005) advisory→CI-enforced once specs are live (coverage/stability/FP bars).
4. Wire in standalone analytics: `engine/enrichment/*.py` (covariate sweep/regime/peer-group) + correlation explorer (`api/analyze-correlation.js`) — need finding adapters to reach the feed.
5. **Deploy #180 fix** (safe now — no active runs): `docker rm -f shell-A shell-B` then `scripts/shell-up.sh` (rebuild + restart Shells).
6. EAS build for PDF native modules (user's call).
7. Optional: write `docs/insight-engine-map.md` (engine spans 6 dirs) + consider a consolidation pass.

## Gotchas surfaced
- **Re-arm mechanics:** a content-FAILED brief re-armed by status-flip alone resumes a futile `repair` loop. Force a fresh `execute` by **bumping the content revision** (`claim_next_brief` branch 2: `current_revision_id > prior run's started_against_revision_id` → reset to attempt 1 execute). Wedge-victims (prior `cancelled`) re-arm to execute via plain status-flip. (Memory: `feedback_major_rearm_revision_bump`.)
- **The "#209 briefs failed because too big" hypothesis was WRONG.** Real causes: under-specified `expected_paths` (planner `expansion-needed`/`expected-paths-insufficient`), one stream-idle-timeout (83), one protected-path block (78). Fix was widen-paths + revision-bump retry — **zero splits needed**.
- **#180 root cause:** TOCTOU race in `shell/main.ts callHeartbeat` — an idle/stale heartbeat (no `runId` → `renewedRun=false` unconditionally) lands during the await right after a Brief is claimed and poisons the fresh run's `leaseLostFlag`. Fixed by attributing lease-loss to the sent `runId` (#182).
- **`app.config.ts` is path-blocker-protected**, but `expo-print`/`expo-sharing` autolink (no config-plugin entry needed), so 78 never actually needed it — it had just mis-planned an `app.config.ts` edit.
- **Operator REST ops:** writes to `major.*` need `Content-Profile: major`; `REST="${MAJOR_API_BASE_URL%/functions/v1}/rest/v1"` (env has `MAJOR_API_BASE_URL`, not `SUPABASE_URL`). Re-arm = guarded PATCH `&status=eq.<expected>`.

## How to verify state
```bash
cd ~/Projects/major && set -a && source shell/.env && set +a
REST="${MAJOR_API_BASE_URL%/functions/v1}/rest/v1"
A=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Accept-Profile: major")
curl -s "$REST/briefs?source_issue_repo=eq.MioMarker/healthbite&source_issue_number=gte.206&select=id,status&order=id.asc" "${A[@]}"  # expect all done/wontfix
gh pr list --repo MioMarker/healthbite --state open   # expect none
git -C ~/Projects/major log -1 --oneline   # expect 494f79d (#182)
docker ps --filter name=shell- --format '{{.Names}} {{.Status}}'   # shells still on pre-#182 image
# engine liveness: how many server specs are implemented (expect ~1: sleepDuration)
ls ~/Projects/healthbite/supabase/functions/generate-health-findings/specs/ 2>/dev/null  # local may be behind dev — use a fresh worktree off origin/dev
```

## Pointers
- Prior handoff: `.claude/handoffs/2026-05-26-engine-overhaul-209-drain-merges-wedges.md`
- #180 fix: `docs/adr/024-heartbeat-lease-loss-run-attribution.md`, `shell/main.ts::callHeartbeat`, major PR #182
- Engine spine (healthbite): `src/services/insights/rules/sources.ts` (registry) + `supabase/functions/generate-health-findings/` (executor); rendering `src/hooks/useFindings.ts` + `src/components/health/{RuleInsightsFeed,RuleInsightCard,CitationFooter}.tsx`; eval `src/engine/evaluation_pipeline.js`
- Memory (this session): `feedback_major_rearm_revision_bump` (+ existing `feedback_major_operator_patch_guard`)
- Cyberbrain REST recipe: `~/projects/personal-nix/wiki/recipes/major-cyberbrain-rest-ops.md`; wedge runbook: `~/projects/personal-nix/wiki/runbooks/major-shell-180-hung-tachikoma-recovery.md`
