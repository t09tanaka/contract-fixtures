# Example: an order API and its client

A deliberately tiny, made-up order API.

- [`provider/`](./provider): the API in TypeScript. `src/orders.ts` is the handler;
  `test/contract.test.ts` is its side of the contract.
- [`consumer/`](./consumer): the client in Dart. `lib/orders_client.dart` builds the request and
  decides what the app does with a response; `test/contract_test.dart` is its side.
- [`contracts/`](./contracts): the fixtures both sides share.

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
contract-fixtures check (provider side): 1 problem(s) in 10 fixture(s)
  - provider/order.cancelled.json: not verified by the provider side's tests (stale: delete it, or restore the test that produces it)

contract-fixtures check (consumer side): 1 problem(s) in 10 fixture(s)
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
