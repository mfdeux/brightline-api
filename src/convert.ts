// src/lib/conversion.ts
import { ZipInputFile, unzipSync, zipSync } from "fflate";
import { HTTPException } from "hono/http-exception";
import { tmpdir } from "os";
import { basename, extname, join } from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/* ------------------------------- Constants -------------------------------- */
export const TEMP_DIR = tmpdir();
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/* ----------------------- External tool availability ----------------------- */
export async function hasWK(): Promise<boolean> {
  try {
    const p = Bun.spawn(
      [process.env.WKHTMLTOPDF_PATH || "wkhtmltopdf", "--version"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

export async function hasUnrtf(): Promise<boolean> {
  try {
    const p = Bun.spawn([process.env.UNRTF_PATH || "unrtf", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

export async function getWKVersion(): Promise<string | null> {
  try {
    const p = Bun.spawn(
      [process.env.WKHTMLTOPDF_PATH || "wkhtmltopdf", "--version"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const out = await new Response(p.stdout).text();
    await p.exited;
    return p.exitCode === 0 ? out.split("\n")[0].trim() : null;
  } catch {
    return null;
  }
}

export async function getUnrtfVersion(): Promise<string | null> {
  try {
    const p = Bun.spawn([process.env.UNRTF_PATH || "unrtf", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return p.exitCode === 0 ? out.split("\n")[0].trim() : null;
  } catch {
    return null;
  }
}

/* --------------------------- Startup assertion ---------------------------- */
export async function assertStartupDependencies(
  opts: { requireWK?: boolean; requireUnrtf?: boolean } = {
    requireWK: true,
    requireUnrtf: true,
  }
) {
  const wantWK = opts.requireWK !== false;
  const wantUN = opts.requireUnrtf !== false;

  if (wantWK && !(await hasWK())) {
    throw new Error(
      "Missing dependency: wkhtmltopdf not found in PATH. " +
        "Install it (e.g., apt-get install wkhtmltopdf) or set WKHTMLTOPDF_PATH."
    );
  }
  if (wantUN && !(await hasUnrtf())) {
    throw new Error(
      "Missing dependency: unrtf not found in PATH. " +
        "Install it (e.g., apt-get install unrtf) or set UNRTF_PATH."
    );
  }
}

/* --------------------------------- Limits -------------------------------- */
export function enforceFileLimit(file: File) {
  if (file.size > MAX_FILE_BYTES) {
    throw new HTTPException(413, {
      message: `File too large. Max size is 50MB.`,
    });
  }
}
export function enforceStringLimit(name: string, text: string) {
  const size = new Blob([text]).size;
  if (size > MAX_FILE_BYTES) {
    throw new HTTPException(413, {
      message: `${name} too large. Max size is 50MB.`,
    });
  }
}

/* ------------------------------ Stream helper ---------------------------- */
export function streamFile(path: string, filename: string, mime: string) {
  const f = Bun.file(path);
  return new Response(f, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": f.size.toString(),
      "Cache-Control": "no-store",
    },
  });
}

/* --------------------------- HTML → PDF (wkhtml) -------------------------- */
export async function htmlToPdfWithWK_toPath(
  html: string,
  outNameBase = "doc"
): Promise<string> {
  const htmlPath = join(
    TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${outNameBase}.html`
  );
  const pdfPath = join(
    TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${outNameBase}.pdf`
  );
  await Bun.write(htmlPath, html);

  const bin = process.env.WKHTMLTOPDF_PATH || "wkhtmltopdf";
  const args = [
    "--quiet",
    "--enable-local-file-access",
    "--print-media-type",
    "--margin-top",
    "12mm",
    "--margin-right",
    "12mm",
    "--margin-bottom",
    "12mm",
    "--margin-left",
    "12mm",
    htmlPath,
    pdfPath,
  ];
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `wkhtmltopdf failed (${code})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
    );
  }
  return pdfPath;
}

/* ----------------------------- RTF → HTML -------------------------------- */
export async function rtfToHtmlWithUnrtf(
  rtfBytes: Uint8Array
): Promise<string> {
  const rtfPath = join(
    TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}.rtf`
  );
  await Bun.write(rtfPath, rtfBytes);

  const bin = process.env.UNRTF_PATH || "unrtf";
  const proc = Bun.spawn([bin, "--html", "--quiet", rtfPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`unrtf failed (${code})\nSTDERR:\n${stderr}`);
  return stdout;
}

/* ----------------------------- TXT → PDF --------------------------------- */
export async function txtToPdf_toPath(
  bytes: Uint8Array,
  filename = "document.txt"
): Promise<string> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);

  const pageSize: [number, number] = [612, 792]; // Letter
  const margin = 50;
  const fontSize = 12;
  const lineHeight = fontSize * 1.3;
  const maxWidth = pageSize[0] - margin * 2;

  const words = text.replace(/\r\n/g, "\n").split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const trial = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(trial, fontSize) <= maxWidth) {
      current = trial;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(w, fontSize) > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          const t2 = chunk + ch;
          if (font.widthOfTextAtSize(t2, fontSize) <= maxWidth) chunk = t2;
          else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        current = chunk;
      } else current = w;
    }
  }
  if (current) lines.push(current);

  let page = pdf.addPage(pageSize);
  let y = page.getHeight() - margin;
  for (const line of lines) {
    if (y < margin + lineHeight) {
      page = pdf.addPage(pageSize);
      y = page.getHeight() - margin;
    }
    page.drawText(line, {
      x: margin,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    y -= lineHeight;
  }

  const footer = basename(filename);
  const footerWidth = font.widthOfTextAtSize(footer, 9);
  const firstPage = pdf.getPage(0);
  firstPage.drawText(footer, {
    x: (firstPage.getWidth() - footerWidth) / 2,
    y: 20,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  const pdfBytes = await pdf.save();
  const outPath = join(
    TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${basename(
      filename,
      ".txt"
    )}.pdf`
  );
  await Bun.write(outPath, pdfBytes);
  return outPath;
}

/* ------------------------------- ZIP utils -------------------------------- */
export function unzipToMap(zipBytes: Uint8Array): Map<string, Uint8Array> {
  const out = unzipSync(zipBytes);
  const map = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(out)) map.set(k, v);
  return map;
}
export async function zipFromMap_toPath(
  files: Map<string, Uint8Array>,
  outBase = "bundle"
): Promise<string> {
  const input: Record<string, ZipInputFile> = {};
  for (const [k, v] of files.entries()) input[k] = v;
  const zipped = zipSync(input);
  const outPath = join(
    TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${outBase}.zip`
  );
  await Bun.write(outPath, zipped);
  return outPath;
}

/* ----------------------------- Request helpers ---------------------------- */
export async function readFormFile(c: any, key = "file"): Promise<File> {
  const form = await c.req.formData();
  const f = form.get(key);
  if (!f || !(f instanceof File)) {
    throw new HTTPException(400, {
      message: `Expected multipart/form-data with a '${key}' file field.`,
    });
  }
  return f;
}

/* ----------------------------- URL utilities ----------------------------- */
export async function getUrlFromRequest(c: any): Promise<string> {
  const ct = c.req.header("content-type") || "";
  if (ct.startsWith("application/json")) {
    const body = await c.req.json().catch(() => ({}));
    if (body?.url && typeof body.url === "string") return body.url;
  } else if (ct.startsWith("multipart/form-data")) {
    const form = await c.req.formData();
    const u = form.get("url");
    if (typeof u === "string") return u;
  }
  throw new HTTPException(400, {
    message:
      'Provide a URL via JSON { "url": "<https://...>" } or form-data field "url".',
  });
}

export function guessExtFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  const t = ct.split(";")[0].trim().toLowerCase();
  switch (t) {
    case "application/pdf":
      return ".pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "text/plain":
      return ".txt";
    case "text/html":
      return ".html";
    case "application/rtf":
      return ".rtf";
    case "application/zip":
    case "application/x-zip-compressed":
      return ".zip";
    default:
      return null;
  }
}

export function extFromUrlOrDisposition(
  urlStr: string,
  contentDisposition?: string | null
): string | null {
  try {
    if (contentDisposition) {
      const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentDisposition);
      if (m) {
        const n = decodeURIComponent(m[1].replace(/"/g, ""));
        const e = extname(n);
        if (e) return e.toLowerCase();
      }
    }
    const u = new URL(urlStr);
    const e = extname(u.pathname || "");
    return e ? e.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function downloadUrlToTemp(
  urlStr: string,
  maxBytes = MAX_FILE_BYTES
): Promise<{ path: string; filename: string; contentType: string | null }> {
  const res = await fetch(urlStr, { redirect: "follow" });
  if (!res.ok)
    throw new HTTPException(502, {
      message: `Failed to fetch URL (status ${res.status}).`,
    });

  const ct = res.headers.get("content-type");
  const cd = res.headers.get("content-disposition");
  const extByCT = guessExtFromContentType(ct);
  const extByURL = extFromUrlOrDisposition(urlStr, cd);
  const ext = (extByURL || extByCT || "").toLowerCase();
  const baseName =
    (cd && /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd)?.[1]) ||
    basename(new URL(urlStr).pathname || "") ||
    "download";
  const safeBase =
    decodeURIComponent(baseName).replace(/[^\w.\-]+/g, "_") || "download";
  const filename = ext
    ? safeBase.endsWith(ext)
      ? safeBase
      : safeBase + ext
    : safeBase;

  const tmpPath = join(
    TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`
  );
  const file = Bun.file(tmpPath);
  const w = file.writer();
  const reader = res.body?.getReader();
  if (!reader)
    throw new HTTPException(502, { message: "No response body from URL." });

  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value?.byteLength ?? 0;
    if (received > maxBytes) {
      reader.cancel().catch(() => {});
      await w.end();
      throw new HTTPException(413, {
        message: "Remote file exceeds 50MB limit.",
      });
    }
    await w.write(value);
  }
  await w.end();
  return { path: tmpPath, filename, contentType: ct };
}

export function normalizeHtmlWrapper(html: string) {
  return /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

/* ------------------------------ Common CSS ------------------------------- */
export const BASE_CSS = `
  body{font-family:"Liberation Serif","DejaVu Serif",serif;font-size:12pt;line-height:1.35}
  h1,h2,h3{margin:0.6em 0 0.3em} p,li{margin:0.3em 0}
  table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:4px}
`;
