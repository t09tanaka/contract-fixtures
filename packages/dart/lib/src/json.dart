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

/// The largest integer every implementation represents exactly (2^53).
const double _maxSafeInteger = 9007199254740992;

/// A copy in which integer-valued doubles are ints, so `1.0` prints as `1`.
Object? _normalize(Object? value, {required bool sort}) {
  if (value is double) {
    if (value.isFinite &&
        value == value.truncateToDouble() &&
        value.abs() <= _maxSafeInteger) {
      return value.toInt();
    }
    return value;
  }
  if (value is List) {
    return [for (final item in value) _normalize(item, sort: sort)];
  }
  if (value is Map<String, dynamic>) {
    return {
      for (final key in sort ? sortedKeys(value) : value.keys)
        key: _normalize(value[key], sort: sort),
    };
  }
  return value;
}

/// One-line JSON with sorted keys. Used to print values in differences.
String compactJson(Object? value) => jsonEncode(_normalize(value, sort: true));

/// The text a fixture file is written as: two-space indentation, trailing newline, keys in
/// the order given, integer-valued numbers without a fraction.
String canonicalJson(Object? value) =>
    '${const JsonEncoder.withIndent('  ').convert(_normalize(value, sort: false))}\n';

/// What [value] looks like after it went over the wire as JSON.
Object? jsonRoundTrip(Object? value) => jsonDecode(jsonEncode(value));
