import express from "express";
import { Readable } from "node:stream";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
await fs.mkdir(uploadDir, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf"))
});

const safeId = value => /^[a-zA-Z0-9-]+$/.test(value || "");
const bookPath = id => path.join(uploadDir, `${id}.json`);
const pdfPath = id => path.join(uploadDir, `${id}.pdf`);

async function readBook(id) {
  if (!safeId(id)) throw new Error("Invalid book id");
  return JSON.parse(await fs.readFile(bookPath(id), "utf8"));
}

async function readOutline(pdf) {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  async function convert(items) {
    const result = [];
    for (const item of items || []) {
      let page = null;
      try {
        const destination = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
        if (destination?.[0]) page = (await pdf.getPageIndex(destination[0])) + 1;
      } catch { /* Some PDFs contain broken outline destinations. */ }
      result.push({ title: String(item.title || "Розділ"), page, endPage: page, children: await convert(item.items) });
    }
    return result;
  }
  return convert(outline);
}

function assignPageRanges(items, pageCount, parentEnd=pageCount) {
  for (let i=0;i<items.length;i++) {
    const item = items[i];
    const next = items.slice(i+1).find(x => Number.isInteger(x.page) && x.page > item.page);
    item.endPage = Math.max(item.page || 1, Math.min(parentEnd, next ? next.page-1 : parentEnd));
    if (item.children?.length) assignPageRanges(item.children, pageCount, item.endPage);
  }
  return items;
}

function inferOutline(pages) {
  // Infer headings from lesson pages; never use the printed contents page as a lesson start.
  const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/gu, " ").trim();
  const paragraphRe = /^(?:§{1,2}\s*|ПАРАГРАФ\s+)(\d{1,3})(?!\d)\s*(?:[.:–—-]\s*)?(.*)$/iu;
  const chapterRe = /^(РОЗДІЛ|РАЗДЕЛ|ЧАСТИНА|ЧАСТЬ|ТЕМА|МОДУЛЬ)\s+([IVXLCDMІХ]+|\d{1,2})(?![\p{L}\d])\s*(?:[.:–—-]\s*)?(.*)$/iu;
  const tocRe = /^(ЗМІСТ|СОДЕРЖАНИЕ|ОГЛАВЛЕНИЕ)(?:$|\s|[.:])/iu;
  const appendixRe = /^(ДОДАТКИ|ДОДАТОК|ПРИЛОЖЕНИЯ|ЛІТЕРАТУРА|БІБЛІОГРАФІЯ|ПОКАЖЧИК|СПИСОК ЛІТЕРАТУРИ)(?:$|\s|[.:])/iu;
  const hintsRe = /^(ЗАПИТАННЯ|ЗАВДАННЯ|ПЕРЕВІРТЕ|ПРИГАДАЙТЕ|ПОМІРКУЙТЕ)/iu;
  const pageCount = pages.length;
  const found = [], endMarkers = [];
  for (const page of pages) {
    const lines = String(page.text || "").split(/\r?\n/u).map(clean).filter(Boolean);
    const distinct = new Set(lines.map(x => x.match(paragraphRe)?.[1]).filter(Boolean));
    const dotted = lines.filter(x => /(?:\.{3,}|…{2,})/u.test(x)).length;
    const printedContents = lines.slice(0, 15).some(x => tocRe.test(x)) ||
      distinct.size >= 4 || (distinct.size >= 3 && dotted >= 1);
    if (printedContents) continue;
    if (page.number > pageCount / 2 && lines.slice(0, 12).some(x => appendixRe.test(x))) {
      endMarkers.push(page.number);
    }
    // A heading should appear early enough on its page; later occurrences
    // tend to be cross-references, captions or exercises.
    const maxLine = Math.max(12, Math.ceil(lines.length * 0.55));
    for (let i = 0; i < lines.length && i <= maxLine; i++) {
      const line = lines[i], p = line.match(paragraphRe);
      const c = p ? null : line.match(chapterRe);
      if (!p && !c) continue;
      const kind = p ? "paragraph" : "chapter";
      const number = p ? Number(p[1]) : c[2].toUpperCase().replace(/І/gu,"I").replace(/Х/gu,"X");
      if (p && (number < 1 || number > 250)) continue;
      let label = clean(p ? p[2] : c[3]).replace(/(?:\.{3,}|…+)\s*\d+\s*$/u, "").trim();
      // Headings may put the number on one line and the title on the next.
      if (!label && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.length >= 3 && next.length <= 110 && !paragraphRe.test(next) &&
            !chapterRe.test(next) && !tocRe.test(next) && !appendixRe.test(next) &&
            !hintsRe.test(next) && !/^\d+$/u.test(next)) label = next;
      }
      if (!label || label.length > 120 || /(?:\.{3,}|…{2,})/u.test(label)) continue;
      // Don't accept normal sentences, page references or question-style captions.
      if (/[!?]$/u.test(label) || /\b(?:сторінк[аи]|стор\.|стр\.)\s*\d+/iu.test(label)) continue;
      const title = p ? `§ ${number}. ${label}` :
        `${c[1][0].toUpperCase() + c[1].slice(1).toLowerCase()} ${c[2]}. ${label}`;
      found.push({ kind, number, title, page: page.number, position: i,
        key: c ? `${c[1].toUpperCase()}:${number}` : null });
    }
  }
  const byNumber = new Map();
  for (const item of found.filter(x => x.kind === "paragraph")) {
    if (!byNumber.has(item.number)) byNumber.set(item.number, []);
    byNumber.get(item.number).push(item);
  }
  // Do not invent missing paragraph numbers. Require a genuine § 1 start.
  if (!byNumber.has(1)) return [];
  const paras = [];
  let lastPage = 0, lastPosition = -1, skipped = 0;
  for (let num = 1; num <= Math.max(...byNumber.keys()); num++) {
    const options = (byNumber.get(num) || []).filter(x =>
      x.page > lastPage || (x.page === lastPage && x.position > lastPosition))
      .sort((a,b) => a.page-b.page || a.position-b.position);
    if (!options.length) {
      if (++skipped >= 3) break;
      continue;
    }
    const item = options[0];
    paras.push(item);
    lastPage = item.page;
    lastPosition = item.position;
    skipped = 0;
  }
  if (!paras.length) return [];
  const ends = endMarkers.filter(x => x > paras[paras.length - 1].page);
  const lastLessonPage = ends.length ? Math.min(...ends)-1 : pageCount;
  const chaptersSeen = new Map();
  for (const c of found.filter(x => x.kind === "chapter")
      .sort((a,b) => a.page-b.page || a.position-b.position)) {
    if (!chaptersSeen.has(c.key) && c.page <= paras[paras.length-1].page)
      chaptersSeen.set(c.key, { ...c, children: [] });
  }
  const chapters = [...chaptersSeen.values()];
  const before = (a,b) => a.page < b.page || (a.page === b.page && a.position <= b.position);
  const result = [];
  for (let i = 0; i < paras.length; i++) {
    const para = paras[i], next = paras[i+1];
    let end = next ? Math.max(para.page, next.page - 1) : Math.max(para.page,lastLessonPage);
    // A section title on a separate page belongs to the new section.
    const nextChapter = chapters.find(c => !before(c,para) && (!next || before(c,next)));
    if (nextChapter && nextChapter.page > para.page) end = Math.min(end, nextChapter.page - 1);
    const item = { title: para.title, page:para.page, endPage:end, kind:"paragraph", children:[] };
    const parent = [...chapters].reverse().find(c => before(c,para));
    if (parent) parent.children.push(item);
    else result.push({ ...item, _position: para.position });
  }
  for (const ch of chapters) {
    if (!ch.children.length) continue;
    const end = ch.children[ch.children.length - 1].endPage;
    result.push({ title: ch.title, page: ch.page, endPage:Math.max(ch.page,end),
      kind:"chapter", children:ch.children, _position:ch.position });
  }
  result.sort((a,b) => a.page-b.page || a._position-b._position);
  return result.map(({_position,...item}) => item);
}

// Stream the original textbook from the official IMZO library. No copyrighted
// PDF binary is copied into GitHub; pages are drawn by PDF.js in the browser.
const HISTORY11_PDF_SOURCE = "https://lib.imzo.gov.ua/wa-data/public/site/books2/pidruchnyky-11-klas-2019/04-istoriya-ukrainy-11-klas/istoriia-ukrainy-riven-standartu-pidruchnyk-dlia-11-klasu-zzso-o-v-gisem-o-o-martyniuk.pdf";
app.use("/vendor/pdfjs", express.static(path.join(__dirname, "node_modules/pdfjs-dist/build")));
app.get("/api/printed-book/history11-gisem-stand.pdf", async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const headers = { "Accept": "application/pdf" };
    if (req.headers.range && /^bytes=\\d+-\\d*$/i.test(req.headers.range)) headers.Range = req.headers.range;
    const upstream = await fetch(HISTORY11_PDF_SOURCE, { headers, signal: controller.signal });
    if (!upstream.ok || !upstream.body) throw new Error("IMZO PDF download failed: " + upstream.status);
    res.status(upstream.status);
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Disposition", "inline");
    Readable.fromWeb(upstream.body).on("error", e => { console.error("PDF stream error", e); res.destroy(e); }).pipe(res);
    res.on("close", () => { clearTimeout(timeout); if (!res.writableEnded) controller.abort(); });
  } catch (error) {
    clearTimeout(timeout);
    console.error("Original textbook load failed", error);
    if (!res.headersSent) res.status(502).json({error:"Не вдалося завантажити офіційне видання ІМЗО. Спробуйте пізніше."});
    else res.destroy(error);
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Урокум" }));

app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Завантаж PDF-файл." });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const data = new Uint8Array(await fs.readFile(req.file.path));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const rows = new Map();
      for (const item of content.items) {
        if (!item.str?.trim()) continue;
        const y = Math.round(item.transform?.[5] || 0);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push(item.str);
      }
      const text = [...rows.entries()].sort((a,b) => b[0]-a[0]).map(([,parts]) => parts.join(" ").replace(/\s+/g," ").trim()).filter(Boolean).join("\n");
      pages.push({ number: n, text });
    }
    let outline = inferOutline(pages);
    if (!outline.length) {
      outline = await readOutline(pdf);
      if (outline.length) outline = assignPageRanges(outline, pdf.numPages);
    }
    const record = { id, name: req.file.originalname, pageCount: pdf.numPages, pages, outline };
    await fs.rename(req.file.path, pdfPath(id));
    await fs.writeFile(bookPath(id), JSON.stringify(record), "utf8");
    res.json({ id, name: record.name, pageCount: record.pageCount, outline });
  } catch (e) {
    await fs.unlink(req.file.path).catch(() => {});
    await fs.unlink(pdfPath(id)).catch(() => {});
    console.error("PDF upload error:", e);
    res.status(400).json({ error: "Не вдалося прочитати PDF. Якщо це скан, потрібне OCR-розпізнавання." });
  }
});

app.get("/api/book/:id/file", async (req, res) => {
  try {
    const book = await readBook(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(book.name)}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.sendFile(pdfPath(req.params.id));
  } catch { res.status(404).json({ error: "PDF-файл не знайдено." }); }
});

app.get("/api/book/:id", async (req, res) => {
  try {
    const book = await readBook(req.params.id);
    res.json({ id: book.id, name: book.name, pageCount: book.pageCount, outline: book.outline || [] });
  } catch { res.status(404).json({ error: "Підручник не знайдено." }); }
});

app.put("/api/book/:id/outline", async (req, res) => {
  try {
    const book = await readBook(req.params.id);
    const outline = req.body?.outline;
    if (!Array.isArray(outline)) return res.status(400).json({ error: "Некоректний зміст." });
    const validate = (items, depth=0) => {
      if (depth > 8) throw new Error("Занадто глибока структура змісту.");
      for (const item of items) {
        if (typeof item.title !== "string" || !item.title.trim()) throw new Error("Кожен пункт має мати назву.");
        if (!Number.isInteger(item.page) || item.page < 1 || item.page > book.pageCount) throw new Error("Номер сторінки поза межами PDF.");
        const end = item.endPage ?? item.page;
        if (!Number.isInteger(end) || end < item.page || end > book.pageCount) throw new Error("Перевір діапазон сторінок.");
        validate(item.children || [], depth+1);
      }
    };
    validate(outline);
    book.outline = outline;
    await fs.writeFile(bookPath(book.id), JSON.stringify(book), "utf8");
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message || "Не вдалося зберегти зміст." }); }
});

app.get("/api/book/:id/page/:number", async (req, res) => {
  try {
    const book = await readBook(req.params.id);
    const page = book.pages.find(p => p.number === Number(req.params.number));
    if (!page) return res.status(404).json({ error: "Сторінку не знайдено." });
    res.json({ name: book.name, ...page });
  } catch { res.status(404).json({ error: "Підручник не знайдено." }); }
});

app.post("/api/tutor", async (req, res) => {
  const { text, task } = req.body || {};
  if (!text) return res.status(400).json({ error: "Немає тексту сторінки." });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "ШІ ще не підключено. Власник сайту має додати OPENAI_API_KEY у налаштуваннях хостингу." });
  const prompt = task === "test"
    ? "Створи 5 тестових запитань українською за фрагментом. Для кожного дай 4 варіанти (А, Б, В, Г), вкажи правильну відповідь і коротке пояснення. Не додавай фактів поза текстом."
    : task === "checkpoint"
      ? "Створи ОДНЕ контрольне запитання для паузи під час читання. Поверни ЛИШЕ валідний JSON без markdown у форматі: {\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":0,\"explanation\":\"...\"}. correct — індекс правильної відповіді від 0 до 3. Усе має перевіряти знання саме з цього тексту."
      : "Поясни цей фрагмент підручника простою українською для школяра. Виділи головне та поясни складні слова.";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", input: `${prompt}\n\nТекст підручника:\n${text.slice(0, 18000)}` })
    });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data.error?.message || "Помилка під час звернення до ШІ." });
    const output = (data.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
    if (task === "checkpoint") {
      const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      try { return res.json({ quiz: JSON.parse(cleaned) }); }
      catch { return res.json({ answer: "Не вдалося сформувати контрольне запитання. Спробуй ще раз." }); }
    }
    res.json({ answer: output || "Не вдалося отримати відповідь." });
  } catch { res.status(502).json({ error: "Не вдалося зв'язатися із сервісом ШІ." }); }
});

app.listen(PORT, () => console.log(`Урокум запущено на порту ${PORT}`));
