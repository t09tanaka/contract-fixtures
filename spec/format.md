# Fixture format, version 1

This document defines the files that `contract-fixtures` reads and writes. It is independent of
any programming language. The packages in this repository (`packages/ts`, `packages/dart`)
implement it, and both run the shared cases in [`fixtures/`](./fixtures) to show that they agree.

JSON Schemas for the three file kinds, for a line of the ledger and for the configuration of a
directory are in [`schema/`](./schema). The schemas describe the
shape; the rules marked **(beyond the schema)** below are enforced by the packages as well.

## Terms

- **Provider**: the side that answers requests (an API).
- **Consumer**: the side that sends requests and interprets the responses (a client).
- **Side**: `provider` or `consumer`. Every helper call and every check is made on behalf of one
  side.
- **Verify**: compare what this side really produced with the stored fixture.
- **Read**: load a fixture that the *other* side verifies (or a table), in order to feed it to this
  side's real code.

## Directory layout

```
<contracts>/
  provider/<name>.json    provider fixtures: one request and the provider's real response to it
  consumer/<name>.json    consumer fixtures: one request the consumer really builds
  tables/<name>.json      tables: rows of input and expected output for a shared calculation
  config.json             optional: what is particular to this directory (see Configuration)
  .ledger/<side>.jsonl    written by the helpers during a test run; not committed
```

- One fixture per file. The file name without `.json` is the fixture's `name`.
- Names match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Directories are flat; subdirectories and files
  that do not end in `.json` are ignored. A file in the place of one of the three directories
  holds no fixtures.
- `.ledger/` must be ignored by version control (for example a `<contracts>/.gitignore` that
  contains `.ledger/`).

| Kind | Directory | The provider side must | The consumer side must |
|---|---|---|---|
| provider fixture | `provider/` | verify it against a real response | read it |
| consumer fixture | `consumer/` | read it (and send it to the real API) | verify it against a request it really builds |
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
| `response` | yes | See below. |
| `volatile` | no | Paths whose values change between runs. See [Volatile paths](#volatile-paths). |
| `secret` | no | Paths whose values must not be stored, each with the placeholder that is stored instead. See [Secrets](#secrets). |

`request`:

| Key | Required | Meaning |
|---|---|---|
| `method` | yes | Upper-case letters, for example `POST`. |
| `path` | yes | Starts with `/`. A query string, if any, is part of the path. |
| `headers` | no | See [Headers](#headers). |
| `body` | no | Any JSON value except `null`. |

`response`:

| Key | Required | Meaning |
|---|---|---|
| `status` | yes | An integer from 100 to 599. |
| `headers` | no | See [Headers](#headers). |
| `body` | no | Any JSON value except `null`. |

No other keys are allowed at any of these levels. "No body" is expressed by omitting `body`;
the helpers drop a `null` body before comparing or writing.

Only what a test passes in is recorded. Record the headers and the fields that are part of the
agreement between the two sides, not everything that happens to be on the wire.

### Headers

`headers` of a request and of a response follow the same rules.

```json
"response": {
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "content-disposition": "attachment; filename=\"receipt-ord_81f3.json\"",
    "set-cookie": ["<cookie:session-1>", "theme=dark; Path=/"]
  },
  "body": { "order_id": "ord_81f3", "total_minor": 1200 }
}
```

- `headers` is an object. A header name is non-empty and contains no `A`–`Z`.
- A value is a string, or a non-empty array of strings for a header that is sent more than
  once (typically `set-cookie`). The order of the array is the order on the wire, and it is
  compared. A string and an array of one string are different: record a header the way the
  test receives it, and keep to that.
- A fixture holds the headers the test passed, nothing more. A header that the test does not
  pass is not compared; a header that is stored and no longer passed is a difference. Leave out
  what varies with the infrastructure (`date`, `server`, `content-length`) unless it is part of
  the agreement, or list it under `volatile`.
- The values of a repeated header are addressed by index: `response.headers.set-cookie.0`,
  `response.headers.set-cookie.*`. `volatile` and `secret` paths work on them as on any other
  node.
- A body that is not JSON (a PDF, a CSV file, an image) cannot be recorded, because a fixture
  is a JSON document that both sides parse the same way and compare value by value. For such
  a response, record `status` and `headers` (`content-type`, `content-disposition`) and omit
  `body`.

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
as they really were (so the reading side parses a real value), and the fixture lists their
locations in `volatile`. Values that must not be stored at all are a different matter: see
[Secrets](#secrets).

```json
"volatile": [
  { "path": "response.body.id", "pattern": "^ord_[a-z0-9]+$" },
  { "path": "response.body.**.created_at", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$" },
  { "path": "response.body.**.closed_at", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", "nullable": true },
  "response.body.note"
]
```

An entry of `volatile` is

- a **path** (a string): the value at that path may change, its JSON type may not; or
- an object with the keys **`path`** and **`pattern`** (both strings): the value at that path
  may change, but it is always a string that matches the pattern as a whole. See
  [Patterns](#patterns). The object may also have the key **`nullable`** with the value
  `true`: the value is then a string that matches the pattern, **or `null`**. See
  [Values that may be null](#values-that-may-be-null).

No other key is allowed in such an object.

Prefer the second form. A plain path says "anything of the same type"; a pattern keeps a check
on the value, so a response that starts to return something else in that place is noticed.

### Paths

A path is a list of segments separated by `.`, starting at the fixture root:
`response.body.items.0.id`.

- A segment is an object key or an array index.
- `*` matches exactly one segment (any key or any index).
- `**` matches any number of segments, none included. It may appear once in a path.
  - In the middle (`response.body.**.created_at`), the path names every node that the segments
    after `**` lead to, at any depth below the segments before it: `response.body.created_at`,
    `response.body.lines.0.created_at`, `response.body.customer.profile.created_at`.
  - As the last segment (`response.body.meta.**`), it names the node before it and everything
    below, and these nodes are compared in a different way (see the table).
- `*` is special only as a whole segment; a segment such as `a*b` is not allowed.
- The first segment is `request` or `response` (`request` only in a consumer fixture), and the
  second names one of its keys literally (`response.body`, `request.headers`, `request.path`,
  ...). A path that could cover the whole request or response (`response`, `response.*`,
  `response.**`, `response.**.id`) is rejected, because it would switch the comparison off
  **(beyond the schema)**.
- Every path must match at least one node of the stored fixture **(beyond the schema)**; a path
  that matches nothing is a mistake.
- Keys that contain `.` cannot be addressed: `a.b` always means the key `b` inside `a`. A path
  written for a dotted key therefore matches nothing and is rejected (or, if a nested key of
  that name exists, addresses that one).

How the verifying side compares:

| The node is | Comparison |
|---|---|
| named by a path that does not end in `**` | The JSON type must be equal (`null`, `boolean`, `number`, `string`, `array`, `object`). If the entry has a pattern, the value must be a string that matches it (or, with `nullable`, `null`); the stored value is then not looked at, because it follows the same rule. Nothing below the node is compared. |
| at or below a path ending in `**` | Same type; objects have the same keys; arrays have the same length; scalar values are not compared. |
| anything else | Exactly equal. |

A key that is present on one side and absent on the other is a difference when the key itself is
the volatile node, and anywhere at or below a path that ends in `**`. Below a node named by a
path that does not end in `**`, nothing is compared, keys included.

When several entries apply to one node, the order of the entries does not matter:

- A path that names the node wins over a path that ends in `**` and merely contains it.
- Every pattern among the entries that name the node applies; the value must match all of
  them. A plain path for the same node adds nothing and takes nothing away.
- `null` is accepted only when every entry with a pattern that names the node says
  `nullable`.

### Values that may be null

A value is often a string in one place and `null` in another: the time at which something
was closed, in a list of which some rows are closed and some are not. One entry names them all:

```json
{ "path": "response.body.**.closed_at", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", "nullable": true }
```

- With `"nullable": true`, each node the path names is a string that matches the pattern, or
  `null`. Nothing else is accepted: not a number, not a string of another shape.
- Whether it is the string or `null` may change between runs, and between the stored fixture
  and what a side produces: a stored `null` and a produced string that matches agree, and so
  do a stored string and a produced `null`. That is what the entry says, so use it only where
  both really occur.
- An absent key is not `null`. A key that is there on one side and missing on the other is
  still a difference.
- `nullable` needs a `pattern`. Without one, a stored `null` would leave nothing to compare
  the next value with, so `{ "path": ..., "nullable": true }` is not an entry.
- The only value is `true`. `"nullable": false` is not an entry either; leave the key out.
- It cannot be combined with a path that ends in `**` (no pattern can), and a secret path has
  no such key: a secret is always a string.
- The top-level `body` of a request or response is never `null` (see above), so `nullable`
  has no effect on `response.body` itself.

Keep volatile paths as narrow as the value that really changes. `response.body` alone reduces
the check of the body to "it is still an object", and `response.body.customer.**` gives up every
value below `customer` to hide one timestamp. Name the key instead, wherever it is, and say what
it looks like: `{ "path": "response.body.**.created_at", "pattern": "..." }`.

The path of a request can be volatile as well. When an id is a part of it, give it a pattern:

```json
{ "path": "request.path", "pattern": "^/orders/ord_[a-z0-9]+/receipt$" }
```

A query string stays a part of that one string. It is not taken apart into parameters: the side
that builds a request does so in a fixed way, so comparing the string (or its pattern) is enough.

The reading side ignores `volatile`.

### Patterns

A pattern is a regular expression in ECMAScript syntax, without flags, restricted to the
constructs below. The value must match **as a whole**: the pattern behaves as if it were written
`^(?:pattern)$`, so `confirmed|cancelled` does not match `confirmed late`, with or without
anchors of its own.

| Construct | Meaning |
|---|---|
| any other character | itself (letters are compared as they are; upper and lower case differ) |
| `.` | one UTF-16 code unit, except line feed, carriage return, U+2028 and U+2029 |
| `\d` `\w` `\s` | `0`–`9`; `A`–`Z`, `a`–`z`, `0`–`9`, `_`; white space as ECMAScript defines it (tab, line feed, vertical tab, form feed, carriage return, space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) |
| `\D` `\W` `\S` | everything else |
| `\n` `\r` `\t` | line feed, carriage return, tab |
| `\` before one of `^ $ \ . * + ? ( ) [ ] { } \| / -` | that character |
| `[...]`, `[^...]` | one code unit that is (not) in the class: single characters, ranges `a-z`, and the escapes above. `-` is a character at the start or the end of the class. A class is not empty. |
| `(...)`, `(?:...)` | a group (the two forms mean the same) |
| `a\|b` | either side |
| `*` `+` `?` `{n}` `{n,}` `{n,m}` | repetition of the character, class or group before it |
| `^` `$` | the start and the end of the value (not of a line) |

Everything else is not a pattern of this format and makes the fixture invalid (issue code
`pattern`): lazy repetitions (`*?`), a repetition of a repetition (`a{2}{3}`), `^*`, look-ahead
and look-behind, named groups, back references, `\b`, `\u`, `\x`, `\p{...}`, every other
escape that is not in the table (`\_`, `\1`, `\a`), `\d`, `\w` or `\s` as one end of a range
in a class, an unescaped `{`, `}` or `]` that is not part of a construct above, and characters
beyond U+FFFF (a value may contain them; each counts as two code units).

Limits, so that a fixture cannot make a test run away: a pattern is at most 1000 code units
long, a repetition count has at most 5 digits, and the *size* of a pattern is at most 10000,
where the size of a character, class or anchor is 1, of a sequence the sum of its parts, of a
choice the sum of its branches plus one less than their number, of `x{n,m}` (also `?`) `m` times
the size of `x` plus `m − n`, and of `x{n,}` (also `*`, `+`) `n + 1` times the size of `x`
plus 1. In a repetition the size of `x` counts as at least 1, also when `x` is empty.

The packages do not hand a pattern to the regular expression engine of their language. They
match it themselves, in time proportional to the length of the value times the size of the
pattern, so `(a+)+b` cannot stall a test, and so that the result is the same in every
implementation. The cases in `fixtures/patterns.json` pin the syntax and the results, and both
packages also compare them with the engine of their language.

A pattern cannot be combined with a path that ends in `**`. A node that a `secret` path matches
cannot be volatile, with or without a pattern.

**(beyond the schema)** A stored fixture is invalid when

| Code | |
|---|---|
| `volatile` | an entry is neither a path nor an object with `path`, `pattern` and (optionally) `nullable`: it has another key, lacks `pattern`, or has a `nullable` that is not `true`; the path does not follow the rules above; or an entry with a pattern has a path that ends in `**`. |
| `pattern` | the pattern of an entry is not one (reported at `volatile.<index>.pattern`). |
| `volatile-unmatched` | a path matches no node of the fixture. |
| `volatile-pattern` | a node named by an entry with a pattern is not a string (and not a `null` that `nullable` allows), or does not match the pattern. |

What a verifying side produced is held to the same rules, with two differences. Both exist
because a difference from the stored fixture says more than the issue does.

- A value that does not match the pattern of its entry is reported as a **difference**
  (`response.body.id: "ord_81f3" -> "81f3" (volatile: does not match ^ord_[a-z0-9]+$)`), like
  any other change of a response.
- A volatile path that matches nothing in what the side produced does not stop the
  comparison. When the response is another one altogether (an error in the place of the
  expected answer), every volatile path of the test matches nothing; the differences then
  show what came back, the status included, and the paths are listed after them. See
  [Messages of a verify](#messages-of-a-verify).

Such a fixture is never written: in update mode the verify fails with `volatile-pattern` or
`volatile-unmatched` instead, whether or not there is a stored fixture. The same error is
given, outside update mode too, when there is no difference to show: such a value or path lies
below another volatile node and is for that reason not compared (`response.body.order` and a
pattern for `response.body.order.id`). Without a stored fixture and outside update mode, the
verify fails because the fixture does not exist.

The message of a `volatile-pattern` issue shows the value, so that a pattern that misses can
be corrected (`response.body.id: "81f3" does not match the pattern ^ord_[a-z0-9]+$ of
volatile.0`). It does not show a value that a secret path names, one in which the expression
for tokens finds a match, or one that the configuration of the directory forbids.

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
  pair of a `cookie` header, the value inside a `set-cookie` header) cannot be addressed; make
  the whole header value the secret and let the placeholder stand for all of it. For a header
  that is sent more than once, each element of the array is such a whole value:
  `"response.headers.set-cookie.0": "<cookie:session-1>"`. A path that stops at the array
  (`response.headers.set-cookie`) matches a value that is not a string, which is an error.

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
  neither message contains the value, or any other value of what the side produced. A secret
  that disappears from a response is therefore noticed by the verifying side, not passed over.
- Paths are applied in UTF-16 code unit order. Two paths that give one node different
  placeholders are an error.
- A path that only the *stored* fixture lists (the test no longer passes it) is covered before
  differences are printed as well: the difference names `secret`, and the value at that path
  is not shown. Update mode refuses to write such a fixture; see [Update mode](#update-mode).

**(beyond the schema)** A stored fixture is invalid when

| Code | |
|---|---|
| `secret` | `secret` is not an object, a key is not a secret path, or a value is not a placeholder. |
| `secret-unmatched` | a path matches no node of the fixture. |
| `secret-value` | a node that a path matches does not hold exactly the placeholder of that path. |
| `secret-volatile` | a node that a path matches is also covered by a volatile path (matched by it, or at or below a path that ends in `**`). A placeholder never changes, so it is compared exactly. |

A volatile path on a parent and a secret path on one of its children are two different nodes
and may be combined. The schema accepts upper-case letters in a path; a path that names a
header in upper case simply matches nothing (`secret-unmatched`), because stored header names
are lower case.

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
is searched (object keys and header names are not), the token may be a part of a longer string
(`Bearer eyJ...`), and it does not matter whether a volatile path covers the value.

- A verify that would write or compare such a fixture fails instead, in update mode too
  (issue code `jwt`). List the path in `secret`.
- A stored fixture that contains such a string is invalid (`jwt`).

The net is deliberately narrow, so that it does not get in the way: it knows this one shape.
Opaque tokens, API keys, payment secrets, cookies, and tokens with an empty third part are not
recognised; they are kept out of fixtures by `secret` paths, or by a pattern of the project's
own in the [configuration](#configuration). Tables are not searched.

## Configuration

A contracts directory may hold a file `config.json` next to `provider/`, `consumer/` and
`tables/`. It is committed with the fixtures, and both sides and every implementation read
the same file. Without the file nothing changes.

```json
{
  "format": 1,
  "forbidden": ["sec_(live|test)_[A-Za-z0-9]+", "^hook_"]
}
```

| Key | Required | Meaning |
|---|---|---|
| `format` | yes | The integer `1`. |
| `forbidden` | no | An array of [patterns](#patterns). No string of a fixture may contain what one of them describes. |

No other keys are allowed. The file is UTF-8, like a fixture, and a byte order mark is
ignored.

`forbidden` is for credentials that have a shape of their own (a prefix, a fixed length) and
that the net for tokens does not know. It works like that net:

- Every string value of a provider or consumer fixture is searched; object keys and header
  names are not, and tables are not.
- A pattern is **searched** in the string: it matches when a part of the string does, so
  `sec_live_[A-Za-z0-9]+` finds the key in `Bearer sec_live_9fK27Q`. This is the one place where
  a pattern is not matched against the whole value. `^` and `$` are still the start and the
  end of the value, so `^hook_` asks for a string that starts with `hook_`. Syntax and
  limits are those of [Patterns](#patterns).
- A verify that would write or compare a fixture with such a string fails instead, in update
  mode too, before anything is compared and whether or not the fixture exists (issue code
  `forbidden`). For a value in headers or a body, list the path in `secret`; the placeholder
  that is then stored is not what the pattern describes. A string elsewhere (the path of a
  request, a description, a pattern) cannot be a secret path and has to change.
- A stored fixture that holds such a string is invalid (`forbidden`): it cannot be read, and
  the check reports it.
- The message names the path and the index of the pattern (`forbidden.0`), never the value,
  and says what to do, which depends on the place (the same holds for a token):

  | The string is | The message ends with |
  |---|---|
  | a value in `request.headers`, `request.body`, `response.headers` or `response.body`, at any depth | `(list this path in secret, so that a placeholder is stored instead)` |
  | anywhere else: `name`, `description`, `request.method`, `request.path`, a path or a `pattern` in `volatile`, a placeholder in `secret` | `(no secret path can name this place: change the text itself)` |
- A pattern that matches the empty string would forbid every string, so it is not accepted.

**(beyond the schema)** A configuration is invalid when

| Code | |
|---|---|
| `json` | `config.json` is not a file, not valid JSON, or not valid UTF-8. |
| `root` | it is not an object. |
| `unknown-key` | it has a key other than `format` and `forbidden`. |
| `format` | `format` is not `1`. |
| `forbidden` | `forbidden` is not an array, or an entry is not a string. |
| `pattern` | an entry is not a pattern, or matches the empty string (reported at `forbidden.<index>`). |

While the configuration is invalid, no helper verifies or reads a fixture of that directory
(the error names `config.json` and the issues), and the check reports every issue as a
problem of `config.json`. The check and the summary then look at the fixtures as if the
directory had no configuration. The cases in `fixtures/configuration.json` pin the issues,
and those of `fixtures/patterns.json` the search.

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
response.body.id: "ord_81f3" -> "81f3" (volatile: does not match ^ord_[a-z0-9]+$)
response.body.id: type string -> number (volatile: must be a string that matches ^ord_[a-z0-9]+$)
response.body.closed_at: null -> "soon" (volatile: does not match ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$)
response.body.closed_at: type null -> number (volatile: must be a string that matches ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$, or null)
response.headers.cache-control: "private, no-store" -> (absent)
response.headers.set-cookie: array length 2 -> 1
```

Object keys are visited in UTF-16 code unit order, so both packages print the same lines in the
same order, with one exception: **the difference at `response.status` comes first**. When a
response is another one altogether, the status says most, and the lines of the body can be
many and long. Every other line keeps its place.

A printed value is at most 200 UTF-16 code units long. A longer one (the compact JSON of a
large object, a long string) is cut after 200 code units, or after 199 when the 200th is the
first half of a surrogate pair, and followed by `... (<n> more)`, where n is the number of
code units left out:

```
response.body.report: {"text":"xxxxxxxxxx... (111 more) -> (absent)
```

(the line is shortened here; the cases have it in full). The stored side and the observed side
of a line are cut each for itself, so both ends of `->` stay readable. The whole value is in
the fixture file and in the real response. The same limit holds for the value in the message
of a `volatile-pattern` issue. Values are printed as compact JSON with keys in the same order. A key that contains
`.` is printed as it is, so its path can look like the path of a nested key.

### Messages of a verify

A verify that fails says what to do next, and the text is the same in every implementation
(the cases in `fixtures/verify.json` pin it). A stored fixture that differs:

```
contract fixture provider/order.created.json no longer matches what the provider side produces (stored -> observed):
  response.body.status: "confirmed" -> "pending"
If the change is intended, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

When volatile paths of the test match nothing in what the side produced, the differences come
first and the paths after them, and the last line says that the paths have to go as well:

```
contract fixture provider/order.created.json no longer matches what the provider side produces (stored -> observed):
  response.status: 201 -> 500
  response.body.created_at: "2026-01-15T09:30:00Z" -> (absent)
  response.body.error: (absent) -> "internal"
  response.body.id: "ord_81f3" -> (absent)
  response.body.message: (absent) -> "Unexpected token"
  response.body.status: "confirmed" -> (absent)
These volatile paths of the test match nothing in what the provider side produced:
  volatile.0: response.body.id matches nothing in this fixture
  volatile.1: response.body.created_at matches nothing in this fixture
If the change is intended, take these paths out of the test, rerun with CONTRACT_FIXTURES_UPDATE=1, then fix the other side's tests in the same change.
```

In update mode the same verify writes nothing, and its message has the same order: the first
line and the differences as above, then

```
The fixture is not updated, because what this side produced is not a valid fixture:
  volatile.0: response.body.id matches nothing in this fixture
  volatile.1: response.body.created_at matches nothing in this fixture
```

When the stored fixture lists a secret path that the test does not pass, update mode would
refuse (see [Update mode](#update-mode)), so the last line does not point there:

```
Update mode does not drop a secret path: pass the path as `secret` in this test, or remove it from the stored file by hand.
```

What a side produced can also be refused before anything is compared: a secret path that
matches nothing, a token, a string the configuration forbids, a header that is not a string.
No difference is printed then, because a difference shows values, and the value in question
may be the secret (a secret that moved to another key would be printed as an added key). One
thing is added, because it is a number that no secret path can name: when the status of the
response is not the one of the stored fixture, the message ends with

```
The status of the response is not the stored one either: 200 -> 500
```

## Update mode

Normally a verify that finds a difference fails, and a verify without a stored fixture fails.

In update mode (environment variable `CONTRACT_FIXTURES_UPDATE=1`, or the equivalent option) a
verify writes the fixture instead:

- A missing fixture is created.
- A fixture that differs is replaced.
- A stored fixture is **not** replaced when it lists a secret path that the test does not pass
  (the same path as a key of `secret`; the placeholder may be another one). Writing it would
  put the real value into the file. The verify fails with the name of the fixture and the
  paths (issue code `secret-removed`), without a value. Either pass the path as `secret` in
  the test, or remove it from the stored file by hand. This holds whether or not the stored
  fixture follows the format otherwise.
- A fixture that already agrees (volatile paths considered) is left untouched, so volatile values
  do not churn.

A response that was not a 5xx and is one now is written like any other change, because a
fixture of a 5xx can be meant. But it is more often the sign of a test application that is
not the deployed one, so the verify adds a note, without failing. When the stored fixture has
a status below 500 and the fixture that was just written has one of 500 or more, one line
goes to standard error (or to the function a test passes for it):

```
contract fixture provider/order.created.json was updated from status 201 to 500. A fixture with a 5xx is rarely what the deployed API answers: before committing it, check how this test assembles the application (docs/adoption.md, "Which tests verify").
```

There is no note for a new fixture, for a fixture that was a 5xx before, for a stored file
without a status, outside update mode, or when nothing was written.

Fixtures are written as JSON with two-space indentation, a trailing newline, and the key order
`format`, `name`, `description`, `request`, `response`, `volatile`, `secret` (inside a request:
`method`, `path`, `headers`, `body`; inside a response: `status`, `headers`, `body`). An empty
`volatile` or `secret` is left out. The entries of `volatile` keep the order the side gave
them; an entry with a pattern is written with the keys `path`, `pattern` and, when it is
set, `nullable`. Inside a body and
inside `secret`, keys keep the order the side produced them in, except that keys that are
array indexes (`"0"`, `"10"`) come first in ascending order, as in a JavaScript object.
Integer-valued numbers are written without a fraction (`1`, not `1.0`). Characters are written
as they are; only characters below U+0020, `"`, `\` and lone surrogates are escaped. The cases
in `fixtures/canonical.json` and `fixtures/verify.json` pin the exact text for both packages.
Update mode never deletes files; a fixture whose test was removed is found by the check.

Reading never writes fixtures. Update mode is meant for a developer's machine, not for CI: when
the environment variable `CI` is `true` or `1`, `CONTRACT_FIXTURES_UPDATE=1` is refused.

## Ledger

Every successful verify and read appends one line to `<contracts>/.ledger/<side>.jsonl`:

```json
{"side":"provider","action":"verified","file":"provider/order.created.json"}
{"side":"provider","action":"read","file":"consumer/create-order.request.json"}
```

`action` is `verified` or `read`; `file` uses `/` on every platform. A failed verify or read
writes nothing. A reader ignores a byte order mark at the start of the file and lines that
hold nothing but spaces, tabs and carriage returns.

A ledger is a file. When something else is in its place (a directory), or the file cannot be
read, written or removed, nothing is passed over: the verify or read fails, and so do the
reset and the check, each with the message
`<tool>: the ledger .ledger/<side>.jsonl cannot be used (it is not a file, or it cannot be read or written)`.
A missing ledger is not such a case (nothing was recorded), and neither is a file in the place
of the directory `.ledger`: there is no ledger then, until a verify or read tries to write
one. The ledger of the *other* side is only looked at for a hint; when it cannot be used, it
counts as one without entries.

## Check

The check compares the fixtures on disk with one side's ledger. It looks at that side's ledger
only, so the provider and the consumer can run it in separate CI jobs.

Sequence: reset the side's ledger, run that side's tests, run the check.

The check fails when, for the given side:

| Code | Meaning |
|---|---|
| `invalid` | A fixture does not follow this format, or `config.json` does not (the problem then names `config.json`, which is not counted as a fixture). |
| `unverified` | A fixture this side must verify was not verified: it is stale (this side no longer produces it) or its test is gone. |
| `unread` | A fixture or table this side must read was not read: nothing on this side depends on it. |
| `ledger` | A ledger line is not an entry of this side: it cannot be parsed, names the other side, or has an unknown action. |
| `empty` | There are no fixtures at all (most likely a wrong directory). |

Exit codes of the check command: `0` no problems, `1` at least one problem, `2` wrong usage
(see [Command line](#command-line)). The reset command exits with `0`, or with `2` for wrong
usage. Both exit with `1` when they cannot finish.

When the ledger of the side has no entries, none of the fixtures that follow the format was
verified or read, and the cause is the ledger, not the fixtures. The report then has one line
for all of them in the place of one line each,
`  - none of the <n> fixture(s) that follow the format was verified or read by the <side> side's tests (they are not listed one by one)`,
followed by the hint. The problems themselves and the exit code are the same as with the
whole list; fixtures that are `invalid` and lines of the ledger that are not entries keep
their own lines. As soon as the ledger has one entry, every fixture is listed.

The check always looks at every fixture. It is meant to run after all tests of a side; when
the tests run in several shards, concatenate the ledger files of the shards into
`<contracts>/.ledger/<side>.jsonl` first (the order and repetition of lines do not matter).

The ledger proves that a fixture was loaded, not that the test asserted anything about it. See
the README for the recommended way to keep reading tests honest (an expectation table whose keys
must equal the list of fixtures, or several tables that each cover the names with one prefix,
together with a list of the prefixes that must cover every name). The messages of these two
assertions are pinned by `fixtures/coverage.json`.

### Hints

When there are `unverified` or `unread` problems, the report of the check may add up to two
hints about their cause, taken from the state of the ledger. They are guesses and are worded
as such. They never change the problems or the exit code.

| The ledger of the side | Hint |
|---|---|
| does not exist, or has no entries | Did this side's tests run, and on this directory? If the other side's ledger has entries: did they run, and is this the side to check? |
| has entries, but no fixture has the verify or read the check asks for | Did the tests run since the fixtures changed? |
| covers fewer than half of the fixtures that follow the format (and at least one) | A part of the tests may have run (a filter, one shard). |
| names files that are not in the directory | It may be left from an earlier run; reset before the tests. |

The first three exclude each other; the last one can follow any of them. The exact wording is
pinned by the cases in `fixtures/check.json`, together with the whole report of every case.

## Summary

The summary command prints the fixtures of a contracts directory side by side, one line each,
so that differences between exchanges show: which status each has, and which keys the body of
its response has. It reads the fixture files only; the ledger plays no part.

```
FIXTURE                        REQUEST       STATUS  RESPONSE BODY
provider/order.created         POST /orders  201     {created_at: string, id: string, lines: array, status: string, total_minor: number}
provider/order.out-of-stock    POST /orders  409     {error: string}
consumer/create-order.request  POST /orders  -       -
tables/order-total             -             -       2 row(s)
```

- A header line, then the fixtures in the order `provider/`, `consumer/`, `tables/`, by name
  in UTF-16 code unit order.
- `FIXTURE` is `<kind>/<name>`; `REQUEST` is the method, a space and the path; `STATUS` is the
  status of the response. A cell without a value holds `-`.
- `RESPONSE BODY` is the top level of the body of the response: for an object, its keys in
  UTF-16 code unit order, each with the JSON type of its value (`null`, `boolean`, `number`,
  `string`, `array`, `object`), as `{key: type, key: type}`; for an array, `array(<length>)`;
  for a scalar, its type; `-` without a body. With a depth of 2 or more (see below), a value
  that is an object is written the same way in the place of `object`, and an array as its
  first element in brackets. A key that contains anything but `A`–`Z`,
  `a`–`z`, `0`–`9`, `_`, `.` and `-` is printed as a JSON string. For a table the cell holds
  `<n> row(s)`. A file that does not follow the format has `-` in the other cells and
  `(does not follow the format; see check)` here.
- The first three columns are padded with spaces to their longest cell, counted in UTF-16
  code units; columns are separated by two spaces; no line ends in a space.

Two bodies with the same keys at the top can differ inside: `{data: object, ok: boolean}` on
every line says little. The **depth** of the summary (the option `--depth <n>`, a whole number
from 1 to 9; 1 is the default) is the number of levels of objects that are opened:

```
--depth 1   {data: object, ok: boolean}
--depth 2   {data: {items: array, next: null, page: object}, ok: boolean}
--depth 3   {data: {items: [{id: string}], next: null, page: {cursor: object, "of all": number, size: number}}, ok: boolean}
```

An object costs a level. An array costs none: where an array may be opened (there is at
least one level left), it is written as its **first element** in brackets, opened with the
levels that are left. A list of rows therefore shows the keys of a row as soon as the list
itself is reached: `{rows: [{id: number, owner: object, tags: array}]}` with a depth of 2.

| The array | Written as |
|---|---|
| has no elements | `[]` |
| has elements of more than one JSON type | `[mixed]` |
| has elements of one JSON type | `[` the first element `]`: `[string]`, `[null]`, `[{id: number}]`, `[[number]]` |
| is the body itself | `array(<length>)`, as with a depth of 1; from a depth of 2 on, followed by ` of ` and the first element opened with one level less (`array(2) of {id: number, tags: array}`), ` of mixed` for more than one type, and nothing for an empty array |

Only the first element is looked at beyond its type: objects further down the array may have
other keys, and the summary does not say so. With a depth of 1 nothing changes: an array is
`array`, and `array(<length>)` at the top.

Exit codes of the summary command: `0`, `1` when the directory holds no fixtures or the
command cannot finish, `2` wrong usage. The cases in `fixtures/summary.json` pin the text.

## Command line

Every package has an executable with the commands `reset`, `check` and `summary`. Its name
follows the conventions of the language (`contract-fixtures` in the TypeScript package,
`contract_fixtures` in the Dart package), and it is the first word of what the commands
print. Everything else is the same text in every package.

- `reset --side <provider|consumer>` and `check --side <provider|consumer>` act on one side;
  `summary` takes no `--side`. `--depth <n>` is for `summary` only.
- `--dir <contracts>` is the contracts directory. Without it, the environment variable
  `CONTRACT_FIXTURES_DIR` is used, and an empty value there counts as not set. An option is
  written `--dir <value>` or `--dir=<value>`; when it is given twice, the last one counts.
- `-h`, `--help` prints the help and `-v`, `--version` the version of the package, both to
  standard output with the exit code `0`.
- A reset, and a check without problems, print one line to standard output:
  `<tool> reset (<side> side): OK (no entries in .ledger/<side>.jsonl)` and
  `<tool> check (<side> side): OK (<n> fixture(s), all verified or read by this side's tests)`.
- A check with problems prints its report to standard error. The first line is
  `<tool> check (<side> side): <n> problem(s) in <m> fixture(s)`; then one line per problem
  (or one line for all fixtures that were not touched, when the ledger has no entries; see
  [Check](#check)), the hints, and a last line that names the reset.
- Wrong usage prints `<tool>: <what is wrong>`, an empty line and the help to standard error.
  Wrong usage is: an unknown command, option or argument, an option without its value, a
  missing or wrong `--side` (or a `--side` for `summary`), a `--depth` that is not a whole
  number from 1 to 9 (or a `--depth` for `reset` or `check`), no contracts directory, and a
  `--dir` that is not a directory.
- A command that cannot finish prints to standard error and exits with `1`, without the
  help. For a ledger that cannot be used, the one line is the message given under
  [Ledger](#ledger). For any other failure of the file system (a fixture that cannot be
  read), the first line is `<tool>: <command> could not finish`, and the lines after it are
  what the platform reports, which differs between implementations.

| Exit code | `reset` | `check` | `summary` |
|---|---|---|---|
| 0 | done | no problems | printed |
| 1 | the ledger could not be removed | at least one problem, or the command could not finish | the directory holds no fixtures, or the command could not finish |
| 2 | wrong usage | wrong usage | wrong usage |

The cases in `fixtures/cli.json` pin the help, the messages and the exit codes; in them
`{tool}` stands for the name of the executable.

## Versioning

`format` is `1`. A reader rejects any other value. Changes that old readers cannot handle will
use a new number.
