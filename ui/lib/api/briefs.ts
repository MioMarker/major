import { getMockBrief, listMockBriefs, listMockBriefsPaged, listMockQaBriefs } from "@/lib/mock/briefs";
import type { Brief, BriefClassification, BriefDetail, BriefStatus, Run } from "@/lib/types";
import { USE_MOCK, majorFetch } from "@/lib/api/client";

// Extended Run type exposing attempt_number from ADR 014 (briefs.max_attempts /
// runs.attempt_number). These fields exist in the DB schema (db/types.ts) but are
// not yet reflected in ui/lib/types.ts.
export type RunWithAttempt = Run & { attempt_number: number };

// Extended BriefDetail with attempt tracking fields.
export type BriefDetailWithAttempts = Omit<BriefDetail, "runs"> & {
  max_attempts: number;
  runs: RunWithAttempt[];
};

export interface ListBriefsFilters {
  status?: BriefStatus;
  classification?: BriefClassification;
  ageMaxHours?: number;
  authToken?: string;
}

// Paging window passed through to the `major-list-briefs` endpoint. `limit`
// clamps server-side to 1–200 (default 50); `offset` is 0-based.
export interface BriefsPage {
  limit?: number;
  offset?: number;
}

export interface BriefsListResult {
  briefs: Brief[];
  total: number;
}

export async function listBriefs(filters: ListBriefsFilters = {}): Promise<Brief[]> {
  if (USE_MOCK) {
    return listMockBriefs({
      status: filters.status,
      classification: filters.classification,
    });
  }
  // API contract: GET ?status=&classification=&repo=&limit=&offset=
  // Returns { briefs: Brief[], total: number }. ageMaxHours is filtered client-side.
  const resp = await majorFetch<BriefsListResult>("major-list-briefs", {
    query: {
      status: filters.status,
      classification: filters.classification,
    },
    authToken: filters.authToken,
  });
  let briefs = resp.briefs;
  if (filters.ageMaxHours !== undefined) {
    const cutoff = Date.now() - filters.ageMaxHours * 3_600_000;
    briefs = briefs.filter((b) => new Date(b.created_at).getTime() >= cutoff);
  }
  return briefs;
}

// Paged variant for the Briefs View. Surfaces `total` so the UI can render a
// page count and Prev/Next controls. Unlike `listBriefs`, this does NOT support
// `ageMaxHours` — that filter runs client-side against a single fetched window
// and would make `total` meaningless under paging, so it's intentionally
// excluded from the paged path.
export async function listBriefsPaged(
  filters: ListBriefsFilters = {},
  page: BriefsPage = {},
): Promise<BriefsListResult> {
  if (USE_MOCK) {
    return listMockBriefsPaged(
      { status: filters.status, classification: filters.classification },
      page,
    );
  }
  return majorFetch<BriefsListResult>("major-list-briefs", {
    query: {
      status: filters.status,
      classification: filters.classification,
      limit: page.limit,
      offset: page.offset,
    },
    authToken: filters.authToken,
  });
}

export async function getBrief(id: number, authToken?: string): Promise<BriefDetailWithAttempts | null> {
  if (USE_MOCK) {
    const mock = getMockBrief(id);
    if (!mock) return null;
    return {
      ...mock,
      max_attempts: 3,
      runs: mock.runs.map((r) => ({ ...r, attempt_number: 1 })),
    };
  }
  return majorFetch<BriefDetailWithAttempts>(`major-get-brief`, {
    query: { briefId: id },
    authToken,
  });
}

// Snapshot of every Brief whose status makes it eligible for a Mode 1 merge
// attempt (ADR 016): `ready-for-review` (never tried) plus `merge-blocked`
// (last attempt failed; can be retried). Two API calls because the
// `major-list-briefs` endpoint accepts a single status; the result is the
// union, in the order returned.
export async function listBriefsEligibleForMerge(
  authToken?: string,
): Promise<Brief[]> {
  const [reviewBriefs, blockedBriefs] = await Promise.all([
    listBriefs({ status: "ready-for-review", authToken }),
    listBriefs({ status: "merge-blocked", authToken }),
  ]);
  return [...reviewBriefs, ...blockedBriefs];
}

export async function listQaBriefs(authToken?: string): Promise<Brief[]> {
  if (USE_MOCK) {
    return listMockQaBriefs();
  }
  const resp = await majorFetch<{ briefs: Brief[]; total: number }>("major-list-briefs", {
    query: { status: "ready-for-review" },
    authToken,
  });
  return resp.briefs;
}

export async function confirmQa(
  briefId: number,
  authToken?: string,
): Promise<{ briefId: number; status: "done" }> {
  if (USE_MOCK) {
    return { briefId, status: "done" };
  }
  return majorFetch<{ briefId: number; status: "done" }>("major-confirm-qa", {
    method: "POST",
    body: { briefId },
    authToken,
  });
}

export async function rejectBrief(
  briefId: number,
  reason: string,
  authToken?: string,
): Promise<{ briefId: number; status: "wontfix" }> {
  if (USE_MOCK) {
    return { briefId, status: "wontfix" };
  }
  return majorFetch<{ briefId: number; status: "wontfix" }>("major-reject-brief", {
    method: "POST",
    body: { briefId, reason },
    authToken,
  });
}

export async function rearmBrief(
  briefId: number,
  reason?: string,
  authToken?: string,
): Promise<{ briefId: number; status: "ready-for-agent" }> {
  if (USE_MOCK) {
    return { briefId, status: "ready-for-agent" };
  }
  return majorFetch<{ briefId: number; status: "ready-for-agent" }>("major-rearm-brief", {
    method: "POST",
    body: { briefId, reason },
    authToken,
  });
}

export async function rearmAsRepair(
  briefId: number,
  authToken?: string,
): Promise<{ ok: boolean }> {
  if (USE_MOCK) return { ok: true };
  return majorFetch<{ ok: boolean }>("major-rearm-brief", {
    method: "POST",
    body: { briefId, mode: "repair-override" },
    authToken,
  });
}

export async function deleteBrief(
  briefId: number,
  authToken?: string,
): Promise<{ briefId: number; deleted: boolean }> {
  if (USE_MOCK) {
    return { briefId, deleted: true };
  }
  return majorFetch<{ briefId: number; deleted: boolean }>("major-delete-brief", {
    method: "POST",
    body: { briefId },
    authToken,
  });
}

export async function quickStart(
  authToken?: string,
): Promise<{ triaged: number; readyForAgent: number }> {
  if (USE_MOCK) {
    return { triaged: 3, readyForAgent: 2 };
  }
  return majorFetch<{ triaged: number; readyForAgent: number }>("major-quick-start", {
    method: "POST",
    authToken,
  });
}
