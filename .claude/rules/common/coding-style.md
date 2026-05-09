# Coding Style

TypeScript strict throughout. Major's code is small enough that discipline costs nothing and pays compound interest.

## Type Safety

- **TypeScript strict mode is on.** All new code is TypeScript; no JavaScript files.
- **Never use `any`.** Use `unknown` and narrow with type guards.
- **Never use type assertions (`as Type`).** Use type guards, narrowing, or schema validation. The exception is `as const` for literal-narrowing in const-assertions.
- **Never use `enum`.** Use `as const` objects + union types:
  ```ts
  // Wrong
  enum Status { Ready = "ready", Running = "running" }

  // Correct
  const STATUS = { ready: "ready", running: "running" } as const;
  type Status = typeof STATUS[keyof typeof STATUS];
  ```
- Leverage type inference; don't annotate what TypeScript can infer.

## Immutability

Always create new objects; never mutate existing ones. Immutable data prevents hidden side effects, makes debugging easier, and enables safe concurrency.

```ts
// Wrong — mutates input
function addEvent(events: Event[], next: Event) { events.push(next); return events; }

// Correct
function addEvent(events: readonly Event[], next: Event) { return [...events, next]; }
```

## Naming

- `camelCase` for variables, functions, properties
- `PascalCase` for classes, types, React components
- `UPPER_SNAKE_CASE` for constants and prompt versions
- Prefix unused destructured fields with `_` to silence the linter intentionally

## Preferences

- `??` over `||` for null/undefined fallback
- `?.` for safely accessing nested properties
- `async/await` over Promise chains
- Destructuring where it improves readability
- Arrow functions for anonymous functions
- Template literals for string interpolation
- No `console.log` in shipped code — use a logger with prefix (`[FunctionName]`, `[Runner]`, etc.)

## File Organization

**Many small files beat a few large ones.**

- 200–400 lines is typical; 800 is the upper bound. If you're past 600 and still adding, split.
- One concern per file. A file should have a name that describes its single responsibility.
- Organize by feature/domain, not by file type. `supabase/functions/major-claim-item/` is a folder, not a layer.

## Schema-Validated User Input

All user input crossing a boundary (HTTP body, env var, file content, GitHub webhook payload) MUST be validated by a schema before use.

- Use Zod (or the equivalent in Deno's edge functions). Define schemas in `_shared/schemas/` and reuse.
- Fail fast with a clear error message that names the offending field.
- Never trust external data (API responses, user input, file content).

```ts
import { z } from "zod";

const ClaimItemRequest = z.object({
  runner_instance_id: z.string().uuid(),
  work_item_id: z.string().uuid(),
});

const parsed = ClaimItemRequest.safeParse(await req.json());
if (!parsed.success) return errorResponse(parsed.error.message, 400);
```

## Error Handling

- Handle errors explicitly at every level. No silent swallowing.
- User-facing surfaces (UI, API responses) get user-friendly messages.
- Server-side logs include detailed context (`error.message`, `error.stack`, request id, Item id).
- Never let an error message leak a stack trace or DB internals to the client.

## Code Quality Checklist

Before marking work complete:

- [ ] No `any`, no `as`, no `enum`
- [ ] All user input validated by a schema
- [ ] Functions are small (< 50 lines typical)
- [ ] Files focused (< 800 lines)
- [ ] No deep nesting (> 4 levels)
- [ ] Errors handled, not swallowed
- [ ] No hardcoded secrets or magic numbers — use constants or config
- [ ] Immutable patterns (no mutation of inputs or shared state)
