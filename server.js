import express from "express";
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
  const found = [];
  const patterns = [
    { type: "chapter", re: /^\s*(?:РОЗДІЛ|РОЗДІЛИ|ТЕМА)\s+(?:[IVXLC]+|\d+)?\s*[:.№—–-]?\s*\S.{2,100}$/i },
    { type: "paragraph", re: /^\s*§\s*\d+[\w.-]*\s*[.—–:-]?\s*.{2,120}$/i },
    { type: "paragraph", re: /^\s*ПАРАГРАФ\s+\d+[\w.-]*\s*[.—–:-]?\s*.{2,120}$/i }
  ];
  for (const page of pages) {
    const lines = page.text.split("\n").map(x => x.trim()).filter(Boolean);
    for (const line of lines) {
      const match = patterns.find(p => p.re.test(line));
      if (!match) continue;
      const title = line.replace(/\s+/g, " ").slice(0, 150);
      if (found.some(x => x.title.toLocaleLowerCase() === title.toLocaleLowerCase())) continue;
      found.push({ title, page: page.number, endPage: page.number, kind: match.type, children: [] });
    }
  }
  found.sort((a,b) => a.page-b.page);
  for (let i=0;i<found.length;i++) found[i].endPage = Math.max(found[i].page, (found[i+1]?.page || pages.length+1)-1);
  const chapters = found.filter(x => x.kind === "chapter");
  const paragraphs = found.filter(x => x.kind === "paragraph");
  if (!chapters.length) return paragraphs;
  for (const p of paragraphs) {
    const parent = [...chapters].reverse().find(c => c.page <= p.page);
    if (parent) { p.endPage = Math.min(p.endPage, parent.endPage || pages.length); parent.children.push(p); }
  }
  return chapters;
}

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
    let outline = await readOutline(pdf);
    if (!outline.length) outline = inferOutline(pages);
    else outline = assignPageRanges(outline, pdf.numPages);
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
