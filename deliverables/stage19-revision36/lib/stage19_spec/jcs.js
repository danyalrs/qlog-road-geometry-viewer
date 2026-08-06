'use strict';

class DuplicatePropertyError extends Error {
  constructor(path) {
    super(`duplicateProperty:${path || ''}`);
    this.name = 'duplicateProperty';
    this.path = path || '';
  }
}

class UnsupportedValueError extends Error {
  constructor(detail) {
    super(detail || 'unsupportedValue');
    this.name = 'unsupportedValue';
  }
}

function jcsString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += s[i];
  }
  return `${out}"`;
}

function jcsNumber(n) {
  if (!Number.isFinite(n)) throw new UnsupportedValueError('unsupportedNumber');
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return String(n);
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return s;
  if (s.includes('.')) return s.replace(/\.?0+$/, '') || '0';
  return s;
}

function jcsSerialize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return jcsNumber(value);
  if (t === 'string') return jcsString(value);
  if (Array.isArray(value)) return `[${value.map(jcsSerialize).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    const seen = new Set();
    for (const k of keys) {
      if (seen.has(k)) throw new DuplicatePropertyError(k);
      seen.add(k);
    }
    return `{${keys.map((k) => `${jcsString(k)}:${jcsSerialize(value[k])}`).join(',')}}`;
  }
  throw new UnsupportedValueError('unsupportedValue');
}

function jcsUtf8Bytes(value) {
  return new TextEncoder().encode(jcsSerialize(value));
}

class Stage19JsonParser {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  parse() {
    this.skipWs();
    const v = this.parseValue('');
    this.skipWs();
    if (this.i !== this.text.length) throw new UnsupportedValueError('trailingContent');
    return v;
  }

  skipWs() {
    while (this.i < this.text.length && ' \t\r\n'.includes(this.text[this.i])) this.i++;
  }

  peek() { return this.text[this.i]; }

  consume(ch) {
    if (this.text[this.i] !== ch) throw new UnsupportedValueError(`expected:${ch}`);
    this.i++;
  }

  parseValue(path) {
    this.skipWs();
    const ch = this.peek();
    if (ch === '{') return this.parseObject(path);
    if (ch === '[') return this.parseArray(path);
    if (ch === '"') return this.parseString();
    if (ch === 't') return this.parseLiteral('true', true);
    if (ch === 'f') return this.parseLiteral('false', false);
    if (ch === 'n') return this.parseLiteral('null', null);
    return this.parseNumber();
  }

  parseLiteral(word, value) {
    if (this.text.slice(this.i, this.i + word.length) !== word) throw new UnsupportedValueError('invalidLiteral');
    this.i += word.length;
    return value;
  }

  parseString() {
    this.consume('"');
    let out = '';
    while (this.i < this.text.length) {
      const ch = this.text[this.i++];
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.text[this.i++];
        if (esc === 'u') {
          const hex = this.text.slice(this.i, this.i + 4);
          this.i += 4;
          out += String.fromCharCode(parseInt(hex, 16));
        } else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else out += esc;
      } else out += ch;
    }
    throw new UnsupportedValueError('unterminatedString');
  }

  parseNumber() {
    const start = this.i;
    if (this.peek() === '-') this.i++;
    while (this.i < this.text.length && this.text[this.i] >= '0' && this.text[this.i] <= '9') this.i++;
    if (this.peek() === '.') {
      this.i++;
      while (this.i < this.text.length && this.text[this.i] >= '0' && this.text[this.i] <= '9') this.i++;
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.i++;
      if (this.peek() === '+' || this.peek() === '-') this.i++;
      while (this.i < this.text.length && this.text[this.i] >= '0' && this.text[this.i] <= '9') this.i++;
    }
    const raw = this.text.slice(start, this.i);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UnsupportedValueError('invalidNumber');
    return n;
  }

  parseArray(path) {
    this.consume('[');
    const arr = [];
    this.skipWs();
    if (this.peek() === ']') { this.i++; return arr; }
    for (;;) {
      arr.push(this.parseValue(`${path}[${arr.length}]`));
      this.skipWs();
      if (this.peek() === ']') { this.i++; return arr; }
      this.consume(',');
    }
  }

  parseObject(path) {
    this.consume('{');
    const obj = {};
    const seen = new Set();
    this.skipWs();
    if (this.peek() === '}') { this.i++; return obj; }
    for (;;) {
      this.skipWs();
      const key = this.parseString();
      if (seen.has(key)) throw new DuplicatePropertyError(path ? `${path}.${key}` : key);
      seen.add(key);
      this.skipWs();
      this.consume(':');
      obj[key] = this.parseValue(path ? `${path}.${key}` : key);
      this.skipWs();
      if (this.peek() === '}') { this.i++; return obj; }
      this.consume(',');
    }
  }
}

function runConformanceVectors() {
  const parser = new Stage19JsonParser;
  const vectors = [
    { name: 'duplicate-top-level', run: () => { new Stage19JsonParser('{"a":1,"a":2}').parse(); }, expectThrow: 'duplicateProperty' },
    { name: 'duplicate-nested', run: () => { new Stage19JsonParser('{"o":{"x":1,"x":2}}').parse(); }, expectThrow: 'duplicateProperty' },
    { name: 'duplicate-multi-level', run: () => { new Stage19JsonParser('{"a":{"b":1,"b":2},"c":3}').parse(); }, expectThrow: 'duplicateProperty' },
    { name: 'number-int', expect: '1', input: 1 },
    { name: 'number-negative-zero', expect: '0', input: -0 },
    { name: 'number-large-int', expect: '1000000000000000', input: 1000000000000000 },
    { name: 'utf16-order', expect: '{"a":1,"b":2}', input: { b: 2, a: 1 } },
    { name: 'control-escape', expect: '{"x":"\\u0007"}', input: { x: '\u0007' } },
    { name: 'unicode-string', expect: '{"s":"\\u03c0"}', input: { s: '\u03c0' } },
    { name: 'nested-object-array', expect: '{"o":{"a":[1,2]}}', input: { o: { a: [1, 2] } } },
    { name: 'round-trip', run: () => {
      const v = { z: 1, a: [{ b: 2 }] };
      const out = jcsSerialize(v);
      const parsed = new Stage19JsonParser(out).parse();
      return jcsSerialize(parsed) === out;
    }, pass: true },
    { name: 'unsupported-nan', run: () => jcsSerialize(NaN), expectThrow: 'unsupportedValue' },
    { name: 'unsupported-undefined', run: () => jcsSerialize(undefined), expectThrow: 'unsupportedValue' },
  ];
  const results = [];
  for (const v of vectors) {
    if (v.expectThrow) {
      let threw = false;
      let errName = '';
      try { v.run(); } catch (e) { threw = true; errName = e.name; }
      results.push({ name: v.name, pass: threw && errName === v.expectThrow });
    } else if (v.run) {
      results.push({ name: v.name, pass: v.run() === v.pass });
    } else {
      const out = jcsSerialize(v.input);
      results.push({ name: v.name, pass: out === v.expect, out, expect: v.expect });
    }
  }
  return {
    allPass: results.every((r) => r.pass),
    results,
    nestedDuplicateRejected: results.find((r) => r.name === 'duplicate-nested')?.pass === true,
    roundTripPass: results.find((r) => r.name === 'round-trip')?.pass === true,
  };
}

module.exports = {
  DuplicatePropertyError,
  UnsupportedValueError,
  jcsSerialize,
  jcsUtf8Bytes,
  Stage19JsonParser,
  runConformanceVectors,
};
