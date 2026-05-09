# UI Conventions

Major UI is a Next.js 14 App Router app deployed on Vercel free tier. Auth via Supabase. UI is `ui/` — a single Next app, not a monorepo workspace.

## App Router Only

- All routing under `ui/app/`. No legacy `pages/` directory.
- Default to **server components**; opt into client components explicitly with `"use client"` at the top of the file when interactivity demands it (forms, charts, mutations using SWR, anything with `useState` / `useEffect`).
- Data fetching for server components uses the Supabase server client directly. Client components mutate via the typed wrappers in `ui/lib/api/`.

## Tailwind

- Tailwind is the styling system. No CSS-in-JS, no styled-components, no module CSS files.
- Use Tailwind utility classes. Compose with `clsx` (or `cn` if shadcn ships it) for conditional classes.
- **No inline `style={{...}}` objects.** Tailwind covers everything we need; if you can't express it in utilities, that's a sign to lift the decision (theme token, design system, etc.).
- Theme tokens (colors, spacing, radius) live in `ui/tailwind.config.ts`. Don't hardcode hex values in components.

## shadcn/ui

- shadcn/ui is the component library. Install components per the shadcn workflow (`npx shadcn-ui add ...`); installed components live in `ui/components/ui/`.
- Compose shadcn primitives in domain components under `ui/components/<domain>/` (e.g., `ui/components/items/ItemList.tsx`, `ui/components/triage/TriageMessageInput.tsx`).
- Don't fork shadcn primitives unless the change is generic and reusable.

## Types from `db/types.ts`

The DB schema generates TypeScript types in `db/types.ts`. The UI consumes these directly:

```ts
import type { WorkItem, Run, Event } from "@/db/types";
```

When the UI needs a derived shape (e.g., a hydrated Item with relationships and recent events for the Item Detail view), define it in `ui/lib/types.ts` next to the query:

```ts
import type { WorkItem, Run, Event, WorkItemArtifact } from "@/db/types";

export type HydratedWorkItem = WorkItem & {
  recentRuns: ReadonlyArray<Run>;
  events: ReadonlyArray<Event>;
  artifacts: ReadonlyArray<WorkItemArtifact>;
};
```

`db/types.ts` is the source of truth for column-level shapes; `ui/lib/types.ts` adds UI-only composites. Don't duplicate column-level definitions in `ui/lib/types.ts`.

## File Layout

```
ui/
├── app/                      # App Router routes
│   ├── (authenticated)/      # auth-gated layout
│   │   ├── items/            # Items View, Item Detail
│   │   ├── triage/           # Triage list, session detail
│   │   ├── pending-qa/       # QA-confirmation surface
│   │   └── settings/         # path-blocker editor, runner pool
│   ├── auth/                 # sign-in, callback
│   └── layout.tsx
├── components/
│   ├── ui/                   # shadcn primitives
│   ├── items/
│   ├── triage/
│   └── ...
├── lib/
│   ├── api/                  # client-side mutators (SWR + edge-function calls)
│   ├── supabase/             # browser + server client factories
│   └── types.ts              # UI composite types
└── tailwind.config.ts
```

## Data Fetching

- **Server components**: fetch directly via the Supabase server client. No SWR.
- **Client components**: SWR for reads with revalidation needs (Items View needs polling; Item Detail polls events). Direct edge-function calls for mutations.
- Use array SWR keys for cache granularity: `useSWR(["items", filters], fetcher)`.
- After mutations, `mutate(...)` the affected keys.

## Forms & Validation

- Reuse Zod schemas from `_shared/schemas/` when the form maps to an edge function call. The same schema validates the form locally and validates the request body server-side.
- React Hook Form (or shadcn's form helpers if simpler) for form state. No custom form state machines.

## Accessibility

- shadcn primitives are accessible by default. Don't strip ARIA attributes.
- Keyboard navigation: every interactive element must be focusable and operable via keyboard.
- Color contrast meets WCAG AA. Tailwind tokens chosen accordingly.

## Never

- Never use the `pages/` directory.
- Never use inline `style={{...}}`.
- Never duplicate `db/types.ts` column types in `ui/lib/types.ts`. Composites only.
- Never call edge functions directly from server components for write operations — use the typed wrappers in `ui/lib/api/`.
- Never store auth tokens in `localStorage`. The Supabase client handles session storage; let it.
