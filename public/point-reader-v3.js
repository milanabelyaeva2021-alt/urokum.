import * as pdfjs from "/vendor/pdfjs/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc="/vendor/pdfjs/pdf.worker.mjs";

const $=id=>document.getElementById(id);
const BOOK_ID="history11-gisem-stand";
const PDF_URL="/api/printed-book/history11-gisem-stand.pdf";
const PROGRESS_KEY="urokum:learning-progress:"+BOOK_ID;
const COMPLETED_KEY="urokum:completed-points:"+BOOK_ID;
const REVIEWED_KEY="urokum:reviewed-paragraphs:"+BOOK_ID;
const OLD_PROGRESS_KEY="urokum-page:"+BOOK_ID;
let lessons=[],pointMap={},pdf=null,lessonIndex=0,pointIndex=0,pageNo=5;
let generation=0,quizzing=false,answered=false,isSelectionQuiz=false,storedText="";
let readingTask=null,questionCache=new Map(),currentItems=[],pageScale=1,fullTextCache=new Map(),paragraphTextCache=new Map(),completedPoints=new Set(),completedReviews=new Set(),pdfLoadVersion=0;
const fallbackFirstPoint=[
 {question:"Який період історії України вивчають у цьому підручнику?",options:["Період Київської Русі","Другий період Новітньої історії України","Стародавню історію України","Історію Галицько-Волинської держави"],correct:1,explanation:"Вступ охоплює події з 1945 року до початку XXI століття."},
 {question:"Для чого історики використовують періодизацію?",options:["Щоб поділити історичний розвиток на етапи","Щоб запам’ятати імена всіх правителів","Щоб замінити історичні джерела","Щоб не досліджувати минуле"],correct:0,explanation:"Історичні періоди допомагають упорядкувати політичні, соціальні й культурні зміни."},
 {question:"Який період Новітньої історії України передував періоду після 1945 року?",options:["1914—1945 роки","XVI—XVIII століття","Середньовіччя","Лише 1991 рік"],correct:0,explanation:"У таблиці подано перший період Новітньої історії — 1914—1945 роки."},
 {question:"Яка подія пов’язана з початком другого періоду Новітньої історії?",options:["Завершення Другої світової війни","Утворення Київської Русі","Люблінська унія","Початок Першої світової війни"],correct:0,explanation:"У підручнику другий період Новітньої історії починається з 1945 року."}
];
const style=document.createElement("style");
style.textContent=
 '#pdfText span,#pdfText br{user-select:text;color:transparent;cursor:text}' +
 '#pdfText span.read-focus{background:transparent!important;box-shadow:none!important;mix-blend-mode:normal!important}' +
 '#pdfText ::selection{background:rgba(110,71,207,.55)}' +
 '.q-option{display:block;width:100%;text-align:left;padding:12px;margin:9px 0;line-height:1.4}' +
 '.q-option.selected{border-color:#764da8;background:#eee5fa}' +
 '.q-option.correct{border-color:#41865c;background:#e4f4e8}' +
 '.q-option.wrong{border-color:#b85763;background:#fae9ec}' +
 '.q-progress{color:#70548c;font-size:13px;font-weight:650}' +
 '.q-feedback{font-size:14px;line-height:1.5;margin:12px 0}' +
 '.q-prompt{line-height:1.6;font-size:16px}' +
 '.bookStatus{font-size:13px;color:#765f8c;line-height:1.5}' +
 '[hidden]{display:none!important}';
document.head.append(style);
const readerLink="/?grade=11&subject="+encodeURIComponent("Історія України");
document.querySelector(".top a").href=readerLink;
$("exitFull").onclick=()=>toggleFull(false);
function toggleFull(on){
 document.body.classList.toggle("full",!!on);
 $("fullscreen").textContent=on?"Вийти з повного екрана":"⛶ Повний екран";
 if(on&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(()=>{});
 else if(!on&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});
}
window.toggleFull=toggleFull;
$("fullscreen").onclick=()=>toggleFull(!document.body.classList.contains("full"));
document.addEventListener("fullscreenchange",()=>{
 if(!document.fullscreenElement){document.body.classList.remove("full");$("fullscreen").textContent="⛶ Повний екран";}
});
function flatten(items){
 for(const item of items||[]){
  if(item.type==="paragraph")lessons.push(item);
  if(item.children)flatten(item.children);
 }
}
function renderContents(items){
 const root=$("toc");root.replaceChildren();
 function append(list){
  for(const item of list||[]){
   if(item.type==="chapter"){
    const d=document.createElement("div");d.className="chapter";
    d.textContent=item.title;
    const small=document.createElement("small");small.textContent="Стор. "+item.startPage+"–"+item.endPage;
    d.append(small);root.append(d);
   }
   if(item.type==="paragraph"){
    const button=document.createElement("button");button.className="para";button.dataset.id=item.id;
    button.textContent=item.title;
    const sm=document.createElement("small");sm.textContent="Стор. "+item.startPage+"–"+item.endPage;
    button.append(sm);button.onclick=()=>{
      const i=lessons.findIndex(lesson=>lesson.id===item.id);
      if(i<0)return;lessonIndex=i;pointIndex=0;pageNo=item.startPage;
      saveProgress();renderPage();
    };
    root.append(button);
   }
   if(item.children)append(item.children);
  }
 }
 append(items);
}
function pointStarts(){return pointMap[lessons[lessonIndex]?.id]||[];}
function pointStart(){return pointStarts()[pointIndex]||{number:1,page:lessons[lessonIndex].startPage,y:40,x:40};}
function pointNext(){return pointStarts()[pointIndex+1]||null;}
function pointLastPage(){const n=pointNext();return n?n.page:lessons[lessonIndex].endPage;}
function atPointEnd(){return pageNo>=pointLastPage();}
function comparePageRange(page,y,start,end){
 if(page<start.page)return false;
 if(end&&page>end.page)return false;
 if(page===start.page&&y<start.y-11)return false;
 if(end&&page===end.page&&y>=end.y-5)return false;
 return true;
}
function pointKey(){return lessons[lessonIndex]?.id+":"+pointIndex;}
function saveCompleted(){try{localStorage.setItem(COMPLETED_KEY,JSON.stringify([...completedPoints]));localStorage.setItem(REVIEWED_KEY,JSON.stringify([...completedReviews]))}catch{}}
function saveProgress(){
 try{
  const data={lesson:lessons[lessonIndex].id,point:pointIndex,page:pageNo,updatedAt:Date.now()};
  localStorage.setItem(PROGRESS_KEY,JSON.stringify(data));
  localStorage.setItem(OLD_PROGRESS_KEY,JSON.stringify({id:data.lesson,page:data.page}));
  localStorage.setItem("urokum:last-selection",JSON.stringify({grade:11,subject:"Історія України",screen:"books"}));
 }catch{}
}
function restoreProgress(){
 try{const done=JSON.parse(localStorage.getItem(COMPLETED_KEY)||"[]");if(Array.isArray(done))completedPoints=new Set(done.filter(x=>typeof x==="string"))}catch{}
 try{const done=JSON.parse(localStorage.getItem(REVIEWED_KEY)||"[]");if(Array.isArray(done))completedReviews=new Set(done.filter(x=>typeof x==="string"))}catch{}
 try{
  const v=JSON.parse(localStorage.getItem(PROGRESS_KEY)||"null");
  if(v){
   const i=lessons.findIndex(x=>x.id===v.lesson);
   if(i>=0){
    lessonIndex=i;pointIndex=Math.max(0,Math.min(pointStarts().length-1,Number(v.point)||0));
    const start=pointStart();pageNo=Math.max(lessons[lessonIndex].startPage,Math.min(pointLastPage(),Number(v.page)||start.page));
    return;
   }
  }
  const old=JSON.parse(localStorage.getItem(OLD_PROGRESS_KEY)||"null");
  if(old){
   const i=lessons.findIndex(x=>x.id===old.id);
   if(i>=0){lessonIndex=i;const p=Number(old.page)||lessons[i].startPage;
    const points=pointStarts();pointIndex=points.reduce((idx,start,j)=>start.page<=p?j:idx,0);
    pageNo=Math.max(lessons[lessonIndex].startPage,Math.min(pointLastPage(),p));}
  }
 }catch(error){console.warn("Cannot restore reading progress",error)}
}
function cachedBookDatabase(){
 return new Promise((resolve,reject)=>{
  if(!("indexedDB" in window))return reject(Error("Немає IndexedDB"));
  const req=indexedDB.open("urokum-saved-pdfs",1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains("books"))req.result.createObjectStore("books");};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
}
async function getCached(){
 try{
  const db=await cachedBookDatabase();
  const value=await new Promise((resolve,reject)=>{
   const req=db.transaction("books","readonly").objectStore("books").get("hisem11");
   req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
  });db.close();return value;
 }catch{return null}
}
async function putCached(buffer){
 try{
  const db=await cachedBookDatabase();
  await new Promise((resolve,reject)=>{
   const tx=db.transaction("books","readwrite");
   tx.objectStore("books").put(buffer,"hisem11");
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });db.close();
 }catch(e){console.warn("Cannot cache PDF in browser",e)}
}
async function loadBytes(data,store){
 const version=++pdfLoadVersion;
 const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
 const doc=await pdfjs.getDocument({data:bytes.slice()}).promise;
 if(doc.numPages!==288){await doc.destroy();throw Error("Потрібна книга Гісема на 288 сторінок.");}
 if(version!==pdfLoadVersion){await doc.destroy();return}
 if(pdf)await pdf.destroy().catch(()=>{});
 pdf=doc;$("pdfRecovery").hidden=true;if(store)await putCached(bytes.buffer);
 $("message").hidden=true;$("app").hidden=false;
 await renderPage();
}
$("localPdf").addEventListener("change",async()=>{
 const f=$("localPdf").files?.[0];if(!f)return;
 $("paperStatus").textContent="Відкриваю файл із твого комп’ютера…";$("paperStatus").hidden=false;
 try{await loadBytes(new Uint8Array(await f.arrayBuffer()),true)}
 catch(e){$("paperStatus").textContent="Помилка: "+e.message;}
});
// PDF.js may split a printed line into many differently styled fragments.
// Select whole body-text lines instead of checking each word's font size;
// this keeps bold/italic words while excluding captions and smaller glossary text.
function lessonLineSegments(page,items,start,end){
 const width=page.view[2],height=page.view[3];
 const candidates=[];
 for(const item of items||[]){
  if(typeof item.str!=="string"||!/[А-Яа-яІіЇїЄєҐґA-Za-z]/u.test(item.str))continue;
  const x=Number(item.transform?.[4]), y=height-Number(item.transform?.[5]);
  const w=Number(item.width||0), size=Math.abs(Number(item.height)||0);
  if(![x,y,w,size].every(Number.isFinite)||x<28||x>width-18||w<=0||size<6.7||size>15.8||y<51||y>height-36)continue;
  if(!comparePageRange(page.pageNumber,y,start,end))continue;
  if(/^\s*(?:§\s*\d|Розділ\s+(?:\d|[IVX]))\b/iu.test(item.str))continue;
  candidates.push({x,y,width:w,size,item,chars:item.str.trim().length});
 }
 candidates.sort((a,b)=>a.y-b.y||a.x-b.x);
 const lines=[];
 for(const piece of candidates){
  let line=lines.find(row=>Math.abs(row.y-piece.y)<=2.7);
  if(!line){line={y:piece.y,items:[]};lines.push(line)}
  line.items.push(piece);
 }
 const result=[];
 for(const row of lines){
  row.items.sort((a,b)=>a.x-b.x);
  const segments=[];let current=[],right=-Infinity;
  for(const piece of row.items){
   // The wide gap between a glossary or picture caption and the
   // main column is a genuine region boundary, not a word space.
   if(current.length && piece.x-right>18){segments.push(current);current=[]}
   current.push(piece);right=Math.max(right,piece.x+piece.width);
  }
  if(current.length)segments.push(current);
  for(const segment of segments){
   const chars=segment.reduce((n,x)=>n+x.chars,0);
   const bodyChars=segment.reduce((n,x)=>
     n+(x.size>=9.1&&x.size<=10.9?x.chars:0),0);
   const minX=Math.min(...segment.map(x=>x.x));
   const maxX=Math.max(...segment.map(x=>x.x+x.width));
   // Evaluate the line as a whole. When the majority of its text has
   // body typography, also include any bold / italic pieces on that line.
   if(chars<5||maxX-minX<19||bodyChars<5||bodyChars/chars<.48)continue;
   result.push({y:row.y,parts:segment,x:minX,right:maxX,
     height:Math.max(...segment.map(x=>x.size))});
  }
 }
 return result;
}
function collectPointText(page,items,start,end){
 return lessonLineSegments(page,items,start,end).map(row=>
  row.parts.map(part=>part.item.str.trim()).join(" ")
 ).join(" ");
}
async function pointText(){
 const key=lessons[lessonIndex].id+":"+pointIndex;
 if(fullTextCache.has(key))return fullTextCache.get(key);
 const start=pointStart(),end=pointNext(),endPage=pointLastPage();
 const sections=[];
 for(let n=start.page;n<=endPage;n++){
  const p=await pdf.getPage(n);
  const items=(await p.getTextContent()).items;
  sections.push(collectPointText(p,items,start,end));
 }
 const result=sections.join("\n\n").replace(/\s+/g," ").trim().slice(0,18000);
 fullTextCache.set(key,result);return result;
}
// Coordinates measured from the uploaded 288-page textbook (PDF points, top-left).
// Cover only the QR images; keep headings, paragraphs, tables and selectable text.
const QR_TOPS = {"13":[66.4],"20":[192.8],"37":[62.4],"45":[241,419.6,493.3],"82":[494.1,314.4,416],"130":[493.7,218.8,414.9],"166":[345.5,419.2,492.9],"179":[437.7],"185":[240.7],"193":[303.9],"211":[370.5],"224":[269.3],"231":[341.9,424.8,251.2],"275":[328.9,416,490.5]};
function hidePublisherQR(ctx,base,bitmap,page){
 const tops=QR_TOPS[page]||[];
 if(!tops.length)return;
 const sx=bitmap.width/base.width,sy=bitmap.height/base.height;
 ctx.save();ctx.fillStyle="#ffffff";
 for(const y of tops)ctx.fillRect((388.373-0.9)*sx,(y-0.9)*sy,(56.64+1.8)*sx,(56.64+1.8)*sy);
 ctx.restore();
}

function highlightPoint(page,items){
 const layer=$("highlightLines");layer.replaceChildren();
 const segments=lessonLineSegments(page,items,pointStart(),pointNext());
 const maxWidth=$("pageSurface").clientWidth,maxHeight=$("pageSurface").clientHeight;
 for(const row of segments){
  const top=Math.max(0,(row.y-row.height*.87)*pageScale);
  const left=Math.max(0,(row.x-1)*pageScale);
  const width=Math.min(maxWidth-left,(row.right-row.x+2.5)*pageScale);
  const height=Math.min(maxHeight-top,Math.min(14,row.height*1.07)*pageScale);
  if(width<=3||height<=3)continue;
  const line=document.createElement("div");line.className="focus-line";
  Object.assign(line.style,{
   left:left+"px",top:top+"px",width:width+"px",height:height+"px"
  });
  layer.append(line);
 }
}
function setButtons(){
 const last=atPointEnd();
 if(last&&completedPoints.has(pointKey()))answered=true;
 $("askQuestion").disabled=!pdf||!last||answered;
 $("nextPage").disabled=!pdf||(last&&!answered);
 $("askQuestion").textContent=answered?"✓ Пункт перевірено":"🧠 Пункт прочитано — 4 запитання";
 $("nextPage").textContent=!last?"Наступна сторінка →":
  pointIndex<pointStarts().length-1?"Наступний пункт →":
  lessonIndex<lessons.length-1?"Наступний параграф →":"Завершити ✓";
 $("guideNote").textContent="§ "+(lessonIndex+1)+" · Пункт "+pointStart().number+
 " із "+pointStarts().length+" · стор. "+pointStart().page+"–"+pointLastPage()+
 (answered?" · ✓ Перевірено":last?" · 4 запитання":"");

}
async function renderPage(){
 if(!pdf||!lessons.length)return;
 const token=++generation,lesson=lessons[lessonIndex];
 answered=completedPoints.has(pointKey())&&atPointEnd();quizzing=false;
 $("questionArea").replaceChildren();
 $("pageSurface").hidden=true;$("paperStatus").hidden=false;
 $("paperStatus").textContent="Відкриваю сторінку "+pageNo+"…";
 $("lessonName").textContent=lesson.title;
 $("pageInfo").textContent="Стор. "+pageNo+" · пункт "+pointStart().number+" · § "+(lessonIndex+1);
 for(const b of document.querySelectorAll(".para"))b.classList.toggle("active",b.dataset.id===lesson.id);
 $("prevPage").disabled=lessonIndex===0&&pointIndex===0&&pageNo===lessons[lessonIndex].startPage;
 
 $("nextPage").disabled=true;$("askQuestion").disabled=true;
 saveProgress();
 try{
  const p=await pdf.getPage(pageNo);if(token!==generation)return;
  const base=p.getViewport({scale:1});
  const available=Math.min(880,Math.max(280,$("paper").clientWidth-30));
  pageScale=available/base.width;
  const view=p.getViewport({scale:pageScale});
  const ratio=Math.min(2,devicePixelRatio||1);
  const bitmap=p.getViewport({scale:pageScale*ratio});
  const canvas=$("pageCanvas"),ctx=canvas.getContext("2d",{alpha:false});
  canvas.width=Math.ceil(bitmap.width);canvas.height=Math.ceil(bitmap.height);
  canvas.style.width=Math.ceil(view.width)+"px";canvas.style.height=Math.ceil(view.height)+"px";
  const surface=$("pageSurface"),layer=$("pdfText");
  surface.style.width=Math.ceil(view.width)+"px";surface.style.height=Math.ceil(view.height)+"px";
  layer.style.width=Math.ceil(view.width)+"px";layer.style.height=Math.ceil(view.height)+"px";
  layer.style.setProperty("--scale-factor",String(pageScale));
  layer.style.setProperty("--total-scale-factor",String(pageScale));
  layer.replaceChildren();
  $("highlightLines").replaceChildren();
  const task=p.render({canvasContext:ctx,viewport:bitmap});readingTask=task;
  await task.promise;if(token!==generation)return;
  hidePublisherQR(ctx,base,bitmap,pageNo);
  const items=await p.getTextContent();if(token!==generation)return;
  try{
   const tl=new pdfjs.TextLayer({textContentSource:items,container:layer,viewport:view});
   await tl.render();
  }catch(error){console.warn("Text layer unavailable",error)}
  if(token!==generation)return;
  $("paperStatus").hidden=true;surface.hidden=false;
  // Wait for layout so page-relative positions are accurate.
  requestAnimationFrame(()=>{
   if(token!==generation)return;
   highlightPoint(p,items.items);setButtons();
   if(atPointEnd()&&completedPoints.has(pointKey()))showQuizCompletion(true);
  });
 }catch(error){
  if(token!==generation)return;
  $("paperStatus").hidden=false;
  $("paperStatus").textContent="Не вдалося відкрити сторінку. Можеш вибрати свій PDF у блоці відновлення.";
  $("pdfRecovery").hidden=false;
  console.error(error);
 }
}
$("askQuestion").onclick=async()=>{
 if(!atPointEnd()||answered||quizzing)return;
 isSelectionQuiz=false;
 $("askQuestion").disabled=true;
 $("questionArea").textContent="Готую чотири запитання за всім пунктом…";
 try{await startQuiz(await pointText())}
 catch(error){showReflections("Не вдалося прочитати текст пункту: "+error.message)}
};

$("sendStudentQuestion").onclick=async()=>{
 const question=$("studentQuestion").value.trim();
 const responseArea=$("studentAnswer");
 if(!question||question.length<3){responseArea.textContent="Напиши запитання про цей пункт.";return}
 if(!pdf){responseArea.textContent="Спочатку відкрий підручник.";return}
 const button=$("sendStudentQuestion"),readingGeneration=generation;
 button.disabled=true;
 button.textContent="ШІ шукає відповідь…";
 responseArea.textContent="";
 try{
  const text=await pointText();
  if(readingGeneration!==generation)return;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),30000);
  let response;
  try{response=await fetch("/api/tutor",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({task:"ask-question",question,text}),signal:controller.signal});
  }finally{clearTimeout(timeout)}
  const data=await response.json();
  if(readingGeneration!==generation)return;
  if(!response.ok)throw Error(data.error||"ШІ не зміг відповісти.");
  responseArea.textContent=data.answer||"ШІ не знайшов відповіді в цьому пункті.";
 }catch(error){
  if(readingGeneration===generation)responseArea.textContent=error.name==="AbortError"
   ?"Відповідь затримується. Спробуй ще раз.":"Не вдалося отримати відповідь: "+error.message;
 }finally{
  button.disabled=false;
  button.textContent="Запитати ШІ";
 }
};

function validQuestion(q){
 return !!(q&&typeof q.question==="string"&&q.question.trim()&&
  Array.isArray(q.options)&&q.options.length===4&&q.options.every(x=>typeof x==="string")&&
  Number.isInteger(q.correct)&&q.correct>=0&&q.correct<4);
}
async function startQuiz(text){
 if(quizzing)return;
 quizzing=true;
 const key=(isSelectionQuiz?"selection":"point")+":"+lessons[lessonIndex].id+":"+pointIndex+":"+text.slice(0,100);
 const cached=questionCache.get(key);
 if(cached){showQuestions(cached);return}
 $("questionArea").textContent="ШІ складає 4 запитання…";
 try{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  let response;
  try{response=await fetch("/api/tutor",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({task:"multi-checkpoint",text}),signal:controller.signal})}
  finally{clearTimeout(timer)}
  const result=await response.json();
  if(!response.ok)throw Error(result.error||"ШІ недоступний");
  if(!Array.isArray(result.questions)||result.questions.length!==3||!result.questions.every(validQuestion))throw Error("Invalid AI response");
  questionCache.set(key,result.questions);
  showQuestions(result.questions);
 }catch(err){
  if(!isSelectionQuiz&&lessonIndex===0&&pointIndex===0){
   showQuestions(fallbackFirstPoint,"4 підготовлені запитання. ШІ тимчасово недоступний.");
  }else{showReflections("ШІ не створив запитання: "+err.message)}
 }
}
function showQuizCompletion(alreadyDone=false){
 const area=$("questionArea");area.replaceChildren();
 const panel=document.createElement("div");panel.className="q-done";
 const symbol=document.createElement("div");symbol.className="q-done-icon";symbol.textContent="✓";
 const heading=document.createElement("h3");heading.textContent=alreadyDone?"Пункт уже перевірено":"Перевірку завершено!";
 const description=document.createElement("p");
 description.textContent=alreadyDone
   ?"Результат збережений. Можеш продовжити з наступного пункту."
   :"Ти відповіла на всі чотири запитання. Прогрес збережено.";
 const continueButton=document.createElement("button");
 continueButton.className="primary";
 continueButton.textContent=pointIndex<pointStarts().length-1?"Наступний пункт →":
   lessonIndex<lessons.length-1?"Наступний параграф →":"Завершити книгу ✓";
 continueButton.onclick=()=>next();
 panel.append(symbol,heading,description);
 if(pointIndex===pointStarts().length-1){
  const finalTest=document.createElement("button");
  finalTest.textContent=completedReviews.has(lessons[lessonIndex].id)
   ?"Самостійна вже виконана ✓ (повторити)":"Самостійна робота — 6 запитань";
  finalTest.onclick=()=>startParagraphReview();
  const retell=document.createElement("button");
  retell.textContent="✍️ Переказати параграф";
  retell.onclick=()=>openRetelling();
  panel.append(finalTest,retell);
 }
 panel.append(continueButton);
 area.append(panel);
 const sidebar=document.querySelector(".questions");
 if(sidebar)sidebar.scrollTop=0;
}
function afterQuiz(){
 quizzing=false;
 answered=true;
 completedPoints.add(pointKey());
 saveCompleted();
 saveProgress();
 setButtons();
 showQuizCompletion();
}
function showQuestions(list,notice="Запитання створені ШІ за прочитаним пунктом",onFinish=afterQuiz){
 let index=0;
 const area=$("questionArea");
 const draw=()=>{
  area.replaceChildren();
  const note=document.createElement("p");note.className="q-progress";
  note.textContent=notice+" · Запитання "+(index+1)+" / "+list.length;
  const heading=document.createElement("h3");heading.className="q-prompt";heading.textContent=list[index].question;
  area.append(note,heading);
  const buttons=[],feedback=document.createElement("div");feedback.className="q-feedback";
  let chosen=-1,verified=false;
  list[index].options.forEach((option,i)=>{
   const b=document.createElement("button");b.className="q-option";b.textContent=String.fromCharCode(1040+i)+". "+option;
   b.onclick=()=>{if(verified)return;chosen=i;buttons.forEach(x=>x.classList.remove("selected"));b.classList.add("selected")};
   buttons.push(b);area.append(b);
  });
  const verify=document.createElement("button");verify.className="primary";verify.textContent="Перевірити відповідь";
  verify.onclick=()=>{
   if(chosen<0){feedback.textContent="Спочатку обери відповідь.";return}
   if(verified)return;
   verified=true;verify.disabled=true;
   buttons[list[index].correct].classList.add("correct");
   buttons[chosen].classList.add(chosen===list[index].correct?"correct":"wrong");
   feedback.textContent=(chosen===list[index].correct?"Правильно! ":"Не зовсім. ")+(list[index].explanation||"Перечитай відповідний фрагмент.");
   const next=document.createElement("button");next.className="primary";
   next.textContent=index===list.length-1?"Завершити перевірку":"Наступне запитання →";
   next.onclick=()=>{index++;if(index<list.length)draw();else onFinish()};
   area.append(next);
  };
  area.append(verify,feedback);
 };
 draw();
}

async function paragraphText(){
 const lesson=lessons[lessonIndex],key=lesson.id;
 if(paragraphTextCache.has(key))return paragraphTextCache.get(key);
 const start={page:lesson.startPage,y:0},sections=[];
 for(let n=lesson.startPage;n<=lesson.endPage;n++){
  const p=await pdf.getPage(n);
  const content=await p.getTextContent();
  sections.push(collectPointText(p,content.items,start,null));
 }
 const result=sections.join("\n\n").replace(/\s+/g," ").trim().slice(0,14900);
 paragraphTextCache.set(key,result);
 return result;
}
function showReviewDone(){
 const area=$("questionArea");area.replaceChildren();
 const box=document.createElement("div");box.className="q-done";
 const heading=document.createElement("h3");heading.textContent="Самостійну роботу завершено!";
 const info=document.createElement("p");info.textContent="Усі шість запитань пройдено. Можеш переказати параграф або продовжити.";
 const retell=document.createElement("button");retell.textContent="✍️ Переказати параграф";
 retell.onclick=()=>openRetelling();
 const forward=document.createElement("button");forward.className="primary";
 forward.textContent="Наступний параграф →";forward.onclick=()=>next();
 box.append(heading,info,retell,forward);area.append(box);
 document.querySelector(".questions").scrollTop=0;
}
async function startParagraphReview(){
 if(!pdf||pointIndex!==pointStarts().length-1||!answered)return;
 const generationAtStart=generation,area=$("questionArea");
 area.textContent="ШІ складає самостійну роботу за всім параграфом…";
 try{
  const text=await paragraphText();
  if(generation!==generationAtStart)return;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  let response;
  try{response=await fetch("/api/tutor",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({task:"paragraph-review",text}),signal:controller.signal});}
  finally{clearTimeout(timer)}
  const data=await response.json();
  if(generation!==generationAtStart)return;
  if(!response.ok)throw Error(data.error||"Немає відповіді.");
  if(!Array.isArray(data.questions)||data.questions.length!==6||!data.questions.every(validQuestion))
    throw Error("ШІ повернув неправильний формат роботи.");
  showQuestions(data.questions,"Самостійна робота за параграфом",()=>{
    completedReviews.add(lessons[lessonIndex].id);saveCompleted();
    showReviewDone();
  });
 }catch(error){
  if(generation!==generationAtStart)return;
  area.replaceChildren();
  const note=document.createElement("p");note.className="muted";
  note.textContent="Не вдалося створити самостійну: "+error.message;
  const retry=document.createElement("button");retry.textContent="Спробувати ще раз";retry.onclick=startParagraphReview;
  const back=document.createElement("button");back.textContent="Повернутись";back.onclick=()=>showQuizCompletion(true);
  area.append(note,retry,back);
 }
}
function openRetelling(){
 if(!pdf||!answered)return;
 const area=$("questionArea");area.replaceChildren();
 const heading=document.createElement("h3");heading.textContent="Переказ параграфа";
 const hint=document.createElement("p");hint.className="muted";
 hint.textContent="Напиши своїми словами основні події, причини та наслідки. ШІ підкаже, що вдалося і що варто уточнити.";
 const input=document.createElement("textarea");input.rows=7;input.maxLength=2500;input.style.width="100%";
 input.style.padding="10px";input.style.borderRadius="10px";input.placeholder="Мій переказ…";
 const assess=document.createElement("button");assess.className="primary";assess.textContent="Перевірити переказ";
 const result=document.createElement("div");result.style.whiteSpace="pre-wrap";result.style.lineHeight="1.6";result.style.fontSize="14px";
 const back=document.createElement("button");back.textContent="Повернутися до пункту";
 back.onclick=()=>showQuizCompletion(true);
 assess.onclick=async()=>{
  const retelling=input.value.trim();
  if(retelling.length<30){result.textContent="Напиши хоча б кілька речень.";return}
  const version=generation;assess.disabled=true;result.textContent="ШІ читає твій переказ…";
  try{
   const text=await paragraphText();if(version!==generation)return;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
   let response;
   try{response=await fetch("/api/tutor",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({task:"assess-retelling",retelling,text}),signal:controller.signal})}
   finally{clearTimeout(timer)}
   const data=await response.json();if(version!==generation)return;
   if(!response.ok)throw Error(data.error||"Невідома помилка");
   result.textContent=data.answer||"Відгук поки недоступний.";
  }catch(error){if(version===generation)result.textContent="Не вдалося перевірити переказ: "+error.message}
  finally{assess.disabled=false}
 };
 area.append(heading,hint,input,assess,result,back);
 document.querySelector(".questions").scrollTop=0;
}

function showReflections(reason){
 const questions=[
  "Яка головна думка цього пункту?",
  "Назви дві важливі події, поняття або дати з прочитаного.",
  "Як цей пункт пов’язаний із темою параграфа?",
  "Яку деталь із прочитаного ти вважаєш найважливішою та чому?"
 ];
 let index=0;
 const area=$("questionArea");
 const draw=()=>{
  area.replaceChildren();
  const note=document.createElement("p");note.className="q-progress";
  note.textContent="Самоперевірка · "+(index+1)+"/"+questions.length;
  const h=document.createElement("h3");h.textContent=questions[index];
  const explanation=document.createElement("p");explanation.className="muted";explanation.textContent=reason;
  const input=document.createElement("textarea");input.rows=4;input.placeholder="Напиши відповідь своїми словами…";input.style.width="100%";
  const next=document.createElement("button");next.className="primary";
  next.textContent=index===questions.length-1?"Завершити":"Наступне питання →";
  next.onclick=()=>{if(!input.value.trim()){input.focus();return}index++;if(index===questions.length)afterQuiz();else draw()};
  area.append(note,h,explanation,input,next);
 };draw();
}
function next(){
 if(!pdf)return;
 if(!atPointEnd()){pageNo++;renderPage();return}
 if(!answered)return;
 if(pointIndex<pointStarts().length-1){pointIndex++;pageNo=pointStart().page}
 else if(lessonIndex<lessons.length-1){lessonIndex++;pointIndex=0;pageNo=pointStart().page}
 else { $("guideNote").textContent="Ти завершила весь доступний підручник!";return}
 renderPage();window.scrollTo({top:0,behavior:"instant"});
}
function previous(){
 if(!pdf)return;
 const start=pointIndex===0?lessons[lessonIndex].startPage:pointStart().page;
 if(pageNo>start){pageNo--;renderPage();return}
 if(pointIndex>0){pointIndex--;pageNo=pointLastPage()}
 else if(lessonIndex>0){lessonIndex--;pointIndex=pointStarts().length-1;pageNo=pointLastPage()}
 else return;
 renderPage();window.scrollTo({top:0,behavior:"instant"});
}
$("nextPage").onclick=next;$("prevPage").onclick=previous;
async function main(){
 try{
  const [outlineReq,pointsReq]=await Promise.all([
   fetch("/books/h11/outline.json",{cache:"no-store"}),
   fetch("/books/h11/points.json",{cache:"no-store"})
  ]);
  if(!outlineReq.ok||!pointsReq.ok)throw Error("Не знайдено зміст або межі пунктів");
  const outline=await outlineReq.json(),points=await pointsReq.json();
  flatten(outline.contents);pointMap=points.paragraphs||{};
  if(lessons.length!==29||!pointMap.p1||pointMap.p1.length!==4)throw Error("Структура підручника пошкоджена");
  renderContents(outline.contents);restoreProgress();
  $("app").hidden=false;$("message").hidden=true;
  $("lessonName").textContent=lessons[lessonIndex].title;
  $("pageInfo").textContent="Стор. "+pageNo+" · пункт "+pointStart().number;
  $("paperStatus").textContent="Зміст відновлено. Завантажую сторінки...";
  const saved=await getCached();
  if(saved){
   try{await loadBytes(new Uint8Array(saved),false);return}
   catch(error){console.warn("Stored PDF cannot be opened",error)}
  }
  try{
   const version=pdfLoadVersion;
   const doc=await pdfjs.getDocument({url:PDF_URL,rangeChunkSize:262144}).promise;
   if(version!==pdfLoadVersion){await doc.destroy();return}
   if(doc.numPages!==288){await doc.destroy();throw Error("Знайдено іншу книгу");}
   pdf=doc;$("pdfRecovery").hidden=true;await renderPage();
  }catch(error){
   console.warn("Publisher PDF unavailable",error);
   if(pdf)return;
   $("pdfRecovery").hidden=false;
   $("paperStatus").hidden=false;
   $("paperStatus").textContent="Зміст збережено. Але зовнішнє джерело книги зараз недоступне. Натисни «Відкрити свій PDF» вище: це потрібно один раз у цьому браузері.";
   $("guideNote").textContent="Вибір класу, параграфа й пункту збережено. Після вибору PDF можна продовжити з тієї самої сторінки.";
  }
 }catch(error){
  $("message").hidden=false;
  $("message").textContent="Не вдалося відкрити електронний підручник: "+error.message;
 }
}
main();
