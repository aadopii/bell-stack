# Crossmint Agent Checkouts

Bell's `crossmint_checkout` and `crossmint_pay` tools buy from a merchant through
[Crossmint Agent Checkouts](https://docs.crossmint.com/agents/checkouts/overview). One request
carries a product URL, a plain-language task, and a spending cap. Crossmint runs the checkout in
its own service and exposes it as a run with status snapshots. Payment comes from an order intent
the operator approved in Crossmint beforehand, funded by a Crossmint agent card, a card on file, or
an agent card from another provider such as Link.

```text
Bell -> create run (URL, task, cap) -> Crossmint works through the merchant checkout
     -> awaiting_input (form)       -> Bell answers from the conversation
     -> awaiting_input (payment)    -> Eve asks the person to approve the exact total
                                    -> server checks total, currency, merchant, cap -> pays
     -> succeeded (receipt)         -> Bell reports the order
```

The checkout does not use this conversation's Browserbase browser. Link, the browser runtime, and
the hooks are unchanged. With the Crossmint variables unset, both tools return `not_configured`.

## Configure

Server-only values in Bell's ignored `.env.local`:

```dotenv
CROSSMINT_SERVER_API_KEY=<production server key, sk_production_...>
CROSSMINT_USER_ID=<stable id for the single trusted operator>
# Optional until the first payment: the operator's approved order intent id.
CROSSMINT_ORDER_INTENT_ID=
# Optional. Saved buyer profile (name, email, shipping) so checkouts ask fewer questions.
CROSSMINT_BUYER_PROFILE_ID=
# Optional. Ceiling for any single checkout's cap, "amount currency".
CROSSMINT_MAX_COST=50.00 EUR
# Optional. Exact HTTPS origins a checkout may start from. Empty allows any merchant.
CROSSMINT_ALLOWED_MERCHANTS=https://shop.example
```

Create the key in the [Crossmint console](https://www.crossmint.com/console) with the
`agent-checkouts.create`, `.read`, `.update`, and `.cancel` scopes. Agent Checkouts run in
production only; a staging key returns `unauthorized`. Client keys (`ck_`) are rejected at startup.

`CROSSMINT_USER_ID` identifies the buyer to Crossmint. Bell serves one trusted operator, so a fixed
value is enough; every run, order intent, and receipt is scoped to it.

`CROSSMINT_ORDER_INTENT_ID` is the budget the operator approved in Crossmint: a saved card plus an
amount, merchant scope, and expiry. The [cards quickstart](https://docs.crossmint.com/agents/cards-quickstart)
walks through saving a card and approving an order intent. Only the `pay` path on the server reads
this id. Without it, checkouts run up to the payment step and `crossmint_pay` returns
`payment_not_configured`.

`CROSSMINT_MAX_COST` and `CROSSMINT_ALLOWED_MERCHANTS` are checked before a run is created, so a
refused request is never billed. They bound what a prompt can ask for; the order intent still bounds
what can be paid.

Restart Bell after changing these values. No database, migration, or browser setting is involved.

## Use

With `pnpm dev` running, in a web conversation or a Linq chat:

1. "Buy one sticker pack from https://shop.example/products/sticker-pack, standard delivery, max
   20 USD." Bell starts the run and waits up to 90 seconds for the next step.
2. When Crossmint asks a form question (size, email, delivery option), Bell asks you and answers
   with the `answer` action. Fields marked `protected` (one-time codes, passwords, card data) cannot
   be answered through the model; Bell declines or asks you to finish in Crossmint's hosted flow.
3. At the payment step Bell calls `crossmint_pay` with the amount, currency, and merchant from the
   request. Eve pauses and shows you an approval: "Pay 12.49 USD to shop.example with your
   Crossmint order intent?" Approving runs the tool; cancelling does not. Only the authenticated
   sender who asked for the purchase can approve.
4. `succeeded` with `purchase.kind: receipt_captured` carries `receipt.total` and
   `receipt.merchantOrderId`. That is the only result Bell reports as a placed order.
   `confirmed_without_receipt` and `nothing_placed` are reported as what they are.

`blocked` returns a code such as `merchant.payment_declined`, `policy.max_cost_exceeded`, or
`product.item_unavailable`; `failed` returns a reason such as `cost_limit` or `input_expired`. Bell
reports these and does not retry on its own. `cancel` stops a run that is still in progress.

Crossmint bills each run that starts, including runs that end `blocked`. Keep the cap tight and do
not start a second run for the same request while one is unresolved.

## How payment is guarded

Approval in chat is not the control. Eve's tool approval is: `crossmint_pay` is declared with
`approval: always()`, so the runtime stops before executing it and shows the person the amount,
currency, and merchant the model put in the call. After approval the server fetches the live
payment request from Crossmint and compares it with those three values and with the cap the run was
started under. Any difference, an expired or replaced request, a `maximum` instead of an `exact`
amount, or a run this conversation did not start refuses the payment and returns the reason. The
approval dialog shows the model's numbers; the cross-check makes sure they are Crossmint's numbers.

Payments need an authenticated sender: a verified Linq number, the HTTP Basic operator, or local
development auth. The anonymous web demo can start and inspect runs but cannot pay, and the
approval response policy rejects anyone other than the principal who requested the call.

## Transcript boundary

Only a projection of each snapshot reaches the model: run id, status, revision, the open question
with its form fields or payment amount and merchant, and the result summary with receipt metadata.
Browser embed URLs, the echoed input, provider error bodies, and any unexpected field are dropped
before Eve can persist them. The API key, buyer id, buyer profile, and order intent id are read from
the server environment inside the tools and never appear in tool arguments or output.

Runs are registered per conversation in process memory, like the Link sandbox request set. After a
restart or worker change an unfinished run cannot be resumed from chat; reconcile it in the
Crossmint console before starting another.

Crossmint's and the merchant's own records are outside Bell's control. Transcripts still contain
the merchant, items, totals, and form answers, so apply your host's retention policy.

## When to use this instead of Bell's browser

For merchants that support an agentic commerce protocol, Agent Checkouts is a pure API call with no
browser session anywhere. For other merchants Crossmint runs its own browser and per-merchant
behavior in its service, so fixes land without a change in Bell. Bell's own browser tools and
`link__checkout` remain the path when the purchase has to happen inside this conversation's
Browserbase session, for example after Baselayer-verified access or in a saved Context.

## Verify

`pnpm check` runs mock provider tests: request shapes and headers against the documented API,
sanitized errors, the merchant allowlist and spending ceiling, snapshot projection including
protected fields and payment interactions, the payment cross-check with one case per refusal
reason, polling with an answered request skipped, the timeout and cancellation paths, and
per-conversation run isolation. No test calls Crossmint.

For a live smoke test, set the key and buyer id, pick a merchant test checkout or an item under a
few dollars, and run the four steps above. Watch the run in the Crossmint console and compare the
receipt with the merchant's confirmation before trusting the flow for anything larger.

References: [Agent Checkouts overview](https://docs.crossmint.com/agents/checkouts/overview),
[quickstart](https://docs.crossmint.com/agents/agent-checkouts-quickstart),
[pay for a checkout](https://docs.crossmint.com/agents/checkouts/payments),
[API reference](https://docs.crossmint.com/api-reference/agent-checkouts/create-agent-checkout).
