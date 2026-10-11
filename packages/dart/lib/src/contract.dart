import 'dart:convert';
import 'dart:io';

import 'check.dart';
import 'differences.dart';
import 'errors.dart';
import 'json.dart';
import 'ledger.dart';
import 'secrets.dart';
import 'types.dart';
import 'validate.dart';

/// Environment variable that names the contracts directory when no `dir` is given.
const String dirEnv = 'CONTRACT_FIXTURES_DIR';

/// Environment variable that turns update mode on when it is `1`.
const String updateEnv = 'CONTRACT_FIXTURES_UPDATE';

/// A contracts directory, opened on behalf of one side.
///
/// The helpers do not depend on a test framework: they throw ordinary exceptions, which
/// every framework reports as a failure.
class ContractFixtures {
  /// [dir] defaults to the environment variable `CONTRACT_FIXTURES_DIR`; a relative path is
  /// resolved against the working directory (the package root under `dart test` and
  /// `flutter test`). [update] defaults to `CONTRACT_FIXTURES_UPDATE=1`.
  factory ContractFixtures({
    required ContractSide side,
    String? dir,
    bool? update,
    Map<String, String>? environment,
  }) {
    final env = environment ?? Platform.environment;
    final given = dir ?? env[dirEnv];
    if (given == null || given.isEmpty) {
      throw const ContractUsageException(
        'contract_fixtures: pass the contracts directory as `dir` or set $dirEnv',
      );
    }
    var updating = update;
    if (updating == null) {
      updating = env[updateEnv] == '1';
      // Refused in CI, where it would hide every change.
      if (updating && (env['CI'] == 'true' || env['CI'] == '1')) {
        throw const ContractUsageException(
          'contract_fixtures: $updateEnv=1 is set in CI. '
          "Update fixtures on a developer's machine and commit them.",
        );
      }
    }
    return ContractFixtures._(side, Directory(given).absolute.path, updating);
  }

  ContractFixtures._(this.side, this.dir, this.update);

  /// The side whose tests are running.
  final ContractSide side;

  /// Absolute path of the contracts directory.
  final String dir;

  /// Whether verifying writes fixtures instead of failing.
  final bool update;

  /// Names of the fixtures of one kind, sorted; optionally only those that start with
  /// [prefix].
  List<String> list(FixtureKind kind, {String prefix = ''}) => [
        for (final name in listFixtureNames(dir, kind))
          if (name.startsWith(prefix)) name,
      ];

  /// Fails unless [expected] names exactly the fixtures of [kind] (that start with
  /// [prefix]).
  ///
  /// Give it the keys of the table of expectations a reading test iterates over: a new
  /// fixture then fails this test until somebody writes down what should happen for it.
  void assertCovers(
    FixtureKind kind,
    Iterable<String> expected, {
    String prefix = '',
  }) {
    final onDisk = list(kind, prefix: prefix);
    final wanted = expected.toSet().toList()..sort();
    final withoutExpectation = [
      for (final name in onDisk)
        if (!wanted.contains(name)) name,
    ];
    final withoutFixture = [
      for (final name in wanted)
        if (!onDisk.contains(name)) name,
    ];
    if (withoutExpectation.isEmpty && withoutFixture.isEmpty) return;
    final scope = prefix.isEmpty ? '${kind.name}/' : '${kind.name}/$prefix*';
    throw ContractCoverageException(
      [
        'the expectations of this test do not cover the fixtures in $scope:',
        for (final name in withoutExpectation)
          '  ${kind.name}/$name.json: no expectation in this test',
        for (final name in withoutFixture)
          '  $name: expected here, but ${kind.name}/$name.json does not exist',
      ].join('\n'),
      withoutExpectation,
      withoutFixture,
    );
  }

  /// Provider side: compares a real response with `provider/<name>.json`.
  ///
  /// Throws [ContractMismatch] on a difference; writes the fixture in update mode.
  ///
  /// [secret] maps paths to placeholders: the real value at such a path is replaced by its
  /// placeholder before anything is compared, printed or written.
  void verifyResponse({
    required String name,
    required String description,
    required ExchangeRequest request,
    required ExchangeResponse response,
    List<String> volatile = const [],
    Map<String, String> secret = const {},
  }) {
    _requireSide(ContractSide.provider, 'verifyResponse');
    _verify(FixtureKind.provider, name, {
      'format': formatVersion,
      'name': name,
      'description': description,
      'request': _request(FixtureKind.provider, name, request),
      'response': response.toJson(),
      if (volatile.isNotEmpty) 'volatile': volatile,
      if (secret.isNotEmpty) 'secret': secret,
    });
  }

  /// Consumer side: compares a request this side really built with
  /// `consumer/<name>.json`.
  ///
  /// Throws [ContractMismatch] on a difference; writes the fixture in update mode.
  /// [secret] works as in [verifyResponse].
  void verifyRequest({
    required String name,
    required String description,
    required ExchangeRequest request,
    List<String> volatile = const [],
    Map<String, String> secret = const {},
  }) {
    _requireSide(ContractSide.consumer, 'verifyRequest');
    _verify(FixtureKind.consumer, name, {
      'format': formatVersion,
      'name': name,
      'description': description,
      'request': _request(FixtureKind.consumer, name, request),
      if (volatile.isNotEmpty) 'volatile': volatile,
      if (secret.isNotEmpty) 'secret': secret,
    });
  }

  /// Consumer side: reads `provider/<name>.json` to feed the response to the real client
  /// code.
  ProviderFixture readResponse(String name) {
    _requireSide(ContractSide.consumer, 'readResponse');
    return ProviderFixture(_read(FixtureKind.provider, name));
  }

  /// Provider side: reads `consumer/<name>.json` to pass the request to the real handler.
  ConsumerFixture readRequest(String name) {
    _requireSide(ContractSide.provider, 'readRequest');
    return ConsumerFixture(_read(FixtureKind.consumer, name));
  }

  /// Either side: reads `tables/<name>.json`.
  TableFixture readTable(String name) =>
      TableFixture(_read(FixtureKind.tables, name));

  void _requireSide(ContractSide wanted, String method) {
    if (side != wanted) {
      throw ContractUsageException(
        'contract_fixtures: $method is for the ${wanted.name} side, '
        'but this is the ${side.name} side',
      );
    }
  }

  void _requireName(String name) {
    if (name.isEmpty) {
      throw const ContractUsageException(
        'contract_fixtures: a fixture needs a name',
      );
    }
  }

  Map<String, dynamic> _request(
    FixtureKind kind,
    String name,
    ExchangeRequest request,
  ) {
    final json = request.toJson();
    final headers = request.headers;
    if (headers != null) {
      final lower = <String, String>{};
      for (final entry in headers.entries) {
        final key = asciiLowerCase(entry.key);
        if (lower.containsKey(key)) {
          throw ContractUsageException(
            'contract fixture ${kind.name}/$name.json: the header $key is given '
            'more than once (names differ only in case)',
          );
        }
        lower[key] = entry.value;
      }
      json['headers'] = lower;
    }
    return json;
  }

  void _verify(FixtureKind kind, String name, Map<String, dynamic> observed) {
    _requireName(name);
    final file = '${kind.name}/$name.json';
    final target = File('$dir/$file');
    final Object? produced;
    try {
      produced = jsonRoundTrip(observed);
    } on JsonUnsupportedObjectError {
      throw ContractFixtureException(
        'contract fixture $file: what this side produced is not a valid fixture:\n'
        '  (root): cannot be encoded as JSON (a number that is NaN or infinite, '
        'or an object without toJson)',
        file,
      );
    }
    // From here on the real values are gone: nothing below can print or write them.
    replaceSecrets(
      produced,
      produced is Map<String, dynamic> ? produced['secret'] : null,
    );
    final producedIssues = validateFixtureValue(kind, name, produced);
    if (producedIssues.isNotEmpty) {
      throw ContractFixtureException(
        'contract fixture $file: what this side produced is not a valid fixture:\n'
        '${formatIssues(producedIssues)}',
        file,
        producedIssues,
      );
    }
    void write() {
      target.parent.createSync(recursive: true);
      target.writeAsStringSync(canonicalJson(produced));
    }

    if (!target.existsSync()) {
      if (!update) {
        throw ContractFixtureException(
          'contract fixture $file does not exist. '
          'Run this test once with $updateEnv=1 to record it.',
          file,
        );
      }
      write();
    } else {
      final stored = validateFixtureFile(kind, name, target);
      if (stored.issues.isNotEmpty) {
        if (!update) {
          throw ContractFixtureException(
            'contract fixture $file does not follow the format:\n'
            '${formatIssues(stored.issues)}',
            file,
            stored.issues,
          );
        }
        write();
      } else {
        final value = stored.value as Map<String, dynamic>;
        final volatile =
            (value['volatile'] as List<dynamic>? ?? const <dynamic>[])
                .cast<String>();
        final diffs =
            differences(value, _comparable(produced, value), volatile);
        if (diffs.isNotEmpty) {
          if (!update) {
            throw ContractMismatch(
              'contract fixture $file no longer matches what the ${side.name} side '
              'produces (stored -> observed):\n${formatDifferences(diffs)}\n'
              'If the change is intended, rerun with $updateEnv=1, '
              "then fix the other side's tests in the same change.",
              file,
              diffs,
            );
          }
          write();
        }
      }
    }
    appendLedger(dir, side, LedgerAction.verified, kind, name);
  }

  /// [produced] as it is compared with the stored fixture. Paths that only the stored
  /// fixture lists as secret are covered as well, so that the difference names the path
  /// (and the change of `secret`) without printing a value that used to be kept out of the
  /// file.
  Object? _comparable(Object? produced, Map<String, dynamic> stored) {
    final storedSecret = stored['secret'];
    final own = produced is Map<String, dynamic> ? produced['secret'] : null;
    bool listed(String path) =>
        own is Map<String, dynamic> && own.containsKey(path);
    if (storedSecret is! Map<String, dynamic> ||
        storedSecret.keys.every(listed)) {
      return produced;
    }
    final copy = jsonRoundTrip(produced);
    replaceSecrets(copy, storedSecret, everything: true, skip: listed);
    return copy;
  }

  Map<String, dynamic> _read(FixtureKind kind, String name) {
    _requireName(name);
    if (!namePattern.hasMatch(name)) {
      throw ContractUsageException(
        'contract_fixtures: ${jsonEncode(name)} is not a fixture name',
      );
    }
    final file = '${kind.name}/$name.json';
    final source = File('$dir/$file');
    if (!source.existsSync()) {
      throw ContractFixtureException(
          'contract fixture $file does not exist.', file);
    }
    final result = validateFixtureFile(kind, name, source);
    if (result.issues.isNotEmpty) {
      throw ContractFixtureException(
        'contract fixture $file does not follow the format:\n'
        '${formatIssues(result.issues)}',
        file,
        result.issues,
      );
    }
    appendLedger(dir, side, LedgerAction.read, kind, name);
    return result.value as Map<String, dynamic>;
  }
}
