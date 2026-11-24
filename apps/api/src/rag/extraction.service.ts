import { extname } from "node:path";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { badRequest } from "../lib/errors.js";
import type { PageText } from "./chunking.service.js";

export type SupportedKind = "pdf" | "docx" | "txt";

export const SUPPORTED_EXTENSIONS: Record<string, SupportedKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "txt",
  ".markdown": "txt",
};

export const MIME_TYPES: Record<SupportedKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

export interface ExtractedDocument {
  kind: SupportedKind;
  mimeType: string;
  pages: PageText[];
  pageCount: number | null;
}

/**
 * Detects the file type from its extension and verifies it against the file's
 * magic bytes, so a renamed binary can't slip through as "text".
 */
export function detectKind(filename: string, bytes: Buffer): SupportedKind {
  const kind = SUPPORTED_EXTENSIONS[extname(filename).toLowerCase()];
  if (!kind) {
    throw badRequest(`Unsupported file type. Allowed: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")}`);
  }
  const head = bytes.subarray(0, 5).toString("latin1");
  if (kind === "pdf" && !head.startsWith("%PDF-")) throw badRequest("File does not look like a valid PDF");
  if (kind === "docx" && !head.startsWith("PK\u0003\u0004")) throw badRequest("File does not look like a valid DOCX");
  if (kind === "txt" && bytes.subarray(0, 8192).includes(0)) throw badRequest("Text file appears to be binary");
  return kind;
}

export async function extractDocument(filename: string, bytes: Buffer): Promise<ExtractedDocument> {
  const kind = detectKind(filename, bytes);
  let pages: PageText[];
  let pageCount: number | null = null;

  switch (kind) {
    case "pdf": {
      // unpdf transfers ownership of the buffer to the worker, so pass a copy.
      const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: false });
      pages = text.map((t, i) => ({ pageNumber: i + 1, text: t }));
      pageCount = totalPages;
      break;
    }
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      pages = [{ pageNumber: null, text: value }];
      break;
    }
    case "txt": {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
      pages = [{ pageNumber: null, text }];
      break;
    }
  }

  if (!pages.some((p) => p.text.trim().length > 0)) {
    throw badRequest(
      kind === "pdf"
        ? "No extractable text found. Scanned PDFs need OCR before they can be indexed."
        : "Document contains no text",
    );
  }
  return { kind, mimeType: MIME_TYPES[kind], pages, pageCount };
}
