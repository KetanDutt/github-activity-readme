"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  readSection,
  replaceSection,
  buildSectionLines,
  findMarkers,
  parseDocument,
} = require("../src/section");
const { SectionError } = require("../src/errors");

const START = "<!--START_SECTION:activity-->";
const END = "<!--END_SECTION:activity-->";

function doc(
  body,
  { start = START, end = END, prefix = "# Hi\n", suffix = "" } = {},
) {
  return `${prefix}${start}\n${body}${end}\n${suffix}`;
}

test("replaceSection replaces the whole section and respects MAX_LINES growth", () => {
  const original = doc("1. old one\n2. old two\n");
  const next = replaceSection(original, {
    lines: buildSectionLines([
      "new one",
      "new two",
      "new three",
      "new four",
      "new five",
    ]),
  });

  assert.equal(next.found, true);
  assert.equal(next.changed, true);
  assert.match(next.text, /1\. new one/);
  assert.match(next.text, /5\. new five/);
  assert.doesNotMatch(next.text, /old one/);
});

test("replaceSection shrinks a section when MAX_LINES is reduced", () => {
  const original = doc("1. a\n2. b\n3. c\n4. d\n5. e\n");
  const next = replaceSection(original, {
    lines: buildSectionLines(["only"]),
  });
  assert.match(next.text, /1\. only/);
  assert.doesNotMatch(next.text, /2\. b/);
});

test("replaceSection reports unchanged content", () => {
  const original = doc("1. a\n2. b\n");
  const next = replaceSection(original, {
    lines: buildSectionLines(["a", "b"]),
  });
  assert.equal(next.changed, false);
  assert.equal(next.text, original);
});

test("replaceSection inserts an END marker and preserves content below", () => {
  const original = `# Hi\n${START}\n1. old\n\nFooter that must stay\n`;
  const next = replaceSection(original, {
    lines: buildSectionLines(["new"]),
  });

  assert.equal(next.insertedEndMarker, true);
  assert.match(next.text, /1\. new/);
  assert.match(next.text, /Footer that must stay/);
  assert.ok(next.text.indexOf(END) > next.text.indexOf("1. new"));
  assert.ok(next.text.indexOf("Footer") > next.text.indexOf(END));
});

test("replaceSection returns found=false when the START marker is absent", () => {
  const result = replaceSection("# Hi\n", { lines: ["a"] });
  assert.equal(result.found, false);
  assert.equal(result.changed, false);
});

test("replaceSection rejects ambiguous or invalid marker layouts", () => {
  assert.throws(
    () => replaceSection(`${START}\n${START}\n${END}\n`, { lines: ["a"] }),
    SectionError,
  );
  assert.throws(
    () => replaceSection(`${START}\n${END}\n${END}\n`, { lines: ["a"] }),
    SectionError,
  );
  assert.throws(
    () => replaceSection(`${END}\n${START}\n`, { lines: ["a"] }),
    SectionError,
  );
});

test("markers inside fenced code blocks are ignored", () => {
  const onlyFenced = `\`\`\`md\n${START}\n${END}\n\`\`\`\n`;
  assert.equal(readSection(onlyFenced).found, false);

  const fencedThenReal = `\`\`\`md\n${START}\n${END}\n\`\`\`\n${START}\n${END}\n`;
  const result = replaceSection(fencedThenReal, {
    lines: buildSectionLines(["a"]),
  });
  assert.equal(result.found, true);
  assert.match(
    result.text,
    /```md\n<!--START_SECTION:activity-->\n<!--END_SECTION:activity-->\n```\n<!--START_SECTION:activity-->\n1\. a/,
  );
});

test("markers tolerate whitespace and case differences", () => {
  const original = `<!-- start_section:activity -->\nold\n<!-- end_section:activity -->\n`;
  const result = replaceSection(original, {
    lines: buildSectionLines(["new"]),
  });
  assert.equal(result.found, true);
  assert.match(result.text, /new/);
  assert.match(result.text, /<!-- end_section:activity -->/);
});

test("CRLF line endings, indentation, and trailing newline are preserved", () => {
  const original = `# Hi\r\n  ${START}\r\n1. old\r\n${END}\r\n`;
  const result = replaceSection(original, {
    lines: buildSectionLines(["new"]),
  });
  assert.equal(result.text, `# Hi\r\n  ${START}\r\n1. new\r\n${END}\r\n`);
});

test("a UTF-8 BOM is preserved", () => {
  const original = `\uFEFF# Hi\n${START}\n${END}\n`;
  const result = replaceSection(original, {
    lines: buildSectionLines(["new"]),
  });
  assert.equal(result.text.startsWith("\uFEFF"), true);
});

test("a missing trailing newline is preserved", () => {
  const original = `# Hi\n${START}\n${END}`;
  const result = replaceSection(original, {
    lines: buildSectionLines(["new"]),
  });
  assert.equal(result.text.endsWith("\n"), false);
  assert.equal(result.text, `# Hi\n${START}\n1. new\n${END}`);
});

test("blank lines around the section are preserved for formatter stability", () => {
  const original = doc("\n1. old\n\n");
  const result = replaceSection(original, {
    lines: buildSectionLines(["new"]),
  });
  assert.equal(result.text, doc("\n1. new\n\n"));
});

test("custom section names are supported", () => {
  const original = "<!--START_SECTION:work-->\n<!--END_SECTION:work-->\n";
  const result = replaceSection(original, {
    sectionName: "work",
    lines: ["did work"],
  });
  assert.equal(
    result.text,
    "<!--START_SECTION:work-->\ndid work\n<!--END_SECTION:work-->\n",
  );
  assert.equal(readSection(result.text, "work").body[0], "did work");
});

test("section names are escaped when building marker patterns", () => {
  const original = "<!--START_SECTION:a.b-->\n<!--END_SECTION:a.b-->\n";
  const result = replaceSection(original, {
    sectionName: "a.b",
    lines: ["x"],
  });
  assert.equal(result.found, true);
  assert.match(result.text, /x/);
});

test("readSection returns the body and marker indexes", () => {
  const text = `# Hi\n${START}\n1. a\n2. b\n${END}\nFooter\n`;
  const section = readSection(text);
  assert.equal(section.found, true);
  assert.equal(section.startIndex, 1);
  assert.equal(section.endIndex, 4);
  assert.deepEqual(section.body, ["1. a", "2. b"]);
});

test("findMarkers and parseDocument expose reusable primitives", () => {
  const text = `a\n${START}\n${END}\n`;
  const document = parseDocument(text);
  assert.deepEqual(document.lines, ["a", START, END]);
  assert.deepEqual(findMarkers(document.lines).starts, [1]);
  assert.deepEqual(findMarkers(document.lines).ends, [2]);
});

test("buildSectionLines numbers from one", () => {
  assert.deepEqual(buildSectionLines(["a", "b"]), ["1. a", "2. b"]);
});

test("replacing an empty section with no lines leaves it empty", () => {
  const original = doc("");
  const result = replaceSection(original, { lines: [] });
  assert.equal(result.changed, false);
  assert.equal(result.text, original);
});

test("a section that contains only a blank line is normalised safely", () => {
  const original = doc("\n");
  const result = replaceSection(original, {
    lines: buildSectionLines(["a"]),
  });
  assert.equal(result.text, doc("\n1. a\n"));
});
