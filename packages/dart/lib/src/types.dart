/// The format version this package reads and writes.
const int formatVersion = 1;

/// Which side of the API a test (or a check) acts for.
enum ContractSide { provider, consumer }

/// The three directories of a contracts directory.
enum FixtureKind { provider, consumer, tables }

/// The request part of a fixture.
class ExchangeRequest {
  const ExchangeRequest({
    required this.method,
    required this.path,
    this.headers,
    this.body,
  });

  factory ExchangeRequest.fromJson(Map<String, dynamic> json) =>
      ExchangeRequest(
        method: json['method'] as String,
        path: json['path'] as String,
        headers:
            (json['headers'] as Map<String, dynamic>?)?.cast<String, String>(),
        body: json['body'],
      );

  /// Upper-case HTTP method.
  final String method;

  /// Starts with `/`; includes the query string, if any.
  final String path;

  /// Header names are lower-cased before comparing and writing.
  final Map<String, String>? headers;

  /// Anything `jsonEncode` accepts. `null` means "no body".
  final Object? body;

  Map<String, dynamic> toJson() => {
        'method': method,
        'path': path,
        if (headers != null) 'headers': headers,
        if (body != null) 'body': body,
      };
}

/// The response part of a provider fixture.
class ExchangeResponse {
  const ExchangeResponse({required this.status, this.body});

  factory ExchangeResponse.fromJson(Map<String, dynamic> json) =>
      ExchangeResponse(
          status: (json['status'] as num).toInt(), body: json['body']);

  final int status;

  /// The decoded body. `null` means "no body".
  final Object? body;

  Map<String, dynamic> toJson() => {
        'status': status,
        if (body != null) 'body': body,
      };
}

/// A request and the provider's real response to it (`provider/<name>.json`).
class ProviderFixture {
  ProviderFixture(this.json)
      : request =
            ExchangeRequest.fromJson(json['request'] as Map<String, dynamic>),
        response =
            ExchangeResponse.fromJson(json['response'] as Map<String, dynamic>);

  /// The decoded file.
  final Map<String, dynamic> json;
  final ExchangeRequest request;
  final ExchangeResponse response;

  String get name => json['name'] as String;
  String get description => json['description'] as String;
  List<String> get volatile =>
      (json['volatile'] as List<dynamic>? ?? const <dynamic>[]).cast<String>();

  /// Path -> placeholder: what is stored in place of the real value at that path.
  Map<String, String> get secret =>
      (json['secret'] as Map<String, dynamic>? ?? const <String, dynamic>{})
          .cast<String, String>();
}

/// A request the consumer really builds (`consumer/<name>.json`).
class ConsumerFixture {
  ConsumerFixture(this.json)
      : request =
            ExchangeRequest.fromJson(json['request'] as Map<String, dynamic>);

  /// The decoded file.
  final Map<String, dynamic> json;
  final ExchangeRequest request;

  String get name => json['name'] as String;
  String get description => json['description'] as String;
  List<String> get volatile =>
      (json['volatile'] as List<dynamic>? ?? const <dynamic>[]).cast<String>();

  /// Path -> placeholder: what is stored in place of the real value at that path.
  Map<String, String> get secret =>
      (json['secret'] as Map<String, dynamic>? ?? const <String, dynamic>{})
          .cast<String, String>();
}

/// Rows of input and expected output for a shared calculation (`tables/<name>.json`).
class TableFixture {
  TableFixture(this.json);

  /// The decoded file.
  final Map<String, dynamic> json;

  String get name => json['name'] as String;
  String get description => json['description'] as String;
  List<Map<String, dynamic>> get rows =>
      (json['rows'] as List<dynamic>).cast<Map<String, dynamic>>();
}
