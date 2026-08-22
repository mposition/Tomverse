# Legacy Office fixtures

Four real documents, for the parsers in `lib/legacyOffice/**`.

They are committed rather than generated at test time because a binary-format
parser tested only against files its own writer produced proves that the two
agree, not that either is right. These came out of LibreOffice 24.2, which is
not this repository's code, and they carry the shapes that matter: a Word
piece table split between a one-byte-per-character run and a UTF-16 one, an
Excel shared string table, RK and NUMBER cells and a cached formula result,
two worksheets, PowerPoint slide text and a speaker note, and Korean in all
four.

| File | Produced by | Holds |
|---|---|---|
| `sample.doc` | `soffice --convert-to "doc:MS Word 97"` | three paragraphs, one Korean |
| `sample.xls` | `soffice --convert-to "xls:MS Excel 97"` | two sheets, shared strings, RK/MULRK/NUMBER, a `SUM` result |
| `sample.ppt` | `soffice --convert-to "ppt:MS PowerPoint 97"`, then rebuilt | two slides and a speaker note |
| `sample.rtf` | `soffice --convert-to "rtf:Rich Text Format"` | the same three paragraphs, with a font table and a style sheet to skip |

`sample.ppt` is the one that was touched after conversion. LibreOffice writes
a preview thumbnail into `SummaryInformation`, which came to 442KB -- 97% of
the file, and a stream no parser here opens. It was rebuilt with
`tests/support/compoundFile.mjs` carrying only `Current User` and
`PowerPoint Document`, both byte for byte as LibreOffice wrote them. The
record stream under test is therefore genuine; only the parts nothing reads
are gone.

The hostile cases -- an encrypted workbook, a sector chain that loops, a
stream that points past the end of the file -- are built in the test itself.
No tool that writes valid documents can produce them, and a decompression
bomb is not something to keep in a repository.
