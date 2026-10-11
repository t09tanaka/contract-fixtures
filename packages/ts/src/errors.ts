import type { Difference } from "./differences.js";
import type { FormatIssue } from "./validate.js";

/** What this side produced no longer equals the stored fixture. */
export class ContractMismatchError extends Error {
  override name = "ContractMismatchError";
  constructor(
    message: string,
    /** `<kind>/<name>.json` */
    readonly file: string,
    readonly differences: readonly Difference[],
  ) {
    super(message);
  }
}

/** A fixture is missing or does not follow the format. */
export class ContractFixtureError extends Error {
  override name = "ContractFixtureError";
  constructor(
    message: string,
    /** `<kind>/<name>.json` */
    readonly file: string,
    readonly issues: readonly FormatIssue[] = [],
  ) {
    super(message);
  }
}

/** The fixtures on disk and the expectations of a test do not cover each other. */
export class ContractCoverageError extends Error {
  override name = "ContractCoverageError";
  constructor(
    message: string,
    /** Fixtures on disk that the test has no expectation for. */
    readonly withoutExpectation: readonly string[],
    /** Expectations in the test that have no fixture on disk. */
    readonly withoutFixture: readonly string[],
  ) {
    super(message);
  }
}

/** The helpers were called in a way that cannot work (wrong side, no directory, ...). */
export class ContractUsageError extends Error {
  override name = "ContractUsageError";
}
