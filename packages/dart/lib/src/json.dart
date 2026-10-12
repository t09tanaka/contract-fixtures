import 'dart:convert';

/// `null`, `boolean`, `number`, `string`, `array` or `object`.
String jsonType(Object? value) {
  if (value == null) return 'null';
  if (value is bool) return 'boolean';
  if (value is num) return 'number';
  if (value is String) return 'string';
  if (value is List) return 'array';
  return 'object';
}

/// Object keys in UTF-16 code unit order (the same order in every implementation).
List<String> sortedKeys(Map<String, dynamic> value) =>
    value.keys.toList()..sort();

/// The largest integer every implementation represents exactly (2^53 - 1).
const int maxSafeInteger = 9007199254740991;

/// Whether a number is one that not every implementation can represent exactly.
bool isUnsafeNumber(Object? value) {
  if (value is int) return value > maxSafeInteger || value < -maxSafeInteger;
  if (value is double) {
    return !value.isFinite ||
        (value == value.truncateToDouble() && value.abs() > maxSafeInteger);
  }
  return false;
}

final RegExp _upperCase = RegExp('[A-Z]');

/// Lower-cases A to Z only, so every implementation gives the same result.
String asciiLowerCase(String text) =>
    text.replaceAllMapped(_upperCase, (match) => match[0]!.toLowerCase());

final RegExp _arrayIndex = RegExp(r'^(0|[1-9][0-9]{0,9})$');

/// Keys in the order a JavaScript object holds them: array indexes (canonical integers
/// below 2^32 - 1) ascending, then the rest in the order given.
List<String> _javaScriptOrder(Iterable<String> keys) {
  bool isIndex(String key) =>
      _arrayIndex.hasMatch(key) && int.parse(key) < 4294967295;
  final indexes = keys.where(isIndex).toList()
    ..sort((a, b) => int.parse(a).compareTo(int.parse(b)));
  return [...indexes, ...keys.where((key) => !isIndex(key))];
}

/// A copy in which integer-valued doubles are ints, so `1.0` prints as `1`, with keys either
/// sorted or in the order JavaScript would write them.
Object? _normalize(Object? value, {required bool sort}) {
  if (value is double) {
    if (value.isFinite &&
        value == value.truncateToDouble() &&
        value.abs() <= maxSafeInteger) {
      return value.toInt();
    }
    return value;
  }
  if (value is List) {
    return [for (final item in value) _normalize(item, sort: sort)];
  }
  if (value is Map<String, dynamic>) {
    return {
      for (final key in sort ? sortedKeys(value) : _javaScriptOrder(value.keys))
        key: _normalize(value[key], sort: sort),
    };
  }
  return value;
}

/// One-line JSON with sorted keys. Used to print values in differences.
String compactJson(Object? value) => jsonEncode(_normalize(value, sort: true));

/// The most code units of a value that a difference or an issue prints.
const int maxShownLength = 200;

/// [compactJson], cut after [maxShownLength] code units (one less when that would split a
/// surrogate pair) and followed by `... (<n> more)`, n being the code units left out. A
/// line of a difference stays readable that way; the whole value is in the fixture file.
String shownJson(Object? value) {
  final text = compactJson(value);
  if (text.length <= maxShownLength) return text;
  final last = text.codeUnitAt(maxShownLength - 1);
  final cut =
      last >= 0xd800 && last <= 0xdbff ? maxShownLength - 1 : maxShownLength;
  return '${text.substring(0, cut)}... (${text.length - cut} more)';
}

/// The text a fixture file is written as: two-space indentation, trailing newline,
/// integer-valued numbers without a fraction. Keys keep the order given, except that keys
/// that are array indexes come first in ascending order (what JavaScript does to every
/// object, so both packages write the same file).
String canonicalJson(Object? value) =>
    '${const JsonEncoder.withIndent('  ').convert(_normalize(value, sort: false))}\n';

/// What [value] looks like after it went over the wire as JSON.
Object? jsonRoundTrip(Object? value) => jsonDecode(jsonEncode(value));
