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
| `secret` | no | Paths whose values must not be stored, each with the placeholder that is stored instead. See [Secrets](#secrets). |

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

The same as a provider fixture without `response`. `volatile` and `secret` paths start with
`request`.

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
Values that must not be stored at all are a different matter: see [Secrets](#secrets).

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

## Secrets

Fixtures are committed, so they must not contain credentials: not a password in a request, and
not an access token, a payment secret or a session cookie that the other side sends back.

### Placeholders

A string value that consists entirely of `<kind:name>`
(`^<[a-z][a-z0-9-]*:[A-Za-z0-9._-]+>$`), for example `<token:customer-1>`, is a placeholder. It
is what a fixture holds in place of a secret.

- A test that replays a fixture replaces placeholders with real values first. Both packages ship
  a helper that walks a JSON value and replaces every placeholder through a callback.
- The comparison treats placeholders as ordinary strings.

### Secret paths

`secret` is an object that maps a path to the placeholder stored at that path:

```json
{
  "format": 1,
  "name": "session.created",
  "description": "Signing in returns an access token",
  "request": {
    "method": "POST",
    "path": "/sessions",
    "body": { "email": "customer-1@example.test", "password": "<password:customer-1>" }
  },
  "response": {
    "status": 200,
    "body": { "access_token": "<token:session-1>", "expires_in": 3600 }
  },
  "secret": {
    "request.body.password": "<password:customer-1>",
    "response.body.access_token": "<token:session-1>"
  }
}
```

A secret path is written like a volatile path, with these differences:

- `**` is not allowed. `*` matches exactly one segment, as in a volatile path.
- After `request` or `response` (`request` only in a consumer fixture) comes `headers` or
  `body`: `request.headers.authorization`, `response.body.access_token`, `response.body` (a
  body that is a secret as a whole). Header names are written in lower case.
- A path replaces a **whole value**. A secret inside a longer string (`Bearer <token>`, one
  pair of a `cookie` header) cannot be addressed; make the whole header value the secret and
  let the placeholder stand for all of it.

The verifying side passes `secret` together with what it really produced. Before anything is
compared, printed or written, every string that a secret path matches is replaced by the
placeholder of that path. The real value therefore never reaches the fixture file, the text of
a difference, the message of an error, or the ledger. After that the fixture is compared like
any other: the stored fixture holds the same placeholder at the same place, so the value is
equal on every run, and `secret` itself is compared too.

- The value may already be the placeholder (a test that hands the placeholder to the helper
  and the real value to the code under test). Replacing it changes nothing.
- A secret path that matches nothing in what the side produced is an error, and so is a matched
  value that is not a string (`null`, a number, an object, an array). Neither is written, and
  neither message contains the value. A secret that disappears from a response is therefore
  noticed by the verifying side, not passed over.
- Paths are applied in UTF-16 code unit order. Two paths that give one node different
  placeholders are an error.
- A path that only the *stored* fixture lists (the test no longer passes it) is covered before
  differences are printed as well: the difference names `secret`, and the value at that path
  is not shown. In update mode the fixture is then written as the test describes it, without
  that path; the check for tokens below still applies.

**(beyond the schema)** A stored fixture is invalid when

| Code | |
|---|---|
| `secret` | `secret` is not an object, a key is not a secret path, or a value is not a placeholder. |
| `secret-unmatched` | a path matches no node of the fixture. |
| `secret-value` | a node that a path matches does not hold exactly the placeholder of that path. |
| `secret-volatile` | a node that a path matches is also covered by a volatile path (matched by it, or at or below a path that ends in `**`). A placeholder never changes, so it is compared exactly. |

A volatile path on a parent and a secret path on one of its children are two different nodes
and may be combined.

The reading side ignores `secret`: it receives the placeholders as they are stored and replaces
them with values of its own.

### Tokens that were not replaced

As a safety net, a provider or consumer fixture must not contain a string in which this
expression (ECMAScript syntax) finds a match:

```
(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+
```

That is the shape of a JSON Web Token: three base64url parts separated by dots, the first one
starting with `eyJ`, not preceded by a base64url character. Every string value of the fixture
is searched, the token may be a part of a longer string (`Bearer eyJ...`), and it does not
matter whether a volatile path covers the value.

- A verify that would write or compare such a fixture fails instead, in update mode too
  (issue code `jwt`). List the path in `secret`.
- A stored fixture that contains such a string is invalid (`jwt`).

The net is deliberately narrow, so that it does not get in the way: it knows this one shape.
Opaque tokens, API keys, payment secrets, cookies, and tokens with an empty third part are not
recognised; they are kept out of fixtures by `secret` paths only. Tables are not searched.

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
- The whole fixture takes part in the comparison (`description`, `volatile` and `secret`
  included), with `volatile` taken from the stored fixture, and after the secret paths of what
  the side produced have been replaced by their placeholders.

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
`format`, `name`, `description`, `request`, `response`, `volatile`, `secret`. An empty
`volatile` or `secret` is left out. Inside a body and inside `secret`, keys keep the
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
