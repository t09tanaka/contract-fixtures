# Adopting contract-fixtures in an existing project

The [README](../README.md) explains the idea and the API. This guide is about the decisions
that come up when the tool meets a project that already has tests. Each section says what
happens and what to do. The code is from the [example](../example) in this repository, which
is built the way this guide recommends.

- [Which tests verify](#which-tests-verify)
- [The provider side](#the-provider-side)
- [The consumer side](#the-consumer-side)
- [More than one reader, and readers outside the repository](#more-than-one-reader-and-readers-outside-the-repository)
- [Next to generated clients and shared types](#next-to-generated-clients-and-shared-types)
- [Many fixtures](#many-fixtures)
- [CI](#ci)
- [When the check fails](#when-the-check-fails)
- [What to leave out](#what-to-leave-out)

## Which tests verify

A fixture is only worth reading if it holds what the deployed API answers. Whether it does is
decided by the test that calls `verifyResponse`.

**What happens.** A test builds its own application around the code under test, and that
application is not the deployed one. The entry point of the real application registers
something the test's application lacks (a layer that turns the 201 of every POST into 200, a
filter that shapes errors, the parsing of cookies), or the test adds something the real one
lacks (stricter validation of input). Or the test replaces the service behind the route with a
mock, or calls the handler function directly. In all of these the test passes, and a
`verifyResponse` in it records a response the deployed API never gives: the copy of a mock,
the wrong status, a body without the envelope. The consumer then reads that file and is
tested against fiction.

**What to do.** Call `verifyResponse` only in tests that send an HTTP request to the
application **assembled the way the deployed one is**, with nothing between the request and
the data replaced except what is outside the process (see
[third-party services](#what-to-leave-out)). Do not call it in tests with a mocked service
layer and not in tests that call a handler directly; those tests stay what they are.

To make "assembled the same way" true by construction, put the assembly in one function and
call it from both places. In the example, [`server.ts`](../example/provider/src/server.ts)
is that function:

```ts
export function assembleServer(options: Parameters<typeof createApp>[0]): http.Server {
  const app = createApp(options);
  return new http.Server((req, res) => {
    // read the body, answer 400 to a body that is not JSON, call app.handle,
    // write the status, the headers and the JSON body
  });
}
```

The entry point adds nothing but the port
([`main.ts`](../example/provider/src/main.ts)):

```ts
const tokens = JSON.parse(process.env.ORDER_API_TOKENS ?? "{}") as Record<string, string>;
assembleServer({ tokens }).listen(Number(process.env.PORT ?? 3000));
```

and the contract tests start the same server
([`support.ts`](../example/provider/test/support.ts)):

```ts
export const api = () => request(assembleServer({ tokens: { "test-token-of-customer-1": "customer-1" } }));
```

With a framework, the function is the one that creates the application **and** registers its
global parts (middleware, interceptors, pipes, filters, the error handler). If today the entry
point does that registration inline, moving it into a function both sides call is the first
step of adopting this tool, and usually the only change to production code.

A project often has both kinds of tests. Verify in the few that go through the whole
application, and keep one such test per exchange a consumer depends on.

Calling the same function from both places is necessary, and it is not always enough. Two
ways in which the two applications still differ:

- **The function branches on the environment.** The entry point and the tests both call
  `assemble()`, but inside it a variable that names the mode of the run (set to `test` by the
  test runner) decides which error handler is registered, or whether one is registered at
  all. The same request then gets one error body from the deployed application and another
  one from the test's, and the fixture holds the second. Look for such branches in the
  assembly, and run the contract tests in the mode the deployed application runs in, or make
  the difference an explicit argument that both callers pass.
- **A check of responses that only runs in tests.** Some applications validate every response
  against a schema while the tests run, and replace a response that does not fit with an
  error. In production the response goes out as it is. A response that the schema does not
  describe is then recorded as a validation error with a status of 500, although the
  deployed API answers 200 with the real body. Switch the check off for the contract tests,
  or let it report without replacing the response.

How to tell: **a fixture with a 5xx status, or with a body that carries the wording of a
validator, was most likely produced by a difference in assembly, not by the API.** Before
committing such a fixture, send the same request to an application started the way it is
deployed, and compare. Update mode points at this section when it happens: when it writes a
5xx over a fixture that held another status, it prints one line to standard error
(`contract fixture ... was updated from status 201 to 500. ...`). The fixture is written all
the same, because a 5xx can be what a fixture is meant to hold.

## The provider side

### From the response of a test client to `verifyResponse`

**What happens.** Tests are written with an HTTP test client
(`client.post(...).set(...).send(...)`), and each `verifyResponse` needs the method, the path,
headers, the body, the status, response headers and the response body picked out of it.

**What to do.** In TypeScript, `exchangeFromTestResponse` picks them out. Wrap it once for
the project ([`support.ts`](../example/provider/test/support.ts)):

```ts
export function verify(scenario: Scenario, res: request.Response): void {
  const exchange = exchangeFromTestResponse(res, {
    requestHeaders: ["authorization"],
    responseHeaders: scenario.responseHeaders,
    // The test client does not show the body it sent.
    request: { body: scenario.call.body },
  });
  // ...
    contracts[reader].verifyResponse({
      name: scenario.name,
      description: scenario.description,
      ...exchange,
      volatile: scenario.volatile,
      secret: { ...token, ...scenario.secret },
    });
}
```

Headers are recorded by name only. A response over HTTP carries `date`, `connection` and
`content-length`, and a fixture should hold the agreement, not the wire. In Dart, build the
`ExchangeRequest` and `ExchangeResponse` from the values of the test in the same way.

### Request headers that change the response

**What happens.** The API answers differently depending on a request header: the language of
a message follows `accept-language`, the shape of a body follows a header with the version of
the app, the CORS headers follow `origin`. A fixture recorded without that header says "this
request gets this response", which is true only for the header the test happened to send, and
the reader cannot tell.

**What to do.** Name every such header in `requestHeaders`, so that it is in the fixture.
Record one fixture per value that a consumer depends on (`order.out-of-stock.en`,
`order.out-of-stock.ja`). If the response says which request headers it depends on (`vary`),
record that header too.

### Responses the tests cannot produce

**What happens.** The consumer has a branch for a response that the provider's tests cannot
bring about: a 429 from a rate limiter that is switched off in tests or lives in a gateway, a
503 during maintenance. There is no real response to verify, so there is no fixture, and the
branch is tested against a hand-written response as before.

**What to do.** First try to make it real: most rate limiters can be configured with a limit
of one request for one test. If the response comes from the application, that is a fixture
like any other, `retry-after` included. If it comes from infrastructure in front of the
application, it is not this provider's response; treat it like a
[third-party service](#what-to-leave-out) and keep the hand-written response in the
consumer's test, outside the contracts directory. Do not put a file into `provider/` by hand:
the provider's check would report it as `unverified`, and rightly so.

## The consumer side

### Through the HTTP layer, not around it

**What happens.** Most client tests replace the API client as a whole: a mock per method, or a
function that returns `{ data, error }`. A fixture fed into such a test never passes through
the code that builds the URL, sets the headers, checks the status and decodes JSON, which is
where the two sides disagree. And the request the client really sends is never seen.

**What to do.** Replace the transport, not the client. In TypeScript, give the client a
`fetch` that answers with the fixture and keeps the request
([`contract.test.ts`](../example/consumer-web/test/contract.test.ts)):

```ts
function clientAnsweredBy(name: string) {
  const sent: ExchangeRequest[] = [];
  const client = createOrdersClient({
    baseUrl: "https://orders.example.test",
    authorization: "Bearer token-of-the-web-test",
    fetch: async (input, init) => {
      sent.push(await requestFromFetch(input, init));
      const { response } = contract.readResponse(name);
      return toFetchResponse(resolvePlaceholders(response, (kind, id) => `test ${kind} of ${id}`));
    },
  });
  return { client, sent };
}
```

The same test then has both halves of the contract. The response:

```ts
const outcome = await clientAnsweredBy(name).client.placeOrder("tea-100", 2);
// assert what the client made of it, from a table: fixture name -> expected outcome
```

and the request:

```ts
const { client, sent } = clientAnsweredBy("order.created");
await client.placeOrder("tea-100", 1);

contract.verifyRequest({
  name: "place-order.request",
  description: "The request the web client sends to place an order",
  request: sent[0]!,
  secret,
});
```

The `fetch` of the test answers with the fixture whatever the client sent; it does not compare
the request with the one in the fixture. What the client sends is checked by `verifyRequest`,
and that the API accepts it is checked by the provider's tests.

If the client cannot be given a `fetch`, replace `globalThis.fetch` for the duration of the
test. A client built on another library has that library's test transport; the
[Dart README](../packages/dart/README.md#http-in-tests) shows `MockClient` of `package:http`
and an `HttpClientAdapter` of dio.

`toFetchResponse` adds no `content-type`. If the client looks at it, the provider's test
should record it, as the example does for the receipt.

### Numbers in Dart

**What happens.** `jsonDecode` gives an `int` for `10` and a `double` for `10.5`. A client
that reads `json['amount'] as double` works with the hand-written `10.5` of its old test and
throws on the first real response with a whole number.

**What to do.** Read numbers as `num` (`(json['amount'] as num).toDouble()`), and have a
fixture whose value is a whole number.

## More than one reader, and readers outside the repository

### Two clients of one API

**What happens.** An API has an app and an admin screen, or an app and a web client. With one
contracts directory, the check of each client asks it to read **every** provider fixture. A
client that has no use for the other one's exchanges fails with `unread`, and the tool has no
way to exempt a fixture.

**What to do.** One contracts directory per pair of provider and consumer. The example has
[`contracts/`](../example/contracts) for the app and
[`contracts-web/`](../example/contracts-web) for the web client. The provider opens both and
verifies a response into the directory of every reader that depends on it:

```ts
export const contracts: Record<Reader, ContractFixtures> = {
  app: contractFixtures({ side: "provider", dir: "../contracts" }),
  web: contractFixtures({ side: "provider", dir: "../contracts-web" }),
};
```

```ts
{
  name: "order.created",
  description: "An order is accepted",
  readers: ["app", "web"],
  call: order({ sku: "tea-100", quantity: 2 }),
  volatile: [anOrderId, anyCreatedAt],
},
{
  name: "order.created-with-coupon",
  description: "An order with a valid coupon is accepted at the discounted total",
  readers: ["app"],
  // ...
},
```

A response both depend on exists as two files with the same content. That is intended: a
change of the API changes both, and each reader's tests fail on their own. The provider runs
`reset` and `check` once per directory; each reader runs them on its own directory only:

```json
"reset": "contract-fixtures reset --side provider --dir ../contracts && contract-fixtures reset --side provider --dir ../contracts-web",
"check": "contract-fixtures check --side provider --dir ../contracts && contract-fixtures check --side provider --dir ../contracts-web"
```

The directories also show at a glance which reader depends on what.

### An API and a screen in one application

When the routes and the pages that call them live in one web application, there are still
two sides: the route handlers answer, the page code reads. Give them a contracts directory
like any other pair, run the route tests as the provider and the page tests as the consumer.
They can run in one job; they still have separate ledgers and separate checks.

### The other side is not in the repository

**What happens.** The callers of an API are external customers, a service that sends
webhooks, or a scheduler that calls an endpoint. Or the API itself calls somebody else's
service. One side of the contract has no tests here, so one check can never pass: nobody
reads the provider fixtures, or nobody verifies the consumer fixtures.

**What to do.** This tool needs both sides in reach. Without the other side:

- For an API with external callers, the fixtures are still useful as recorded, reviewed
  examples, but nothing replaces the consumer's check. Run the provider's `reset`, tests and
  `check` only if some code in the repository plays the consumer (a small client used in
  end-to-end tests, an SDK that is published from the same repository). Otherwise this is the
  wrong tool; a published schema and tests against it fit better.
- For a webhook that an external service sends to you, that service is the consumer that
  builds the request. You cannot verify what it builds. Keep a copy of its request as an
  ordinary test resource, not in `consumer/`.
- For a service you call, see [third-party services](#what-to-leave-out).

## Next to generated clients and shared types

**What happens.** The client is generated from an OpenAPI document, or both sides share types.
It looks as if the contract were already checked.

**What a fixture adds.** Types and generated code describe shapes at compile time. A fixture
is a value at run time, and it is run through the client:

- **Values.** The spelling of an error code, of a status, of an enum member; the string the
  client compares with.
- **Statuses.** Which status goes with which body, and what the client does on each.
- **Error bodies.** They are often missing from the document, or described as "any object".
- **`null` and absent.** A field that is `null`, absent, `""` or `[]` in a real response,
  where the type says only "optional".
- **Dates and numbers as they are sent.** The exact format of a timestamp (with a pattern in
  `volatile`), an amount that is a whole number.
- **A document that is out of date.** The fixture comes from the response, not from the
  description of it.

**What it does not add.** A fixture is an example, not a rule. It does not show that a field
is *always* present, and it does not notice a new enum member or a new field in responses
nobody recorded. Keep the generated client and the types; add fixtures for the exchanges
where a wrong value, not a wrong shape, would break the client.

## Many fixtures

**What happens.** With dozens of routes, one table of expectations per side and one call of
`assertCovers` become a file nobody wants to open.

**What to do.** Name fixtures with a prefix per area (`order.`, `payment.`), keep one table
per area in the test file of that area, and let each cover its prefix. One more test lists
the prefixes, so that a fixture with a new prefix cannot go unnoticed
([`contract.test.ts`](../example/consumer-web/test/contract.test.ts)):

```ts
it("every provider fixture belongs to one of the tables", () => {
  contract.assertPrefixesCover("provider", ["order.", "receipt."]);
});

it("every order fixture has an expectation here", () => {
  contract.assertCovers("provider", Object.keys(orderExpectations), { prefix: "order." });
});
```

To see whether routes answer alike, print the fixtures side by side:

```
$ npx contract-fixtures summary --dir example/contracts-web
FIXTURE                            REQUEST                            STATUS  RESPONSE BODY
provider/order.body-not-json       POST /orders                       400     {error: string}
provider/order.created             POST /orders                       201     {created_at: string, customer: string, id: string, status: string, total_minor: number}
provider/order.out-of-stock        POST /orders                       409     {available: number, error: string}
provider/order.token-invalid       POST /orders                       401     {error: string}
provider/receipt.downloaded        GET /orders/ord_mv3vvd651/receipt  200     {lines: array, order_id: string, total_minor: number}
consumer/download-receipt.request  GET /orders/ord_demo1/receipt      -       -
consumer/place-order.request       POST /orders                       -       -
```

An API where the same failure is `{error: string}` on one route and
`{code: string, message: string}` on another shows it here. The summary does not judge; it is
a list to read before deciding what the client has to handle.

## CI

### One job per side

Each side resets its ledger, runs **all** its tests, and checks. The sides do not need each
other's results, only the committed fixtures. The workflow of the example in this repository
([`example.yml`](../.github/workflows/example.yml)) has a job for the web client:

```yaml
  web:
    name: Web client (reset, test, check), Node ${{ matrix.node }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: [20, 24]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run contract -w example/consumer-web
```

where `contract` is `contract-fixtures reset ... && npm test && contract-fixtures check ...`.
When the tests of a side are split into several suites (unit, integration, end-to-end; each
a command or a container run of its own), the order is `reset`, then **every** suite of that
side, then `check`: the tables may be read in the integration tests and the responses
verified in the end-to-end tests, and a `reset` between two suites forgets the first.
The job fails when a test fails or when the check exits with 1; the exit codes are listed in
the [README](../README.md#command-line).
(`npm run build` builds the package of this repository; a project that installs it from the
registry has no such step.)

### A change of the fixtures starts both sides

**What happens.** In a repository with several projects, workflows are limited to the paths
of their project. A pull request that changes only the API and its fixtures then starts the
API's job and not the client's, and the client's tests, which are the ones that would fail,
do not run.

**What to do.** Put the contracts directory into the `paths` of every side that uses it
(from `example.yml`, which has one workflow for all sides and so lists them all):

```yaml
on:
  pull_request:
    paths:
      - "example/contracts/**"
      - "example/contracts-web/**"
      - "example/provider/**"
      - "example/consumer/**"
      - "example/consumer-web/**"
      - "packages/**"
      - "package.json"
      - "package-lock.json"
      - ".github/workflows/example.yml"
```

With one workflow per side, each lists its own project and its contracts directory or
directories (in this repository the list also has the packages the example is built on). If
the jobs are required checks, remember that a workflow that is not started reports nothing: a
pull request outside these paths then waits for a check that never arrives.

### Shards and workers

**What happens.** The tests of one side run in several shards on different machines. Each
shard writes its own ledger, with a part of the fixtures. A check on any one of them fails;
when a shard covers fewer than half of the fixtures, the report has a hint that says so.

**What to do.** Do not check in the shards. Keep each shard's ledger, join them in a job that
runs after all shards, and check there. A ledger is a list of lines; joining is `cat`, and
order and repetition do not matter. From [`example.yml`](../.github/workflows/example.yml),
the end of a shard:

```yaml
      - name: Reset, then run one shard of the tests
        working-directory: example/provider
        run: |
          npm run reset
          rm -rf .test-build && npx tsc -p tsconfig.json
          node --test --test-shard=${{ matrix.shard }}/2 .test-build/test/*.test.js
      - name: Collect the ledgers of this shard
        run: |
          for dir in contracts contracts-web; do
            mkdir -p "ledgers/$dir"
            ledger="example/$dir/.ledger/provider.jsonl"
            if [ -f "$ledger" ]; then cp "$ledger" "ledgers/$dir/${{ matrix.shard }}.jsonl"; fi
          done
      - uses: actions/upload-artifact@v4
        with:
          name: ledgers-${{ matrix.shard }}
          path: ledgers/
```

and the job after them:

```yaml
      - uses: actions/download-artifact@v4
        with:
          pattern: ledgers-*
          path: ledgers
          merge-multiple: true
      - name: Join the ledgers of the shards, then check
        run: |
          for dir in contracts contracts-web; do
            mkdir -p "example/$dir/.ledger"
            cat "ledgers/$dir"/*.jsonl > "example/$dir/.ledger/provider.jsonl"
          done
          npm run check -w example/provider
```

The ledger is copied out of `.ledger/` under another name, so that the upload does not depend
on how the action treats hidden directories. Each contracts directory gets a directory of its
own among the copies: a ledger names fixtures as `provider/order.created.json`, without the
contracts directory, so the lines of one directory must never be joined into the ledger of
another.

Several workers on **one** machine need nothing: every verify and read appends one line to
the same file, from whichever process it runs in. Reset once before the run, not in a setup
hook that every worker executes.

### Tests in a container

**What happens.** The provider's tests run inside a container (next to a database, say), and
the contracts directory is outside the build context of the image. The tests cannot find the
fixtures, or update mode writes files that never leave the container.

**What to do.** Mount the contracts directory into the container, writable, and point the
tests at it with `CONTRACT_FIXTURES_DIR` (or a relative `dir` that is right inside the
container). To record, pass `CONTRACT_FIXTURES_UPDATE=1` into the container explicitly; an
environment variable set on the host does not reach the tests by itself. The ledger is
written into the mounted directory, so `reset` and `check` can run inside or outside the
container, as long as both see the same directory. Do not pass `CI` into a container in which
you want to record: update mode is refused when `CI` is `true` or `1`.

## When the check fails

`check` lists every fixture this side did not verify or read. For one or two fixtures the
list is the answer: a fixture is new and has no reading test yet, or its verifying test was
deleted. When the list is long, the cause is usually not the fixtures, and the report has a
hint, taken from the state of the ledger, before its last line. When the ledger has no
entries at all, the list is left out: one line gives the number of fixtures, and the hint
follows it.

| Hint | Usual cause |
|---|---|
| the ledger does not exist, or has no entries | The tests did not run before the check, or they open another directory than the one given to `check` (compare `dir` in the tests with `--dir`). |
| ..., but the other side's ledger has some | The same, or `--side` names the wrong side. |
| has entries, but none that this check asks for | The ledger is from an earlier state of the directory and the tests did not run since. |
| only N of M fixtures were verified or read (given when more than half are untouched) | A part of the tests ran: a name filter, one file, one shard. `check` belongs after a full run. |
| names files that are not in this directory | No `reset` before the tests. |

A missing `reset` matters for another reason: the ledger of an old run still lists fixtures
whose tests are gone, and the check passes although it should not. Always reset, in CI and
in the script developers run.

## What to leave out

The README lists
[what the tool does not cover, and why](../README.md#what-it-does-not-cover). In an existing
project these come up most:

- **Sequences.** A fixture is one request and one response. A flow of several calls is
  several fixtures; that the calls fit together is not checked.
- **Signatures over raw bytes.** A fixture is compared after parsing, so a signature over the
  exact bytes of a body (as in webhooks) cannot be reproduced from it. Test the signature
  with bytes of your own.
- **Bodies that are not JSON.** Record status and headers, leave the body out.
- **Third-party services.** If the provider's tests replace a payment service, the fixture
  shows the replacement. Record such an exchange only if the response the consumer sees is
  built by your own code.
- **Parts of a value.** A secret is a whole value, and a volatile value is a whole value. A
  token inside a URL, or a timestamp inside a sentence, is covered by making the whole string
  secret or by giving it a pattern.
