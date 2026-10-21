"use strict";

const { SectionError } = require("./errors");

const DEFAULT_SECTION_NAME = "activity";

/**
 * Find the START/END markers for a managed section, ignoring anything inside
 * fenced code blocks (where README authors often quote the marker syntax).
 *
 * @param {string[]} lines
 * @param {string} sectionName
 * @returns {{starts: number[], ends: number[]}}
 */
function findMarkers(lines, sectionName = DEFAULT_SECTION_NAME) {
  const startPattern = markerPattern("START", sectionName);
  const endPattern = markerPattern("END", sectionName);
  const starts = [];
  const ends = [];
  let fence = null;

  lines.forEach((line, index) => {
    if (fence) {
      const closing = line.trim().match(/^(`{3,}|~{3,})\s*$/);
      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      return;
    }

    const opening = line.match(/^\s*(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      return;
    }

    if (startPattern.test(line)) {
      starts.push(index);
    } else if (endPattern.test(line)) {
      ends.push(index);
    }
  });

  return { starts, ends };
}

/**
 * Read the current contents of a managed section.
 *
 * @param {string} text
 * @param {string} [sectionName]
 * @returns {{found: boolean, startIndex: number, endIndex: number, body: string[]}}
 */
function readSection(text, sectionName = DEFAULT_SECTION_NAME) {
  const document = parseDocument(text);
  const { starts, ends } = findMarkers(document.lines, sectionName);

  if (starts.length === 0) {
    return { found: false, startIndex: -1, endIndex: -1, body: [] };
  }

  const startIndex = starts[0];
  const endIndex = ends.find((index) => index > startIndex);
  return {
    found: true,
    startIndex,
    endIndex: endIndex === undefined ? -1 : endIndex,
    body:
      endIndex === undefined
        ? []
        : document.lines.slice(startIndex + 1, endIndex),
  };
}

/**
 * Replace (or create) the managed activity section.
 *
 * The rest of the file - including a trailing newline, CRLF line endings, a
 * UTF-8 BOM, and blank lines around the section - is preserved. If the END
 * marker is missing it is inserted immediately after the generated list,
 * leaving any existing content below the section untouched.
 *
 * @param {string} text
 * @param {object} options
 * @param {string} [options.sectionName]
 * @param {string[]} options.lines - Already formatted activity lines.
 * @returns {{
 *   found: boolean,
 *   changed: boolean,
 *   text: string,
 *   startIndex: number,
 *   endIndex: number,
 *   insertedEndMarker: boolean
 * }}
 */
function replaceSection(
  text,
  { sectionName = DEFAULT_SECTION_NAME, lines: activityLines = [] } = {},
) {
  if (!sectionName || typeof sectionName !== "string") {
    throw new SectionError("A SECTION_NAME is required.");
  }

  const document = parseDocument(text);
  const { starts, ends } = findMarkers(document.lines, sectionName);

  if (starts.length === 0) {
    return {
      found: false,
      changed: false,
      text,
      startIndex: -1,
      endIndex: -1,
      insertedEndMarker: false,
    };
  }

  if (starts.length > 1) {
    throw new SectionError(
      `Found ${starts.length} START markers for section "${sectionName}" (lines ${starts
        .map((index) => index + 1)
        .join(", ")}).`,
      {
        hint: "Keep exactly one START/END marker pair per SECTION_NAME. Use multiple action steps with different SECTION_NAME values for multiple sections.",
      },
    );
  }
  if (ends.length > 1) {
    throw new SectionError(
      `Found ${ends.length} END markers for section "${sectionName}" (lines ${ends
        .map((index) => index + 1)
        .join(", ")}).`,
      {
        hint: "Keep exactly one START/END marker pair per SECTION_NAME.",
      },
    );
  }

  const startIndex = starts[0];
  const endIndex = ends[0];

  if (endIndex !== undefined && endIndex < startIndex) {
    throw new SectionError(
      `The END marker for section "${sectionName}" appears before its START marker.`,
      {
        hint: "Place <!--END_SECTION:activity--> after <!--START_SECTION:activity-->.",
      },
    );
  }

  if (endIndex === undefined) {
    const endMarker = `<!--END_SECTION:${sectionName}-->`;
    const newLines = [
      ...document.lines.slice(0, startIndex + 1),
      ...activityLines,
      endMarker,
      ...document.lines.slice(startIndex + 1),
    ];
    const nextText = serializeDocument(newLines, document);

    return {
      found: true,
      changed: nextText !== text,
      text: nextText,
      startIndex,
      endIndex: startIndex + 1 + activityLines.length,
      insertedEndMarker: true,
    };
  }

  const existing = document.lines.slice(startIndex + 1, endIndex);
  const leadingBlank = existing.length > 0 && existing[0].trim() === "";
  const trailingBlank =
    existing.length > (leadingBlank ? 1 : 0) &&
    existing[existing.length - 1].trim() === "";

  const replacement = [
    ...(leadingBlank ? [""] : []),
    ...activityLines,
    ...(trailingBlank ? [""] : []),
  ];

  const newLines = [
    ...document.lines.slice(0, startIndex + 1),
    ...replacement,
    ...document.lines.slice(endIndex),
  ];
  const nextText = serializeDocument(newLines, document);

  return {
    found: true,
    changed: nextText !== text,
    text: nextText,
    startIndex,
    endIndex,
    insertedEndMarker: false,
  };
}

/**
 * Add `1. `, `2. `, ... prefixes to activity lines.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function buildSectionLines(lines) {
  return lines.map((line, index) => `${index + 1}. ${line}`);
}

/**
 * @param {string} text
 * @returns {{bom: boolean, eol: string, trailingNewline: boolean, lines: string[]}}
 */
function parseDocument(text) {
  const value = typeof text === "string" ? text : "";
  const bom = value.startsWith("\uFEFF");
  const body = bom ? value.slice(1) : value;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = body.endsWith("\n");
  const lines = body.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  return { bom, eol, trailingNewline, lines };
}

/**
 * @param {string[]} lines
 * @param {{bom: boolean, eol: string, trailingNewline: boolean}} document
 * @returns {string}
 */
function serializeDocument(lines, document) {
  const body =
    lines.join(document.eol) + (document.trailingNewline ? document.eol : "");
  return `${document.bom ? "\uFEFF" : ""}${body}`;
}

/**
 * @param {"START"|"END"} kind
 * @param {string} sectionName
 * @returns {RegExp}
 */
function markerPattern(kind, sectionName) {
  return new RegExp(
    `^\\s*<!--\\s*${kind}_SECTION\\s*:\\s*${escapeRegExp(sectionName)}\\s*-->\\s*$`,
    "i",
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  DEFAULT_SECTION_NAME,
  findMarkers,
  readSection,
  replaceSection,
  buildSectionLines,
  parseDocument,
  serializeDocument,
};
