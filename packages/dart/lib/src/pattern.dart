/// The patterns of volatile paths: a small subset of ECMAScript regular expressions, defined
/// in spec/format.md. The package does not hand them to `RegExp`. It matches them itself, in
/// time proportional to the length of the value, so that every implementation gives the
/// same answer and no pattern can make a test hang.
library;

/// A pattern is longer than this many UTF-16 code units: refused.
const int maxPatternLength = 1000;

/// A pattern is larger than this once its counted repetitions are written out: refused.
const int maxPatternSize = 10000;

/// Why a string is not a pattern. The message does not repeat the pattern.
class PatternException implements Exception {
  const PatternException(this.message);

  final String message;

  @override
  String toString() => message;
}

class _Range {
  const _Range(this.low, this.high);

  final int low;
  final int high;
}

class _Item {
  const _Item(this.ranges, {this.negated = false});

  final List<_Range> ranges;
  final bool negated;
}

/// A set of code units: the union of [items], each a (possibly negated) list of ranges.
class _CharSet {
  _CharSet(this.items);

  _CharSet.one(int unit)
      : items = [
          _Item([_Range(unit, unit)]),
        ];

  final List<_Item> items;
  bool negated = false;

  bool contains(int unit) {
    var found = false;
    for (final item in items) {
      var inside = false;
      for (final range in item.ranges) {
        if (unit >= range.low && unit <= range.high) {
          inside = true;
          break;
        }
      }
      if (inside != item.negated) {
        found = true;
        break;
      }
    }
    return found != negated;
  }
}

sealed class _Node {
  const _Node();
}

class _SetNode extends _Node {
  const _SetNode(this.set);
  final _CharSet set;
}

class _StartNode extends _Node {
  const _StartNode();
}

class _EndNode extends _Node {
  const _EndNode();
}

class _SequenceNode extends _Node {
  const _SequenceNode(this.nodes);
  final List<_Node> nodes;
}

class _ChoiceNode extends _Node {
  const _ChoiceNode(this.nodes);
  final List<_Node> nodes;
}

/// [max] is -1 when there is no upper bound.
class _RepeatNode extends _Node {
  const _RepeatNode(this.node, this.min, this.max);
  final _Node node;
  final int min;
  final int max;
}

int _code(String char) => char.codeUnitAt(0);

final List<_Range> _digit = [_Range(_code('0'), _code('9'))];
final List<_Range> _word = [
  _Range(_code('0'), _code('9')),
  _Range(_code('A'), _code('Z')),
  _Range(_code('_'), _code('_')),
  _Range(_code('a'), _code('z')),
];
const List<_Range> _lineEnd = [
  _Range(0x0a, 0x0a),
  _Range(0x0d, 0x0d),
  _Range(0x2028, 0x2029),
];
const List<_Range> _space = [
  _Range(0x09, 0x0d),
  _Range(0x20, 0x20),
  _Range(0xa0, 0xa0),
  _Range(0x1680, 0x1680),
  _Range(0x2000, 0x200a),
  _Range(0x2028, 0x2029),
  _Range(0x202f, 0x202f),
  _Range(0x205f, 0x205f),
  _Range(0x3000, 0x3000),
  _Range(0xfeff, 0xfeff),
];
final Map<String, List<_Range>> _classEscapes = {
  'd': _digit,
  'w': _word,
  's': _space,
};
const Map<String, int> _controlEscapes = {'n': 0x0a, 'r': 0x0d, 't': 0x09};

/// The characters that mean something in a pattern; each can be escaped with a backslash.
const String _syntax = r'^$\.*+?()[]{}|/-';

class _Repetition {
  const _Repetition(this.min, this.max);
  final int min;
  final int max;
}

class _Parser {
  _Parser(this.source);

  final String source;
  int at = 0;

  Never fail(String message) =>
      throw PatternException('$message (at position $at)');

  /// The character at [index] (by default the next one), or `''` at the end.
  String peek([int? index]) {
    final i = index ?? at;
    return i < source.length ? source[i] : '';
  }

  /// What follows a backslash: an [_Item] for \d \w \s (and their negations), or one code
  /// unit.
  Object escape() {
    final char = peek();
    at++;
    final lower = char.toLowerCase();
    final ranges = _classEscapes[lower];
    if (char.isNotEmpty && ranges != null) {
      return _Item(ranges, negated: char != lower);
    }
    final control = _controlEscapes[char];
    if (control != null) return control;
    if (char.isNotEmpty && _syntax.contains(char)) return _code(char);
    at--;
    fail('this escape is not supported');
  }

  _CharSet characterClass() {
    final set = _CharSet([]);
    if (peek() == '^') {
      set.negated = true;
      at++;
    }
    final ranges = <_Range>[];
    for (;;) {
      final char = peek();
      if (char.isEmpty) fail('a character class is not closed');
      if (char == ']') break;
      at++;
      int low;
      if (char == r'\') {
        final escaped = escape();
        if (escaped is _Item) {
          set.items.add(escaped);
          if (peek() == '-' && peek(at + 1) != ']') {
            fail('a range in a character class needs a single character on '
                'both sides');
          }
          continue;
        }
        low = escaped as int;
      } else {
        low = _code(char);
      }
      if (peek() != '-' || peek(at + 1) == ']' || peek(at + 1).isEmpty) {
        ranges.add(_Range(low, low));
        continue;
      }
      at++;
      int high;
      if (peek() == r'\') {
        at++;
        final escaped = escape();
        if (escaped is! int) {
          fail('a range in a character class needs a single character on '
              'both sides');
        }
        high = escaped;
      } else {
        high = _code(peek());
        at++;
      }
      if (high < low) fail('a range in a character class is out of order');
      ranges.add(_Range(low, high));
    }
    at++;
    if (ranges.isNotEmpty) set.items.add(_Item(ranges));
    if (set.items.isEmpty) fail('a character class is empty');
    return set;
  }

  bool get atDigit {
    final char = peek();
    return char.isNotEmpty && _code(char) >= 0x30 && _code(char) <= 0x39;
  }

  int count() {
    final from = at;
    while (atDigit) {
      at++;
    }
    if (at == from) fail('a repetition needs a number');
    if (at - from > 5) fail('a repetition count is too large');
    return int.parse(source.substring(from, at));
  }

  /// The repetition after an atom, if there is one.
  _Repetition? repetition() {
    final char = peek();
    if (char == '*') {
      at++;
      return const _Repetition(0, -1);
    }
    if (char == '+') {
      at++;
      return const _Repetition(1, -1);
    }
    if (char == '?') {
      at++;
      return const _Repetition(0, 1);
    }
    if (char != '{') return null;
    at++;
    final min = count();
    var max = min;
    if (peek() == ',') {
      at++;
      max = peek() == '}' ? -1 : count();
    }
    if (peek() != '}') fail('a repetition is not closed');
    at++;
    if (max != -1 && max < min) fail('a repetition is out of order');
    return _Repetition(min, max);
  }

  _Node sequence() {
    final nodes = <_Node>[];
    for (;;) {
      final char = peek();
      if (char.isEmpty || char == '|' || char == ')') break;
      _Node atom;
      at++;
      if (char == '^') {
        atom = const _StartNode();
      } else if (char == r'$') {
        atom = const _EndNode();
      } else if (char == '.') {
        atom = _SetNode(_CharSet([const _Item(_lineEnd, negated: true)]));
      } else if (char == '[') {
        atom = _SetNode(characterClass());
      } else if (char == '(') {
        if (peek() == '?') {
          if (peek(at + 1) != ':') {
            fail('only groups of the form (...) and (?:...) are supported');
          }
          at += 2;
        }
        atom = choice();
        if (peek() != ')') fail('a group is not closed');
        at++;
      } else if (char == r'\') {
        final escaped = escape();
        atom = _SetNode(
          escaped is int ? _CharSet.one(escaped) : _CharSet([escaped as _Item]),
        );
      } else if ('*+?{'.contains(char)) {
        at--;
        fail('there is nothing to repeat here (lazy and stacked repetitions '
            'are not supported)');
      } else if (char == ']' || char == '}') {
        at--;
        fail('$char must be escaped');
      } else {
        atom = _SetNode(_CharSet.one(_code(char)));
      }
      final repeat = repetition();
      if (repeat == null) {
        nodes.add(atom);
      } else if (atom is _StartNode || atom is _EndNode) {
        at--;
        fail(r'^ and $ cannot be repeated');
      } else {
        nodes.add(_RepeatNode(atom, repeat.min, repeat.max));
      }
    }
    return nodes.length == 1 ? nodes.single : _SequenceNode(nodes);
  }

  _Node choice() {
    final nodes = [sequence()];
    while (peek() == '|') {
      at++;
      nodes.add(sequence());
    }
    return nodes.length == 1 ? nodes.single : _ChoiceNode(nodes);
  }

  _Node parse() {
    final root = choice();
    if (at < source.length) fail('a group is closed that was not opened');
    return root;
  }
}

int _capped(int value) => value > maxPatternSize ? maxPatternSize + 1 : value;

/// The number of states the pattern needs, or [maxPatternSize] + 1 as soon as it is more.
int _size(_Node node) {
  switch (node) {
    case _SetNode() || _StartNode() || _EndNode():
      return 1;
    case _SequenceNode(:final nodes):
      var sum = 0;
      for (final child in nodes) {
        sum = _capped(sum + _size(child));
      }
      return sum;
    case _ChoiceNode(:final nodes):
      var sum = nodes.length - 1;
      for (final child in nodes) {
        sum = _capped(sum + _size(child));
      }
      return sum;
    case _RepeatNode(node: final inner, :final min, :final max):
      // At least 1, so that repeating something empty is not free: the limit also bounds
      // the work of building the states.
      final size = _size(inner) < 1 ? 1 : _size(inner);
      return max == -1
          ? _capped(size * (min + 1) + 1)
          : _capped(size * max + (max - min));
  }
}

enum _Kind { set, split, start, end, match }

/// A pattern, ready to be tried on values.
class CompiledPattern {
  CompiledPattern._(
    this._entry,
    this._kinds,
    this._next,
    this._other,
    this._sets,
    this.required,
    this.requiredAny,
    this.shortest,
  );

  /// Texts of which every match contains at least one, for a pattern without one
  /// [required] text (a choice between whole alternatives); empty when none are known.
  final List<String> requiredAny;

  /// The fewest code units a match can have. A shorter value is not tried either.
  final int shortest;

  /// Whether [value] can hold a match at all: long enough, and with a text every match
  /// contains.
  bool _possible(String value) {
    if (value.length < shortest) return false;
    if (required.isNotEmpty) return value.contains(required);
    return requiredAny.isEmpty || requiredAny.any(value.contains);
  }

  /// A text that every match of the pattern contains, or `''` when none is known. A value
  /// without it cannot hold a match, which [search] finds out before it tries the pattern.
  final String required;

  final int _entry;
  final List<_Kind> _kinds;
  final List<int> _next;
  final List<int> _other;
  final List<_CharSet?> _sets;

  /// Whether the whole of [value] matches.
  bool test(String value) => _run(value, anywhere: false);

  /// Whether a part of [value] matches (`^` and `$` are still the ends of the value).
  bool search(String value) => _possible(value) && _run(value, anywhere: true);

  /// [search] without its shortcut: every position of the value is tried. The result is
  /// the same by definition; the tests hold the two against each other.
  bool scan(String value) => _run(value, anywhere: true);

  bool _run(String value, {required bool anywhere}) {
    final seen = List<int>.filled(_kinds.length, -1);

    /// Follows the states that consume nothing, as they hold at [position].
    void enter(List<int> list, int first, int position) {
      final stack = [first];
      while (stack.isNotEmpty) {
        final state = stack.removeLast();
        if (seen[state] == position) continue;
        seen[state] = position;
        switch (_kinds[state]) {
          case _Kind.split:
            stack
              ..add(_other[state])
              ..add(_next[state]);
          case _Kind.start:
            if (position == 0) stack.add(_next[state]);
          case _Kind.end:
            if (position == value.length) stack.add(_next[state]);
          case _Kind.set || _Kind.match:
            list.add(state);
        }
      }
    }

    bool matched(List<int> list) =>
        list.any((state) => _kinds[state] == _Kind.match);

    var current = <int>[];
    enter(current, _entry, 0);
    if (anywhere && matched(current)) return true;
    for (var position = 0;
        position < value.length && (anywhere || current.isNotEmpty);
        position++) {
      final unit = value.codeUnitAt(position);
      final following = <int>[];
      for (final state in current) {
        if (_kinds[state] == _Kind.set && _sets[state]!.contains(unit)) {
          enter(following, _next[state], position + 1);
        }
      }
      if (anywhere) {
        // A match may start at every position, and it may end before the value does.
        enter(following, _entry, position + 1);
        if (matched(following)) return true;
      }
      current = following;
    }
    return matched(current);
  }
}

/// What is known about the texts a part of a pattern matches: the one text it matches
/// ([exact], `null` when it can match more than one, or none), and the longest text found
/// that every match of the part contains ([required]).
class _Literal {
  const _Literal(this.exact, this.required, this.anyOf, this.min);
  final String? exact;
  final String required;

  /// Texts of which every match of the part contains at least one; empty when none are
  /// known.
  final List<String> anyOf;

  /// The fewest code units a match of the part can have.
  final int min;
}

/// More alternatives than this are not kept: the part then says nothing.
const int _maxAlternatives = 32;

/// A length beyond this is not counted further; no value is that long.
const int _maxMinLength = 1000000000;

int _cappedLength(int length) =>
    length > _maxMinLength ? _maxMinLength : length;

/// An exact text is not carried on beyond this length; what was found so far still counts.
const int _maxLiteralLength = 256;

String _longer(String a, String b) => b.length > a.length ? b : a;

/// A text that every match of [node] contains. Only what is certain counts: a character
/// that stands for itself, a sequence of such, and what a group or a repetition of at least
/// one holds. A choice, a class, an optional part and an anchor say nothing, and end a run.
_Literal _literal(_Node node) {
  switch (node) {
    case _SetNode(:final set):
      String? exact;
      if (!set.negated && set.items.length == 1) {
        final item = set.items.single;
        if (!item.negated &&
            item.ranges.length == 1 &&
            item.ranges.single.low == item.ranges.single.high) {
          exact = String.fromCharCode(item.ranges.single.low);
        }
      }
      return _Literal(
          exact, exact ?? '', exact == null ? const [] : [exact], 1);
    case _StartNode() || _EndNode():
      return const _Literal(null, '', [], 0);
    case _ChoiceNode(:final nodes):
      // A match is a match of one branch: it contains a text of that branch, if every
      // branch has one, and is as long as the shortest branch allows.
      final parts = nodes.map(_literal).toList();
      final all = parts.every((part) => part.anyOf.isNotEmpty)
          ? <String>{for (final part in parts) ...part.anyOf}.toList()
          : const <String>[];
      return _Literal(
        null,
        '',
        all.length <= _maxAlternatives ? all : const [],
        parts.map((part) => part.min).reduce((a, b) => a < b ? a : b),
      );
    case _SequenceNode(:final nodes):
      var run = '';
      var required = '';
      var exact = true;
      var anyOf = const <String>[];
      var min = 0;
      for (final child in nodes) {
        final part = _literal(child);
        min = _cappedLength(min + part.min);
        // Of the parts that offer alternatives, the one with the fewest (the first, if
        // equal).
        if (part.anyOf.isNotEmpty &&
            (anyOf.isEmpty || part.anyOf.length < anyOf.length)) {
          anyOf = part.anyOf;
        }
        final text = part.exact;
        if (text != null && run.length + text.length <= _maxLiteralLength) {
          run += text;
          continue;
        }
        exact = false;
        required = _longer(_longer(required, run), part.required);
        run = text ?? '';
      }
      required = _longer(required, run);
      return _Literal(
        exact ? run : null,
        required,
        required.isEmpty ? anyOf : [required],
        min,
      );
    case _RepeatNode(node: final inner, :final min, :final max):
      if (min < 1) return const _Literal(null, '', [], 0);
      final part = _literal(inner);
      return _Literal(
        min == 1 && max == 1 ? part.exact : null,
        part.required,
        part.anyOf,
        _cappedLength(part.min * min),
      );
  }
}

/// Patterns that were compiled before, by their text. What a pattern means depends on
/// nothing else.
final Map<String, CompiledPattern> _compiled = {};

/// More texts than this are not kept: the map is emptied and starts again.
const int _maxCompiled = 1000;

/// Checks [source] against the pattern syntax of spec/format.md and prepares it for
/// matching. Throws [PatternException] when it is not a pattern.
CompiledPattern compilePattern(String source) {
  final known = _compiled[source];
  if (known != null) return known;
  final pattern = _prepare(source);
  if (_compiled.length >= _maxCompiled) _compiled.clear();
  _compiled[source] = pattern;
  return pattern;
}

CompiledPattern _prepare(String source) {
  if (source.length > maxPatternLength) {
    throw const PatternException('is longer than $maxPatternLength characters');
  }
  for (var i = 0; i < source.length; i++) {
    final unit = source.codeUnitAt(i);
    if (unit >= 0xd800 && unit <= 0xdfff) {
      throw PatternException(
        'characters beyond U+FFFF are not supported (at position $i)',
      );
    }
  }
  final root = _Parser(source).parse();
  if (_size(root) > maxPatternSize) {
    throw const PatternException(
      'is too large once its repetitions are written out (more than '
      '$maxPatternSize)',
    );
  }

  final kinds = <_Kind>[_Kind.match];
  final next = <int>[0];
  final other = <int>[0];
  final sets = <_CharSet?>[null];
  int add(_Kind kind, int to, [int alternative = 0, _CharSet? set]) {
    kinds.add(kind);
    next.add(to);
    other.add(alternative);
    sets.add(set);
    return kinds.length - 1;
  }

  /// Adds the states of [node], continuing at state [to]; returns the state to enter at.
  int build(_Node node, int to) {
    switch (node) {
      case _SetNode(:final set):
        return add(_Kind.set, to, 0, set);
      case _StartNode():
        return add(_Kind.start, to);
      case _EndNode():
        return add(_Kind.end, to);
      case _SequenceNode(:final nodes):
        var target = to;
        for (final child in nodes.reversed) {
          target = build(child, target);
        }
        return target;
      case _ChoiceNode(:final nodes):
        final entries = [for (final child in nodes) build(child, to)];
        var second = entries.last;
        for (var i = entries.length - 2; i >= 0; i--) {
          second = add(_Kind.split, entries[i], second);
        }
        return second;
      case _RepeatNode(node: final inner, :final min, :final max):
        var target = to;
        if (max == -1) {
          final loop = add(_Kind.split, 0, to);
          next[loop] = build(inner, loop);
          target = loop;
        } else {
          for (var i = min; i < max; i++) {
            target = add(_Kind.split, build(inner, target), to);
          }
        }
        for (var i = 0; i < min; i++) {
          target = build(inner, target);
        }
        return target;
    }
  }

  final entry = build(root, 0);
  final literal = _literal(root);
  return CompiledPattern._(
    entry,
    kinds,
    next,
    other,
    sets,
    literal.required,
    List.unmodifiable(
        literal.required.isEmpty ? literal.anyOf : const <String>[]),
    literal.min,
  );
}
