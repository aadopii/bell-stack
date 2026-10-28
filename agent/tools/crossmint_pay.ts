import { defineTool, toolOutput } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  CrossmintSetupError,
  getCheckout,
  isCrossmintConfigured,
  payWithOrderIntent,
  waitForCheckout,
} from "../../server/crossmint/client";
import { assertPaymentMatches, PaymentMismatchError } from "../../server/crossmint/payment";
import { assertSessionCheckout } from "../../server/crossmint/runs";
import { errorOutput, WAIT_MS, type CheckoutToolOutput } from "./crossmint_checkout";

const inputSchema = z.object({
  runId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200).describe("The open payment request's id."),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .describe("The exact total Crossmint is asking for, copied from the payment request."),
  currency: z.string().length(3).toUpperCase(),
  merchant: z
    .string()
    .min(1)
    .max(255)
    .describe("The merchant URL or host from the payment request."),
});

type Input = z.infer<typeof inputSchema>;

type PayOutput =
  | CheckoutToolOutput
  | { status: "payment_not_configured"; runId: string; requestId: string; hint: string };

export default defineTool({
  description:
    "Pay an open Crossmint checkout payment request with the operator's order intent. Copy amount, currency, and merchant exactly from the payment request. Eve stops and asks the person to approve this call; the server then checks those three values against the live request and the checkout's cap before paying, and refuses on any difference. Requires an authenticated sender. Call once per payment request. Use crossmint_checkout decline if the person says no.",
  inputSchema,
  label: {
    start: (input: Readonly<Input>) =>
      `Paying ${input.amount} ${input.currency} at ${input.merchant} through Crossmint`,
  },
  approval: {
    request: always(),
    prompt: ({ input }) =>
      `Pay ${input.amount} ${input.currency} to ${input.merchant} with your Crossmint order intent?`,
    response: ({ request, response }) => {
      const requester = request.principal;
      if (!requester) {
        return { status: "rejected", reason: "Payments need an authenticated sender." };
      }
      const same =
        response.principal.principalId === requester.principalId &&
        response.principal.authenticator === requester.authenticator;
      return same
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only the person who requested this payment can approve it." };
    },
  },
  async execute(input, ctx): Promise<PayOutput> {
    ctx.abortSignal.throwIfAborted();
    if (!isCrossmintConfigured()) {
      return {
        status: "not_configured",
        hint: "Set CROSSMINT_SERVER_API_KEY and CROSSMINT_USER_ID on the server. See docs/crossmint.md.",
      };
    }
    const sessionId = ctx.session.id;
    const signal = ctx.abortSignal;
    const auth = ctx.session.auth.current;
    if (!auth) {
      return {
        status: "error",
        reason: "authentication_required",
        message: "Payments are available to authenticated senders only. The anonymous web demo cannot pay.",
      };
    }
    try {
      const record = assertSessionCheckout(sessionId, input.runId);
      if (record.principalId !== null && record.principalId !== auth.principalId) {
        return {
          status: "error",
          reason: "principal_mismatch",
          message: "A different sender started this checkout.",
        };
      }
      const live = await getCheckout(input.runId, { signal });
      try {
        assertPaymentMatches(input, live, record);
      } catch (error) {
        if (error instanceof PaymentMismatchError) {
          return { status: "error", reason: error.reason, message: error.message };
        }
        throw error;
      }
      try {
        await payWithOrderIntent(input.runId, input.requestId, { signal });
      } catch (error) {
        if (error instanceof CrossmintSetupError && error.setting === "CROSSMINT_ORDER_INTENT_ID") {
          return {
            status: "payment_not_configured",
            runId: input.runId,
            requestId: input.requestId,
            hint: "No order intent is configured on the server, so Bell cannot pay. Decline the request and tell the person. See docs/crossmint.md.",
          };
        }
        throw error;
      }
      return await waitForCheckout(input.runId, {
        signal,
        timeoutMs: WAIT_MS,
        skipRequestId: input.requestId,
      });
    } catch (error) {
      return errorOutput(error);
    }
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});
