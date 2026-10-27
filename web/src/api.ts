export type Account = { id: string; name: string; type: "customer" | "settlement" | "fees"; balance: number; currency: string };
export type Posting = { account_id: string; amount: number; balance_after: number };
export type Entry = { id: string; type: "deposit" | "transfer"; description: string | null; created_at: string; postings: Posting[] };
export type Delivery = {
  id: string;
  event_id: string;
  event_type: string;
  status: "pending" | "sending" | "retrying" | "succeeded" | "dead";
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
};
export type Endpoint = { id: string; url: string; enabled: boolean; simulated_failure_rate: number };
export type Reconciliation = {
  balanced: boolean;
  trial_balance: number;
  accounts: { account_id: string; name: string; stored_balance: number; ledger_balance: number; postings: number; matches: boolean }[];
  checked_at: string;
};
export type ApiResult<T = unknown> = { status: number; ok: boolean; replayed: boolean; body: T; ms: number };

const STORAGE_KEY = "payledger.apiKey";

function readKey() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeKey(key: string) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* private mode: the key lives for this tab only */
  }
}

let apiKey: string | null = readKey();

export const currentKey = () => apiKey;

export async function call<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {}
): Promise<ApiResult<T>> {
  const started = performance.now();
  const res = await fetch(path, {
    method,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: res.status,
    ok: res.ok,
    replayed: res.headers.get("Idempotent-Replayed") === "true",
    body: body as T,
    ms: Math.round(performance.now() - started),
  };
}

export async function createSandbox() {
  const res = await call<{ api_key: string }>("POST", "/v1/sandbox");
  if (!res.ok) throw new Error((res.body as { error?: { message?: string } })?.error?.message ?? "Could not create a sandbox");
  apiKey = res.body.api_key;
  writeKey(apiKey);
}

/** Reuse this browser's sandbox if it still exists; otherwise make a new one. */
export async function ensureSandbox() {
  if (apiKey) {
    const check = await call("GET", "/v1/accounts");
    if (check.ok) return;
  }
  await createSandbox();
}

export const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
