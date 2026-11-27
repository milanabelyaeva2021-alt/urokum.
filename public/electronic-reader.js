const $=id=>document.getElementById(id);
const BOOK="history11-gisem-stand";
const SAVE="urokum:ebook-reading:"+BOOK, DONE="urokum:ebook-finished:"+BOOK,
 REVIEW_DONE="urokum:ebook-reviews:"+BOOK, SKIPPED="urokum:ebook-skipped:"+BOOK,
 QUIZ_CACHE="urokum:ebook-quiz-cache:"+BOOK,
 ATTEMPTS="urokum:ebook-attempts:"+BOOK, FONT_SIZE="urokum:ebook-font-size:"+BOOK,
 REVIEW_QUIZ_CACHE="urokum:ebook-prepared-reviews:"+BOOK;
let lessons=[],points={},current=null,lessonIndex=0,pointIndex=0,loadToken=0;
let completed=new Set(),reviews=new Set(),skipped=new Set(),quizState=null,quizRun=0;
let locallySavedQuestions={},locallySavedReviews={},pointAttempts={},readerFontSize=19;
const textCache=new Map(),summaryCache=new Map();
const SPACED_KEY="urokum:spaced:"+BOOK;
let spaced=fromStore(SPACED_KEY,{});
function dueCards(){return Object.values(spaced).filter(x=>x&&x.due<=Date.now())}
function renderDueCards(){
 $("spacedDue")?.remove();
 const panel=make("section","spaced-review");panel.id="spacedDue";
 const due=dueCards();
 panel.append(make("strong",null,"🔁 На повторення сьогодні"),make("span","small",due.length+" запитань"));
 if(due.length){
  const btn=make("button","primary","Повторити зараз");
  btn.onclick=()=>{quizState={questions:due.slice(0,12).map(x=>x.q),cardIds:due.slice(0,12).map(x=>x.id),index:0,mode:"spaced",done:0,results:[],loadVersion:loadToken};
   $("readerArticle").hidden=true;$("finished").hidden=true;$("review").hidden=true;$("paragraphSummary").hidden=true;showQuestion();go($("quiz"))};
  panel.append(btn);
 }
 $("readerArticle").before(panel);
}
function recordSpaced(state){
 if(state.mode==="spaced"){
  state.cardIds.forEach((id,i)=>{const card=spaced[id];if(!card)return;
   if(state.results[i]?.status==="correct"){card.step++;if(card.step>=3)delete spaced[id];
    else card.due=Date.now()+[1,3,7][card.step]*86400000}
   else{card.step=0;card.due=Date.now()+86400000}
  });
 }else{
  state.questions.forEach((q,i)=>{if(!state.results[i]||state.results[i].status==="correct")return;
   const id=pointId()+":"+q.question.slice(0,120);
   if(!spaced[id])spaced[id]={id,q,step:0,due:Date.now()+86400000};
  });
 }
 const entries=Object.entries(spaced);if(entries.length>200)spaced=Object.fromEntries(entries.slice(-200));
 toStore(SPACED_KEY,spaced);renderDueCards();
}
const TEACHER_CHAT_KEY="urokum:teacher-history:"+BOOK;
const TEACHER_OPEN_KEY="urokum:teacher-panel-open:"+BOOK;
let teacherChats=fromStore(TEACHER_CHAT_KEY,{});
let activeTeacherQuizContext=null,teacherBusy=false;

function fromStore(key,fallback){try{return JSON.parse(localStorage.getItem(key)||"null")??fallback}catch{return fallback}}
function toStore(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}
function lessonQuizKey(){
 let n=5381,text=String(current?.text||"");
 for(let i=0;i<text.length;i++)n=(((n<<5)+n)^text.charCodeAt(i))>>>0;
 return lessons[lessonIndex].id+":"+(pointIndex+1)+":"+n.toString(16)+":"+text.length;
}
function pointId(i=lessonIndex,j=pointIndex){return lessons[i]?.id+":"+(j+1)}
function clampFont(v){return Math.max(15,Math.min(26,Number(v)||19))}
function applyFontSize(v){
 readerFontSize=clampFont(v);
 document.documentElement.style.setProperty("--reader-font-size",readerFontSize+"px");
 toStore(FONT_SIZE,readerFontSize);
 $("fontSmaller").disabled=readerFontSize<=15;
 $("fontLarger").disabled=readerFontSize>=26;
}
$("fontSmaller").onclick=()=>applyFontSize(readerFontSize-1);
$("fontReset").onclick=()=>applyFontSize(19);
$("fontLarger").onclick=()=>applyFontSize(readerFontSize+1);
function restartParagraph(){
 const lesson=lessons[lessonIndex];if(!lesson)return;
 if(!window.confirm("Пройти весь параграф ще раз? Позначки про завершення його пунктів буде скинуто."))return;
 $("evidenceView").hidden=true;$("readerArticle").hidden=false;
 for(let j=0;j<(points[lesson.id]||[]).length;j++){
  completed.delete(lesson.id+":"+(j+1));skipped.delete(lesson.id+":"+(j+1));
 }
 toStore(DONE,[...completed]);toStore(SKIPPED,[...skipped]);
 $("paragraphSummary").hidden=true;
 loadPoint(lessonIndex,0);
}
$("restartParagraphBtn").onclick=restartParagraph;
const PREPARED_KEY_EVENTS={
 p1:[
  {date:"1945 р.",event:"Завершення Другої світової війни та початок другого періоду Новітньої історії України."},
  {date:"1946–1947 рр.",event:"Масовий штучний голод в УРСР у роки післявоєнної відбудови."},
  {date:"Середина 1950-х рр.",event:"Десталінізація, реабілітація незаконно засуджених і певна лібералізація режиму за Микити Хрущова."},
  {date:"1959 р.",event:"Перепис населення УРСР: 41,9 млн жителів; українці становили 76,8 % населення."},
  {date:"1985–1991 рр.",event:"Період «перебудови», «гласності» та активізації українського національно-визвольного руху."},
  {date:"24 серпня 1991 р.",event:"Проголошення незалежності України."}
 ],
 p2:[
  {date:"6 травня 1945 р.",event:"Українська делегація прибула на установчу конференцію Організації Об’єднаних Націй у Сан-Франциско."},
  {date:"16 серпня 1945 р.",event:"Радянсько-польський договір юридично закріпив державний кордон."},
  {date:"22 січня 1946 р.",event:"Утворено Закарпатську область у складі УРСР."},
  {date:"10 лютого 1947 р.",event:"Підписано радянсько-румунський договір, який закріпив післявоєнні кордони."},
  {date:"1947 р.",event:"Примусова депортаційна операція «Вісла» проти українського населення в Польщі."},
  {date:"1990 р.",event:"Сенат Республіки Польща засудив операцію «Вісла»."}
 ]
};
async function keyDatesAndEvents(i){
 const lesson=lessons[i],key=lesson.id;
 if(PREPARED_KEY_EVENTS[key])return {events:PREPARED_KEY_EVENTS[key],prepared:true};
 if(summaryCache.has(key))return summaryCache.get(key);
 const events=[],seen=new Set(),length=(points[key]||[]).length;
 for(let j=0;j<Math.min(length,8)&&events.length<8;j++){
  const part=await fetchPoint(i,j);
  const paragraphs=(part.blocks||[]).filter(x=>["text","list","source"].includes(x.type))
   .flatMap(x=>x.type==="list"?x.items||[]:[x.text||""]);
  if(!paragraphs.length)paragraphs.push(...(part.paragraphs||[]));
  for(const paragraph of paragraphs){
   for(const sentence of textbookSentenceRanges(paragraph)){
    const date=sentence.text.match(/(?:18|19|20)\d{2}(?:\s*[—–-]\s*(?:18|19|20)?\d{2})?\s*рр?\./u);
    if(!date||sentence.text.length<35||sentence.text.length>300)continue;
    if(!/(відбув|підпис|поча|утвор|створ|проголос|заверш|обра|заснув|вступ|ліквід|віднов|ухвал|пров[еі]л|пересел|здійсн|запровад|відкр|увійш|започат|загин|було|стала|прийня)/iu.test(sentence.text))continue;
    const fingerprint=sentence.text.toLocaleLowerCase("uk");
    if(seen.has(fingerprint))continue;
    seen.add(fingerprint);
    events.push({date:date[0],event:sentence.text});
    if(events.length>=8)break;
   }
   if(events.length>=8)break;
  }
 }
 const result={events,prepared:false};summaryCache.set(key,result);return result;
}
async function showParagraphSummary(){
 const host=$("paragraphSummary"),lesson=lessons[lessonIndex];
 if(!lesson)return;
 const length=(points[lesson.id]||[]).length;
 if(pointIndex!==length-1){host.hidden=true;return}
 const version=loadToken,lessonAtStart=lessonIndex;
 host.hidden=false;host.replaceChildren();
 const recap=make("div","recap-flow");
 recap.append(make("h2","recap-title","🧠 Закріпити знання"));
 recap.append(make("p","recap-intro","Спочатку переказуй матеріал своїми словами. Потім за бажанням відкрий найважливіші дати й події для повторення."));
 const retell=make("button","secondary recap-retell","✍️ Переказати своїми словами");
 retell.onclick=openRetelling;recap.append(retell);
 const expand=make("details","synopsis-toggle");
 expand.append(make("summary",null,"📅 Основні дати і події"));
 const body=make("div","synopsis-content");
 body.append(make("p","small","Готую перелік дат і подій…"));
 expand.append(body);recap.append(expand);host.append(recap);
 try{
  const data=await keyDatesAndEvents(lessonAtStart);
  if(version!==loadToken||lessonAtStart!==lessonIndex)return;
  body.replaceChildren();
  if(!data.events.length){
   body.append(make("p","small","Для цього параграфа ще немає підготовленого переліку дат і подій."));
   return;
  }
  const list=make("ol","key-events-list");
  for(const item of data.events){
   const li=make("li","key-event");
   li.append(make("strong","key-event-date",bookTypography(item.date)),
    make("span","key-event-description",bookTypography(item.event)));
   list.append(li);
  }
  body.append(list);
  if(!data.prepared)body.append(make("p","summary-footnote",
   "Ці речення з датами автоматично вибрано з електронного тексту. Перевір їх за підручником."));
 }catch(error){
  if(version!==loadToken)return;
  body.replaceChildren(make("p","small","Не вдалося відкрити перелік дат і подій."));
 }
}
// Progress belongs to the learner; transfer via local JSON rather than insecure shared server files.
const TRANSFER_KEYS=[SAVE,DONE,REVIEW_DONE,SKIPPED,QUIZ_CACHE,ATTEMPTS,FONT_SIZE,REVIEW_QUIZ_CACHE,SPACED_KEY];
$("exportProgress").onclick=()=>{
 const values={};
 for(const key of TRANSFER_KEYS){
  const value=localStorage.getItem(key);
  if(value!=null)values[key]=value;
 }
 const doc={format:"urokum-progress",version:1,book:BOOK,createdAt:new Date().toISOString(),values};
 const file=new Blob([JSON.stringify(doc,null,2)],{type:"application/json"});
 const address=URL.createObjectURL(file);
 const link=document.createElement("a");
 link.href=address;link.download="urokum-progres.json";
 document.body.append(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(address),5000);
 $("progressTransferStatus").textContent="Прогрес збережено у файл. На іншому пристрої відкрий його в Урокумі.";
};
$("importProgress").onclick=()=>$("importProgressFile").click();
$("importProgressFile").onchange=async()=>{
 const input=$("importProgressFile"),file=input.files?.[0];
 if(!file)return;
 const status=$("progressTransferStatus");
 try{
  if(file.size>1_000_000)throw Error("Файл занадто великий.");
  const parsed=JSON.parse(await file.text());
  if(parsed?.format!=="urokum-progress"||parsed?.version!==1||parsed?.book!==BOOK||
     !parsed.values||typeof parsed.values!=="object"||Array.isArray(parsed.values))
   throw Error("Це не файл прогресу цього підручника.");
  const items=Object.entries(parsed.values);
  if(items.some(([key,value])=>!TRANSFER_KEYS.includes(key)||typeof value!=="string"||value.length>450_000))
   throw Error("У файлі є некоректні дані.");
  for(const [key,value] of items)JSON.parse(value);
  if(!confirm("Відновлення замінить прогрес цього підручника на поточному пристрої. Продовжити?"))return;
  for(const [key,value] of items)localStorage.setItem(key,value);
  status.textContent="Прогрес відновлено. Оновлюю сторінку…";
  location.reload();
 }catch(error){status.textContent=error.message||"Не вдалося відкрити файл."}
 finally{input.value=""}
};

// Presentation-only typography: textbook JSON and source evidence stay intact.
function bookTypography(value){
 return String(value||"")
   .replace(/(\b\d{1,4})\s+(рр?\.|ст\.|тис\.)(?=\s|[),;.!?]|$)/gu,"$1\u00a0$2")
   .replace(/(\d+(?:[,.]\d+)?)\s+(%)(?=\s|[),;.!?]|$)/gu,"$1\u00a0$2")
   .replace(/(\b\d{4})\s*[—–-]\s*(\d{4}\b)/gu,"$1\u2060—\u2060$2");
}

const safeText=value=>String(value||"").replace(/[\u00ad\u200b\ufeff]/g,"").replace(/\s+/g," ").trim();
function explainMarkup(root,text){
 root.replaceChildren();
 for(const [i,line] of String(text||"").split(/\n/).entries()){
  if(i)root.append(document.createElement("br"));
  const pieces=line.split(/(\*\*[^*]+\*\*)/);
  for(const piece of pieces){
   if(piece.startsWith("**")&&piece.endsWith("**")){
    const el=document.createElement("strong");el.textContent=piece.slice(2,-2);root.append(el);
   }else root.append(document.createTextNode(piece));
  }
 }
}
function make(tag,classes,text){
 const node=document.createElement(tag);
 if(classes)node.className=classes;
 if(text!=null)node.textContent=text;
 return node;
}
function renderEbookBlocks(host,blocks){
 host.replaceChildren();
 for(const block of blocks||[]){
  if(!block||typeof block.type!=="string")continue;
  if(block.type==="heading"){
   host.append(make("h2","point-heading",bookTypography(block.text)));continue;
  }
  if(block.type==="text"){
   host.append(make("p",null,bookTypography(block.text)));continue;
  }
  if(block.type==="table"){
   const wrap=make("div","ebook-table-wrap");
   const table=make("table","ebook-table");
   table.append(make("caption",null,block.title));
   const thead=make("thead");
   for(const headerRow of block.headerRows||[]){
    const tr=make("tr");
    for(const cellData of headerRow){
     const cell=make("th",null,typeof cellData==="string"?cellData:cellData.text);
     if(typeof cellData==="object"){
      cell.colSpan=Math.max(1,Number(cellData.colSpan)||1);
      cell.rowSpan=Math.max(1,Number(cellData.rowSpan)||1);
     }
     cell.scope="col";tr.append(cell);
    }
    thead.append(tr);
   }
   table.append(thead);
   const tbody=make("tbody");
   for(const rowData of block.rows||[]){
    const tr=make("tr");
    for(const value of rowData)tr.append(make("td",null,value));
    tbody.append(tr);
   }
   table.append(tbody);wrap.append(table);host.append(wrap);
   continue;
  }
  if(block.type==="list"){
   const ul=make("ul","ebook-bullets");
   for(const item of block.items||[])ul.append(make("li",null,bookTypography(item)));
   host.append(ul);continue;
  }
  if(block.type==="terms"){
   const details=make("details","ebook-vocab");
   details.append(make("summary",null,"📖 "+(block.title||"Словничок")));
   const dl=make("dl");
   for(const item of block.entries||[]){
    dl.append(make("dt",null,item.term),make("dd",null,bookTypography(item.definition)));
   }
   details.append(dl);host.append(details);continue;
  }
  if(block.type==="note"){
   const details=make("details","ebook-fact");
   details.append(make("summary",null,"✨ "+(block.title||"Цікавий факт")));
   details.append(make("p",null,bookTypography(block.text||"")));
   host.append(details);continue;
  }
  if(block.type==="source"){
   const details=make("details","ebook-source");
   details.append(make("summary",null,"📜 "+(block.title||"Історичне джерело")));
   details.append(make("p","source-caption",block.caption||""));
   details.append(make("blockquote",null,bookTypography(block.text||"")));
   host.append(details);continue;
  }
  if(block.type==="chart"){
   const figure=make("figure","ebook-chart");
   figure.append(make("figcaption",null,block.title||"Діаграма"));
   const body=make("div","ebook-chart-body");
   const pie=make("div","ebook-pie");
   pie.setAttribute("role","img");
   const colors=["#7953b7","#c0a5e5","#e9dff5","#a38cc5"];
   let sum=0;
   const segments=[];
   const items=make("ul");
   for(let i=0;i<(block.series||[]).length;i++){
    const part=block.series[i];
    const percent=Math.min(100,Math.max(0,Number(part.percent)||0));
    const from=sum;sum=Math.min(100,sum+percent);
    segments.push(colors[i%colors.length]+" "+from+"% "+sum+"%");
    const li=make("li");
    const chip=make("span","swatch");
    chip.style.background=colors[i%colors.length];
    li.append(chip,make("span",null,part.name+" — "+String(percent).replace(".",",")+" %"));
    items.append(li);
   }
   pie.style.background="conic-gradient("+segments.join(",")+")";
   pie.setAttribute("aria-label",(block.series||[]).map(x=>x.name+" "+x.percent+" відсотків").join(", "));
   body.append(pie,items);
   figure.append(body);
   if(block.caption)figure.append(make("p","chart-note",block.caption));
   host.append(figure);continue;
  }
  if(block.type==="conclusion"){
   const aside=make("aside","ebook-conclusion");
   aside.append(make("h3",null,block.title||"Висновки"));
   aside.append(make("p",null,block.text||""));
   host.append(aside);
  }
 }
}

function go(node){node?.scrollIntoView({behavior:"smooth",block:"start"})}
function flatten(list){
 for(const item of list||[]){
  if(item.type==="paragraph")lessons.push(item);
  if(item.children)flatten(item.children);
 }
}
function setTheme(){
 const next=document.documentElement.dataset.theme==="dark"?"light":"dark";
 document.documentElement.dataset.theme=next;
 toStore("urokum:ebook-theme",next);
 $("themeBtn").textContent=next==="dark"?"☀":"☾";
}
$("themeBtn").onclick=setTheme;
const theme=fromStore("urokum:ebook-theme",null);
if(theme){document.documentElement.dataset.theme=theme;$("themeBtn").textContent=theme==="dark"?"☀":"☾"}
$("contentsBtn").onclick=()=>{$("tocPanel").hidden=false;$("closeToc").focus()};
$("closeToc").onclick=()=>{$("tocPanel").hidden=true;$("contentsBtn").focus()};
$("tocPanel").addEventListener("click",event=>{if(event.target===$("tocPanel"))$("tocPanel").hidden=true});
document.addEventListener("keydown",event=>{if(event.key==="Escape")$("tocPanel").hidden=true});
function renderContents(nodes){
 const root=$("tocList");root.replaceChildren();
 function add(items){
  for(const item of items||[]){
   if(item.type==="chapter"){
    root.append(make("div","tocChapter",item.title));
   }else if(item.type==="paragraph"){
    const i=lessons.findIndex(x=>x.id===item.id);
    const button=make("button","tocItem",item.title);
    button.dataset.lesson=String(i);
    button.onclick=()=>{loadPoint(i,0);$("tocPanel").hidden=true};
    root.append(button);
   }
   if(item.children)add(item.children);
  }
 }
 add(nodes);
}
function showError(error){
 $("bookShell").hidden=true;
 $("loading").hidden=false;
 $("loading").replaceChildren();
 $("loading").append(make("p",null,"Не вдалося відкрити електронний текст: "+error.message));
 const retry=make("button","primary","Спробувати ще раз");
 retry.onclick=()=>loadPoint(lessonIndex,pointIndex);
 $("loading").append(retry);
}
function progress(){
 const lesson=lessons[lessonIndex],length=(points[lesson.id]||[]).length;
 $("progressName").textContent=lesson.title;
 $("progressStep").textContent="Пункт "+(pointIndex+1)+" / "+length;
 const n=(completed.has(lesson.id+":"+(pointIndex+1))||skipped.has(lesson.id+":"+(pointIndex+1)))?pointIndex+1:pointIndex;
 $("progressFill").style.width=(100*n/Math.max(1,length))+"%";
 document.querySelectorAll(".tocItem").forEach(button=>
  button.classList.toggle("current",Number(button.dataset.lesson)===lessonIndex));
}
function storeLocation(){
 toStore(SAVE,{lessonIndex,pointIndex});
 toStore("urokum:last-selection",{grade:11,subject:"Історія України",screen:"books"});
}
async function fetchPoint(i,j){
 const key=i+":"+j;
 if(textCache.has(key))return textCache.get(key);
 const req=await fetch("/api/ebook/"+BOOK+"/"+(i+1)+"/"+(j+1));
 let result;try{result=await req.json()}catch{throw Error("Сервер не повернув електронний текст")}
 if(!req.ok)throw Error(result.error||"Помилка читання");
 if(!result.paragraphs?.length)throw Error("Для цього пункту не знайдено тексту");
 textCache.set(key,result);
 return result;
}
async function loadPoint(i,j){
 if(!lessons[i])return;
 const length=(points[lessons[i].id]||[]).length;
 if(j<0||j>=length)return;
 const token=++loadToken;quizRun++;
 lessonIndex=i;pointIndex=j;current=null;quizState=null;
 storeLocation();
 $("bookShell").hidden=true;$("loading").hidden=false;
 $("loading").textContent="Готую електронний текст пункту "+(j+1)+"…";
 $("quiz").hidden=true;$("finished").hidden=true;$("review").hidden=true;$("paragraphSummary").hidden=true;
 activeTeacherQuizContext=[...currentTeacherThread()].reverse().find(m=>m.role==="user")?.context||null;
 renderTeacherMessages();
 refreshTeacherContext();
 $("evidenceView").hidden=true;$("readerArticle").hidden=false;
 try{
  const data=await fetchPoint(i,j);
  if(token!==loadToken)return;
  current=data;
  renderDueCards();
  const lesson=lessons[i];
  $("lessonEyebrow").textContent="Історія України · 11 клас · "+lesson.title.split(".")[0];
  $("lessonTitle").textContent=lesson.title;
  const host=$("ebookText");
  if(Array.isArray(data.blocks)&&data.blocks.length)renderEbookBlocks(host,data.blocks);
  else{host.replaceChildren();data.paragraphs.forEach(part=>host.append(make("p",null,part)))}
  $("loading").hidden=true;$("bookShell").hidden=false;
  // An exam opens an exact source excerpt in a separate tab without losing the exam.
  const requested=new URLSearchParams(location.search).get("find");
  if(requested&&requested.length<400)
   setTimeout(()=>{if(token===loadToken)revealEvidenceInText(requested)},120);
  progress();
  const done=completed.has(lesson.id+":"+(j+1));
  const passed=skipped.has(lesson.id+":"+(j+1));
  $("readEnd").hidden=done||passed;
  if(done||passed)showCompletion(true);
  const url=new URL(location.href);url.searchParams.set("id",BOOK);
  url.searchParams.set("paragraph",String(i+1));url.searchParams.set("point",String(j+1));
  history.replaceState(null,"",url.pathname+url.search);
  window.scrollTo({top:0,behavior:"instant"});
 }catch(e){if(token===loadToken)showError(e)}
}
async function aiCall(task,body,timeout=30000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{
  const response=await fetch("/api/tutor",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({task,...body}),signal:controller.signal});
  let data;try{data=await response.json()}catch{throw Error("ШІ повернув незрозумілу відповідь")}
  if(!response.ok)throw Error(data.error||"ШІ тимчасово не відповідає");
  return data;
 }finally{clearTimeout(timer)}
}
function validQuestion(q,index,mode="point"){
 if(!q||typeof q.question!=="string"||!q.question.trim())return false;
 if((mode==="point"&&index>=4)||(mode==="review"&&index>=9))
  return q.type==="open"&&typeof q.referenceAnswer==="string"&&q.referenceAnswer.trim().length>5;
 return Array.isArray(q.options)&&q.options.length===4&&
   q.options.every(x=>typeof x==="string")&&Number.isInteger(q.correct)&&q.correct>=0&&q.correct<4;
}
// Attach the exact textbook sentence to each question before it is saved.
// Older cached quizzes are repaired locally, without spending AI requests.
function anchorPointQuestions(questions,part){
 return questions.map(q=>{
  // Old cached automatic anchors can be wrong. Re-evaluate the answer from
  // scratch first, then consider an exact AI-provided source as a fallback.
  const {sourceSentence,...freshQuestion}=q;
  const found=bestMatchingEvidence(freshQuestion,part)||bestMatchingEvidence(q,part);
  return found?{...q,sourceSentence:found.quote}:q;
 });
}
$("beginQuiz").onclick=()=>startQuiz();
$("skipAllQuiz").onclick=()=>skipCheckpoint();
function skipCheckpoint(){
 if(!current)return;
 const key=lessons[lessonIndex].id+":"+(pointIndex+1);
 if(!completed.has(key)){skipped.add(key);toStore(SKIPPED,[...skipped]);}
 quizState=null;quizRun++;
 $("quiz").hidden=true;$("review").hidden=true;
 showCompletion(false);progress();
}
async function startQuiz(){
 if(!current)return;
 const cacheKey=lessonQuizKey(),cached=locallySavedQuestions[cacheKey];
 if(Array.isArray(cached)&&cached.length===5&&cached.every((q,i)=>validQuestion(q,i,"point"))){
  $("readEnd").hidden=true;$("finished").hidden=true;$("paragraphSummary").hidden=true;$("quiz").hidden=false;
  const anchored=anchorPointQuestions(cached,current);
  locallySavedQuestions[cacheKey]=anchored;
  toStore(QUIZ_CACHE,locallySavedQuestions);
  quizState={questions:anchored,index:0,mode:"point",done:0,results:[],loadVersion:loadToken};
  showQuestion();go($("quiz"));return;
 }
 $("readEnd").hidden=true;$("finished").hidden=true;$("paragraphSummary").hidden=true;
 const card=$("quiz");card.hidden=false;card.replaceChildren();
 card.append(make("span","pill","Навчальна зупинка"),make("h2",null,"Перевіримо, що ти зрозумів(ла)"));
 const status=make("p","small","ШІ готує 5 запитань: 4 з варіантами відповідей і 1 письмове.");
 const skip=make("button","secondary","Пропустити перевірку →");skip.onclick=skipCheckpoint;
 card.append(status,skip);go(card);
 const version=loadToken,attempt=++quizRun;
 try{
  const response=await aiCall("multi-checkpoint",{text:current.text.slice(0,14700)});
  if(version!==loadToken||attempt!==quizRun)return;
  if(!Array.isArray(response.questions)||response.questions.length!==5||
     !response.questions.every((q,i)=>validQuestion(q,i,"point")))
   throw Error("Отримано некоректний формат запитань");
  const anchored=anchorPointQuestions(response.questions,current);
  quizState={questions:anchored,index:0,mode:"point",done:0,results:[],loadVersion:loadToken};
  locallySavedQuestions[cacheKey]=anchored;
  const entries=Object.entries(locallySavedQuestions);
  if(entries.length>140)locallySavedQuestions=Object.fromEntries(entries.slice(-140));
  toStore(QUIZ_CACHE,locallySavedQuestions);
  showQuestion();
 }catch(error){
  if(version!==loadToken||attempt!==quizRun)return;
  card.replaceChildren();
  card.append(make("h2",null,"ШІ зараз недоступний"),
    make("p","small",error.message));
  const retry=make("button","primary","Спробувати знову");retry.onclick=startQuiz;
  const back=make("button","secondary","Повернутися до тексту");
  back.onclick=()=>{card.hidden=true;$("readEnd").hidden=false};
  const skip=make("button","secondary","Пропустити перевірку →");skip.onclick=skipCheckpoint;
  card.append(retry,back,skip);
 }
}
function quizStepBar(state){
 const steps=make("ol","quizSteps");steps.style.gridTemplateColumns="repeat("+Math.min(6,state.questions.length)+",minmax(0,1fr))";
 steps.setAttribute("aria-label","Прогрес перевірки");
 for(let i=0;i<state.questions.length;i++){
  const result=state.results?.[i];
  const kind=result?.status==="correct"?"correct":result?.status==="wrong"?"wrong":
    result?.status==="skipped"||result?.status==="ungraded"?"skipped":i===state.index?"current":"pending";
  const step=make("li","quizStep "+kind);
  step.append(make("span","bar"),make("span","step-label",(i+1)+(result?.status==="correct"?" ✓":result?.status==="wrong"?" ✕":"")));
  steps.append(step);
 }
 return steps;
}

/* Text evidence must be an actual, sufficiently long verbatim excerpt.
   Normalize punctuation and whitespace, but never invent a source location. */
function evidenceIndex(text){
 const raw=String(text||"");let value="",offsets=[];
 for(let i=0;i<raw.length;i++){
  const lower=raw[i].toLocaleLowerCase("uk");
  if(/[\p{L}\p{N}]/u.test(lower)){value+=lower;offsets.push(i)}
  else if(value&&!value.endsWith(" ")){value+=" ";offsets.push(i)}
 }
 if(value.endsWith(" ")){value=value.slice(0,-1);offsets.pop()}
 return {value,offsets};
}
function evidenceBounds(haystack,quote){
 const searched=evidenceIndex(haystack),expected=evidenceIndex(quote).value;
 if(expected.length<24||expected.split(" ").length<4)return null;
 const at=searched.value.indexOf(expected);
 if(at<0)return null;
 return {start:searched.offsets[at],end:searched.offsets[at+expected.length-1]+1};
}
function availableEvidenceQuote(q){
 const text=String(q?.sourceQuote||"").trim();
 if(text&&text.length>=24)return text;
 // For older, cached questions, accept only an explanation that is itself an exact excerpt.
 const old=String(q?.explanation||q?.referenceAnswer||"").trim();
 return old.length>=30?old:"";
}
// Treat evidence as a complete textbook sentence, never an arbitrary window of words.
function textbookSentenceRanges(text){
 const source=String(text||""),ranges=[];let start=0;
 for(let i=0;i<source.length;i++){
  if(!/[.!?]/u.test(source[i]))continue;
  // Do not break after common Ukrainian abbreviations or years ("1945 р.").
  const word=source.slice(Math.max(start,i-12),i+1);
  if(/(?:^|[\s(])(?:р|рр|ст|тис|млн|млрд|ім|н|пор|див|рис|табл)\.$/iu.test(word)&&!/^\s+(?:Згодом|Проте|Однак|Натомість|Пізніше|Тоді|Водночас|Відтак|Отже)(?=\s|[,.;])/u.test(source.slice(i+1)))continue;
  if(/\d\.\d/u.test(source.slice(Math.max(0,i-1),i+2)))continue;
  let after=i+1;
  while(after<source.length&&/[»”’"')\]]/u.test(source[after]))after++;
  const next=source.slice(after).match(/^\s+/u);
  if(!next)continue;
  const nextStart=after+next[0].length;
  if(nextStart>=source.length||/[А-ЯІЇЄҐA-Z«„“"0-9]/u.test(source[nextStart])){
   if(source.slice(start,after).trim())ranges.push({start,end:after,text:source.slice(start,after).trim()});
   start=nextStart;
  }
 }
 if(source.slice(start).trim()){
  const trimmed=source.slice(start);
  const trailing=trimmed.length-trimmed.trimEnd().length;
  ranges.push({start,end:source.length-trailing,text:trimmed.trim()});
 }
 return ranges;
}
function fullSentenceContaining(text,quote){
 const bounds=evidenceBounds(text,quote);
 if(!bounds)return null;
 const sentences=textbookSentenceRanges(text);
 if(!sentences.length)return null;
 // If a quote straddles two sentences, select the one with the biggest overlap.
 let chosen=null,bestOverlap=0;
 for(const sentence of sentences){
  const overlap=Math.max(0,Math.min(sentence.end,bounds.end)-Math.max(sentence.start,bounds.start));
  if(overlap>bestOverlap){chosen=sentence;bestOverlap=overlap}
 }
 return chosen&&bestOverlap>=Math.min(15,bounds.end-bounds.start)?chosen:null;
}

function revealEvidenceInText(quote,area=$("ebookText"),onBack=()=>go($("quiz"))){
 if(!quote)return false;
 for(const previous of area.querySelectorAll("mark.ebook-source-highlight")){
  previous.replaceWith(...Array.from(previous.childNodes));
 }
 for(const previous of area.querySelectorAll(".source-inline-return"))previous.remove();
 // Search within rendered blocks rather than requiring an element to have no
 // nested markup. The latter silently skipped quotes inside emphasis/links.
 const selectors="p, li, td, th, dd, dt, blockquote, figcaption, .ebook-fact, .ebook-source";
 const nodes=Array.from(area.querySelectorAll(selectors)).filter(el=>
   !el.querySelector("p, li, td, th, dd, dt, blockquote, figcaption"));
 for(const el of nodes){
  const full=el.textContent||"";
  const sentence=fullSentenceContaining(full,quote);
  if(!sentence)continue;
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
  const segments=[];let cursor=0,node;
  while((node=walker.nextNode())){
   if(node.parentElement?.closest("button,script,style"))continue;
   const next=cursor+node.textContent.length;
   segments.push({node,start:cursor,end:next});cursor=next;
  }
  const first=segments.find(x=>x.end>sentence.start);
  const last=segments.find(x=>x.end>=sentence.end);
  if(!first||!last)continue;
  const range=document.createRange();
  range.setStart(first.node,sentence.start-first.start);
  range.setEnd(last.node,sentence.end-last.start);
  const mark=make("mark","ebook-source-highlight");
  mark.append(range.extractContents());
  range.insertNode(mark);
  const back=make("span","source-inline-return");
  const button=make("button","secondary","← Повернутися до запитання");
  button.onclick=onBack;back.append(button);
  // Exactly one return button, directly after the highlighted answer.
  mark.after(back);
  const details=mark.closest("details");if(details)details.open=true;
  mark.scrollIntoView({behavior:"smooth",block:"center"});
  return true;
 }
 return false;
}
function findEvidencePoint(quote){
 if(!quote)return null;
 const length=(points[lessons[lessonIndex]?.id]||[]).length;
 for(let i=0;i<length;i++){
  const part=textCache.get(lessonIndex+":"+i);
  if(part?.text&&evidenceBounds(part.text,quote))return i;
 }
 return null;
}
// Recover a textbook location even for questions cached before sourceQuote was added.
// We score individual text passages using the question AND its correct answer.
// If confidence is too low, jump to the reading passage without a false highlight.
const evidenceStopWords=new Set(("який яка які яке коли куди чому для через після перед було були була буде років року роках час чим що хто як це цей цих при між через про свою своєї своїх до від над під із та або але не на у в за по його їх вона вони має мала підручник текст параграф пункт якій котрий тієї часів вкажи назви поясни правильну відповідь відповідний історії історичний період періоду друга світова війна").split(/\s+/u));
// Numeric answers may be written in the textbook as words: 6 = «шість».
// Canonical numbers prevent accidentally treating digits inside a date as an answer.
function evidenceNumber(token){
 const w=String(token||"").toLocaleLowerCase("uk").replace(/[ʼ’']/gu,"");
 if(/^\d+(?:[,.]\d+)?$/u.test(w))return w.replace(",",".");
 const words=[
 ["0",/^(нуль|нуля|нулю)$/u],
 ["1",/^(один|одна|одне|однієї|одного|одну|одним|одні|однією)$/u],
 ["2",/^(два|дві|двох|двома|двом)$/u],
 ["3",/^(три|трьох|трьома|трьом)$/u],
 ["4",/^(чотири|чотирьох|чотирма|чотирьом)$/u],
 ["5",/^(пять|пяти|пятьох|пятьма)$/u],
 ["6",/^(шість|шести|шістьох|шістьма|шестеро)$/u],
 ["7",/^(сім|семи|сімох|сімома|семеро)$/u],
 ["8",/^(вісім|восьми|вісьмох|вісьмома|восьмеро)$/u],
 ["9",/^(девять|девяти|девятьох|девятьма)$/u],
 ["10",/^(десять|десяти|десятьох|десятьма)$/u],
 ["11",/^(одинадцять|одинадцяти)$/u],
 ["12",/^(дванадцять|дванадцяти)$/u],
 ["13",/^(тринадцять|тринадцяти)$/u],
 ["14",/^(чотирнадцять|чотирнадцяти)$/u],
 ["15",/^(пятнадцять|пятнадцяти)$/u],
 ["16",/^(шістнадцять|шістнадцяти)$/u],
 ["17",/^(сімнадцять|сімнадцяти)$/u],
 ["18",/^(вісімнадцять|вісімнадцяти)$/u],
 ["19",/^(девятнадцять|девятнадцяти)$/u],
 ["20",/^(двадцять|двадцяти)$/u],
 ["30",/^(тридцять|тридцяти)$/u],
 ["40",/^(сорок|сорока)$/u],
 ["50",/^(пятдесят|пятдесяти)$/u],
 ["60",/^(шістдесят|шістдесяти)$/u],
 ["70",/^(сімдесят|сімдесяти)$/u],
 ["80",/^(вісімдесят|вісімдесяти)$/u],
 ["90",/^(девяносто|девяноста)$/u],
 ["100",/^(сто|ста)$/u]
 ];
 return words.find(([,pattern])=>pattern.test(w))?.[0]||null;
}
function evidenceTerms(text){
 const result=new Set();
 for(const raw of String(text||"").toLocaleLowerCase("uk").match(/[\p{L}\p{N}]+(?:[ʼ’'][\p{L}]+|[,.][0-9]+)?/gu)||[]){
  const token=raw.replace(",",".");
  const number=evidenceNumber(token);
  if(number!==null){result.add(number);continue}
  if(token.length<4&&!["сша","упа","оон","оун"].includes(token))continue;
  if(evidenceStopWords.has(token))continue;
  result.add(token.slice(0,token.length>=6?5:token.length));
 }
 return [...result];
}
function normalizedSourceText(text){return evidenceIndex(text).value}
function evidencePassages(part){
 const blocks=part?.blocks||[];
 const collected=[];
 for(const b of blocks){
  if(["text","source","note","conclusion"].includes(b.type))collected.push(b.text||"");
  if(b.type==="list")collected.push(...(b.items||[]));
  if(b.type==="table")collected.push(...(b.rows||[]).flat().map(String));
  if(b.type==="terms")collected.push(...(b.entries||[]).map(x=>x.term+" "+x.definition));
  if(b.type==="chart"&&b.caption)collected.push(b.caption);
 }
 if(!collected.length)collected.push(...(part?.paragraphs||[]));
 return collected.filter(x=>String(x).trim().length>25);
}
function candidateEvidenceSentences(q,part){
 const answer=String(q.type==="open"?q.referenceAnswer:q.options?.[q.correct]||"").trim();
 const answerTerms=evidenceTerms(answer),questionTerms=evidenceTerms(q.question||"");
 const extraTerms=evidenceTerms(q.explanation||"");
 const quote=String(q.sourceQuote||q.sourceSentence||"").trim();
 const normQuote=normalizedSourceText(quote),normAnswer=normalizedSourceText(answer);
 const choices=[];
 for(const passage of evidencePassages(part)){
  const quoteIsHere=normQuote.length>=20&&normalizedSourceText(passage).includes(normQuote);
  const linked=quoteIsHere?fullSentenceContaining(passage,quote):null;
  for(const sentence of textbookSentenceRanges(passage)){
   if(sentence.text.split(/\s+/u).length<3)continue;
   const normalized=normalizedSourceText(sentence.text),tokens=new Set(evidenceTerms(sentence.text));
   const answerHits=answerTerms.filter(t=>tokens.has(t)).length;
   const questionHits=questionTerms.filter(t=>tokens.has(t)).length;
   const extraHits=extraTerms.filter(t=>tokens.has(t)).length;
   const phraseMatch=normAnswer.length>=5&&normalized.includes(normAnswer);
   const fromQuote=Boolean(linked&&linked.text===sentence.text);
   const score=answerHits*7+questionHits*2+Math.min(3,extraHits)+
     (phraseMatch?40:0)+(fromQuote?35:0);
   // A verbatim AI source quote is stronger than lexical similarity alone.
   // For older questions without an anchor, require several thematic hits.
   const credible=phraseMatch||fromQuote||
     (answerHits>=1&&(questionHits>=1||answerHits>=2))||
     (questionHits>=2&&extraHits>=1);
   if(credible)choices.push({quote:sentence.text,score,answerHits,questionHits,fromQuote});
  }
 }
 return choices.sort((a,b)=>b.score-a.score||a.quote.length-b.quote.length);
}
function bestMatchingEvidence(q,part){return candidateEvidenceSentences(q,part)[0]||null}
function determineEvidence(q,mode){
 const length=(points[lessons[lessonIndex]?.id]||[]).length;
 const indices=mode==="review"&&Number.isInteger(q.sourcePoint)&&q.sourcePoint>=1&&q.sourcePoint<=length?
  [q.sourcePoint-1]:[pointIndex];
 if(mode==="review"&&!Number.isInteger(q.sourcePoint))
  for(let i=0;i<length;i++)if(i!==pointIndex)indices.push(i);
 let best=null;
 for(const index of indices){
  const part=textCache.get(lessonIndex+":"+index)||(index===pointIndex?current:null);
  if(!part)continue;
  const found=bestMatchingEvidence(q,part);
  if(found&&(!best||found.score>best.score))best={...found,point:index};
 }
 return best;
}
// Keep the quiz DOM and answers intact while showing a source from another point.
function returnToQuizFromEvidence(){
 $("evidenceView").hidden=true;
 $("readerArticle").hidden=false;
 if(quizState)$("quiz").hidden=false;
 go($("quiz"));
}
function focusEvidenceQuote(value,q){
 return String(value||"").trim();
}
async function showEvidenceForQuestion(q,feedback,mode){
 const savedState=quizState,version=loadToken;
 const length=(points[lessons[lessonIndex]?.id]||[]).length;
 const isReview=mode==="review";
 let found=determineEvidence(q,mode);
 let index=isReview && Number.isInteger(q.sourcePoint) && q.sourcePoint>=1 &&
   q.sourcePoint<=length ?q.sourcePoint-1:found?.point??pointIndex;
 if(index<0||index>=length)index=pointIndex;
 const box=$("evidenceView"),host=$("evidenceText");
 host.replaceChildren(make("p","source-note","Відкриваю відповідний пункт підручника…"));
 $("evidenceTitle").textContent="Пункт "+(index+1)+" · "+lessons[lessonIndex].title;
 box.hidden=false;$("quiz").hidden=true;$("readerArticle").hidden=true;
 go(box);
 try{
  const part=await fetchPoint(lessonIndex,index);
  if(version!==loadToken||quizState!==savedState)return;
  if(Array.isArray(part.blocks)&&part.blocks.length)renderEbookBlocks(host,part.blocks);
  else{host.replaceChildren();(part.paragraphs||[]).forEach(p=>host.append(make("p",null,bookTypography(p))))}
  // Exact quotes come from the textbook; old quizzes use the closest passage.
  const candidate=bestMatchingEvidence(q,part);
  // If the best-scored answer cannot be rendered, try the verified AI quote
  // and the remaining candidates before reporting an actual missing source.
  const candidates=[candidate?.quote,q.sourceQuote,q.sourceSentence,
    ...candidateEvidenceSentences(q,part).slice(0,8).map(x=>x.quote)]
    .filter((v,i,a)=>v&&a.indexOf(v)===i);
  if(!candidates.some(quote=>revealEvidenceInText(quote,host,returnToQuizFromEvidence))){
   const info=make("p","source-note","Не вдалося надійно знайти речення, яке підтверджує правильну відповідь. Відповідь у тесті збережена.");
   const back=make("div","source-inline-return");
   const btn=make("button","secondary","← Повернутися до запитання");
   btn.onclick=returnToQuizFromEvidence;back.append(btn);
   host.prepend(back);host.prepend(info);go(box);
  }
 }catch(error){
  if(version!==loadToken)return;
  host.replaceChildren(make("p","source-note","Не вдалося відкрити текст: "+error.message));
 }
}
function showQuestion(){
 const state=quizState;
 if(!state || state.index>=state.questions.length)return;
 if(!Array.isArray(state.results))state.results=[];
 const index=state.index,q=state.questions[index],card=$("quiz");
 card.hidden=false;card.replaceChildren();
 card.append(quizStepBar(state));
 const label=make("span","pill",state.mode==="spaced"?"Інтервальне повторення":state.mode==="point"?"Навчальна зупинка":
  state.mode==="practice"?"Повторення складного":"Самостійна робота");
 card.append(label,make("p","qNo","Запитання "+(index+1)+" із "+state.questions.length),
  make("h2","questionText",q.question));
 const report=make("button","secondary quiz-report","⚑ Повідомити про помилку");
 report.type="button";
 report.onclick=async()=>{
  if(report.disabled)return;
  const reason=window.prompt("Що саме неправильно в запитанні? (необов’язково)","Неправильна правильна відповідь");
  if(reason===null)return;
  report.disabled=true;report.textContent="Надсилаю повідомлення…";
  try{
   const response=await fetch("/api/quiz-report",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({question:q.question,options:q.options||[],
      correct:q.correct,reason:reason.slice(0,300),book:BOOK,mode:state.mode})
   });
   if(!response.ok)throw Error("Сервер тимчасово недоступний");
   report.textContent="✓ Повідомлення надіслано";
  }catch(error){
   report.disabled=false;report.textContent="⚑ Спробувати повідомити ще раз";
  }
 };
 card.append(report);
 const feedback=make("div","quizFeedback");feedback.hidden=true;
 let verified=false,verifyButton=null,skipButton=null;
 activeTeacherQuizContext=questionContextFromQuiz(q,state.results[index]);
 refreshTeacherContext();
 const current=()=>quizState===state&&state.index===index&&loadToken===state.loadVersion;
 const next=make("button","primary",index===state.questions.length-1?
   "Завершити перевірку":"Наступне запитання →");
 next.onclick=()=>{
  if(!verified||!current())return;
  next.disabled=true;state.index++;
  if(state.index===state.questions.length){finishQuiz(state.mode);return}
  showQuestion();go($("quiz"));
 };
 const record=(result,message)=>{
  if(verified||!current())return;
  verified=true;state.results[index]={question:q.question,type:q.type||"choice",...result};
  verifyButton?.remove();skipButton?.remove();
  activeTeacherQuizContext=questionContextFromQuiz(q,result);
  refreshTeacherContext();
  if(result.status==="correct")state.done=(state.done||0)+1;
  feedback.hidden=false;
  feedback.className="quiz-feedback-box "+(result.status==="correct"?"is-correct":
    result.status==="wrong"?"is-wrong":"is-neutral");
  explainMarkup(feedback,message);
  if(result.status==="wrong"){
   const find=make("button","secondary","📖 Показати в тексті");
   find.onclick=()=>showEvidenceForQuestion(q,feedback,state.mode);
   const row=make("div","source-back-link");row.append(find);card.append(row);
  }
  card.append(next);go(feedback);
 };
 const skipOne=make("button","secondary",q.type==="open"?"Пропустити письмову відповідь →":"Пропустити запитання →");skipButton=skipOne;
 skipOne.onclick=()=>{
  if(verified||!current())return;
  verified=true;state.skipped=(state.skipped||0)+1;
  state.results[index]={status:"skipped",question:q.question,type:q.type||"choice",correctAnswer:
    q.type==="open"?q.referenceAnswer:q.options?.[q.correct]||""};
  state.index++;
  if(state.index===state.questions.length)finishQuiz(state.mode);
  else{showQuestion();go($("quiz"))}
 };
 if(q.type==="open"){
  const hint=make("p","small","Відповідай своїми словами: ШІ перевірить зміст, а не дослівний збіг.");
  const input=make("textarea","written");input.rows=5;input.maxLength=1800;
  input.placeholder="Моя відповідь…";
  const check=make("button","primary","Перевірити письмову відповідь");verifyButton=check;
  check.onclick=async()=>{
   if(verified||!current())return;
   const answer=input.value.trim();
   if(answer.length<5){feedback.hidden=false;feedback.textContent="Напиши хоча б одне речення.";return}
   check.disabled=true;input.readOnly=true;
   feedback.hidden=false;feedback.className="quiz-feedback-box is-neutral";
   feedback.textContent="ШІ перевіряє твою відповідь…";
   try{
    const data=await aiCall("check-open",{
     text:window.currentLessonText||globalLessonText(),question:q.question,
     studentAnswer:answer,referenceAnswer:q.referenceAnswer
    });
    if(!current()||verified)return;
    const status=data.passed===true?"correct":data.passed===false?"wrong":"ungraded";
    record({status,userAnswer:answer,correctAnswer:q.referenceAnswer,explanation:data.answer||""},
      (status==="correct"?"✓ Правильно. ":status==="wrong"?"✕ Ще не зовсім. ":"Перевірка без оцінки. ")+
      (data.answer||"Орієнтовна відповідь: "+q.referenceAnswer));
   }catch(error){
    if(!current()||verified)return;
    record({status:"ungraded",userAnswer:answer,correctAnswer:q.referenceAnswer,
      explanation:"ШІ зараз не відповідає."},
      "ШІ зараз недоступний, тому не зараховую відповідь як правильну. Орієнтовна відповідь: "+q.referenceAnswer);
   }
  };
  card.append(hint,input,check,skipOne,feedback);return;
 }
 let chosen=-1;
 const answers=make("div","answers");
 const buttons=q.options.map((option,i)=>{
  const button=make("button","choice");button.type="button";
  button.append(make("b",null,"АБВГ"[i]),make("span","answer-text",option),make("span","choice-mark"));
  button.onclick=()=>{
   if(verified||!current())return;
   chosen=i;buttons.forEach(b=>b.classList.remove("selected"));button.classList.add("selected");
  };
  return button;
 });
 buttons.forEach(b=>answers.append(b));
 const check=make("button","primary","Перевірити відповідь");verifyButton=check;
 check.onclick=()=>{
  if(verified||!current())return;
  if(chosen<0){feedback.hidden=false;feedback.textContent="Спочатку вибери відповідь.";return}
  buttons[q.correct].classList.add("correct");
  buttons[q.correct].querySelector(".choice-mark").textContent="✓";
  if(chosen!==q.correct){
   buttons[chosen].classList.add("wrong");
   buttons[chosen].querySelector(".choice-mark").textContent="✕";
  }
  buttons.forEach(b=>b.disabled=true);
  check.disabled=true;
  record({status:chosen===q.correct?"correct":"wrong",userAnswer:q.options[chosen],
   correctAnswer:q.options[q.correct],explanation:q.explanation||""},
   (chosen===q.correct?"✓ Правильно! ":"✕ Ще ні. Правильна відповідь: "+
    q.options[q.correct]+(/[.!?…]\s*$/u.test(q.options[q.correct])?" ":". "))+
    (q.explanation||"Перечитай відповідний уривок підручника."));
 };
 card.append(answers,check,skipOne,feedback);
}
function globalLessonText(){
 if(quizState?.mode==="review")return quizState.sourceText||current?.text||"";
 return current?.text?.slice(0,14700)||"";
}
function finishQuiz(mode){
 if(quizState)recordSpaced(quizState);
 const state=quizState;
 if(!state)return;
 const lesson=lessons[lessonIndex],results=state.results||[];
 const score=results.filter(r=>r?.status==="correct").length;
 const hasSkipped=results.some(r=>r?.status==="skipped");
 $("quiz").hidden=true;
 if(mode==="point"){
  const key=pointId();
  pointAttempts[key]={score,total:state.questions.length,results:results.slice(),
    questions:state.questions,at:Date.now()};
  toStore(ATTEMPTS,pointAttempts);
  if(hasSkipped){completed.delete(key);skipped.add(key)}
  else{skipped.delete(key);completed.add(key)}
  toStore(DONE,[...completed]);toStore(SKIPPED,[...skipped]);
  showCompletion(false);progress();
  return;
 }
 if(mode==="spaced"){
  const host=$("finished");host.replaceChildren();host.hidden=false;
  host.append(make("h2",null,"Повторення завершено"),make("p","small",score+" із "+state.questions.length+" правильних"));
  const back=make("button","primary","До читання");back.onclick=()=>loadPoint(lessonIndex,pointIndex);
  host.append(back);go(host);return;
 }
 if(mode==="practice"){
  const host=$("finished");host.replaceChildren();host.hidden=false;
  host.append(make("span","finish-badge","ПОВТОРЕННЯ ЗАВЕРШЕНО"),
   make("h2",null,"Тренування завершено"),
   make("div","score-big",score+" із "+state.questions.length),
   make("p","small","Це тренування не змінює результат основної перевірки."));
  const back=make("button","primary","До результату пункту");
  back.onclick=()=>showCompletion(true);
  host.append(back);go(host);return;
 }
 if(!hasSkipped){reviews.add(lesson.id);toStore(REVIEW_DONE,[...reviews])}
 showReviewCompleted(hasSkipped,score,state.questions.length);
}
function addMistakeReview(host,attempt){
 const box=make("div","review-errors");box.hidden=true;
 box.append(make("h3",null,"Розбір запитань"));
 const results=attempt?.results||[];
 let misses=0;
 results.forEach((r,i)=>{
  if(!r||r.status==="correct")return;
  misses++;
  const item=make("div","review-item");
  item.append(make("strong",null,(i+1)+". "+r.question),
    make("p",null,"Твоя відповідь: "+(r.status==="skipped"?"пропущено":r.userAnswer||"без відповіді")));
  if(r.correctAnswer)item.append(make("p",null,"Орієнтовна правильна відповідь: "+r.correctAnswer));
  if(r.explanation)item.append(make("p",null,"Пояснення: "+r.explanation));
  if(r.status==="ungraded")item.append(make("p",null,"ШІ не зміг підтвердити правильність відповіді."));
  box.append(item);
 });
 if(!misses)box.append(make("p",null,"Помилок немає!"));
 host.append(box);return box;
}
function showCompletion(already){
 $("readEnd").hidden=true;$("review").hidden=true;
 const host=$("finished");host.hidden=false;host.replaceChildren();
 const lesson=lessons[lessonIndex],key=pointId();
 const incomplete=skipped.has(key)&&!completed.has(key);
 const attempt=pointAttempts[key]||null;
 const length=(points[lesson.id]||[]).length,finalPoint=pointIndex===length-1;
 host.append(make("span","finish-badge",incomplete?"ПРОПУЩЕНО":"ЗАВЕРШЕНО"),
  make("h2",null,incomplete?"Перевірку можна пройти пізніше":"Пункт завершено!"));
 if(attempt){
  const result=make("div","compact-score");
  result.append(make("strong",null,attempt.score+" із "+attempt.total),
   make("span",null,"правильних відповідей"));
  host.append(result);
  const misses=attempt.results.filter(x=>x.status!=="correct");
  host.append(make("p","repeat-note",misses.length
   ?"Є "+misses.length+" запитань для повторення."
   :"Усі відповіді правильні!"));
 }else host.append(make("p","small","Можна продовжити читання та повернутися до перевірки пізніше."));
 const primary=make("div","completion-main-actions");
 if(finalPoint){
  const test=make("button","primary","📝 Самостійна робота");
  test.onclick=startParagraphReview;primary.append(test);
 }
 const goNext=make("button",finalPoint?"secondary":"primary",
  finalPoint?(lessonIndex<lessons.length-1?"Наступний параграф →":"Книгу пройдено ✓"):
   "Наступний пункт →");
 goNext.onclick=()=>nextPoint();primary.append(goNext);
 host.append(primary);
 const extra=make("details","completion-more");
 extra.append(make("summary",null,"Додаткові дії"));
 const secondary=make("div","actions");
 if(attempt){
  const mistakes=addMistakeReview(extra,attempt);
  const reviewButton=make("button","secondary","Переглянути помилки");
  reviewButton.onclick=()=>{
   mistakes.hidden=!mistakes.hidden;
   reviewButton.textContent=mistakes.hidden?"Переглянути помилки":"Сховати помилки";
   if(!mistakes.hidden)go(mistakes);
  };
  secondary.append(reviewButton);
  const missedIndices=attempt.results.map((r,i)=>r.status==="correct"?-1:i).filter(i=>i>=0);
  if(missedIndices.length&&missedIndices.every(i=>attempt.questions?.[i])){
   const practice=make("button","secondary","Повторити складне");
   practice.onclick=()=>{
    quizState={questions:missedIndices.map(i=>attempt.questions[i]),index:0,
     mode:"practice",done:0,results:[],loadVersion:loadToken};
    host.hidden=true;$("paragraphSummary").hidden=true;$("quiz").hidden=false;
    showQuestion();go($("quiz"));
   };
   secondary.append(practice);
  }
 }
 const again=make("button","secondary",incomplete?"Пройти 5 запитань":"↻ Пройти пункт ще раз");
 again.onclick=startQuiz;secondary.append(again);
 if(finalPoint){

 }
 extra.append(secondary);host.append(extra);
 if(finalPoint)showParagraphSummary();
 else $("paragraphSummary").hidden=true;
 if(!already)go(host);
}
function nextPoint(){
 const lesson=lessons[lessonIndex],length=(points[lesson.id]||[]).length;
 if(pointIndex<length-1)return loadPoint(lessonIndex,pointIndex+1);
 if(lessonIndex<lessons.length-1)return loadPoint(lessonIndex+1,0);
 $("finished").append(make("p",null,"Ти пройшов(ла) всі доступні параграфи!"));
}
async function fullParagraphText(){
 const lesson=lessons[lessonIndex],length=(points[lesson.id]||[]).length;
 const result=[],maxPerPoint=Math.max(650,Math.floor(14000/Math.max(length,1))-40);
 for(let i=0;i<length;i++){
  const source=String((await fetchPoint(lessonIndex,i)).text||"");
  let sample=source;
  if(source.length>maxPerPoint){
   const head=Math.round(maxPerPoint*.76),tail=maxPerPoint-head;
   sample=source.slice(0,head).replace(/\s+\S*$/,"").trim()+
     "\n[... продовження пункту ...]\n"+
     source.slice(-tail).replace(/^\S*\s/,"").trim();
  }
  result.push("Пункт "+(i+1)+":\n"+sample);
 }
 return result.join("\n\n").slice(0,14700);
}
async function preparedReviewQuestions(lesson,text){
 const key=lesson.id;
 // The first two lessons have editor-checked, already-written exam sheets.
 if(key==="p1"||key==="p2"){
  try{
   const response=await fetch("/books/h11/review-"+key+".json");
   if(response.ok){
    const data=await response.json();
    if(data.lessonId===key&&Array.isArray(data.questions)&&data.questions.length===12&&
      data.questions.every((q,i)=>validQuestion(q,i,"review")))return data.questions;
   }
  }catch(error){console.warn("Prepared review load failed",error.message)}
 }
 // For other lessons, reuse the first valid generation instead of spending free tokens again.
 const fromMemory=locallySavedReviews[key];
 if(Array.isArray(fromMemory)&&fromMemory.length===12&&
    fromMemory.every((q,i)=>validQuestion(q,i,"review")))return fromMemory;
 const fresh=await aiCall("paragraph-review",{text},60000);
 if(!Array.isArray(fresh.questions)||fresh.questions.length!==12||
    !fresh.questions.every((q,i)=>validQuestion(q,i,"review")))throw Error("Некоректні запитання");
 locallySavedReviews[key]=fresh.questions;
 const entries=Object.entries(locallySavedReviews);
 if(entries.length>30)locallySavedReviews=Object.fromEntries(entries.slice(-30));
 toStore(REVIEW_QUIZ_CACHE,locallySavedReviews);
 return fresh.questions;
}
async function startParagraphReview(){
 $("finished").hidden=true;$("review").hidden=false;
 const host=$("review");host.replaceChildren();
 host.append(make("h2",null,"Самостійна робота"),
  make("p","small","Завантажую 12 підготовлених запитань…"));
 go(host);const version=loadToken;
 try{
  const lesson=lessons[lessonIndex];
  const text=await fullParagraphText();if(version!==loadToken)return;
  const questions=await preparedReviewQuestions(lesson,text);
  if(version!==loadToken)return;
  quizState={questions,index:0,mode:"review",done:0,results:[],loadVersion:loadToken,sourceText:text};
  host.hidden=true;$("quiz").hidden=false;showQuestion();go($("quiz"));
 }catch(error){
  if(version!==loadToken)return;
  host.replaceChildren();
  host.append(make("h2",null,"Самостійна поки недоступна"),make("p","small",error.message));
  const back=make("button","secondary","Повернутися");back.onclick=()=>{host.hidden=true;showCompletion(true)};
  host.append(back);
 }
}
function showReviewCompleted(partial=false,score=null,total=6){
 const host=$("review");host.hidden=false;host.replaceChildren();
 host.append(make("h2",null,partial?"Самостійна робота завершена з пропусками":"Самостійну роботу завершено!"));
 if(typeof score==="number")host.append(make("div","score-big",score+" із "+total));
 host.append(make("p","small",partial?"Пропущені запитання не зараховуються як правильні. Самостійну можна пройти ще раз.":"Результат збережено. Можеш переказати матеріал або перейти до наступного параграфа."));
 const actions=make("div","actions");
 const retell=make("button","secondary","🧠 Закріпити знання");
 retell.onclick=()=>{
  host.hidden=true;showCompletion(true);
  go($("paragraphSummary"));
 };
 const next=make("button","primary","Продовжити читання →");next.onclick=nextPoint;
 actions.append(retell,next);host.append(actions);go(host);
}
function openRetelling(){
 const host=$("review");$("finished").hidden=true;host.hidden=false;host.replaceChildren();
 host.append(make("h2",null,"Переказ своїми словами"),
  make("p","small","Спробуй пригадати головні події, дати та їхні причини. Потім звір відповідь зі списком основних дат і подій."));
 const input=make("textarea","written");input.maxLength=2500;input.rows=8;
 input.placeholder="Я зрозумів(ла), що…";
 const responseHost=make("div","reviewText");responseHost.hidden=true;
 const check=make("button","primary","Отримати відгук ШІ");
 check.onclick=async()=>{
  if(input.value.trim().length<30){responseHost.hidden=false;responseHost.textContent="Напиши хоча б кілька речень.";return}
  check.disabled=true;responseHost.hidden=false;responseHost.textContent="ШІ читає переказ…";
  const version=loadToken;
  try{
   const text=await fullParagraphText();if(version!==loadToken)return;
   const result=await aiCall("assess-retelling",{text,retelling:input.value.trim()});
   if(version!==loadToken)return;
   explainMarkup(responseHost,result.answer||"Відгук недоступний.");
  }catch(error){if(version===loadToken)responseHost.textContent=error.message}
  finally{check.disabled=false}
 };
 const compare=make("button","secondary","📅 Переглянути основні дати і події");
 compare.onclick=()=>{
  host.hidden=true;showCompletion(true);
  const summary=$("paragraphSummary");
  const details=summary.querySelector(".synopsis-toggle");
  if(details)details.open=true;
  go(summary);
 };
 const back=make("button","secondary","Повернутися до пункту");
 back.onclick=()=>{host.hidden=true;showCompletion(true)};
 const actions=make("div","actions");actions.append(compare,back);
 host.append(input,check,responseHost,actions);go(host);
}
function teacherThreadKey(){return lessons[lessonIndex]?.id||"general"}
function currentTeacherThread(){
 const thread=teacherChats[teacherThreadKey()];
 return Array.isArray(thread)?thread:[];
}
function saveTeacherThread(thread,key=teacherThreadKey()){
 teacherChats[key]=thread.slice(-32).map(m=>({
  role:m.role==="assistant"?"assistant":"user",
  content:String(m.content||"").slice(0,2500),
  ...(m.context?{context:m.context}:{})
 }));
 const keys=Object.keys(teacherChats);
 if(keys.length>30)for(const keyToRemove of keys.slice(0,keys.length-30))delete teacherChats[keyToRemove];
 toStore(TEACHER_CHAT_KEY,teacherChats);
}
function renderTeacherMessages(){
 const host=$("teacherMessages"),messages=currentTeacherThread();
 host.replaceChildren();
 if(!messages.length){
  host.append(make("p","teacher-empty","Привіт! Запитай про події з підручника або про відповідь у тесті. Я запам’ятаю нашу розмову, і ти зможеш продовжити її пізніше."));
 }else for(const message of messages){
  const card=make("div","teacher-message "+(message.role==="user"?"user":"assistant"));
  const body=make("div","message-body");
  explainMarkup(body,String(message.content||""));
  card.append(body);
  host.append(card);
 }
 host.scrollTop=host.scrollHeight;
}
function refreshTeacherContext(){
 const box=$("teacherContext");
 box.hidden=!activeTeacherQuizContext;
 if(activeTeacherQuizContext){
  $("teacherContextText").textContent="Обговорюємо запитання: "+activeTeacherQuizContext.question;
 }
}
function setTeacherOpen(visible){
 const panel=$("teacherPanel");
 panel.hidden=!visible;
 $("teacherToggle").setAttribute("aria-expanded",String(Boolean(visible)));
 $("teacherToggle").hidden=Boolean(visible);
 document.body.classList.toggle("teacher-open",Boolean(visible));
 toStore(TEACHER_OPEN_KEY,Boolean(visible));
 if(visible){renderTeacherMessages();refreshTeacherContext()}
}
function questionContextFromQuiz(q,result){
 return {
  question:String(q.question||"").slice(0,450),
  sourcePoint:Number.isInteger(q.sourcePoint)?q.sourcePoint:(pointIndex+1),
  ...(result?.userAnswer?{chosenAnswer:String(result.userAnswer).slice(0,250)}:{}),
  ...(result?.status==="wrong"||result?.status==="correct"?
   {correctAnswer:String(q.type==="open"?q.referenceAnswer:q.options?.[q.correct]||"").slice(0,550)}:{}),
  ...(q.explanation?{explanation:String(q.explanation).slice(0,450)}:{}),
  ...(q.sourceQuote?{sourceQuote:String(q.sourceQuote).slice(0,280)}:{})
 };
}
function openTeacherForQuestion(q,result){
 activeTeacherQuizContext=questionContextFromQuiz(q,result);
 setTeacherOpen(true);
 $("studentQuestion").focus();
}
$("teacherToggle").onclick=()=>{
 if(quizState?.questions?.[quizState.index]&&quizState?.results?.[quizState.index]&&
    !activeTeacherQuizContext){
  const q=quizState.questions[quizState.index];
  activeTeacherQuizContext=questionContextFromQuiz(q,quizState.results[quizState.index]);
 }
 setTeacherOpen(true);
 $("studentQuestion").focus();
};
$("teacherClose").onclick=()=>setTeacherOpen(false);
$("teacherClearContext").onclick=()=>{activeTeacherQuizContext=null;refreshTeacherContext()};
$("teacherClearHistory").onclick=()=>{
 if(!window.confirm("Очистити історію листування для цього параграфа?"))return;
 saveTeacherThread([]);
 activeTeacherQuizContext=null;
 renderTeacherMessages();refreshTeacherContext();
};
$("studentQuestion").addEventListener("keydown",event=>{
 if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){
  event.preventDefault();
  if(!teacherBusy)sendTeacherMessage();
 }
});
async function sendTeacherMessage(){
 const field=$("studentQuestion"),text=field.value.trim();
 if(text.length<3){field.focus();return}
 if(teacherBusy)return;
 const key=teacherThreadKey(),context=activeTeacherQuizContext?
  {...activeTeacherQuizContext}:null;
 const wholeThread=currentTeacherThread();
 const previous=wholeThread.slice(-10);
 const nextMessage={role:"user",content:text,...(context?{context}:{})};
 saveTeacherThread([...wholeThread,nextMessage],key);
 field.value="";
 teacherBusy=true;$("sendQuestion").disabled=true;
 renderTeacherMessages();
 const host=$("teacherMessages"),waiting=make("div","teacher-message assistant","Учитель-ШІ думає…");
 host.append(waiting);host.scrollTop=host.scrollHeight;
 try{
  let source=current?.text||"";
  if(context&&Number.isInteger(context.sourcePoint)){
   try{source=(await fetchPoint(lessonIndex,context.sourcePoint-1)).text||source}catch{}
  }else if(quizState?.mode==="review")source=quizState.sourceText||source;
  const history=previous.map(m=>({role:m.role,content:m.content.slice(0,650)}));
  const data=await aiCall("ask-question",{
   text:String(source).slice(0,14500),question:text,chatHistory:history,
   ...(context?{quizContext:context}:{})
  },40000);
  saveTeacherThread([...currentTeacherThread(),{role:"assistant",content:data.answer||"Не вдалося отримати пояснення."}],key);
 }catch(error){
  saveTeacherThread([...currentTeacherThread(),{role:"assistant",content:"ШІ тимчасово не відповідає: "+error.message}],key);
 }finally{
  teacherBusy=false;$("sendQuestion").disabled=false;
  if(key===teacherThreadKey())renderTeacherMessages();
 }
}
$("sendQuestion").onclick=sendTeacherMessage;
const savedPanel=fromStore(TEACHER_OPEN_KEY,null);
const largeScreen=typeof window.matchMedia==="function"&&window.matchMedia("(min-width:1400px)").matches;
setTeacherOpen(savedPanel===null?largeScreen:Boolean(savedPanel));

async function init(){
 completed=new Set(fromStore(DONE,[]));reviews=new Set(fromStore(REVIEW_DONE,[]));skipped=new Set(fromStore(SKIPPED,[]));
 locallySavedQuestions=fromStore(QUIZ_CACHE,{});pointAttempts=fromStore(ATTEMPTS,{});locallySavedReviews=fromStore(REVIEW_QUIZ_CACHE,{});
 applyFontSize(fromStore(FONT_SIZE,19));
 try{
  const [a,b]=await Promise.all([
   fetch("/books/h11/outline.json",{cache:"no-store"}),
   fetch("/books/h11/points.json",{cache:"no-store"})
  ]);
  if(!a.ok||!b.ok)throw Error("Не знайдено змісту підручника");
  const outline=await a.json(),mapping=await b.json();
  points=mapping.paragraphs||{};flatten(outline.contents);
  if(!lessons.length||!points[lessons[0].id])throw Error("Зміст підручника порожній");
  renderContents(outline.contents);
  const params=new URLSearchParams(location.search),old=fromStore(SAVE,{lessonIndex:0,pointIndex:0});
  const i=params.has("paragraph")?Number(params.get("paragraph"))-1:Number(old.lessonIndex||0);
  const j=params.has("point")?Number(params.get("point"))-1:Number(old.pointIndex||0);
  await loadPoint(Math.max(0,Math.min(lessons.length-1,i)),
   Math.max(0,Math.min((points[lessons[Math.max(0,Math.min(lessons.length-1,i))].id]||[]).length-1,j)));
 }catch(error){showError(error)}
}
init();
