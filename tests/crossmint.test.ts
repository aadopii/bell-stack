import { describe, expect, it, vi } from "vitest";
import {
  answerForm,
  assertCheckoutPolicy,
  cancelCheckout,
  compareAmounts,
  createCheckout,
  crossmintConfig,
  CrossmintPolicyError,
  CrossmintRequestError,
  CrossmintSetupError,
  declineRequest,
  getCheckout,
  isCrossmintConfigured,
  payWithOrderIntent,
  projectCheckout,
  waitForCheckout,
  type CheckoutSnapshot,
} from "../server/crossmint/client.js";
import { assertPaymentMatches, PaymentMismatchError } from "../server/crossmint/payment.js";
import { assertSessionCheckout, rememberCheckout, sessionCheckout } from "../server/crossmint/runs.js";

const config = {
  apiKey: "sk_unit_test_only",
  userId: "operator-1",
  baseUrl: "https://www.crossmint.com/api/unstable",
  allowedMerchants: [] as string[],
  orderIntentId: "oi_test_secret",
};

const snapshot = (overrides: Record<string, unknown>) => ({
  runId: "run_1",
  status: "running",
  revision: 1,
  createdAt: "2026-10-28T12:00:00.000Z",
  browser: { embedUrl: "https://browser.example/secret", permissions: ["read"] },
  input: { request: { startUrl: "https://shop.example/p/1" }, constraints: { maxCost: { amount: "20.00", currency: "USD" } } },
  requiredAction: null,
  ...overrides,
});

const paymentRequest = (amount = "12.49", currency = "USD", url = "https://shop.example") =>
  snapshot({
    status: "awaiting_input",
    requiredAction: {
      requestId: "req_pay",
      request: {
        question: `Authorize a card payment of ${amount} ${currency}.`,
        interaction: {
          kind: "payment",
          method: "card",
          purpose: "checkout_payment",
          amount: { kind: "exact", value: amount, currency },
          merchant: { name: "Example Shop", url, countryCode: "US" },
        },
      },
    },
  });

describe("Crossmint configuration", () => {
  it("is optional until used", () => {
    expect(isCrossmintConfigured({})).toBe(false);
    expect(isCrossmintConfigured({ CROSSMINT_SERVER_API_KEY: "sk_x", CROSSMINT_USER_ID: "u" })).toBe(true);
  });

  it("names the missing or invalid setting without logging values", () => {
    const base = { CROSSMINT_SERVER_API_KEY: "sk_x", CROSSMINT_USER_ID: "u" };
    expect(() => crossmintConfig({})).toThrow(CrossmintSetupError);
    expect(() => crossmintConfig({})).toThrow("CROSSMINT_SERVER_API_KEY");
    expect(() => crossmintConfig({ ...base, CROSSMINT_SERVER_API_KEY: "ck_client_key" })).toThrow("CROSSMINT_SERVER_API_KEY");
    expect(() => crossmintConfig({ ...base, CROSSMINT_API_BASE_URL: "http://insecure.example" })).toThrow("CROSSMINT_API_BASE_URL");
    expect(() => crossmintConfig({ ...base, CROSSMINT_MAX_COST: "50 dollars" })).toThrow("CROSSMINT_MAX_COST");
    expect(() => crossmintConfig({ ...base, CROSSMINT_ALLOWED_MERCHANTS: "https://shop.example/path" })).toThrow("CROSSMINT_ALLOWED_MERCHANTS");
    expect(() => crossmintConfig({ ...base, CROSSMINT_ALLOWED_MERCHANTS: "http://shop.example" })).toThrow("CROSSMINT_ALLOWED_MERCHANTS");

    const parsed = crossmintConfig({
      ...base,
      CROSSMINT_MAX_COST: "50.00 EUR",
      CROSSMINT_ALLOWED_MERCHANTS: "https://shop.example, https://other.example",
      CROSSMINT_BUYER_PROFILE_ID: "bp_1",
    });
    expect(parsed).toMatchObject({
      baseUrl: "https://www.crossmint.com/api/unstable",
      maxCost: { amount: "50.00", currency: "EUR" },
      allowedMerchants: ["https://shop.example", "https://other.example"],
      buyerProfileId: "bp_1",
    });
    expect(parsed.orderIntentId).toBeUndefined();
  });
});

describe("Crossmint checkout policy", () => {
  it("compares decimal amounts without floating point", () => {
    expect(compareAmounts("20", "20.00")).toBe(0);
    expect(compareAmounts("19.99", "20.00")).toBe(-1);
    expect(compareAmounts("20.01", "20.00")).toBe(1);
    expect(compareAmounts("0.1", "0.10")).toBe(0);
  });

  it("allows any merchant and any cap when no policy is set", () => {
    expect(() => assertCheckoutPolicy("https://anything.example/p", { amount: "9999.00", currency: "USD" }, config)).not.toThrow();
  });

  it("refuses merchants outside the allowlist before any request is made", () => {
    const policy = { ...config, allowedMerchants: ["https://shop.example"] };
    expect(() => assertCheckoutPolicy("https://shop.example/p/1", { amount: "1.00", currency: "USD" }, policy)).not.toThrow();
    for (const url of ["https://evil.example/p", "http://shop.example/p", "https://shop.example.evil.example/p", "https://user:pw@shop.example/p"]) {
      expect(() => assertCheckoutPolicy(url, { amount: "1.00", currency: "USD" }, policy)).toThrow(CrossmintPolicyError);
    }
  });

  it("refuses caps above the operator ceiling or in another currency", () => {
    const policy = { ...config, maxCost: { amount: "50.00", currency: "EUR" } };
    expect(() => assertCheckoutPolicy("https://shop.example", { amount: "50.00", currency: "EUR" }, policy)).not.toThrow();
    expect(() => assertCheckoutPolicy("https://shop.example", { amount: "50.01", currency: "EUR" }, policy)).toThrow("operator ceiling");
    expect(() => assertCheckoutPolicy("https://shop.example", { amount: "1.00", currency: "USD" }, policy)).toThrow("limited to EUR");
  });

  it("stops createCheckout at the policy, so a refused run is never billed", async () => {
    const fetcher = vi.fn();
    await expect(
      createCheckout(
        { startUrl: "https://evil.example/p", task: "x", maxCost: { amount: "1.00", currency: "USD" } },
        { config: { ...config, allowedMerchants: ["https://shop.example"] }, fetch: fetcher },
      ),
    ).rejects.toThrow(CrossmintPolicyError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Crossmint client", () => {
  it("creates a checkout with the documented body and headers", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://www.crossmint.com/api/unstable/agent-checkouts");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        "X-API-KEY": config.apiKey,
        "x-crossmint-user-id": config.userId,
        "Content-Type": "application/json",
      });
      expect(JSON.parse(init!.body as string)).toEqual({
        request: { startUrl: "https://shop.example/p/1", task: "One sticker pack" },
        constraints: { maxCost: { amount: "20.00", currency: "USD" } },
        buyerProfileId: "bp_1",
        browser: { location: { type: "country", countryCode: "ES" } },
      });
      return Response.json({ runId: "run_1" });
    });
    await expect(
      createCheckout(
        { startUrl: "https://shop.example/p/1", task: "One sticker pack", maxCost: { amount: "20.00", currency: "USD" }, countryCode: "ES" },
        { config: { ...config, buyerProfileId: "bp_1" }, fetch: fetcher },
      ),
    ).resolves.toEqual({ runId: "run_1" });
  });

  it("answers a form with a fresh message id and the submit shape", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://www.crossmint.com/api/unstable/agent-checkouts/run_1/messages");
      const body = JSON.parse(init!.body as string);
      expect(body.id).toMatch(/^bell_/);
      expect(body.parts).toEqual([
        { type: "input_response", requestId: "req_1", action: "submit", response: { kind: "form", answers: { email: "ada@example.com", size: "M" } } },
      ]);
      return Response.json({ messageId: "msg_1", status: "accepted" }, { status: 202 });
    });
    await answerForm("run_1", "req_1", { email: "ada@example.com", size: "M" }, { config, fetch: fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("pays with the server-side order intent only", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.parts[0].response).toEqual({ kind: "payment", orderIntentId: "oi_test_secret" });
      return Response.json({ messageId: "msg_2", status: "accepted" }, { status: 202 });
    });
    await payWithOrderIntent("run_1", "req_pay", { config, fetch: fetcher });
    await expect(
      payWithOrderIntent("run_1", "req_pay", { config: { ...config, orderIntentId: undefined }, fetch: fetcher }),
    ).rejects.toThrow("CROSSMINT_ORDER_INTENT_ID");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("declines and cancels through the documented endpoints and accepts empty 202 bodies", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace(config.baseUrl, "")}`);
      if (init?.body) expect(JSON.parse(init.body as string).parts[0]).toMatchObject({ action: "decline", requestId: "req_1" });
      return new Response(null, { status: 202 });
    });
    await declineRequest("run_1", "req_1", { config, fetch: fetcher });
    await cancelCheckout("run_1", { config, fetch: fetcher });
    expect(calls).toEqual(["POST /agent-checkouts/run_1/messages", "POST /agent-checkouts/run_1/cancel"]);
  });

  it("does not expose provider error bodies", async () => {
    const run = (status: number) => getCheckout("run_1", { config, fetch: async () => new Response("private merchant data", { status }) });
    await expect(run(401)).rejects.toThrow(/^Crossmint rejected the API key or its scopes\.$/);
    await expect(run(404)).rejects.toThrow(/^Crossmint has no checkout with that id for this buyer\.$/);
    await expect(run(429)).rejects.toThrow(/rate limited/);
    await expect(run(500)).rejects.toThrow(/^Crossmint returned HTTP 500\.$/);
    await expect(
      getCheckout("run_1", { config, fetch: async () => { throw new Error("private request details"); } }),
    ).rejects.toThrow(/^Crossmint request failed\. Check connectivity and retry\.$/);
  });

  it("does not call the API after cancellation", async () => {
    const fetcher = vi.fn();
    await expect(getCheckout("run_1", { config, fetch: fetcher, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Crossmint snapshot projection", () => {
  it("drops browser URLs, the echoed input, and unknown fields", () => {
    const projected = projectCheckout(snapshot({ secret: "x" }));
    expect(projected).toEqual({ runId: "run_1", status: "running", revision: 1, requiredAction: null, result: null, failureReason: null });
    expect(JSON.stringify(projected)).not.toContain("browser.example");
  });

  it("projects a form request and keeps protected handling", () => {
    const projected = projectCheckout(
      snapshot({
        status: "awaiting_input",
        requiredAction: {
          messageId: "m",
          requestId: "req_1",
          type: "input_response",
          request: {
            question: "Which size?",
            expiresAt: "2026-10-28T12:10:00.000Z",
            interaction: {
              kind: "form",
              fields: [
                { key: "size", label: "Size", required: true, handling: "standard", input: { type: "choice", choices: [{ value: "M", label: "Medium" }, "L"] } },
                { key: "otp", label: "Code", required: true, handling: "protected", input: { type: "text" } },
              ],
            },
          },
        },
      }),
    );
    expect(projected.requiredAction).toEqual({
      requestId: "req_1",
      question: "Which size?",
      expiresAt: "2026-10-28T12:10:00.000Z",
      interaction: {
        kind: "form",
        fields: [
          { key: "size", label: "Size", required: true, handling: "standard", type: "choice", choices: ["M", "L"] },
          { key: "otp", label: "Code", required: true, handling: "protected", type: "text" },
        ],
      },
    });
  });

  it("projects a payment request to amount and merchant only", () => {
    const raw = paymentRequest();
    (raw.requiredAction as unknown as { request: { interaction: Record<string, unknown> } }).request.interaction.card = { number: "4242" };
    const projected = projectCheckout(raw);
    expect(projected.requiredAction?.interaction).toEqual({
      kind: "payment",
      method: "card",
      amount: { kind: "exact", value: "12.49", currency: "USD" },
      merchant: { name: "Example Shop", url: "https://shop.example", countryCode: "US" },
    });
    expect(JSON.stringify(projected)).not.toContain("4242");
  });

  it("keeps receipt metadata on success and codes on blocked or failed runs", () => {
    expect(
      projectCheckout(
        snapshot({
          status: "succeeded",
          result: { outcome: "succeeded", summary: "Ordered one sticker pack.", purchase: { kind: "receipt_captured", receipt: { total: { amount: "12.49", currency: "USD" }, merchantOrderId: "A-100" } } },
        }),
      ).result,
    ).toEqual({ outcome: "succeeded", summary: "Ordered one sticker pack.", purchase: { kind: "receipt_captured", receipt: { total: { amount: "12.49", currency: "USD" }, merchantOrderId: "A-100" } } });
    expect(projectCheckout(snapshot({ status: "blocked", result: { outcome: "blocked", code: "merchant.payment_declined", summary: "Declined." } })).result)
      .toEqual({ outcome: "blocked", code: "merchant.payment_declined", summary: "Declined." });
    expect(projectCheckout(snapshot({ status: "failed", reason: "cost_limit" })).failureReason).toBe("cost_limit");
  });

  it("rejects malformed snapshots", () => {
    expect(() => projectCheckout({ status: "running" })).toThrow(CrossmintRequestError);
    expect(() => projectCheckout(snapshot({ status: "exploded" }))).toThrow(CrossmintRequestError);
  });
});

describe("Crossmint payment cross-check", () => {
  const record = { runId: "run_1", maxCost: { amount: "20.00", currency: "USD" }, principalId: "linq:1" };
  const approved = { requestId: "req_pay", amount: "12.49", currency: "USD", merchant: "shop.example" };
  const live = (raw: Record<string, unknown>): CheckoutSnapshot => projectCheckout(raw);

  it("accepts a payment whose amount, currency, merchant, and cap all agree", () => {
    expect(assertPaymentMatches(approved, live(paymentRequest()), record)).toEqual({ amount: { amount: "12.49", currency: "USD" }, merchant: "shop.example" });
    expect(assertPaymentMatches({ ...approved, merchant: "https://shop.example/checkout" }, live(paymentRequest()), record).merchant).toBe("shop.example");
  });

  it.each([
    ["no_payment_request", approved, snapshot({ status: "running" })],
    ["request_changed", { ...approved, requestId: "req_old" }, paymentRequest()],
    ["amount_mismatch", { ...approved, amount: "12.48" }, paymentRequest()],
    ["currency_mismatch", { ...approved, currency: "EUR" }, paymentRequest()],
    ["merchant_mismatch", { ...approved, merchant: "evil.example" }, paymentRequest()],
    ["cap_exceeded", { ...approved, amount: "20.01" }, paymentRequest("20.01")],
  ] as const)("refuses on %s", (reason, input, raw) => {
    let caught: unknown;
    try {
      assertPaymentMatches(input, live(raw), record);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PaymentMismatchError);
    expect((caught as PaymentMismatchError).reason).toBe(reason);
  });

  it("refuses a maximum amount, which cannot be shown to the person as an exact total", () => {
    const raw = paymentRequest();
    (raw.requiredAction as unknown as { request: { interaction: { amount: { kind: string } } } }).request.interaction.amount.kind = "maximum";
    expect(() => assertPaymentMatches(approved, live(raw), record)).toThrow(/maximum rather than an exact total/);
  });
});

describe("Crossmint polling", () => {
  it("waits through running states, skips an answered request, and stops on new input or a terminal state", async () => {
    const sequence = [
      snapshot({ status: "running", revision: 1 }),
      snapshot({ status: "awaiting_input", revision: 2, requiredAction: { requestId: "answered", request: { question: "old", interaction: { kind: "form", fields: [] } } } }),
      snapshot({ status: "awaiting_input", revision: 3, requiredAction: { requestId: "req_new", request: { question: "new", interaction: { kind: "form", fields: [] } } } }),
    ];
    const fetcher = vi.fn(async () => Response.json(sequence.shift() ?? sequence.at(-1)));
    const result = await waitForCheckout("run_1", { config, fetch: fetcher, intervalMs: 1, skipRequestId: "answered" });
    expect(result.status).toBe("awaiting_input");
    expect(result.requiredAction?.requestId).toBe("req_new");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns the latest snapshot at the timeout instead of hanging", async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot({ status: "running" })));
    const result = await waitForCheckout("run_1", { config, fetch: fetcher, intervalMs: 1, timeoutMs: 10 });
    expect(result.status).toBe("running");
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops polling when the turn is cancelled", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return Response.json(snapshot({ status: "running" }));
    });
    await expect(waitForCheckout("run_1", { config, fetch: fetcher, intervalMs: 50, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("Crossmint run registry", () => {
  it("scopes checkouts to the conversation that started them and keeps the cap", () => {
    const record = { runId: "run_a", maxCost: { amount: "20.00", currency: "USD" }, principalId: "linq:1" };
    rememberCheckout("session-a", record);
    expect(sessionCheckout("session-a", "run_a")).toEqual(record);
    expect(sessionCheckout("session-b", "run_a")).toBeUndefined();
    expect(assertSessionCheckout("session-a", "run_a")).toEqual(record);
    expect(() => assertSessionCheckout("session-b", "run_a")).toThrow("did not start that checkout");
  });
});
