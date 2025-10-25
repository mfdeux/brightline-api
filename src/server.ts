// src/server.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";
import mammoth from "mammoth";
import { basename, extname } from "path";
import {
  BASE_CSS,
  MAX_FILE_BYTES,
  assertStartupDependencies,
  downloadUrlToTemp,
  enforceFileLimit,
  enforceStringLimit,
  getUnrtfVersion,
  getUrlFromRequest,
  getWKVersion,
  guessExtFromContentType,
  hasUnrtf,
  hasWK,
  htmlToPdfWithWK_toPath,
  normalizeHtmlWrapper,
  readFormFile,
  rtfToHtmlWithUnrtf,
  streamFile,
  txtToPdf_toPath,
  unzipToMap,
  zipFromMap_toPath,
} from "./convert";

// --- Fail fast on startup ---
await (async () => {
  try {
    await assertStartupDependencies({ requireWK: true, requireUnrtf: true });
    console.log("[startup] ✅ Dependencies OK: wkhtmltopdf + unrtf available");
  } catch (err) {
    console.error(
      "[startup] ❌ Dependency check failed:",
      (err as Error).message
    );
    process.exit(1);
  }
})();

const app = new Hono();
app.use("*", cors());
app.use("*", prettyJSON());

/* ------------------------------- Health ----------------------------------- */
app.get("/health", async (c) => {
  const [wkOk, unOk, wkVer, unVer] = await Promise.all([
    hasWK(),
    hasUnrtf(),
    getWKVersion(),
    getUnrtfVersion(),
  ]);
  const healthy = wkOk && unOk;
  return c.json({
    ok: healthy,
    deps: {
      wkhtmltopdf: {
        present: wkOk,
        version: wkVer,
        path: process.env.WKHTMLTOPDF_PATH || "wkhtmltopdf",
      },
      unrtf: {
        present: unOk,
        version: unVer,
        path: process.env.UNRTF_PATH || "unrtf",
      },
    },
    config: { maxUploadBytes: MAX_FILE_BYTES },
    runtime: {
      pid: process.pid,
      bunVersion: Bun.version,
      nodeCompat: process.versions?.node,
      uptimeSecs: Math.round(process.uptime()),
      env: process.env.NODE_ENV || "development",
    },
    timestamp: new Date().toISOString(),
  });
});

/* -------------------------------- Index ----------------------------------- */
app.get("/", (c) =>
  c.json({
    ok: true,
    service: "Local document conversion API (no LibreOffice)",
    runtime: "Bun",
    endpoints: [
      {
        method: "GET",
        path: "/health",
        desc: "Check dependency health & versions",
      },
      {
        method: "POST",
        path: "/convert/txt",
        desc: "file=*.txt  → PDF (pdf-lib)",
      },
      {
        method: "POST",
        path: "/convert/rtf",
        desc: "file=*.rtf  → PDF (unrtf→wkhtmltopdf)",
      },
      {
        method: "POST",
        path: "/convert/docx",
        desc: "file=*.docx → PDF (mammoth→wkhtmltopdf)",
      },
      {
        method: "POST",
        path: "/convert/html",
        desc: 'file=*.html or field "html" → PDF (wkhtmltopdf)',
      },
      {
        method: "POST",
        path: "/convert/zip",
        desc: "file=*.zip  → ZIP (PDF-only inside)",
      },
      {
        method: "POST",
        path: "/convert/url",
        desc: "JSON {url} or form field url → fetch & convert",
      },
    ],
  })
);

/* -------------------------------- Routes ---------------------------------- */
// TXT → PDF (streamed)
app.post("/api/convert/txt", async (c) => {
  const file = await readFormFile(c, "file");
  enforceFileLimit(file);
  const name = file.name || "document.txt";
  if (!/\.txt$/i.test(name))
    throw new HTTPException(400, { message: "Please upload a .txt file." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfPath = await txtToPdf_toPath(bytes, name);
  return streamFile(
    pdfPath,
    `${basename(name, ".txt")}.pdf`,
    "application/pdf"
  );
});

// RTF → PDF (unrtf → HTML → wkhtmltopdf) streamed
app.post("/api/convert/rtf", async (c) => {
  const file = await readFormFile(c, "file");
  enforceFileLimit(file);
  const name = file.name || "document.rtf";
  if (!/\.rtf$/i.test(name))
    throw new HTTPException(400, { message: "Please upload a .rtf file." });

  const rtfBytes = new Uint8Array(await file.arrayBuffer());
  const rawHtml = await rtfToHtmlWithUnrtf(rtfBytes);
  const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${rawHtml}</body></html>`;
  const pdfPath = await htmlToPdfWithWK_toPath(htmlDoc, basename(name, ".rtf"));
  return streamFile(
    pdfPath,
    `${basename(name, ".rtf")}.pdf`,
    "application/pdf"
  );
});

// DOCX → PDF (mammoth → HTML → wkhtmltopdf) streamed
app.post("/api/convert/docx", async (c) => {
  const file = await readFormFile(c, "file");
  enforceFileLimit(file);
  const name = file.name || "document.docx";
  if (!/\.docx$/i.test(name))
    throw new HTTPException(400, { message: "Please upload a .docx file." });

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;
  const pdfPath = await htmlToPdfWithWK_toPath(
    htmlDoc,
    basename(name, ".docx")
  );
  return streamFile(
    pdfPath,
    `${basename(name, ".docx")}.pdf`,
    "application/pdf"
  );
});

// HTML → PDF (wkhtmltopdf) streamed
// Accepts EITHER multipart file=*.html/htm OR multipart field "html" (string)
app.post("/api/convert/html", async (c) => {
  const form = await c.req.formData();
  const htmlField = form.get("html");
  const maybeFile = form.get("file");

  let html = "";
  if (maybeFile instanceof File) {
    enforceFileLimit(maybeFile);
    const name = maybeFile.name || "document.html";
    if (!/\.(html?|xhtml)$/i.test(name))
      throw new HTTPException(400, {
        message: 'Please upload a .html/.htm file or provide an "html" field.',
      });
    html = await maybeFile.text();
  } else if (typeof htmlField === "string") {
    enforceStringLimit("HTML content", htmlField);
    html = htmlField;
  } else {
    throw new HTTPException(400, {
      message: 'Provide either file=*.html or a text field "html".',
    });
  }

  const wrapped = normalizeHtmlWrapper(html);
  const pdfPath = await htmlToPdfWithWK_toPath(wrapped, "html-upload");
  return streamFile(pdfPath, "document.pdf", "application/pdf");
});

// ZIP → ZIP (PDF-only inside) streamed
app.post("/convert/zip", async (c) => {
  const file = await readFormFile(c, "file");
  enforceFileLimit(file);
  const name = file.name || "archive.zip";
  if (!/\.zip$/i.test(name))
    throw new HTTPException(400, { message: "Please upload a .zip file." });

  const zipBytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzipToMap(zipBytes);
  const out = new Map<string, Uint8Array>();

  for (const [path, data] of entries.entries()) {
    const ext = extname(path).toLowerCase();
    const buffer = Buffer.from(data);
    if (ext === ".txt") {
      const pdfPath = await txtToPdf_toPath(data, basename(path));
      const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
      out.set(path.replace(/\.txt$/i, ".pdf"), pdfBytes);
    } else if (ext === ".docx") {
      const { value: html } = await mammoth.convertToHtml({ buffer });
      const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;
      const pdfPath = await htmlToPdfWithWK_toPath(htmlDoc, basename(path));
      const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
      out.set(path.replace(/\.docx$/i, ".pdf"), pdfBytes);
    } else if (ext === ".rtf") {
      const rawHtml = await rtfToHtmlWithUnrtf(data);
      const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${rawHtml}</body></html>`;
      const pdfPath = await htmlToPdfWithWK_toPath(htmlDoc, basename(path));
      const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
      out.set(path.replace(/\.rtf$/i, ".pdf"), pdfBytes);
    } else if (ext === ".html" || ext === ".htm") {
      const wrapped = normalizeHtmlWrapper(new TextDecoder().decode(data));
      const pdfPath = await htmlToPdfWithWK_toPath(wrapped, basename(path));
      const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
      out.set(path.replace(/\.(html|htm)$/i, ".pdf"), pdfBytes);
    }
    // ignore others to keep output ZIP PDF-only
  }

  const outZipPath = await zipFromMap_toPath(
    out,
    basename(name, ".zip") + "-pdfs"
  );
  return streamFile(outZipPath, basename(outZipPath), "application/zip");
});

// URL → (PDF or convert) streamed
app.post("/convert/url", async (c) => {
  const urlStr = await getUrlFromRequest(c);
  if (!/^https?:\/\//i.test(urlStr)) {
    throw new HTTPException(400, {
      message: "Only http(s) URLs are supported.",
    });
  }

  const {
    path: tmpPath,
    filename,
    contentType,
  } = await downloadUrlToTemp(urlStr, MAX_FILE_BYTES);
  const ext = (extname(filename) || "").toLowerCase();

  // Fast-path: PDF as-is
  if (
    ext === ".pdf" ||
    (contentType && guessExtFromContentType(contentType) === ".pdf")
  ) {
    return streamFile(tmpPath, filename, "application/pdf");
  }

  // TXT
  if (
    ext === ".txt" ||
    (contentType && guessExtFromContentType(contentType) === ".txt")
  ) {
    const bytes = new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
    const pdfPath = await txtToPdf_toPath(bytes, filename);
    return streamFile(
      pdfPath,
      `${basename(filename, ".txt")}.pdf`,
      "application/pdf"
    );
  }

  // DOCX
  if (
    ext === ".docx" ||
    (contentType && guessExtFromContentType(contentType) === ".docx")
  ) {
    const arrayBuffer = await Bun.file(tmpPath).arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const { value: html } = await mammoth.convertToHtml({ buffer });
    const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;
    const pdfPath = await htmlToPdfWithWK_toPath(
      htmlDoc,
      basename(filename, ".docx")
    );
    return streamFile(
      pdfPath,
      `${basename(filename, ".docx")}.pdf`,
      "application/pdf"
    );
  }

  // RTF
  if (
    ext === ".rtf" ||
    (contentType && guessExtFromContentType(contentType) === ".rtf")
  ) {
    const bytes = new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
    const rawHtml = await rtfToHtmlWithUnrtf(bytes);
    const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${rawHtml}</body></html>`;
    const pdfPath = await htmlToPdfWithWK_toPath(
      htmlDoc,
      basename(filename, ".rtf")
    );
    return streamFile(
      pdfPath,
      `${basename(filename, ".rtf")}.pdf`,
      "application/pdf"
    );
  }

  // HTML
  if (
    ext === ".html" ||
    ext === ".htm" ||
    (contentType && guessExtFromContentType(contentType) === ".html")
  ) {
    const htmlText = await Bun.file(tmpPath).text();
    const wrapped = normalizeHtmlWrapper(htmlText);
    const pdfPath = await htmlToPdfWithWK_toPath(
      wrapped,
      basename(filename, ext || ".html")
    );
    return streamFile(
      pdfPath,
      `${basename(filename, ext || ".html")}.pdf`,
      "application/pdf"
    );
  }

  // // ZIP
  // if (
  //   ext === ".zip" ||
  //   (contentType && guessExtFromContentType(contentType) === ".zip")
  // ) {
  //   const zipBytes = new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
  //   const entries = unzipToMap(zipBytes);
  //   const out = new Map<string, Uint8Array>();

  //   for (const [p, data] of entries.entries()) {
  //     const e = extname(p).toLowerCase();
  //     const buffer = Buffer.from(data);
  //     if (e === ".txt") {
  //       const pdfPath = await txtToPdf_toPath(data, basename(p));
  //       const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  //       out.set(p.replace(/\.txt$/i, ".pdf"), pdfBytes);
  //     } else if (e === ".docx") {
  //       const { value: html } = await mammoth.convertToHtml({ buffer });
  //       const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;
  //       const pdfPath = await htmlToPdfWithWK_toPath(htmlDoc, basename(p));
  //       const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  //       out.set(p.replace(/\.docx$/i, ".pdf"), pdfBytes);
  //     } else if (e === ".rtf") {
  //       const rawHtml = await rtfToHtmlWithUnrtf(data);
  //       const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${rawHtml}</body></html>`;
  //       const pdfPath = await htmlToPdfWithWK_toPath(htmlDoc, basename(p));
  //       const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  //       out.set(p.replace(/\.rtf$/i, ".pdf"), pdfBytes);
  //     } else if (e === ".html" || e === ".htm") {
  //       const wrapped = normalizeHtmlWrapper(new TextDecoder().decode(data));
  //       const pdfPath = await htmlToPdfWithWK_toPath(wrapped, basename(p));
  //       const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  //       out.set(p.replace(/\.(html|htm)$/i, ".pdf"), pdfBytes);
  //     }
  //     // ignore others to keep output ZIP PDF-only
  //   }

  //   const outZipPath = await zipFromMap_toPath(
  //     out,
  //     basename(filename, ".zip") + "-pdfs"
  //   );
  //   return streamFile(outZipPath, basename(outZipPath), "application/zip");
  // }

  throw new HTTPException(415, {
    message: `Unsupported remote type. Allowed: pdf, docx, txt, rtf, html, zip.`,
  });
});

/* --------------------------- Error + bootstrap ---------------------------- */
app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500;
  const message =
    err instanceof HTTPException
      ? err.message
      : (err as Error)?.message || "Internal error";
  return c.json({ ok: false, error: message }, status);
});

export default {
  port: Number(process.env.PORT || 3000),
  fetch: app.fetch,
};
