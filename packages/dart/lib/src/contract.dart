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
          name.startsWith(prefix)
              ? '  $name: expected here, but ${kind.name}/$name.json does not exist'
              : '  $name: expected here, but it does not start with $prefix',
      ].join('\n'),
      withoutExpectation,
      withoutFixture,
    );
  }

  /// Fails unless every fixture of [kind] starts with one of [prefixes], and every prefix
  /// has a fixture.
  ///
  /// Tests that call [assertCovers] with a prefix each cover a part of the fixtures; this
  /// is the one test that shows the parts leave nothing out.
  void assertPrefixesCover(FixtureKind kind, Iterable<String> prefixes) {
    final onDisk = list(kind);
    final wanted = prefixes.toSet().toList()..sort();
    final outside = [
      for (final name in onDisk)
        if (!wanted.any(name.startsWith)) name,
    ];
    final unused = [
      for (final prefix in wanted)
        if (!onDisk.any((name) => name.startsWith(prefix))) prefix,
    ];
    if (outside.isEmpty && unused.isEmpty) return;
    throw ContractCoverageException(
      [
        'the prefixes of this test do not cover the fixtures in ${kind.name}/:',
        for (final name in outside)
          '  ${kind.name}/$name.json: starts with none of the prefixes',
        for (final prefix in unused)
          '  $prefix*: listed here, but no fixture in ${kind.name}/ starts with it',
      ].join('\n'),
      outside,
      unused,
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
    List<Object> volatile = const [],
    Map<String, String> secret = const {},
  }) {
    _requireSide(ContractSide.provider, 'verifyResponse');
    _verify(FixtureKind.provider, name, {
      'format': formatVersion,
      'name': name,
      'description': description,
      'request': request.toJson(),
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
    List<Object> volatile = const [],
    Map<String, String> secret = const {},
  }) {
    _requireSide(ContractSide.consumer, 'verifyRequest');
    _verify(FixtureKind.consumer, name, {
      'format': formatVersion,
      'name': name,
      'description': description,
      'request': request.toJson(),
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

  /// Provider side: reads `consumer/<name>.json` to send the request to the real API.
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

  /// Lower-cases the header names of what this side produced, after its JSON round trip.
  void _lowerCaseHeaders(String file, Object? produced) {
    if (produced is! Map<String, dynamic>) return;
    for (final part in const ['request', 'response']) {
      final exchange = produced[part];
      if (exchange is! Map<String, dynamic>) continue;
      final headers = exchange['headers'];
      if (headers is! Map<String, dynamic>) continue;
      final lower = <String, dynamic>{};
      for (final entry in headers.entries) {
        final key = asciiLowerCase(entry.key);
        if (lower.containsKey(key)) {
          throw ContractUsageException(
            'contract fixture $file: the header $key is given '
            'more than once (names differ only in case)',
          );
        }
        lower[key] = entry.value;
      }
      exchange['headers'] = lower;
    }
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
    _lowerCaseHeaders(file, produced);
    // From here on the real values are gone: nothing below can print or write them.
    replaceSecrets(
      produced,
      produced is Map<String, dynamic> ? produced['secret'] : null,
    );
    _orderVolatile(produced);
    void refuse(List<FormatIssue> issues) {
      if (issues.isEmpty) return;
      throw ContractFixtureException(
        'contract fixture $file: what this side produced is not a valid fixture:\n'
        '${formatIssues(issues)}',
        file,
        issues,
      );
    }

    // A value that does not match the pattern of its own volatile entry is a difference
    // from the stored fixture, if there is one to compare with. It is never written.
    final producedIssues = validateFixtureValue(kind, name, produced);
    final unmatchedPatterns = [
      for (final issue in producedIssues)
        if (issue.code == 'volatile-pattern') issue,
    ];
    refuse([
      for (final issue in producedIssues)
        if (issue.code != 'volatile-pattern') issue,
    ]);
    void write() {
      refuse(unmatchedPatterns);
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
      if (update) _refuseToRemoveSecrets(file, produced, stored.value);
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
            value['volatile'] as List<dynamic>? ?? const <dynamic>[];
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
        refuse(unmatchedPatterns);
      }
    }
    appendLedger(dir, side, LedgerAction.verified, kind, name);
  }

  /// Writes the keys of volatile entries with a pattern as `path`, `pattern`.
  void _orderVolatile(Object? produced) {
    if (produced is! Map<String, dynamic>) return;
    final volatile = produced['volatile'];
    if (volatile is! List) return;
    for (var i = 0; i < volatile.length; i++) {
      final entry = volatile[i];
      if (entry is! Map<String, dynamic>) continue;
      volatile[i] = <String, dynamic>{
        for (final key in const ['path', 'pattern'])
          if (entry.containsKey(key)) key: entry[key],
        ...entry,
      };
    }
  }

  /// [produced] as it is compared with the stored fixture. Paths that only the stored
  /// fixture lists as secret are covered as well, so that the difference names the path
  /// (and the change of `secret`) without printing a value that used to be kept out of the
  /// file.
  Object? _comparable(Object? produced, Map<String, dynamic> stored) {
    final removed = _removedSecretPaths(produced, stored);
    if (removed.isEmpty) return produced;
    final copy = jsonRoundTrip(produced);
    replaceSecrets(
      copy,
      stored['secret'],
      everything: true,
      skip: (path) => !removed.contains(path),
    );
    return copy;
  }

  /// The secret paths of the stored fixture that what this side produced does not list.
  List<String> _removedSecretPaths(Object? produced, Object? stored) {
    final storedSecret =
        stored is Map<String, dynamic> ? stored['secret'] : null;
    if (storedSecret is! Map<String, dynamic>) return const [];
    final own = produced is Map<String, dynamic> ? produced['secret'] : null;
    return [
      for (final path in sortedKeys(storedSecret))
        if (own is! Map<String, dynamic> || !own.containsKey(path)) path,
    ];
  }

  /// Update mode never drops a secret path: the value behind it would be written as it
  /// really is. Whoever wants the path gone removes it from the stored file by hand.
  void _refuseToRemoveSecrets(String file, Object? produced, Object? stored) {
    final issues = [
      for (final path in _removedSecretPaths(produced, stored))
        FormatIssue(
          'secret-removed',
          'secret.$path',
          'is a secret path of the stored fixture, but this test does not pass it',
        ),
    ];
    if (issues.isEmpty) return;
    throw ContractFixtureException(
      'contract fixture $file is not updated, because that would drop a secret path:\n'
      '${formatIssues(issues)}\n'
      'Pass the path as `secret` in this test, or remove it from the stored file by hand.',
      file,
      issues,
    );
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
