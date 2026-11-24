import { describe, expect, it } from "vitest";
import { detectKind, extractDocument } from "../../src/rag/extraction.service.js";
import { sanitizeFilename } from "../../src/rag/ingestion.service.js";
import { makeDocx, makePdf } from "../helpers/fixtures.js";

describe("extractDocument", () => {
  it("extracts text per page from PDFs", async () => {
    const pdf = makePdf(["Annual leave is 14 days.", "Sick leave is 10 days."]);
    const res = await extractDocument("policy.pdf", pdf);
    expect(res.kind).toBe("pdf");
    expect(res.pageCount).toBe(2);
    expect(res.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(res.pages[0]!.text).toContain("Annual leave is 14 days.");
    expect(res.pages[1]!.text).toContain("Sick leave is 10 days.");
  });

  it("extracts raw text from DOCX", async () => {
    const res = await extractDocument("handbook.docx", await makeDocx(["Welcome to the team.", "Office hours are 9 to 5."]));
    expect(res.kind).toBe("docx");
    expect(res.mimeType).toContain("wordprocessingml");
    expect(res.pages[0]!.text).toContain("Office hours are 9 to 5.");
  });

  it("decodes UTF-8 text and markdown, stripping the BOM", async () => {
    const res = await extractDocument("notes.md", Buffer.from("\uFEFF# Notes\nCafé ☕", "utf8"));
    expect(res.pages[0]!.text).toBe("# Notes\nCafé ☕");
  });

  it("rejects unsupported extensions and mismatched content", () => {
    expect(() => detectKind("evil.exe", Buffer.from("MZ"))).toThrow(/Unsupported file type/);
    expect(() => detectKind("fake.pdf", Buffer.from("hello"))).toThrow(/valid PDF/);
    expect(() => detectKind("fake.docx", Buffer.from("hello"))).toThrow(/valid DOCX/);
    expect(() => detectKind("bin.txt", Buffer.from([0x68, 0x00, 0x69]))).toThrow(/binary/);
  });

  it("rejects documents without text", async () => {
    await expect(extractDocument("empty.txt", Buffer.from("   \n  "))).rejects.toThrow(/no text/);
    await expect(extractDocument("scan.pdf", makePdf([""]))).rejects.toThrow(/OCR/);
  });
});

describe("zip bomb protection", () => {
  it("rejects a DOCX whose content inflates far beyond its size, before parsing it", async () => {
    const { deflateRawSync } = await import("node:zlib");
    const { assertSafeZip } = await import("../../src/rag/zip-guard.js");
    // Build a one-entry zip: ~50 MB of zeros compresses to ~50 KB.
    const raw = Buffer.alloc(50 * 1024 * 1024);
    const data = deflateRawSync(raw);
    const name = Buffer.from("word/document.xml");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    const cdOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const bomb = Buffer.concat([local, name, data, central, name, eocd]);

    expect(() => assertSafeZip(bomb)).toThrow(/compression ratio/);
    expect(() => assertSafeZip(bomb, { maxUncompressedBytes: 10 * 1024 * 1024, maxRatio: 1e9, maxEntries: 10 })).toThrow(/too large/);
    await expect(extractDocument("bomb.docx", bomb)).rejects.toThrow(/Rejected archive/);
  });

  it("accepts normal DOCX files", async () => {
    const { assertSafeZip } = await import("../../src/rag/zip-guard.js");
    expect(() => assertSafeZip(Buffer.alloc(0))).toThrow(/not a valid zip/);
    const docx = await makeDocx(["Hello"]);
    expect(() => assertSafeZip(docx)).not.toThrow();
  });
});

describe("sanitizeFilename", () => {
  it("strips paths and control characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeFilename("..")).toBe("document");
    expect(sanitizeFilename(`${"x".repeat(300)}.pdf`)).toHaveLength(200);
  });
});
