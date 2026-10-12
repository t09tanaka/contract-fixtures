# Example: an order API and its two clients

A deliberately tiny, made-up order API with two readers.

- [`provider/`](./provider): the API in TypeScript. `src/orders.ts` is the handler,
  `src/server.ts` puts it behind HTTP, and `src/main.ts` is the entry point. The contract tests
  in `test/` start the same server as the entry point and reach it with an HTTP test client.
- [`consumer/`](./consumer): the app, in Dart. `lib/orders_client.dart` builds the request and
  decides what the app does with a response; `test/contract_test.dart` is its side.
- [`consumer-web/`](./consumer-web): the web client, in TypeScript. `src/orders-client.ts`
  calls `fetch`; `test/contract.test.ts` gives it a `fetch` that answers with fixtures.
- [`contracts/`](./contracts): the fixtures the API shares with the app.
- [`contracts-web/`](./contracts-web): the fixtures the API shares with the web client.

## Two readers, two directories

A contracts directory is the agreement between **one** provider and **one** consumer: the
check asks the consumer side to read every provider fixture in it. The web client does not
start payments and knows nothing of coupons, so in a shared directory its check would fail
for fixtures it has no use for. Each reader therefore has a directory of its own, with the
exchanges that reader depends on:

| | `contracts/` (app) | `contracts-web/` (web client) |
|---|---|---|
| `order.created`, `order.out-of-stock`, `order.token-invalid`, `receipt.downloaded` | yes | yes |
| `order.created-with-coupon`, `order.coupon-unknown`, `order.invalid-quantity`, `payment.started` | yes | |
| `order.body-not-json` (answered by the HTTP layer, before the handler) | | yes |
| requests the reader builds (`consumer/`) | 2 | 2 |
| `tables/order-total` | yes | |

The provider's tests name the readers of each scenario and verify the same real response into
the directory of each ([`provider/test/support.ts`](./provider/test/support.ts)). When the API
changes a response both depend on, both files change, and both readers' tests fail. The
provider runs `reset` and `check` once per directory; each reader runs them on its own.

Placing an order (`POST /orders`) shows responses, requests and a shared calculation. Starting
the payment of an order (`POST /payments`) shows a response with a **secret** in it: the API
returns a new `confirm_key` every time, the provider's test lists
`response.body.confirm_key` under `secret`, and
[`contracts/provider/payment.started.json`](./contracts/provider/payment.started.json) holds
the placeholder `<key:payment-1>` instead. The consumer's test replaces the placeholder with a
value of its own before the client reads the response.

Downloading the receipt of an order (`GET /orders/<id>/receipt`) shows **response headers**
that are part of the agreement: the client saves the receipt under the file name of
`content-disposition`, so
[`contracts/provider/receipt.downloaded.json`](./contracts/provider/receipt.downloaded.json)
records the headers as well as the body.

Ids and timestamps are new on every run. The provider's test lists them under `volatile`, each
with a pattern for the shape it keeps, and names `created_at` wherever it occurs
(`response.body.**.created_at`). The id of an order is also a part of the path of the receipt
request, so `request.path` has a pattern too.

An order also says when its coupon was redeemed: `coupon_redeemed_at` is a time in
[`order.created-with-coupon`](./contracts/provider/order.created-with-coupon.json) and `null`
in [`order.created`](./contracts/provider/order.created.json). Both scenarios list the same
entry for it, a pattern with `nullable: true`
([`provider/test/orders.contract.test.ts`](./provider/test/orders.contract.test.ts)): the
value is a time of that shape or `null`, and nothing else.

## Run it

From the repository root:

```sh
npm ci && npm run build

# provider: reset both ledgers, run the tests, check both directories
npm run contract -w example/provider

# web client
npm run contract -w example/consumer-web

# app
cd example/consumer
dart pub get
dart run contract_fixtures reset --side consumer --dir ../contracts
dart test
dart run contract_fixtures check --side consumer --dir ../contracts
```

## Break it

Each of these was run against this example; the output is what the tools printed.

**(a) Change a response of the provider.** In `provider/src/orders.ts`, rename the error
`out_of_stock` to `sold_out`. The provider's test fails:

```
✖ order.out-of-stock
  Error [ContractMismatchError]: contract fixture provider/order.out-of-stock.json no longer matches what the provider side produces (stored -> observed):
    response.body.error: "out_of_stock" -> "sold_out"
  If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

**(b) Update the fixture.** `CONTRACT_FIXTURES_UPDATE=1 npm test -w example/provider` rewrites
`order.out-of-stock.json` in both directories, because both readers depend on that response.
Now the tests of both readers fail, because neither client recognises the error any more:

```
provider fixtures: what the app makes of real responses order.out-of-stock [E]
  Expected: 'out of stock, 0 left'
    Actual: 'failed'

✖ order.out-of-stock
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'failed'
  - 'out of stock, 0 left'
```

**(c) Add a fixture nobody touches.** Put a valid `contracts/provider/order.cancelled.json` in
place. The check of that directory fails on both sides, and so does the app's coverage test:

```
contract-fixtures check (provider side): 1 problem(s) in 12 fixture(s)
  - provider/order.cancelled.json: not verified by the provider side's tests (stale: delete it, or restore the test that produces it)
Run `contract-fixtures reset` and the provider side's tests before this check.

contract_fixtures check (consumer side): 1 problem(s) in 12 fixture(s)
  - provider/order.cancelled.json: not read by the consumer side's tests (add a test that feeds it to the real code)
Run `contract_fixtures reset` and the consumer side's tests before this check.

provider fixtures: what the app makes of real responses every provider fixture has an expectation here [E]
  the expectations of this test do not cover the fixtures in provider/order.*:
    provider/order.cancelled.json: no expectation in this test
```

**(d) Change the shape of a request of the consumer.** In `consumer/lib/orders_client.dart`,
send the quantity as a string. The consumer's test fails:

```
consumer fixtures: the requests the client really builds create-order.request [E]
  contract fixture consumer/create-order.request.json no longer matches what the consumer side produces (stored -> observed):
    request.body.quantity: 2 -> "2"
```

After `CONTRACT_FIXTURES_UPDATE=1 dart test` on the consumer, the provider's test fails, because
the real handler rejects the request:

```
✖ app: create-order.request
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  422 !== 201
```

**(e) Stop listing the secret.** In `provider/test/payments-receipts.contract.test.ts`, remove
the `secret` line of the `payment.started` scenario. The provider's test fails, and the message
does not show the key the API returned. Its last line does not suggest update mode:

```
✖ payment.started
  Error [ContractMismatchError]: contract fixture provider/payment.started.json no longer matches what the provider side produces (stored -> observed):
    secret.response.body.confirm_key: "<key:payment-1>" -> (absent)
  Update mode does not drop a secret path: pass the path as `secret` in this test, or remove it from the stored file by hand.
```

Update mode would not help. `CONTRACT_FIXTURES_UPDATE=1 npm test -w example/provider`
leaves the fixture as it is, because rewriting it would put the real key into the file:

```
✖ payment.started
  Error [ContractFixtureError]: contract fixture provider/payment.started.json is not updated, because that would drop a secret path:
    secret.response.body.confirm_key: is a secret path of the stored fixture, but this test does not pass it
  Pass the path as `secret` in this test, or remove it from the stored file by hand.
```

**(f) Change a response header.** In `provider/src/orders.ts`, send the receipt as
`application/json; charset=utf-8`. The provider's test fails:

```
✖ receipt.downloaded
  Error [ContractMismatchError]: contract fixture provider/receipt.downloaded.json no longer matches what the provider side produces (stored -> observed):
    response.headers.content-type: "application/json" -> "application/json; charset=utf-8"
  If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

After updating the fixture, the app's test fails (and the web client's in the same way),
because the client only accepts the content type it knows:

```
provider fixtures: a response whose headers matter receipt.downloaded [E]
  Expected: 'save receipt-<order id>.json, total 1200'
    Actual: 'failed'
```

**(g) Change the shape of a value that changes.** The id of an order is new on every run, so
the provider's test lists it under `volatile`, with the pattern `^ord_[a-z0-9]+$`. In
`provider/src/orders.ts`, let ids start with `order-` instead of `ord_`. The provider's test
fails, although the value was never compared exactly:

```
✖ order.created
  Error [ContractMismatchError]: contract fixture provider/order.created.json no longer matches what the provider side produces (stored -> observed):
    response.body.id: "ord_mv4g7hsv1" -> "order-mv4g82it1" (volatile: does not match ^ord_[a-z0-9]+$)
  If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

Update mode does not write a value that contradicts the pattern of its own entry; the pattern
in the test has to change with the API. The message shows the value that missed:

```
✖ order.created
  Error [ContractFixtureError]: contract fixture provider/order.created.json no longer matches what the provider side produces (stored -> observed):
    response.body.id: "ord_mv4g7hsv1" -> "order-mv4g835t1" (volatile: does not match ^ord_[a-z0-9]+$)
  The fixture is not updated, because what this side produced is not a valid fixture:
    response.body.id: "order-mv4g835t1" does not match the pattern ^ord_[a-z0-9]+$ of volatile.0
```

**(h) Answer with another response altogether.** In `provider/src/orders.ts`, let the handler
answer every request to `/orders` with an error, the way an unexpected failure would (as the
first line of `handle`:
`if (request.path === "/orders") return { status: 500, body: { error: "unexpected_failure" } };`).
None of the volatile paths of the test matches anything in such a response. The provider's
test shows what came back first, the status included, and the paths after it:

```
✖ order.created
  Error [ContractMismatchError]: contract fixture provider/order.created.json no longer matches what the provider side produces (stored -> observed):
    response.status: 201 -> 500
    response.body.coupon_redeemed_at: null -> (absent)
    response.body.created_at: "2026-10-11T23:22:30.751Z" -> (absent)
    response.body.customer: "customer-1" -> (absent)
    response.body.error: (absent) -> "unexpected_failure"
    response.body.id: "ord_mv4g7hsv1" -> (absent)
    response.body.status: "confirmed" -> (absent)
    response.body.total_minor: 1200 -> (absent)
  These volatile paths of the test match nothing in what the provider side produced:
    volatile.0: response.body.id matches nothing in this fixture
    volatile.1: response.body.**.created_at matches nothing in this fixture
    volatile.2: response.body.coupon_redeemed_at matches nothing in this fixture
  If the change is intended, take these paths out of the test, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

Update mode does not write this fixture, because a fixture whose volatile paths match nothing
is not valid. Its message has the same order:

```
✖ order.created
  Error [ContractFixtureError]: contract fixture provider/order.created.json no longer matches what the provider side produces (stored -> observed):
    response.status: 201 -> 500
    response.body.coupon_redeemed_at: null -> (absent)
    response.body.created_at: "2026-10-11T23:22:30.751Z" -> (absent)
    response.body.customer: "customer-1" -> (absent)
    response.body.error: (absent) -> "unexpected_failure"
    response.body.id: "ord_mv4g7hsv1" -> (absent)
    response.body.status: "confirmed" -> (absent)
    response.body.total_minor: 1200 -> (absent)
  The fixture is not updated, because what this side produced is not a valid fixture:
    volatile.0: response.body.id matches nothing in this fixture
    volatile.1: response.body.**.created_at matches nothing in this fixture
    volatile.2: response.body.coupon_redeemed_at matches nothing in this fixture
```

The fixtures of the errors this API really answers with (`order.out-of-stock` and the others)
have no volatile paths, so nothing stops that run from rewriting them with the 500 in them.
It says so for each, on standard error, and the fixture is written all the same:

```
contract fixture provider/order.out-of-stock.json was updated from status 409 to 500. A fixture with a 5xx is rarely what the deployed API answers: before committing it, check how this test assembles the application (docs/adoption.md, "Which tests verify").
```

Look at what update mode changed before committing it.
