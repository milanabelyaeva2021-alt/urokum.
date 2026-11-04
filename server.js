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

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Урокум" }));

app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Завантаж PDF-файл." });
  try {
    const data = new Uint8Array(await fs.readFile(req.file.path));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map(x => x.str).join(" ").replace(/\s+/g, " ").trim();
      pages.push({ number: n, text });
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const record = { id, name: req.file.originalname, pageCount: pdf.numPages, pages };
    await fs.writeFile(path.join(uploadDir, `${id}.json`), JSON.stringify(record), "utf8");
    await fs.unlink(req.file.path).catch(() => {});
    res.json({ id, name: record.name, pageCount: record.pageCount, pages: pages.map(p => ({ number: p.number, preview: p.text.slice(0, 180) })) });
  } catch (e) {
    await fs.unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: "Не вдалося прочитати PDF. Якщо це скан, потрібне OCR-розпізнавання." });
  }
});

app.get("/api/book/:id/page/:number", async (req, res) => {
  try {
    const book = JSON.parse(await fs.readFile(path.join(uploadDir, `${req.params.id}.json`), "utf8"));
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
    ? "Створи 5 запитань тесту українською за цим фрагментом. Дай варіанти відповідей і правильні відповіді наприкінці."
    : "Поясни цей фрагмент підручника простою українською для школяра. Виділи головне та поясни складні слова.";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: `${prompt}\n\nТекст підручника:\n${text.slice(0, 18000)}`
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data.error?.message || "Помилка під час звернення до ШІ." });
    const output = (data.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
    res.json({ answer: output || "Не вдалося отримати відповідь." });
  } catch {
    res.status(502).json({ error: "Не вдалося зв'язатися із сервісом ШІ." });
  }
});

app.listen(PORT, () => console.log(`Урокум запущено на порту ${PORT}`));
