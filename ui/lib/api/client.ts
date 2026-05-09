// Shared API client. Per SPEC's "API surface", every endpoint hangs off the
// edge function base URL with the `major-` prefix. When NEXT_PUBLIC_USE_MOCK=1
// the wrappers return mock data without ever hitting the network.

export const USE_MOCK =
  (process.env.NEXT_PUBLIC_USE_MOCK ?? "1") === "1";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_MAJOR_API_BASE_URL ?? "";

export class MajorApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface FetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  authToken?: string;
}

export async function majorFetch<TResponse>(
  path: string,
  options: FetchOptions = {},
): Promise<TResponse> {
  if (!API_BASE_URL && !USE_MOCK) {
    throw new MajorApiError(
      500,
      "NEXT_PUBLIC_MAJOR_API_BASE_URL is not set and USE_MOCK is off",
      null,
    );
  }

  const url = new URL(`${API_BASE_URL}/${path.replace(/^\//, "")}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.authToken) {
    headers.authorization = `Bearer ${options.authToken}`;
  }

  const res = await fetch(url.toString(), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    cache: "no-store",
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const errMessage =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new MajorApiError(res.status, errMessage, parsed);
  }

  return parsed as TResponse;
}
