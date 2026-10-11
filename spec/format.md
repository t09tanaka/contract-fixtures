# Fixture format, version 1

This document defines the files that `contract-fixtures` reads and writes. It is independent of
any programming language. The packages in this repository (`packages/ts`, `packages/dart`)
implement it, and both run the shared cases in [`fixtures/`](./fixtures) to show that they agree.

JSON Schemas for the three file kinds are in [`schema/`](./schema). The schemas describe the
shape; the rules marked **(beyond the schema)** below are enforced by the packages as well.

## Terms

- **Provider**: the side that answers requests (an API).
- **Consumer**: the side that sends requests and interprets the responses (a client).
- **Side**: `provider` or `consumer`. Every helper call and every check is made on behalf of one side.
- **Verify**: compare what this side really produced with the stored fixture.
- **Read**: load a fixture that the *other* side verifies (or a table), in order to feed it to this
  side's real code.

## Directory layout

```
<contracts>/
  provider/<name>.json    provider fixtures: one request and the provider's real response to it
  consumer/<name>.json    consumer fixtures: one request the consumer really builds
  tables/<name>.json      tables: rows of input and expected output for a shared calculation
  .ledger/<side>.jsonl    written by the helpers during a test run; not committed
```

- One fixture per file. The file name without `.json` is the fixture's `name`.
- Names match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Directories are flat; subdirectories and files
  that do not end in `.json` are ignored.
- `.ledger/` must be ignored by version control (for example a `<contracts>/.gitignore` that
  contains `.ledger/`).

| Kind | Directory | The provider side must | The consumer side must |
|---|---|---|---|
| provider fixture | `provider/` | verify it against a real response | read it |
| consumer fixture | `consumer/` | read it (and pass it to the real handler) | verify it against a request it really builds |
| table | `tables/` | read it | read it |

## Provider fixture

```json
{
  "format": 1,
  "name": "order.created",
  "description": "An order is accepted",
  "request": {
    "method": "POST",
    "path": "/orders",
    "headers": { "authorization": "<token:customer-1>" },
    "body": { "sku": "tea-100", "quantity": 2 }
  },
  "response": {
    "status": 201,
    "body": { "id": "ord_81f3", "status": "confirmed", "total_minor": 1200 }
  },
  "volatile": ["response.body.id"]
}
```

| Key | Required | Meaning |
|---|---|---|
| `format` | yes | The integer `1`. |
| `name` | yes | Equal to the file name without `.json` **(beyond the schema)**. |
| `description` | yes | A non-empty string: what this exchange is an example of. |
| `request` | yes | See below. |
| `response` | yes | `status` (integer, 100 to 599) and optionally `body` (any JSON value except `null`). |
| `volatile` | no | Paths whose values change between runs. See [Volatile paths](#volatile-paths). |

`request`:

| Key | Required | Meaning |
|---|---|---|
| `method` | yes | Upper-case letters, for example `POST`. |
| `path` | yes | Starts with `/`. A query string, if any, is part of the path. |
| `headers` | no | An object of strings. Header names are non-empty and contain no `A`–`Z`. |
| `body` | no | Any JSON value except `null`. |

No other keys are allowed at any of these levels. "No body" is expressed by omitting `body`;
the helpers drop a `null` body before comparing or writing.

Only what a test passes in is recorded. Record the request headers and the response fields that
are part of the agreement between the two sides, not everything that happens to be on the wire.

## Consumer fixture

The same as a provider fixture without `response`. `volatile` paths start with `request`.

```json
{
  "format": 1,
  "name": "create-order.request",
  "description": "The request the client sends to place an order",
  "request": {
    "method": "POST",
    "path": "/orders",
    "headers": { "authorization": "<token:customer-1>", "content-type": "application/json" },
    "body": { "sku": "tea-100", "quantity": 2 }
  }
}
```

## Table

```json
{
  "format": 1,
  "name": "order-total",
  "description": "Total in minor units. The discount is rounded half up before it is subtracted.",
  "rows": [
    { "case": "no discount", "unit_price_minor": 600, "quantity": 2, "discount_percent": 0, "expected_minor": 1200 }
  ]
}
```

`rows` is a non-empty array of objects. The keys of a row are up to the table; both sides read the
same rows and assert that their own implementation produces the expected values.

## Volatile paths

Values such as generated ids, timestamps and order numbers differ on every run. They are stored
as they really were (so the reading side parses a real sample), and the fixture lists their
locations in `volatile`.

A path is a list of segments separated by `.`, starting at the fixture root:
`response.body.items.0.id`.

- A segment is an object key or an array index.
- `*` matches exactly one segment (any key or any index).
- `**` is allowed only as the last segment. It matches the node before it and everything below.
- `*` is special only as a whole segment; a segment such as `a*b` is not allowed.
- The first segment is `request` or `response` (`request` only in a consumer fixture), and the
  second names one of its keys literally (`response.body`, `request.headers`, ...). A path that
  covers the whole request or response (`response`, `response.*`, `response.**`) is rejected,
  because it would switch the comparison off **(beyond the schema)**.
- Every path must match at least one node of the stored fixture **(beyond the schema)**; a path
  that matches nothing is a mistake.
- Keys that contain `.` cannot be addressed: `a.b` always means the key `b` inside `a`. A path
  written for a dotted key therefore matches nothing and is rejected (or, if a nested key of
  that name exists, addresses that one).

How the verifying side compares:

| The node is | Comparison |
|---|---|
| matched by a path without `**` | The JSON type must be equal (`null`, `boolean`, `number`, `string`, `array`, `object`). Nothing below the node is compared. |
| at or below a path ending in `**` | Same type; objects have the same keys; arrays have the same length; scalar values are not compared. |
| anything else | Exactly equal. |

A key that is present on one side and absent on the other is a difference when the key itself is
the volatile node, and anywhere at or below a `**` path. Below a node matched by a path without
`**`, nothing is compared, keys included. When both rules apply to a node, the first one wins.

Keep volatile paths as narrow as the value that really changes: `response.body` alone reduces
the check of the body to "it is still an object".

The reading side ignores `volatile`.

## Secret placeholders

Fixtures are committed, so they must not contain credentials. A string value that consists
entirely of `<kind:name>` (`^<[a-z][a-z0-9-]*:[A-Za-z0-9._-]+>$`), for example
`<token:customer-1>`, is a placeholder.

- The verifying test passes the placeholder (not the real secret) as the recorded request, and
  sends the real value to the code under test.
- A test that replays a fixture replaces placeholders with real values first. Both packages ship
  a helper that walks a JSON value and replaces every placeholder through a callback.

Placeholders are a convention on values; the comparison treats them as ordinary strings.

## Comparison

- A stored fixture is parsed before it is compared. Formatting, indentation and key order do not
  matter, so a formatter may rewrite the files.
- What a side produced is taken through a JSON round trip first, so the comparison sees what
  would go over the wire.
- Header names in what a side produced are lower-cased before comparing or writing (`A`–`Z` only;
  other characters are left alone). Two headers that differ only in case are an error.
- Fixture files are UTF-8. A byte order mark at the start is ignored; a file that is not valid
  UTF-8 is an invalid fixture.
- A symbolic link to a file counts as that file.
- Numbers are compared by value: `1` and `1.0` are equal.
- A number whose value is a whole number beyond ±(2^53 − 1) is not allowed anywhere in a fixture
  or a table **(beyond the schema)**: not every JSON parser keeps it exact, so the two sides
  could silently see different values. This includes large floating point values such as `1e300`
  and literals too large for a double (`1e400`). Send such values as strings. This holds for
  what a side produced as well as for stored files; NaN and infinities in what a side produced
  are rejected too.
- Strings are compared code unit by code unit. Nothing is normalised: a composed and a decomposed
  form of the same character are different strings.
- `null`, an absent key, `""`, `{}` and `[]` are all different from each other. The one exception
  is the top-level `body` of a request or response, where `null` means "no body" (see above).
- The whole fixture takes part in the comparison (`description` and `volatile` included), with
  `volatile` taken from the stored fixture.

A difference is reported as a path and what changed, stored value first:

```
response.body.total_minor: 1200 -> 1250
response.body.note: (absent) -> "gift"
response.body.status: "confirmed" -> (absent)
response.body.items: array length 2 -> 3
response.body.id: type string -> number (volatile: only the type is compared)
```

Object keys are visited in UTF-16 code unit order, so both packages print the same lines in the
same order. Values are printed as compact JSON with keys in the same order. A key that contains
`.` is printed as it is, so its path can look like the path of a nested key.

## Update mode

Normally a verify that finds a difference fails, and a verify without a stored fixture fails.

In update mode (environment variable `CONTRACT_FIXTURES_UPDATE=1`, or the equivalent option) a
verify writes the fixture instead:

- A missing fixture is created.
- A fixture that differs is replaced.
- A fixture that already agrees (volatile paths considered) is left untouched, so volatile values
  do not churn.

Fixtures are written as JSON with two-space indentation, a trailing newline, and the key order
`format`, `name`, `description`, `request`, `response`, `volatile`. Inside a body, keys keep the
order the side produced them in, except that keys that are array indexes (`"0"`, `"10"`) come
first in ascending order, as in a JavaScript object. Integer-valued numbers are written without
a fraction (`1`, not `1.0`). Characters are written as they are; only characters below U+0020,
`"`, `\` and lone surrogates are escaped. The cases in `fixtures/canonical.json` and `fixtures/verify.json` pin
the exact text for both packages. Update mode never deletes files; a fixture whose
test was removed is found by the check.

Reading never writes fixtures. Update mode is meant for a developer's machine, not for CI: when
the environment variable `CI` is `true` or `1`, `CONTRACT_FIXTURES_UPDATE=1` is refused.

## Ledger

Every successful verify and read appends one line to `<contracts>/.ledger/<side>.jsonl`:

```json
{"side":"provider","action":"verified","file":"provider/order.created.json"}
{"side":"provider","action":"read","file":"consumer/create-order.request.json"}
```

`action` is `verified` or `read`; `file` uses `/` on every platform. A failed verify or read
writes nothing.

## Check

The check compares the fixtures on disk with one side's ledger. It looks at that side's ledger
only, so the provider and the consumer can run it in separate CI jobs.

Sequence: reset the side's ledger, run that side's tests, run the check.

The check fails when, for the given side:

| Code | Meaning |
|---|---|
| `invalid` | A fixture does not follow this format. |
| `unverified` | A fixture this side must verify was not verified: it is stale (this side no longer produces it) or its test is gone. |
| `unread` | A fixture or table this side must read was not read: nothing on this side depends on it. |
| `ledger` | A ledger line is not an entry of this side: it cannot be parsed, names the other side, or has an unknown action. |
| `empty` | There are no fixtures at all (most likely a wrong directory). |

Exit codes of the check command: `0` no problems, `1` at least one problem, `2` wrong usage
(unknown option, missing or non-existent directory).

The ledger proves that a fixture was loaded, not that the test asserted anything about it. See
the README for the recommended way to keep reading tests honest (an expectation table whose keys
must equal the list of fixtures).

## Versioning

`format` is `1`. A reader rejects any other value. Changes that old readers cannot handle will
use a new number.
