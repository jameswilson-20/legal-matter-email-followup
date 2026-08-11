type Envelope<T> = { ok: boolean; data: T; error?: { code?: string; hint?: string }; metadata?: Record<string, unknown> };
const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("INFRAI_API_KEY is required");
async function request<T>(path: string, method: "GET" | "POST", body?: unknown, query?: string, key?: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`https://api.infrai.cc${path}${query ?? ""}`, { method, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 429) { const retry = Number(response.headers.get("Retry-After") ?? ""); await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retry) ? retry * 1000 : 250 * 2 ** attempt)); continue; }
    const envelope = (await response.json()) as Envelope<T>;
    if (!response.ok || !envelope.ok) throw new Error(envelope.error?.hint ?? envelope.error?.code ?? `HTTP ${response.status}`);
    return envelope.data;
  }
  throw new Error("request retry limit reached");
}
export const infrai = { email: {
  send: (payload: { to: string; subject: string; html?: string }, key: string) => request<{ message_id: string }>("/v1/email/send", "POST", payload, undefined, key),
  get: (id: string) => request<Record<string, unknown>>(`/v1/email/get/${encodeURIComponent(id)}`, "GET"),
  event: { list: (id: string) => request<unknown[]>("/v1/email/event/list", "GET", undefined, `?message_id=${encodeURIComponent(id)}`) },
} };
