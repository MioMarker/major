import { getMockItem, listMockItems, listMockQaItems } from "@/lib/mock/items";
import type { ItemDetail, WorkItem, WorkItemClassification, WorkItemStatus } from "@/lib/types";
import { USE_MOCK, majorFetch } from "@/lib/api/client";

export interface ListItemsFilters {
  status?: WorkItemStatus;
  classification?: WorkItemClassification;
  ageMaxHours?: number;
  authToken?: string;
}

export async function listItems(filters: ListItemsFilters = {}): Promise<WorkItem[]> {
  if (USE_MOCK) {
    return listMockItems({
      status: filters.status,
      classification: filters.classification,
    });
  }
  // API contract: GET ?status=&classification=&repo=&limit=&offset=
  // Returns { items: WorkItem[], total: number }. ageMaxHours is filtered client-side.
  const resp = await majorFetch<{ items: WorkItem[]; total: number }>("major-list-items", {
    query: {
      status: filters.status,
      classification: filters.classification,
    },
    authToken: filters.authToken,
  });
  let items = resp.items;
  if (filters.ageMaxHours !== undefined) {
    const cutoff = Date.now() - filters.ageMaxHours * 3_600_000;
    items = items.filter((i) => new Date(i.created_at).getTime() >= cutoff);
  }
  return items;
}

export async function getItem(id: number, authToken?: string): Promise<ItemDetail | null> {
  if (USE_MOCK) {
    return getMockItem(id);
  }
  return majorFetch<ItemDetail>(`major-get-item`, {
    query: { id },
    authToken,
  });
}

export async function listQaItems(authToken?: string): Promise<WorkItem[]> {
  if (USE_MOCK) {
    return listMockQaItems();
  }
  const resp = await majorFetch<{ items: WorkItem[]; total: number }>("major-list-items", {
    query: { status: "ready-for-review" },
    authToken,
  });
  return resp.items;
}

export async function confirmQa(
  itemId: number,
  authToken?: string,
): Promise<{ itemId: number; status: "done" }> {
  if (USE_MOCK) {
    return { itemId, status: "done" };
  }
  return majorFetch<{ itemId: number; status: "done" }>("major-confirm-qa", {
    method: "POST",
    body: { itemId },
    authToken,
  });
}

export async function rejectItem(
  itemId: number,
  reason: string,
  authToken?: string,
): Promise<{ itemId: number; status: "wontfix" }> {
  if (USE_MOCK) {
    return { itemId, status: "wontfix" };
  }
  return majorFetch<{ itemId: number; status: "wontfix" }>("major-reject-item", {
    method: "POST",
    body: { itemId, reason },
    authToken,
  });
}
