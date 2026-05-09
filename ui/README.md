# Major UI

Next.js 14 (App Router) front-end for Major. Hosted on Vercel free tier; auth via Supabase email magic link; data via Major edge functions.

## Stack

- Next.js 14 (App Router, TypeScript strict)
- Tailwind CSS + shadcn/ui (button, card, table, badge, dialog, input, textarea, tabs, dropdown-menu, scroll-area)
- `@supabase/ssr` + `@supabase/supabase-js` for auth and (later) realtime

## Scripts

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start (prod server)
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
```

## Environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (`https://nuihvxluxdpdjgkvtdih.supabase.co` for staging) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key for browser-side auth |
| `NEXT_PUBLIC_MAJOR_API_BASE_URL` | Edge function base URL (e.g. `https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1`) |
| `NEXT_PUBLIC_USE_MOCK` | `1` to use bundled mock data; unset/`0` to hit the real API |

Copy `.env.example` to `.env.local` for local dev.

## Mock mode

Until the Major API is deployed (Phase 3), set `NEXT_PUBLIC_USE_MOCK=1`. All API wrappers in `lib/api/*` short-circuit to fixtures from `lib/mock/*`. Auth middleware also no-ops in mock mode so you can navigate every surface without signing in.

## Surfaces

| Path | Purpose |
|---|---|
| `/` | Items View — filter + sort by queue rank |
| `/items/[id]` | Item Detail with tabs: Content, Events, Runs, Verification, Artifacts, Relationships |
| `/triage` | Triage Sessions list + new-session button |
| `/triage/[id]` | Chat surface with grilling, Apply button, draft PRD pane |
| `/qa` | Pending QA — items in `ready-for-review`, "QA Confirmed" action |
| `/settings` | Path-blocker globs, mass-rerank threshold, runner pool hint, auto-triage toggles |
| `/login` | Email magic-link sign-in |
| `/auth/callback` | Supabase OAuth callback route |

## Deploying to Vercel

```bash
# one-time
npx vercel link
# every deploy
npx vercel --prod
```

Configure the four env vars above in the Vercel dashboard. The repo's `vercel.json` is intentionally absent — defaults work.

## Notes

- `middleware.ts` enforces auth on every non-public route in non-mock mode.
- Types in `lib/types.ts` mirror `db/0001_initial_schema.sql`. In Phase 3 these should be re-exported from a generated `@/db/types` once the DB types are produced.
- API wrappers route through `lib/api/client.ts` with `NEXT_PUBLIC_MAJOR_API_BASE_URL` and `NEXT_PUBLIC_USE_MOCK` switches.
