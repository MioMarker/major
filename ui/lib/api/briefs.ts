import { getMockBrief, listMockBriefs, listMockQaBriefs } from "@/lib/mock/briefs";
import type { Brief, BriefClassification, BriefDetail, BriefStatus } from "@/lib/types";
import { USE_MOCK, majorFetch } from "@/lib/api/client";

export interface ListBriefsFilters {
  status?: BriefStatus;
  classification?: BriefClassification;
  ageMaxHours?: number;
  authToken?: string;
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
  const resp = await majorFetch<{ briefs: Brief[]; total: number }>("major-list-briefs", {
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

export async function getBrief(id: number, authToken?: string): Promise<BriefDetail | null> {
  if (USE_MOCK) {
    return getMockBrief(id);
  }
  return majorFetch<BriefDetail>(`major-get-brief`, {
    query: { briefId: id },
    authToken,
  });
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
