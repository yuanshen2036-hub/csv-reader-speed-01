// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader 1.0.0's readCsv answer
// ({columns, rows, errors}) for every input, but scans in chunks — regex finds the next special
// character and whole field segments are sliced out of the text — instead of reading one character
// at a time and building each field a character at a time.
//
// The policy reproduced, exactly as the reference reads it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one
//     quote, and each CRLF or lone CR inside it is read as LF; what follows its closing quote, up
//     to the next comma or line break, is appended to it as it stands (quote_junk, when the field
//     ends); a quote that never closes is read as a literal character and the text after it is read
//     again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed
//     or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF
//     and lone CR inside a quoted field counted), row its record's index in rows (null for the
//     header), in the order met, a field's quote_junk when the field ends and a record's short_row
//     or long_row when the record ends.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 'comma';
const LINE_BREAK = 'line break';
const END = 'end';

const RE_UNQUOTED = /[,\n\r]/g;
const RE_QUOTED = /["\n\r]/g;

/** csv-reader 1.0.0's answer for one case's input, computed by chunk scanning. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text[0] === '\uFEFF') pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Scratch result for the field readers: reused instead of allocating a result object per field.
  // The caller consumes .value/.ended before the next read, so sharing one object is safe.
  const F = { value: '', ended: END, added: 0 };

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Sets F to the field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      RE_UNQUOTED.lastIndex = pos;
      const m = RE_UNQUOTED.exec(text);
      if (m === null) {
        if (pos < n) {
          value += text.slice(pos, n);
          added += n - pos;
          pos = n;
        }
        F.value = value;
        F.ended = END;
        F.added = added;
        return F;
      }
      const i = m.index;
      const c = text[i];
      if (c === ',') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        F.value = value;
        F.ended = COMMA;
        F.added = added;
        return F;
      }
      if (c === '\n') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        line += 1;
        F.value = value;
        F.ended = LINE_BREAK;
        F.added = added;
        return F;
      }
      // c === '\r'
      if (text[i + 1] === '\n') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 2;
        line += 1;
        F.value = value;
        F.ended = LINE_BREAK;
        F.added = added;
        return F;
      }
      // A lone CR outside quotes is dropped (stray_cr); the segment before it is kept.
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      error('stray_cr');
      pos = i + 1;
      if (pos >= n) {
        F.value = value;
        F.ended = END;
        F.added = added;
        return F;
      }
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      RE_QUOTED.lastIndex = pos;
      const m = RE_QUOTED.exec(text);
      if (m === null) {
        pos = n;
        break;
      }
      const i = m.index;
      const c = text[i];
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += text.slice(pos, i) + '"';
          pos = i + 2;
          continue;
        }
        value += text.slice(pos, i);
        pos = i + 1;
        closed = true;
        break;
      }
      if (c === '\n') {
        value += text.slice(pos, i) + '\n';
        line += 1;
        pos = i + 1;
        continue;
      }
      // c === '\r': CRLF and a lone CR inside quotes are each one LF.
      value += text.slice(pos, i) + '\n';
      line += 1;
      pos = text[i + 1] === '\n' ? i + 2 : i + 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= n) {
      F.value = value;
      F.ended = END;
      F.added = 0;
      return F;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      F.value = value;
      F.ended = COMMA;
      F.added = 0;
      return F;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      F.value = value;
      F.ended = LINE_BREAK;
      F.added = 0;
      return F;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      F.value = value;
      F.ended = LINE_BREAK;
      F.added = 0;
      return F;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields = null;
    let quoted = false;

    // Fast path: a record that sits on one line whose body (the line without its CRLF ending) holds
    // no quote and no CR is exactly its comma-split: no field can span lines and no error can arise
    // inside it. body is never empty here (empty lines were skipped above, and a line holding only
    // stray CRs contains a CR, so it takes the general path and its errors are kept).
    const nl = text.indexOf('\n', pos);
    const rawEnd = nl === -1 ? n : nl;
    let bodyEnd = rawEnd;
    if (nl !== -1 && bodyEnd > pos && text[bodyEnd - 1] === '\r') bodyEnd -= 1;
    const body = text.slice(pos, bodyEnd);
    if (body.indexOf('"') === -1 && body.indexOf('\r') === -1) {
      fields = body.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      fields = [];
      let field;
      do {
        quoted = text[pos] === '"';
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
