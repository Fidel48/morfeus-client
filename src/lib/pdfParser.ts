/**
 * PDF parsing using pdfjs-dist (legacy build).
 * Supports two modes:
 *  1. Text extraction — for standard text-layer PDFs
 *  2. Image rendering — for scanned/image-based PDFs (renders pages to canvas → base64 JPEG)
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).href;

async function openPdf(bytes: Uint8Array) {
  // Use bytes.slice(0) to create a copy of the underlying ArrayBuffer.
  // This prevents the worker from detaching/consuming the original buffer,
  // allowing us to reuse the same bytes if we need to fallback to image rendering.
  return pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true }).promise;
}

/**
 * Try to extract text from a PDF.
 * Returns null if the PDF has no text layer (indicating it is image-based).
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string | null> {
  let pdf: any;
  try {
    pdf = await openPdf(bytes);
  } catch (err: any) {
    throw new Error(`Could not open PDF: ${err?.message || String(err)}`);
  }

  const totalPages = pdf.numPages;
  console.log(`[pdfParser] Opened PDF — ${totalPages} page(s)`);

  const allLines: string[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      const lineMap = new Map<number, string[]>();
      for (const item of textContent.items as any[]) {
        if (!('str' in item) || !item.str.trim()) continue;
        const y = Math.round(item.transform?.[5] ?? 0);
        if (!lineMap.has(y)) lineMap.set(y, []);
        lineMap.get(y)!.push(item.str);
      }

      const sortedLines = [...lineMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, words]) => words.join('').trim())
        .filter(Boolean);

      allLines.push(...sortedLines);
      console.log(`[pdfParser] Page ${pageNum}: ${sortedLines.length} lines`);
    } catch (pageErr) {
      console.warn(`[pdfParser] Page ${pageNum} error:`, pageErr);
    }
  }

  const result = allLines.join('\n').trim();
  console.log(`[pdfParser] Text extraction done — ${result.length} chars`);

  // Return null if no text was found (signals caller to try image rendering)
  return result.length > 20 ? result : null;
}

/**
 * Render PDF pages to base64 JPEG images using HTML Canvas.
 * Used as a fallback for scanned / design-tool PDFs with no text layer.
 * Limits to maxPages to avoid sending too many images to the LLM.
 */
export async function renderPdfToImages(bytes: Uint8Array, maxPages = 4): Promise<string[]> {
  let pdf: any;
  try {
    pdf = await openPdf(bytes);
  } catch (err: any) {
    throw new Error(`Could not open PDF for rendering: ${err?.message || String(err)}`);
  }

  const totalPages = Math.min(pdf.numPages, maxPages);
  console.log(`[pdfParser] Rendering ${totalPages} page(s) to images...`);

  const images: string[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      // Scale 1.5x for good readability without oversizing
      const viewport = page.getViewport({ scale: 1.5 });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d')!;

      // White background (PDFs are typically white)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Export as JPEG base64 (no data URI prefix — we add that when building the API message)
      const base64 = canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
      images.push(base64);
      console.log(`[pdfParser] Page ${pageNum} rendered: ${base64.length} base64 chars`);
    } catch (err) {
      console.error(`[pdfParser] Failed to render page ${pageNum}:`, err);
    }
  }

  return images;
}
