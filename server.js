import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
// Render runs Express behind an HTTPS reverse proxy; trust the last hop only.
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
await fs.mkdir(uploadDir, { recursive: true });

// Bound API requests so a single visitor cannot exhaust scarce free AI credits.
// This fixed-window counter is suitable for a single small Render instance.
// When hosting multiple instances use a shared rate-limit store (e.g. Redis).
const requestWindows=new Map();
function limitRequests(group,maxCount,windowMs){
 return (req,res,next)=>{
  const now=Date.now();
  const address=String(req.ip||req.socket?.remoteAddress||"anonymous");
  const key=group+"|"+address;
  let record=requestWindows.get(key);
  if(!record||now>=record.expires){
   record={count:0,expires:now+windowMs};requestWindows.set(key,record);
  }
  if(record.count>=maxCount){
   res.setHeader("Retry-After",String(Math.max(1,Math.ceil((record.expires-now)/1000))));
   return res.status(429).json({error:group==="ai"
    ?"Забагато запитів до ШІ. Спробуй трохи пізніше — читання й готові тести доступні."
    :"Забагато запитів. Спробуй пізніше."});
  }
  record.count++;
  if(requestWindows.size>4000){
   for(const [k,v] of requestWindows){if(v.expires<=now)requestWindows.delete(k)}
   if(requestWindows.size>4500)requestWindows.delete(requestWindows.keys().next().value);
  }
  next();
 };
}
// Private admin routes remain off until an admin secret is configured in Render.
// A header token is accepted only over HTTPS on hosted deployments.
function requireAdmin(req,res,next){
 const expected=process.env.UROKUM_ADMIN_TOKEN;
 const submitted=req.get("X-Urokum-Admin-Key");
 if(!expected||expected.length<24||typeof submitted!=="string"||
    Buffer.byteLength(expected)!==Buffer.byteLength(submitted)||
    !timingSafeEqual(Buffer.from(expected),Buffer.from(submitted))){
  return res.status(403).json({error:"Цю дію може виконувати лише адміністратор Урокуму."});
 }
 next();
}
const aiLimiter=limitRequests("ai",20,10*60*1000);
const uploadLimiter=limitRequests("admin",3,60*60*1000);

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
// The original textbook is fetched from its publisher or the official IMZO library
// and rendered by PDF.js, not embedded as text-only HTML. Cache in memory so page
// navigation stays fast and repeated requests don't burden the source servers.
const HISTORY11_PDF_SOURCES = [
  "https://www.ranok.com.ua/resources/IstUkr-stand-11kl_Gisem.pdf",
  "https://lib.imzo.gov.ua/wa-data/public/site/books2/pidruchnyky-11-klas-2019/04-istoriya-ukrainy-11-klas/istoriia-ukrainy-riven-standartu-pidruchnyk-dlia-11-klasu-zzso-o-v-gisem-o-o-martyniuk.pdf",
  "https://downloads.aunivers.no/ukraina/11.klasse_Historie_Ukrainsk_historie_%D0%86%D1%81%D1%82%D0%BE%D1%80%D1%96%D1%8F_%D0%A3%D0%BA%D1%80%D0%B0%D1%97%D0%BD%D0%B8.pdf"
];
let history11PdfPromise = null;
async function getHistory11Pdf() {
  if (!history11PdfPromise) {
    history11PdfPromise = (async () => {
      let lastError = new Error("No textbook source was reachable");
      for (const sourceURL of HISTORY11_PDF_SOURCES) {
        try {
          const response = await fetch(sourceURL, {
            headers: {"Accept":"application/pdf","User-Agent":"UrokumTextbookReader/1.0"},
            signal: AbortSignal.timeout(25000),
            redirect:"follow"
          });
          if (!response.ok) throw new Error("HTTP "+response.status);
          const length = Number(response.headers.get("content-length")||0);
          if (length > 25 * 1024 * 1024) throw new Error("Unexpected PDF size");
          const data = Buffer.from(await response.arrayBuffer());
          if (data.length < 500000 || data.length > 25*1024*1024 ||
              data.subarray(0,5).toString("ascii") !== "%PDF-")
            throw new Error("Response is not the textbook PDF");
          console.log("History 11 textbook source verified:", new URL(sourceURL).hostname, data.length, "bytes");
          return data;
        } catch (error) {
          lastError = error;
          console.warn("Textbook source not available:", new URL(sourceURL).hostname, error.message);
        }
      }
      throw lastError;
    })().catch(error => { history11PdfPromise = null; throw error; });
  }
  return history11PdfPromise;
}

// Ebook text is extracted on the server and delivered as ordinary HTML-friendly
// paragraphs. Visitors never need a PDF viewer or an uploaded PDF.
const historyOutline=JSON.parse(await fs.readFile(path.join(__dirname,"public/books/h11/outline.json"),"utf8"));
const historyPointMap=JSON.parse(await fs.readFile(path.join(__dirname,"public/books/h11/points.json"),"utf8")).paragraphs;
const historyParagraphs=[];
function listHistoryParagraphs(nodes){
 for(const n of nodes||[]){
  if(n.type==="paragraph")historyParagraphs.push(n);
  if(n.children)listHistoryParagraphs(n.children);
 }
}
listHistoryParagraphs(historyOutline.contents);
let historyEbookPdfPromise;
const historyEbookTextCache=new Map();
async function getHistoryEbookPDF(){
 if(!historyEbookPdfPromise)historyEbookPdfPromise=getHistory11Pdf().then(data=>
   pdfjsLib.getDocument({data:new Uint8Array(data),useSystemFonts:true,disableFontFace:true}).promise
 ).catch(error=>{historyEbookPdfPromise=null;throw error});
 return historyEbookPdfPromise;
}
function ebookClean(value){
 return String(value||"").replace(/[\u00ad\ufeff]/g,"").replace(/[\u0000-\u001f]/g,"")
   .replace(/\s+/g," ").trim();
}
function getHistoryEbookLines(page,items,from,to,pageNumber){
 const h=page.view[3],w=page.view[2],pieces=[];
 (items||[]).forEach((item,seq)=>{
  if(typeof item.str!=="string"||!/[А-Яа-яІіЇїЄєҐґA-Za-z]/u.test(item.str))return;
  const x=Number(item.transform?.[4]),y=h-Number(item.transform?.[5]);
  const width=Number(item.width||0),height=Math.abs(Number(item.height||0));
  if(![x,y,width,height].every(Number.isFinite)||width<=0||
    x<28||x>w-18||y<50||y>h-36||height<6.8||height>15.8)return;
  if(pageNumber===from.page&&y<from.y-11)return;
  if(to&&pageNumber===to.page&&y>=to.y-5)return;
  pieces.push({x,y,width,height,str:item.str,seq,chars:item.str.trim().length});
 });
 const rows=[];
 for(const piece of pieces){
  let row=rows.find(row=>Math.abs(row.y-piece.y)<2.7);
  if(!row){row={y:piece.y,parts:[]};rows.push(row)}
  row.parts.push(piece);
 }
 const body=[];
 for(const row of rows){
  const ordered=row.parts.sort((a,b)=>a.x-b.x),groups=[];
  let group=[],right=-Infinity;
  for(const piece of ordered){
   if(group.length && piece.x-right>12){groups.push(group);group=[]}
   group.push(piece);right=Math.max(right,piece.x+piece.width);
  }
  if(group.length)groups.push(group);
  for(const parts of groups){
   const count=parts.reduce((n,p)=>n+p.chars,0);
   const regular=parts.reduce((n,p)=>n+(p.height>=9.15&&p.height<=10.95?p.chars:0),0);
   const minX=Math.min(...parts.map(p=>p.x));
   const maxX=Math.max(...parts.map(p=>p.x+p.width));
   if(count<5||maxX-minX<18||regular<4||regular/count<.46)continue;
   const line=ebookClean(parts.map(p=>p.str).join(""));
   if(!line||/^(?:§\s*\d|РОЗДІЛ\s+\d)/iu.test(line))continue;
   body.push({str:line,x:minX,y:row.y,seq:Math.min(...parts.map(p=>p.seq))});
  }
 }
 // Preserve the publisher's text-stream sequence, including columns,
 // rather than mixing unrelated sidebars by their vertical position.
 return body.sort((a,b)=>a.seq-b.seq);
}
function historyEbookParagraphs(rows){
 const result=[];let current="",last=null,minX=null;
 const finish=()=>{
  const text=ebookClean(current);
  if(text.length>=8)result.push(text);
  current="";
 };
 for(const row of rows){
  const newPage=row.page!==last?.page;
  if(newPage)minX=null;
  minX=minX==null?row.x:Math.min(minX,row.x);
  const endsSentence=/[.!?;»)]$/.test(current.trim());
  const startsNew=last&&current.length>60&&(
    (newPage&&endsSentence)||
    (!newPage&&row.y-last.y>19)||
    (!newPage&&row.x-minX>17&&endsSentence)
  );
  if(startsNew)finish();
  const next=ebookClean(row.str);
  if(!next){last=row;continue}
  if(current){
   if(/[-\u2010]$/.test(current)&&/^[а-яіїєґ]/u.test(next))
    current=current.replace(/[-\u2010]$/u,"")+next;
   else current+=" "+next;
  }else current=next;
  last=row;
  if(current.length>850&&endsSentence)finish();
 }
 finish();
 return result;
}
// Try to recover printed side-column definitions rather than placing their
// small-font fragments unpredictably inside the main narrative.
function findHistoryGlossary(page,items,start,end,n){
 const w=page.view[2],h=page.view[3];
 const terms=[];
 const rows=[];
 (items||[]).forEach((item,seq)=>{
  const x=Number(item.transform?.[4]),y=h-Number(item.transform?.[5]);
  const size=Math.abs(Number(item.height||0));
  if(![x,y,size].every(Number.isFinite)||x<30||x>w-24||
    y<51||y>h-38||size<8.2||size>9.15||!ebookClean(item.str))return;
  if(n===start.page&&y<start.y-9)return;
  if(end&&n===end.page&&y>=end.y-5)return;
  const column=x<240?0:1;
  let row=rows.find(v=>v.col===column&&Math.abs(v.y-y)<2.1);
  if(!row){row={col:column,y,parts:[]};rows.push(row)}
  row.parts.push({x,str:item.str,seq});
 });
 rows.sort((a,b)=>a.col-b.col||a.y-b.y);
 const active={0:null,1:null};
 let lastY={0:null,1:null};
 for(const row of rows){
  row.parts.sort((a,b)=>a.x-b.x);
  const line=ebookClean(row.parts.map(x=>x.str).join(""));
  if(!line)continue;
  const match=line.match(/^(.{3,70}?)\s*[—–]\s+(.{7,})$/u);
  const looksLikeTerm=match&&match[1].length<=55&&!/[.!?]$/.test(match[1])&&
    !/^Із |^Зі |^На |^За /u.test(match[1]);
  const col=row.col;
  if(looksLikeTerm){
    const entry={term:match[1].trim(),definition:match[2].trim()};
    terms.push(entry);active[col]=entry;
    lastY[col]=row.y;continue;
  }
  if(active[col]&&lastY[col]!=null&&row.y-lastY[col]<=15.5 &&
    line.length<145&&!/^[•❖\u0017]/u.test(line)){
    const prev=active[col].definition;
    active[col].definition=/[-\u2010]$/.test(prev)&&/^[а-яіїєґ]/u.test(line)
      ?prev.replace(/[-\u2010]$/u,"")+line:prev+" "+line;
    lastY[col]=row.y;
  } else {active[col]=null;lastY[col]=null}
 }
 return terms.filter(x=>x.definition.length>=18);
}
function structuredHistoryBlocks(paragraphs,point,glossary){
 const blocks=[];
 const work=paragraphs.slice();
 if(work.length){
  const first=work[0];
  const match=first.match(/^\s*\d{1,2}\s+(.{4,160}?[.!?])\s+([А-ЯІЇЄҐ].{12,})/u);
  if(match){
   blocks.push({type:"heading",text:point+". "+match[1].trim()});
   work[0]=match[2];
  }else if(/^\s*\d{1,2}\s+[А-ЯІЇЄҐ]/u.test(first)){
   const split=first.search(/[.!?]\s+[А-ЯІЇЄҐ]/u);
   if(split>=0){
     blocks.push({type:"heading",text:first.slice(0,split+1).trim()});
     work[0]=first.slice(split+2).trim();
   }else blocks.push({type:"heading",text:"Пункт "+point});
  }else blocks.push({type:"heading",text:"Пункт "+point});
 }
 for(const paragraph of work){
  if(!paragraph?.trim())continue;
  const closing=paragraph.match(/^Висновки[.:\s]+(.+)/isu);
  if(closing){blocks.push({type:"conclusion",title:"Висновки",text:closing[1].trim()});continue}
  if(/^[•●▪\u0017]\s*/u.test(paragraph)){
   const last=blocks[blocks.length-1];
   if(last?.type==="list")last.items.push(paragraph.replace(/^[•●▪\u0017]\s*/u,""));
   else blocks.push({type:"list",items:[paragraph.replace(/^[•●▪\u0017]\s*/u,"")]});
   continue;
  }
  blocks.push({type:"text",text:paragraph});
 }
 const distinct=new Map();
 for(const term of glossary){
  const key=term.term.toLocaleLowerCase("uk");
  if(!distinct.has(key))distinct.set(key,term);
 }
 if(distinct.size)blocks.push({type:"terms",title:"Словничок до пункту",entries:[...distinct.values()]});
 return blocks;
}
async function getHistoryEbookPoint(paraIndex,pointIndex){
 const lesson=historyParagraphs[paraIndex];
 if(!lesson)throw new Error("Unknown lesson");
 const points=historyPointMap[lesson.id]||[];
 if(!points[pointIndex])throw new Error("Unknown teaching point");
 // §1 and §2 use editorially structured text rather than rough PDF extraction.
 // §2: [ ] = interesting facts, < > = historical sources, " " = tables.
 if(paraIndex===0||paraIndex===1){
  const basename=paraIndex===0?"intro-point-":"paragraph-2-point-";
  const file=path.join(__dirname,"public","books","h11",
    basename+String(pointIndex+1)+".json");
  const data=JSON.parse(await fs.readFile(file,"utf8"));
  const paragraphs=[];
  const textParts=[];
  for(const block of data.blocks||[]){
   if(block.type==="text"){
    paragraphs.push(block.text);
    textParts.push(block.text);
   } else if(block.type==="heading"||block.type==="conclusion"){
    textParts.push(block.text||"");
   } else if(block.type==="list"){
    textParts.push(...(block.items||[]));
   } else if(block.type==="terms"){
    textParts.push(...(block.entries||[]).map(x=>x.term+": "+x.definition));
   } else if(block.type==="source"||block.type==="note"){
    textParts.push(block.text||"");
   } else if(block.type==="table"){
    for(const row of block.rows||[])textParts.push(row.join(" | "));
   } else if(block.type==="chart"){
    textParts.push(...(block.series||[]).map(x=>x.name+": "+x.percent+"%"));
   }
  }
  return {
   id:lesson.id,title:lesson.title,point:pointIndex+1,
   pointCount:points.length,pages:data.pages,
   paragraphs,blocks:data.blocks,text:textParts.filter(Boolean).join("\n\n")
  };
 }
 const cacheKey=lesson.id+":"+pointIndex;
 if(!historyEbookTextCache.has(cacheKey)){
  const promise=(async()=>{
   const document=await getHistoryEbookPDF();
   const start=points[pointIndex],next=points[pointIndex+1]||null;
   const finalPage=next?next.page:lesson.endPage;
   const rows=[],glossary=[];
   for(let n=start.page;n<=finalPage;n++){
    const page=await document.getPage(n),content=await page.getTextContent();
    for(const line of getHistoryEbookLines(page,content.items,start,next,n))rows.push({...line,page:n});
    glossary.push(...findHistoryGlossary(page,content.items,start,next,n));
   }
   const paragraphs=historyEbookParagraphs(rows);
   if(!paragraphs.length)throw new Error("No electronic text detected");
   const blocks=structuredHistoryBlocks(paragraphs,pointIndex+1,glossary);
   const text=blocks.map(b=>b.type==="terms"?b.entries.map(e=>e.term+": "+e.definition).join("\n"):b.text||"").filter(Boolean).join("\n\n");
   return {id:lesson.id,title:lesson.title,point:pointIndex+1,pointCount:points.length,
     pages:[start.page,finalPage],paragraphs,blocks,text};
  })().catch(error=>{historyEbookTextCache.delete(cacheKey);throw error});
  historyEbookTextCache.set(cacheKey,promise);
 }
 return historyEbookTextCache.get(cacheKey);
}
app.get("/api/ebook/history11-gisem-stand/:paragraph/:point",async(req,res)=>{
 const para=Number(req.params.paragraph),point=Number(req.params.point);
 if(!Number.isInteger(para)||para<1||para>historyParagraphs.length||
    !Number.isInteger(point)||point<1||point>20)
  return res.status(400).json({error:"Некоректний параграф або пункт"});
 try{
  const data=await getHistoryEbookPoint(para-1,point-1);
  res.setHeader("Cache-Control","public, max-age=3600");
  res.json(data);
 }catch(error){
  console.error("Ebook extraction failed",error.message);
  res.status(503).json({error:"Не вдалося завантажити електронний текст. Онови сторінку та спробуй ще раз."});
 }
});

app.use("/vendor/pdfjs", express.static(path.join(__dirname,"node_modules/pdfjs-dist/build")));
app.get("/api/printed-book/history11-gisem-stand.pdf", async (req,res) => {
  try {
    const data = await getHistory11Pdf();
    const size = data.length;
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Accept-Ranges","bytes");
    res.setHeader("Cache-Control","public, max-age=86400");
    res.setHeader("Content-Disposition","inline");
    const match = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range||"");
    if (req.headers.range && !match) {
      res.setHeader("Content-Range", "bytes */"+size);
      return res.status(416).end();
    }
    if (match) {
      const first = Number(match[1]);
      const last = match[2] ? Number(match[2]) : size-1;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
          first >= size || last < first) {
        res.setHeader("Content-Range", "bytes */"+size);
        return res.status(416).end();
      }
      const actualLast = Math.min(last, size-1);
      const chunk = data.subarray(first, actualLast+1);
      res.status(206);
      res.setHeader("Content-Range", "bytes "+first+"-"+actualLast+"/"+size);
      res.setHeader("Content-Length", chunk.length);
      return res.end(chunk);
    }
    res.setHeader("Content-Length", size);
    return res.end(data);
  } catch (error) {
    console.error("Textbook PDF load failed", error);
    if (!res.headersSent)
      res.status(503).json({error:"Книга тимчасово недоступна. Не вдалося отримати файл від офіційних джерел."});
  }
});
app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Урокум" }));
app.get("/api/ai-status", (_req, res) => {
 const provider=process.env.GEMINI_API_KEY?"gemini":process.env.GROQ_API_KEY?"groq":
  process.env.OPENROUTER_API_KEY?"openrouter":
  (process.env.ALLOW_PAID_AI==="true"&&process.env.OPENAI_API_KEY?"openai":null);
 res.json({configured:Boolean(provider),provider});
});

app.post("/api/upload", requireAdmin, uploadLimiter, upload.single("pdf"), async (req, res) => {
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

app.put("/api/book/:id/outline", requireAdmin, uploadLimiter, async (req, res) => {
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

// Save generated textbook questions in memory, so repeat views do not
// consume scarce free-tier requests. Never cache students' written answers.
const textbookQuizCache=new Map();
app.post("/api/tutor", aiLimiter, async (req, res) => {
  const { text, task, question, retelling, studentAnswer, referenceAnswer } = req.body || {};
  if (task === "ask-question" && (typeof question !== "string" || question.trim().length < 3 || question.length > 500)) return res.status(400).json({error:"Напиши коротке запитання до прочитаного пункту."});
  if (task === "assess-retelling" && (typeof retelling !== "string" || retelling.trim().length < 30 || retelling.length > 2500)) return res.status(400).json({error:"Напиши переказ хоча б у кількох реченнях (до 2500 символів)."});
  if (task === "check-open" && (
    typeof question !== "string" || question.length < 5 || question.length > 500 ||
    typeof studentAnswer !== "string" || studentAnswer.trim().length < 5 || studentAnswer.length > 1800 ||
    typeof referenceAnswer !== "string" || referenceAnswer.length < 5 || referenceAnswer.length > 2000
  )) return res.status(400).json({ error: "Напиши відповідь своїми словами, щоб ШІ міг її перевірити." });
  if (!text) return res.status(400).json({ error: "Немає тексту сторінки." });
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY && !(process.env.ALLOW_PAID_AI==="true" && process.env.OPENAI_API_KEY)) return res.status(503).json({error:"Безкоштовний ШІ зараз не налаштований. Читання та пропуск перевірки доступні."});
  const prompt = task === "check-open"
    ? 'Ти уважний учитель історії. Перевір зміст письмової відповіді учня за матеріалом підручника. Враховуй синоніми, не вимагай дослівного збігу. Статус passed=true дозволений ЛИШЕ якщо відповідь фактично правильна і відповідає на поставлене запитання; якщо відповідь неповна, хибна чи не по темі — passed=false. Поверни ВИКЛЮЧНО валідний JSON без markdown: {"passed":true,"feedback":"Коротке пояснення українською: що добре і що варто уточнити (2–4 речення)."} Запитання: '+question.trim().slice(0,500)+'\\nВідповідь учня: '+studentAnswer.trim().slice(0,1800)+'\\nОрієнтовна відповідь: '+referenceAnswer.trim().slice(0,2000)

    : task === "paragraph-review"
    ? "Створи підсумкову САМОСТІЙНУ РОБОТУ з РІВНО 12 різних запитань українською за ВСІМ параграфом. Перевіряй найважливіші події, дати, причини та наслідки, історичних діячів і поняття. Розподіляй запитання між різними пунктами параграфа. ПЕРШІ 9 запитань — тестові (тип choice) з чотирма варіантами, ОСТАННІ 3 — письмові (тип open) на пояснення власними словами. КОЖНЕ запитання ОБОВ’ЯЗКОВО має поле \"sourceQuote\": дослівний безперервний уривок 8–18 слів із наданого тексту, що містить підказку або підтверджує правильну відповідь. Копіюй БЕЗ ЗМІН, не вигадуй та не змішуй різні пункти. Поверни виключно валідний JSON без markdown: {\"questions\":[{\"type\":\"choice\",\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":0,\"explanation\":\"...\",\"sourceQuote\":\"дослівний уривок\"},{\"type\":\"open\",\"question\":\"...\",\"referenceAnswer\":\"коротка змістовна відповідь за текстом\",\"sourceQuote\":\"дослівний уривок\"}]}. ОБОВ’ЯЗКОВО рівно 12 об’єктів: індекси 0–8 choice із correct 0..3, індекси 9–11 open з referenceAnswer; кожне запитання унікальне."
    : task === "assess-retelling"
    ? "Ти доброзичливий учитель. Оціни переказ параграфа за наданим текстом. Спочатку відзнач 2 конкретні сильні сторони, потім 2 важливі пропущені чи переплутані факти (якщо є), а вкінці запропонуй один крок, як покращити переказ. Без вигаданих фактів і без оцінки балами. Переказ учня: " + retelling.trim().slice(0,2500)
    : task === "ask-question"
    ? "Ти уважний учитель історії. Відповідай українською зрозуміло і по суті, спираючись на текст цього пункту. Пояснюй незнайомі поняття й причинно-наслідкові зв’язки. Якщо в пункті немає достатньо відомостей, чесно зазнач це, а не вигадуй. Запитання учня: " + question.trim().slice(0,500)
    : task === "multi-checkpoint"
    ? "Створи РІВНО 5 запитань українською ТІЛЬКИ за прочитаним пунктом підручника. ПЕРШІ ЧОТИРИ — тести з чотирма варіантами (тип choice), П’ЯТЕ — письмове відкрите (тип open), яке потребує пояснення причин, наслідків або власними словами. Не вигадуй фактів. КОЖНЕ запитання ОБОВ’ЯЗКОВО повинно мати поле \"sourceQuote\": дослівний безперервний уривок 8–18 слів із наданого тексту, який підтверджує правильну відповідь. Скопіюй його БУКВАЛЬНО, з одного абзацу, не перефразовуй, не вигадуй і не змінюй слова. Поверни виключно валідний JSON без markdown: {\"questions\":[{\"type\":\"choice\",\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":0,\"explanation\":\"...\",\"sourceQuote\":\"дослівний уривок із тексту\"},{\"type\":\"choice\",\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":1,\"explanation\":\"...\",\"sourceQuote\":\"...\"},{\"type\":\"choice\",\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":2,\"explanation\":\"...\",\"sourceQuote\":\"...\"},{\"type\":\"choice\",\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":3,\"explanation\":\"...\",\"sourceQuote\":\"...\"},{\"type\":\"open\",\"question\":\"...\",\"referenceAnswer\":\"коротка змістовна орієнтовна відповідь за текстом\",\"sourceQuote\":\"...\"}]}. РІВНО 4 тестових, потім 1 письмове."
    : task === "test"
    ? "Створи 5 тестових запитань українською за фрагментом. Для кожного дай 4 варіанти (А, Б, В, Г), вкажи правильну відповідь і коротке пояснення. Не додавай фактів поза текстом."
    : task === "checkpoint"
      ? "Створи ОДНЕ контрольне запитання для паузи під час читання. Поверни ЛИШЕ валідний JSON без markdown у форматі: {\"question\":\"...\",\"options\":[\"...\",\"...\",\"...\",\"...\"],\"correct\":0,\"explanation\":\"...\"}. correct — індекс правильної відповіді від 0 до 3. Усе має перевіряти знання саме з цього тексту."
      : "Поясни цей фрагмент підручника простою українською для школяра. Виділи головне та поясни складні слова.";
  try {
    // Never silently spend paid API credits. Paid OpenAI is opt-in only.
    const input=prompt+"\n\nТекст підручника:\n"+String(text).slice(0,15000);
    const cacheable=task==="multi-checkpoint"||task==="paragraph-review";
    const cacheKey=cacheable?createHash("sha256").update(task+"|"+input).digest("hex"):null;
    if(cacheKey){
      const cached=textbookQuizCache.get(cacheKey);
      if(cached&&cached.expires>Date.now())return res.json(cached.response);
      if(cached)textbookQuizCache.delete(cacheKey);
    }
    const providers=[];
    if(process.env.GEMINI_API_KEY)providers.push("gemini");
    if(process.env.GROQ_API_KEY)providers.push("groq");
    if(process.env.OPENROUTER_API_KEY)providers.push("openrouter");
    if(!providers.length && process.env.ALLOW_PAID_AI==="true" && process.env.OPENAI_API_KEY)providers.push("openai");
    let output="",lastStatus=503,usedProvider="";
    for(const provider of providers){
      let response,answer;
      try{
        if(provider==="gemini"){
          const model=process.env.GEMINI_MODEL||"gemini-2.5-flash-lite";
          response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+":generateContent",{
            method:"POST",headers:{"x-goog-api-key":process.env.GEMINI_API_KEY,"Content-Type":"application/json"},
            signal:AbortSignal.timeout(11500),
            body:JSON.stringify({
              contents:[{role:"user",parts:[{text:input}]}],
              generationConfig:{temperature:0.25,maxOutputTokens:6000}
            })
          });
          answer=await response.json();
          if(response.ok)output=(answer.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join("\n");
        }else if(provider==="groq"||provider==="openrouter"){
          const isGroq=provider==="groq";
          response=await fetch(isGroq?"https://api.groq.com/openai/v1/chat/completions":"https://openrouter.ai/api/v1/chat/completions",{
            method:"POST",headers:{
              "Authorization":"Bearer "+(isGroq?process.env.GROQ_API_KEY:process.env.OPENROUTER_API_KEY),
              "Content-Type":"application/json"
            },
            signal:AbortSignal.timeout(11500),
            body:JSON.stringify({
              model:isGroq?(process.env.GROQ_MODEL||"openai/gpt-oss-20b"):(process.env.OPENROUTER_MODEL||"openrouter/free"),
              messages:[
                {role:"system",content:"Ти український освітній асистент. Пояснюй лише на основі наданого навчального тексту, без вигаданих фактів."},
                {role:"user",content:input}
              ],temperature:0.25,max_completion_tokens:6000
            })
          });
          answer=await response.json();
          if(response.ok)output=answer.choices?.[0]?.message?.content||"";
        }else{
          response=await fetch("https://api.openai.com/v1/responses",{
            method:"POST",headers:{"Authorization":"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},
            signal:AbortSignal.timeout(11500),
            body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-4.1-mini",input})
          });
          answer=await response.json();
          if(response.ok)output=(answer.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==="output_text").map(x=>x.text).join("\n");
        }
        lastStatus=response.status;
        if(response.ok&&output.trim()){usedProvider=provider;break}
        console.warn("AI provider unavailable",provider,response.status);
        output="";
      }catch(error){
        console.warn("AI provider error",provider,error.name||"unknown");
      }
    }
    if(!usedProvider){
      const friendly=lastStatus===429
        ?"Безкоштовний ліміт ШІ вичерпаний. Можеш пропустити перевірку або повернутися пізніше."
        :"Безкоштовний ШІ тимчасово недоступний. Читання й пропуск перевірки працюють.";
      return res.status(lastStatus===429?429:503).json({error:friendly});
    }
    if (task === "multi-checkpoint" || task === "checkpoint" || task === "paragraph-review") {
      const cleaned=output.replace(/^\`\`\`(?:json)?\s*/i,"").replace(/\`\`\`\s*$/i,"").trim();
      try{
        const parsed=JSON.parse(cleaned);
        if(task==="checkpoint")return res.json({quiz:parsed});
        const qs=parsed.questions;
        if(!Array.isArray(qs)||qs.length!==(task==="paragraph-review"?12:5)||qs.some((q,i)=>{
          if(!q || typeof q.question!=="string" || q.question.trim().length<5)return true;
          if((task==="multi-checkpoint" && i>=4) || (task==="paragraph-review" && i>=9)){
            return q.type!=="open" || typeof q.referenceAnswer!=="string" || q.referenceAnswer.trim().length<8;
          }
          return !Array.isArray(q.options) || q.options.length!==4 ||
            q.options.some(x=>typeof x!=="string") || !Number.isInteger(q.correct) || q.correct<0 || q.correct>3;
        }))
          throw Error("Wrong quiz structure");
        // Treat model output as untrusted: only keep exact source excerpts.
        const normalizedEvidence=value=>String(value||"").toLocaleLowerCase("uk").replace(/[^\p{L}\p{N}]+/gu," ").trim();
        const sourcePassages=String(text).slice(0,15000).split(/\n{2,}/u).map(normalizedEvidence);
        for(const item of qs){
          const quote=typeof item.sourceQuote==="string"?item.sourceQuote.trim().slice(0,250):"";
          const normalized=normalizedEvidence(quote);
          if(normalized.length>=24 && normalized.split(" ").length>=4 && sourcePassages.some(p=>p.includes(normalized)))
            item.sourceQuote=quote;
          else delete item.sourceQuote;
        }
        const result={questions:qs};
        if(cacheKey){if(textbookQuizCache.size>200)textbookQuizCache.delete(textbookQuizCache.keys().next().value);
          textbookQuizCache.set(cacheKey,{expires:Date.now()+24*3600_000,response:result});}
        return res.json(result);
      }catch(error){
        console.warn("AI quiz JSON invalid",error.message);
        return res.status(502).json({error:"ШІ не повернув потрібну кількість коректних запитань. Спробуй ще раз."});
      }
    }
    if(task==="check-open"){
      const cleaned=output.replace(/^```(?:json)?\s*/i,"").replace(/```\s*$/i,"").trim();
      try{
        const result=JSON.parse(cleaned);
        if(typeof result.passed==="boolean" && typeof result.feedback==="string" && result.feedback.trim()){
          return res.json({passed:result.passed,answer:result.feedback.trim()});
        }
      }catch{/* The AI may answer in prose instead of JSON. */}
      return res.json({passed:null,answer:output||"Відповідь збережена, але перевірку ШІ не вдалося завершити."});
    }
    res.json({ answer: output || "Не вдалося отримати відповідь." });
  } catch { res.status(502).json({ error: "Не вдалося зв'язатися із сервісом ШІ." }); }
});

app.listen(PORT, () => console.log(`Урокум запущено на порту ${PORT}`));
