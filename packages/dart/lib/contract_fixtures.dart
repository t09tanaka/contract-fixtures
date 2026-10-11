/// Shared request/response fixtures that keep an API and its clients in step.
///
/// The provider's tests verify fixtures against real responses, the consumer's tests read
/// them (and the other way round for requests). See the README for how to wire both sides.
library;

export 'src/check.dart'
    show
        CheckProblem,
        CheckResult,
        checkContracts,
        formatCheckResult,
        requiredAction;
export 'src/cli.dart' show runCli, usage;
export 'src/contract.dart' show ContractFixtures, dirEnv, updateEnv;
export 'src/differences.dart'
    show Difference, DifferenceKind, differences, formatDifferences;
export 'src/errors.dart';
export 'src/json.dart' show canonicalJson, compactJson;
export 'src/ledger.dart' show LedgerAction, resetLedger;
export 'src/placeholders.dart'
    show Placeholder, parsePlaceholder, resolvePlaceholders;
export 'src/types.dart';
export 'src/volatile.dart' show VolatilePattern;
export 'src/validate.dart'
    show
        FixtureValidation,
        FormatIssue,
        validateFixture,
        validateFixtureFile,
        validateFixtureValue;
