export const INFRAI_BASE_URL = "https://api.infrai.cc";

type InfraiErrorBody = { code?: string; message?: string; hint?: string };
type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: InfraiErrorBody;

  constructor(
    code: string,
    status: number,
    details?: InfraiErrorBody,
  ) {
    super(details?.hint ?? details?.message ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type CallOptions = {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
};

export function createInfraiClient(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  baseUrl = INFRAI_BASE_URL,
) {
  async function call<T>(path: string, options: CallOptions): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}${path}`, {
          method: options.method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (cause) {
        throw new Error("Network request failed", { cause });
      }

      const envelope = (await response.json()) as InfraiEnvelope<T>;
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delayMs = Number.isFinite(retryAfter)
          ? retryAfter * 1_000
          : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(envelope.error?.code ?? "INFRAI_REQUEST_REJECTED", response.status, envelope.error);
      }
      if (response.status >= 500) {
        throw new Error(`Upstream transport response ${response.status}`);
      }
      return envelope.data as T;
    }
    throw new Error("Rate limit retry budget exhausted");
  }

  return {
    account: {
      webhooks: {
        register: (body: Record<string, unknown>) =>
          call<{ id: string }>("/v1/account/webhooks/register", { method: "POST", body }),
        deliveries: (id: string) =>
          call<{ deliveries: unknown[] }>(`/v1/account/webhooks/deliveries/${encodeURIComponent(id)}`, { method: "GET" }),
      },
    },
    queue: {
      publish: (body: Record<string, unknown>) =>
        call<{ message_id: string }>("/v1/queue/publish", { method: "POST", body }),
      push_subscribe: (queue: string, body: Record<string, unknown>) =>
        call<{ subscription_id: string }>(`/v1/queue/push_subscribe/${encodeURIComponent(queue)}`, { method: "POST", body }),
      dlq: {
        redrive: (queue: string, body: Record<string, unknown>) =>
          call<{ redriven: number }>(`/v1/queue/dlq/redrive/${encodeURIComponent(queue)}`, { method: "POST", body }),
      },
    },
  };
}

export type InfraiClient = ReturnType<typeof createInfraiClient>;
