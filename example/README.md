# Example: an order API and its client

A deliberately tiny, made-up order API.

- [`provider/`](./provider): the API in TypeScript. `src/orders.ts` is the handler;
  `test/contract.test.ts` is its side of the contract.
- [`consumer/`](./consumer): the client in Dart. `lib/orders_client.dart` builds the request and
  decides what the app does with a response; `test/contract_test.dart` is its side.
- [`contracts/`](./contracts): the fixtures both sides share.

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

## Run it

From the repository root:

```sh
npm ci && npm run build

# provider: reset the ledger, run the tests, check
npm run contract -w example/provider

# consumer
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
`contracts/provider/order.out-of-stock.json`. Now the consumer's test fails, because the client
no longer recognises the error:

```
provider fixtures: what the app makes of real responses order.out-of-stock [E]
  Expected: 'out of stock, 0 left'
    Actual: 'failed'
```

**(c) Add a fixture nobody touches.** Put a valid `contracts/provider/order.cancelled.json` in
place. The check fails on both sides, and so does the consumer's coverage test:

```
contract-fixtures check (provider side): 1 problem(s) in 12 fixture(s)
  - provider/order.cancelled.json: not verified by the provider side's tests (stale: delete it, or restore the test that produces it)

contract-fixtures check (consumer side): 1 problem(s) in 12 fixture(s)
  - provider/order.cancelled.json: not read by the consumer side's tests (add a test that feeds it to the real code)

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
✖ create-order.request
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  422 !== 201
```

**(e) Stop listing the secret.** In `provider/test/contract.test.ts`, remove the `secret` line
of the `payment.started` scenario. The provider's test fails, and the message does not show the
key the API returned:

```
✖ payment.started
  Error [ContractMismatchError]: contract fixture provider/payment.started.json no longer matches what the provider side produces (stored -> observed):
    secret: {"response.body.confirm_key":"<key:payment-1>"} -> (absent)
  If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

Update mode does not help here. `CONTRACT_FIXTURES_UPDATE=1 npm test -w example/provider`
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

After updating the fixture, the consumer's test fails, because the client only accepts the
content type it knows:

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
    response.body.id: "ord_mv3svalt1" -> "order-mv3svok81" (volatile: does not match ^ord_[a-z0-9]+$)
  If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

Update mode does not write a value that contradicts the pattern of its own entry; the pattern
in the test has to change with the API:

```
✖ order.created
  Error [ContractFixtureError]: contract fixture provider/order.created.json: what this side produced is not a valid fixture:
    response.body.id: does not match the pattern ^ord_[a-z0-9]+$ of volatile.0
```
