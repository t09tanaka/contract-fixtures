import 'differences.dart';
import 'validate.dart';

/// What this side produced no longer equals the stored fixture.
class ContractMismatch implements Exception {
  const ContractMismatch(this.message, this.file, this.differences);

  final String message;

  /// `<kind>/<name>.json`
  final String file;
  final List<Difference> differences;

  @override
  String toString() => message;
}

/// A fixture is missing or does not follow the format.
class ContractFixtureException implements Exception {
  const ContractFixtureException(this.message, this.file,
      [this.issues = const []]);

  final String message;

  /// `<kind>/<name>.json`
  final String file;
  final List<FormatIssue> issues;

  @override
  String toString() => message;
}

/// The fixtures on disk and the expectations of a test do not cover each other.
class ContractCoverageException implements Exception {
  const ContractCoverageException(
    this.message,
    this.withoutExpectation,
    this.withoutFixture,
  );

  final String message;

  /// Fixtures on disk that the test has no expectation for.
  final List<String> withoutExpectation;

  /// Expectations in the test that have no fixture on disk.
  final List<String> withoutFixture;

  @override
  String toString() => message;
}

/// The helpers were called in a way that cannot work (wrong side, no directory, ...).
class ContractUsageException implements Exception {
  const ContractUsageException(this.message);

  final String message;

  @override
  String toString() => message;
}
