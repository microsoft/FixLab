import { deflateSync } from "node:zlib";
import { normalizeTraceEvidence } from "./issue-plans.js";

// Original 5x7 bitmap glyphs keep report rendering independent of fonts, browsers and network access.
const glyphs = {
  " ": "00000000000000", "-": "0000001f000000", ".": "00000000000c0c",
  ",": "000000000c0c08", ":": "000c0c000c0c00", "/": "01010204081010",
  "!": "04040404040004", "\"": "0a0a0a00000000", "#": "0a0a1f0a1f0a0a",
  "$": "040f140e051e04", "%": "19190204081313", "&": "0c12140a15120d",
  "'": "04040400000000", "(": "02040808080402", ")": "08040202020408",
  "*": "00150e1f0e1500", "+": "0004041f040400", ";": "000c0c000c0c08",
  "<": "01020408040201", ">": "10080402040810", "_": "0000000000001f",
  "{": "02040408040402", "}": "08040402040408", "|": "04040404040404",
  "~": "00000916000000", "`": "08040200000000",
  "0": "0e11131519110e", "1": "040c040404040e", "2": "0e11010204081f",
  "3": "1e01010601011e", "4": "02060a121f0202", "5": "1f10101e01011e",
  "6": "0e10101e11110e", "7": "1f010204080808", "8": "0e11110e11110e", "9": "0e11110f01010e",
  A: "0e11111f111111", B: "1e11111e11111e", C: "0f10101010100f", D: "1e11111111111e",
  E: "1f10101e10101f", F: "1f10101e101010", G: "0f10101711110f", H: "1111111f111111",
  I: "0e04040404040e", J: "0702020212120c", K: "11121418141211", L: "1010101010101f",
  M: "111b1515111111", N: "11191915131311", O: "0e11111111110e", P: "1e11111e101010",
  Q: "0e11111115120d", R: "1e11111e141211", S: "0f10100e01011e", T: "1f040404040404",
  U: "1111111111110e", V: "11111111110a04", W: "11111115151b11", X: "11110a040a1111",
  Y: "11110a04040404", Z: "1f01020408101f"
};
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

export function renderTraceImage(value, policy) {
  if (!policy) { throw new Error("Trace rendering requires an approved policy."); }
  const evidence = normalizeTraceEvidence(value, policy);
  // Only normalized, exact policy-approved diagnostics may accompany the metadata.
  const rows = evidence.rows.map((row, index) => [
    `${index + 1} ${row.timestamp}`, row.table.toUpperCase(),
    row.success === true ? "TRUE" : row.success === false ? "FALSE" : "N/A",
    /^\d{3}$/u.test(row.resultCode ?? "") ? row.resultCode : "N/A",
    Number.isInteger(row.severityLevel) ? `${row.severityLevel} ${["VERBOSE", "INFO", "WARNING", "ERROR", "CRITICAL"][row.severityLevel]}` : "N/A"
  ]);
  const headings = ["ROW / UTC TIMESTAMP", "TABLE / TYPE", "SUCCESS", "STATUS CODE", "SEVERITY"];
  const top = [
    "RENDERED TRACE RESULTS",
    `UTC WINDOW: ${evidence.start} TO ${evidence.end}`,
    `OBSERVED ROWS: ${rows.length} / 10 MAX - TRUNCATED: ${evidence.truncated === undefined ? "UNKNOWN" : evidence.truncated ? "YES" : "NO"}`,
    `OMITTED DIAGNOSTICS: ${evidence.omittedDiagnostics ?? "N/A"}`
  ];
  const diagnostics = ["APPROVED DIAGNOSTICS - ROW NUMBERS MATCH THE TABLE"];
  evidence.rows.forEach((row, index) => {
    if (row.table === "requests" || row.table === "dependencies") {
      diagnostics.push(`ROW ${index + 1} API: ${row.endpoint ?? "ROUTE NOT CAPTURED"}`);
    } else if (row.logMessage) {
      diagnostics.push(`ROW ${index + 1} LOG: ${row.logMessage}`);
    }
  });
  if (diagnostics.length === 1) { diagnostics.push("NO APPROVED ENDPOINTS OR MESSAGES CAPTURED."); }
  const diagnosticLines = diagnostics.flatMap(line => {
    const visible = [...line.toUpperCase()].map(character => Object.hasOwn(glyphs, character)
      ? character : `U+${character.codePointAt(0).toString(16).toUpperCase()}`).join("");
    return visible.match(/.{1,88}/gu) ?? [];
  });
  const footer = [
    "OBSERVED EVIDENCE - NOT A PORTAL SCREENSHOT OR ROOT-CAUSE PROOF.",
    "PRIVATE IDS, URLS AND PAYLOADS EXCLUDED. N/A: NOT AVAILABLE.",
    "TEXT UPPERCASED. OTHER GLYPHS: U+HEX. NOT APPLICATION VALIDATION."
  ];
  const width = 1100;
  const height = 252 + rows.length * 36 + diagnosticLines.length * 22;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const rectangle = (x, y, w, h, color) => {
    for (let dy = y; dy < y + h; dy++) {
      for (let dx = x; dx < x + w; dx++) {
        const offset = (dy * width + dx) * 3;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
      }
    }
  };
  const text = (value, x, y, color = [24, 35, 50]) => {
    for (const character of value) {
      const glyph = glyphs[character];
      if (!glyph) { throw new Error("Unsupported trace report glyph."); }
      for (let row = 0; row < 7; row++) {
        const bits = Number.parseInt(glyph.slice(row * 2, row * 2 + 2), 16);
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) { rectangle(x + col * 2, y + row * 2, 2, 2, color); }
        }
      }
      x += 12;
    }
  };
  top.forEach((line, index) => text(line, 20, 18 + index * 26));
  const columns = [20, 360, 590, 720, 880];
  rectangle(10, 122, 1080, 32, [31, 65, 98]);
  headings.forEach((line, index) => text(line, columns[index], 131, [255, 255, 255]));
  rows.forEach((row, index) => {
    const y = 154 + index * 36;
    rectangle(10, y, 1080, 35, index % 2 ? [238, 244, 250] : [248, 250, 252]);
    row.forEach((cell, column) => text(cell, columns[column], y + 11));
  });
  const diagnosticsY = 166 + rows.length * 36;
  diagnosticLines.forEach((line, index) => text(line, 20, diagnosticsY + index * 22));
  footer.forEach((line, index) => text(line, 20, diagnosticsY + (diagnosticLines.length + 1 + index) * 22));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(scanlines, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    signature, chunk("IHDR", header),
    chunk("iTXt", Buffer.from(`Description\0\0\0\0\0${[...top, headings.join(" | "), ...rows.map(row => row.join(" | ")), ...diagnostics, ...footer].join("\n")}`)),
    chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))
  ]);
}
