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

/// A number as JavaScript writes it, so that both packages print and write the same text:
/// an integer-valued number without a fraction, also beyond 2^53 (`123456789012345680000`,
/// not `123456789012345680000.0`), `1e+21` from there on, and `null` for one that JSON
/// has no form for. A Dart `int` beyond 2^53 is first taken to the double JavaScript would
/// hold.
String _number(num value) {
  // Not `abs()`: it overflows for the smallest int.
  if (value is int && value <= maxSafeInteger && value >= -maxSafeInteger) {
    return '$value';
  }
  final number = value.toDouble();
  if (!number.isFinite) return 'null';
  if (number == 0) return '0';
  final text = number.toString();
  return text.endsWith('.0') ? text.substring(0, text.length - 2) : text;
}

/// Writes [value] as JSON: on one line with sorted keys (no [indent]), or indented with the
/// keys in the order JavaScript would write them.
void _write(StringBuffer out, Object? value, String? indent, String current) {
  if (value is num) {
    out.write(_number(value));
  } else if (value is List) {
    if (value.isEmpty) {
      out.write('[]');
      return;
    }
    final inner = indent == null ? '' : '$current$indent';
    out.write('[');
    for (var i = 0; i < value.length; i++) {
      if (i > 0) out.write(',');
      if (indent != null) out.write('\n$inner');
      _write(out, value[i], indent, inner);
    }
    if (indent != null) out.write('\n$current');
    out.write(']');
  } else if (value is Map && value.keys.every((key) => key is String)) {
    if (value.isEmpty) {
      out.write('{}');
      return;
    }
    final members = value.cast<String, dynamic>();
    final inner = indent == null ? '' : '$current$indent';
    out.write('{');
    var first = true;
    for (final key in indent == null
        ? sortedKeys(members)
        : _javaScriptOrder(members.keys)) {
      if (!first) out.write(',');
      first = false;
      if (indent != null) out.write('\n$inner');
      out
        ..write(jsonEncode(key))
        ..write(indent == null ? ':' : ': ');
      _write(out, members[key], indent, inner);
    }
    if (indent != null) out.write('\n$current');
    out.write('}');
  } else if (value == null || value is bool || value is String) {
    out.write(jsonEncode(value));
  } else {
    // An object with `toJson`: what it encodes to is written like everything else. What
    // JSON has no form for (a set, a map with keys that are not strings) throws here.
    _write(out, jsonDecode(jsonEncode(value)), indent, current);
  }
}

/// One-line JSON with sorted keys. Used to print values in differences.
String compactJson(Object? value) {
  final out = StringBuffer();
  _write(out, value, null, '');
  return out.toString();
}

/// The most code units of a value that a difference or an issue prints.
const int maxShownLength = 200;

/// [compactJson], cut after [maxShownLength] code units (one less when that would split a
/// surrogate pair) and followed by `... (<n> more)`, n being the code units left out. A
/// line of a difference stays readable that way; the whole value is in the fixture file.
String shownJson(Object? value) => _cutText(compactJson(value));

String _cutText(String text) {
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
String canonicalJson(Object? value) {
  final out = StringBuffer();
  _write(out, value, '  ', '');
  out.write('\n');
  return out.toString();
}

/// What [value] looks like after it went over the wire as JSON.
Object? jsonRoundTrip(Object? value) => jsonDecode(jsonEncode(value));

/// How much of what two long values have in common is kept before the place where they
/// part.
const int _shownContext = 20;

/// The two sides of a difference, as [shownJson] prints them, joined by ` -> `. When both
/// are longer than [maxShownLength] and equal that far, cutting each would print the same
/// text twice; both then start 20 code units before the first one that differs, after
/// `(<n> the same) ... `, n being the code units left out at the start.
String shownPair(Object? stored, Object? observed) {
  final s = compactJson(stored);
  final o = compactJson(observed);
  var same = 0;
  while (same < s.length &&
      same < o.length &&
      s.codeUnitAt(same) == o.codeUnitAt(same)) {
    same++;
  }
  if (s.length <= maxShownLength ||
      o.length <= maxShownLength ||
      same < maxShownLength) {
    return '${_cutText(s)} -> ${_cutText(o)}';
  }
  var skip = same - _shownContext;
  final first = s.codeUnitAt(skip);
  if (first >= 0xdc00 && first <= 0xdfff) skip--;
  final lead = '($skip the same) ... ';
  return '$lead${_cutText(s.substring(skip))} -> '
      '$lead${_cutText(o.substring(skip))}';
}
