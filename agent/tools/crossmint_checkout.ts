import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";

import {
  answerForm,
  cancelCheckout,
  createCheckout,
  CrossmintPolicyError,
  CrossmintRequestError,
  CrossmintSetupError,
  declineRequest,
  getCheckout,
  isCrossmintConfigured,
  waitForCheckout,
  type CheckoutSnapshot,
} from "../../server/crossmint/client";
import { assertSessionCheckout, rememberCheckout } from "../../server/crossmint/runs";

const maxCost = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "Decimal string such as 20.00")
    .describe("Spending cap including shipping and tax, as a decimal string."),
  currency: z.string().length(3).toUpperCase().describe("ISO 4217 code, such as USD or EUR."),
});

const runId = z.string().min(1).max(200);
const requestId = z.string().min(1).max(200);

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    startUrl: z.string().url().max(2048).describe("Product or store page to start from."),
    task: z
      .string()
      .min(1)
      .max(20_000)
      .describe("What to buy, in plain language: item, options, quantity, delivery."),
    maxCost,
    merchantGuidance: z
      .string()
      .max(20_000)
      .optional()
      .describe("Optional notes about this merchant's checkout."),
    countryCode: z
      .string()
      .length(2)
      .toUpperCase()
      .optional()
      .describe("Optional browser location for the checkout, such as ES or US."),
  }),
  z.object({ action: z.literal("status"), runId }),
  z.object({
    action: z.literal("answer"),
    runId,
    requestId,
    answers: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .describe("One value per form field key. Protected fields cannot be answered here."),
  }),
  z.object({ action: z.literal("decline"), runId, requestId }),
  z.object({ action: z.literal("cancel"), runId }),
]);

export type CheckoutToolOutput =
  | { status: "not_configured"; hint: string }
  | { status: "error"; reason: string; message: string }
  | CheckoutSnapshot;

export function errorOutput(error: unknown): CheckoutToolOutput {
  if (
    error instanceof CrossmintSetupError ||
    error instanceof CrossmintRequestError ||
    error instanceof CrossmintPolicyError
  ) {
    return { status: "error", reason: error.reason, message: error.message };
  }
  throw error;
}

export const WAIT_MS = 90_000;

export default defineTool({
  description:
    "Buy from a merchant through Crossmint Agent Checkouts with a hard spending cap. Crossmint runs the checkout in its own service, not in this conversation's browser. Actions: start (product URL, plain-language task, maxCost), then follow requiredAction. For a form, call answer with one value per field key. For a payment request, call crossmint_pay; the person approves the exact amount there. decline refuses a request; cancel stops the run. Returns status snapshots only. A succeeded result whose purchase.kind is receipt_captured is the only proof of a placed order. Never start a second checkout for the same request while one is unresolved.",
  inputSchema,
  label: {
    start: (input) =>
      input.action === "start"
        ? `Starting a Crossmint checkout at ${new URL(input.startUrl).hostname}`
        : `Crossmint checkout: ${input.action}`,
  },
  async execute(input, ctx): Promise<CheckoutToolOutput> {
    ctx.abortSignal.throwIfAborted();
    if (!isCrossmintConfigured()) {
      return {
        status: "not_configured",
        hint: "Set CROSSMINT_SERVER_API_KEY and CROSSMINT_USER_ID on the server. See docs/crossmint.md.",
      };
    }
    const sessionId = ctx.session.id;
    const signal = ctx.abortSignal;
    try {
      switch (input.action) {
        case "start": {
          const { runId } = await createCheckout(
            {
              startUrl: input.startUrl,
              task: input.task,
              maxCost: input.maxCost,
              ...(input.merchantGuidance ? { merchantGuidance: input.merchantGuidance } : {}),
              ...(input.countryCode ? { countryCode: input.countryCode } : {}),
            },
            { signal },
          );
          rememberCheckout(sessionId, {
            runId,
            maxCost: input.maxCost,
            principalId: ctx.session.auth.current?.principalId ?? null,
          });
          return await waitForCheckout(runId, { signal, timeoutMs: WAIT_MS });
        }
        case "status": {
          assertSessionCheckout(sessionId, input.runId);
          return await waitForCheckout(input.runId, { signal, timeoutMs: WAIT_MS });
        }
        case "answer": {
          assertSessionCheckout(sessionId, input.runId);
          const current = await getCheckout(input.runId, { signal });
          const action = current.requiredAction;
          if (!action || action.requestId !== input.requestId) return current;
          if (action.interaction.kind !== "form") {
            return {
              status: "error",
              reason: "wrong_interaction",
              message: "This request is not a form. Payment requests go through crossmint_pay.",
            };
          }
          const protectedKeys = new Set(
            action.interaction.fields
              .filter((field) => field.handling === "protected")
              .map((field) => field.key),
          );
          if (Object.keys(input.answers).some((key) => protectedKeys.has(key))) {
            return {
              status: "error",
              reason: "protected_field",
              message:
                "Protected fields (codes, passwords, card data) cannot be answered through the model. Decline the request or ask the person to finish in Crossmint's hosted flow.",
            };
          }
          await answerForm(input.runId, input.requestId, input.answers, { signal });
          return await waitForCheckout(input.runId, {
            signal,
            timeoutMs: WAIT_MS,
            skipRequestId: input.requestId,
          });
        }
        case "decline": {
          assertSessionCheckout(sessionId, input.runId);
          await declineRequest(input.runId, input.requestId, { signal });
          return await waitForCheckout(input.runId, {
            signal,
            timeoutMs: 30_000,
            skipRequestId: input.requestId,
          });
        }
        case "cancel": {
          assertSessionCheckout(sessionId, input.runId);
          await cancelCheckout(input.runId, { signal });
          return await waitForCheckout(input.runId, { signal, timeoutMs: 30_000 });
        }
      }
    } catch (error) {
      return errorOutput(error);
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
