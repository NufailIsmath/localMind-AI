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

describe("sanitizeFilename", () => {
  it("strips paths and control characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeFilename("..")).toBe("document");
    expect(sanitizeFilename(`${"x".repeat(300)}.pdf`)).toHaveLength(200);
  });
});
