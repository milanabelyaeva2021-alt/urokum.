const $=id=>document.getElementById(id);
const BOOK="history11-gisem-stand";
const SAVE="urokum:ebook-reading:"+BOOK, DONE="urokum:ebook-finished:"+BOOK,
 REVIEW_DONE="urokum:ebook-reviews:"+BOOK, SKIPPED="urokum:ebook-skipped:"+BOOK,
 QUIZ_CACHE="urokum:ebook-quiz-cache:"+BOOK,
 ATTEMPTS="urokum:ebook-attempts:"+BOOK, FONT_SIZE="urokum:ebook-font-size:"+BOOK;
let lessons=[],points={},current=null,lessonIndex=0,pointIndex=0,loadToken=0;
let completed=new Set(),reviews=new Set(),skipped=new Set(),quizState=null,quizRun=0;
let locallySavedQuestions={},pointAttempts={},readerFontSize=19;
const textCache=new Map(),summaryCache=new Map();

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
function updateRestartButton(){
 if(!lessons[lessonIndex])return;
 const count=(points[lessons[lessonIndex].id]||[]).length;
 $("restartParagraphBtn").hidden=!Array.from({length:count},(_,j)=>pointId(lessonIndex,j)).some(key=>
   completed.has(key)||skipped.has(key)||Boolean(pointAttempts[key]));
}
$("restartParagraphBtn").onclick=()=>restartParagraph();
function restartParagraph(){
 const lesson=lessons[lessonIndex];if(!lesson)return;
 for(let j=0;j<(points[lesson.id]||[]).length;j++){
  completed.delete(lesson.id+":"+(j+1));skipped.delete(lesson.id+":"+(j+1));
 }
 toStore(DONE,[...completed]);toStore(SKIPPED,[...skipped]);
 $("paragraphSummary").hidden=true;
 loadPoint(lessonIndex,0);
}
const PREPARED_SUMMARIES={
 p1:[
  "Другий період Новітньої історії України охоплює 1945 р. — початок XXI ст.",
  "Після Другої світової війни світ розділився на два блоки, розгорнулося протистояння США та СРСР.",
  "24 серпня 1991 р. Україна проголосила незалежність; почалося становлення незалежної держави.",
  "Друга світова війна завдала Україні величезних людських та матеріальних втрат.",
  "За переписом 1959 р. українці становили 76,8 % населення УРСР."
 ],
 p2:[
  "Після Другої світової війни кордони УРСР визначалися домовленостями з Польщею, Чехословаччиною та Румунією.",
  "Переселення населення між УРСР і Польщею часто було примусовим.",
  "У 1947 р. польська влада здійснила операцію «Вісла», під час якої українців депортували з їхніх етнічних земель.",
  "У 1945 р. УРСР стала однією з країн — засновниць ООН, але її зовнішня політика залежала від СРСР."
 ]
};
function firstSummarySentence(value){
 const text=String(value||"").replace(/\s+/g," ").trim();
 if(!text)return "";
 const sentence=text.match(/^(.{20,220}?[.!?])(?:\s|$)/u);
 return (sentence?sentence[1]:text.slice(0,210).replace(/\s+\S*$/,"")+"…").trim();
}
async function shortParagraphSummary(i){
 const lesson=lessons[i],key=lesson.id;
 if(summaryCache.has(key))return summaryCache.get(key);
 if(PREPARED_SUMMARIES[key])return PREPARED_SUMMARIES[key];
 const length=(points[key]||[]).length,items=[];
 for(let j=0;j<length;j++){
  const part=await fetchPoint(i,j);
  const blocks=Array.isArray(part.blocks)?part.blocks:[];
  const intro=blocks.find(x=>x.type==="text"&&String(x.text||"").length>50)?.text||
    part.paragraphs?.find(x=>String(x||"").length>50)||"";
  const sentence=firstSummarySentence(intro);
  if(sentence)items.push(sentence);
  if(items.length>=6)break;
 }
 summaryCache.set(key,items);
 return items;
}
async function showParagraphSummary(){
 const host=$("paragraphSummary"),lesson=lessons[lessonIndex];
 if(!lesson)return;
 const length=(points[lesson.id]||[]).length;
 if(pointIndex!==length-1){host.hidden=true;return}
 const version=loadToken,lessonAtStart=lessonIndex;
 host.hidden=false;host.replaceChildren();
 host.append(make("h2",null,"📚 Короткий конспект параграфа"),
  make("p","small","Готую основні тези з підручника…"));
 try{
  const items=await shortParagraphSummary(lessonAtStart);
  if(version!==loadToken||lessonAtStart!==lessonIndex)return;
  host.replaceChildren();host.append(make("h2",null,"📚 Короткий конспект параграфа"));
  const list=make("ol");
  for(const item of items)list.append(make("li",null,item));
  host.append(list);
  if(!PREPARED_SUMMARIES[lesson.id]){
   host.append(make("p","summary-footnote","Тези вибрано з тексту пунктів. Звіряй складні місця з підручником."));
  }
  if(!items.length)host.append(make("p","small","Для цього параграфа поки немає готових тез."));
 }catch(error){
  if(version!==loadToken)return;
  host.replaceChildren();host.append(make("h2",null,"📚 Короткий конспект"),
   make("p","small","Не вдалося завантажити тези параграфа."));
 }
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
   host.append(make("h2","point-heading",block.text));continue;
  }
  if(block.type==="text"){
   host.append(make("p",null,block.text));continue;
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
   for(const item of block.items||[])ul.append(make("li",null,item));
   host.append(ul);continue;
  }
  if(block.type==="terms"){
   const details=make("details","ebook-vocab");
   details.append(make("summary",null,"📖 "+(block.title||"Словничок")));
   const dl=make("dl");
   for(const item of block.entries||[]){
    dl.append(make("dt",null,item.term),make("dd",null,item.definition));
   }
   details.append(dl);host.append(details);continue;
  }
  if(block.type==="note"){
   const details=make("details","ebook-fact");
   details.append(make("summary",null,"✨ "+(block.title||"Цікавий факт")));
   details.append(make("p",null,block.text||""));
   host.append(details);continue;
  }
  if(block.type==="source"){
   const details=make("details","ebook-source");
   details.append(make("summary",null,"📜 "+(block.title||"Історичне джерело")));
   details.append(make("p","source-caption",block.caption||""));
   details.append(make("blockquote",null,block.text||""));
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
 const qs=$("studentQuestion");qs.value="";$("answerFromAI").hidden=true;
 try{
  const data=await fetchPoint(i,j);
  if(token!==loadToken)return;
  current=data;
  const lesson=lessons[i];
  $("lessonEyebrow").textContent="Історія України · 11 клас · "+lesson.title.split(".")[0];
  $("lessonTitle").textContent=lesson.title;
  $("lessonSubtitle").textContent="Електронний текст • Пункт "+data.point+" із "+data.pointCount+
    " • Сторінки оригінального видання: "+data.pages.join("–");
  $("pointNumber").textContent=String(data.point);
  $("pointLabel").textContent="Читай текст — після нього буде зупинка";
  const host=$("ebookText");
  if(Array.isArray(data.blocks)&&data.blocks.length)renderEbookBlocks(host,data.blocks);
  else{host.replaceChildren();data.paragraphs.forEach(part=>host.append(make("p",null,part)))}
  $("loading").hidden=true;$("bookShell").hidden=false;
  progress();updateRestartButton();
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
 if(mode==="point"&&index>=3)
  return q.type==="open"&&typeof q.referenceAnswer==="string"&&q.referenceAnswer.trim().length>5;
 return Array.isArray(q.options)&&q.options.length===4&&
   q.options.every(x=>typeof x==="string")&&Number.isInteger(q.correct)&&q.correct>=0&&q.correct<4;
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
  $("readEnd").hidden=true;$("finished").hidden=true;$("quiz").hidden=false;
  quizState={questions:cached,index:0,mode:"point",done:0};
  showQuestion();go($("quiz"));return;
 }
 $("readEnd").hidden=true;$("finished").hidden=true;
 const card=$("quiz");card.hidden=false;card.replaceChildren();
 card.append(make("span","pill","Навчальна зупинка"),make("h2",null,"Перевіримо, що ти зрозумів(ла)"));
 const status=make("p","small","ШІ готує 5 запитань: 3 з варіантами та 2 письмові.");
 const skip=make("button","secondary","Пропустити перевірку →");skip.onclick=skipCheckpoint;
 card.append(status,skip);go(card);
 const version=loadToken,attempt=++quizRun;
 try{
  const response=await aiCall("multi-checkpoint",{text:current.text.slice(0,14700)});
  if(version!==loadToken||attempt!==quizRun)return;
  if(!Array.isArray(response.questions)||response.questions.length!==5||
     !response.questions.every((q,i)=>validQuestion(q,i,"point")))
   throw Error("Отримано некоректний формат запитань");
  quizState={questions:response.questions,index:0,mode:"point",done:0};
  locallySavedQuestions[cacheKey]=response.questions;
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
function showQuestion(){
 const state=quizState;if(!state)return;
 const q=state.questions[state.index],card=$("quiz");
 card.replaceChildren();
 const label=make("span","pill",state.mode==="point"?"Зупинка":"Самостійна робота");
 card.append(label,make("p","qNo","Запитання "+(state.index+1)+" / "+state.questions.length),
  make("h2","questionText",q.question));
 const feedback=make("div","quizFeedback");feedback.hidden=true;
 let verified=false;
 const next=make("button","primary",state.index===state.questions.length-1?
   "Завершити перевірку":"Наступне запитання →");
 next.onclick=()=>{
  if(!verified)return;
  state.index++;
  if(state.index===state.questions.length){finishQuiz(state.mode);return}
  showQuestion();go($("quiz"));
 };
 const skipOne=make("button","secondary",q.type==="open"?"Пропустити письмову відповідь →":"Пропустити запитання →");
 skipOne.onclick=()=>{
  if(verified)return;
  verified=true;state.skipped=(state.skipped||0)+1;
  state.index++;
  if(state.index===state.questions.length)finishQuiz(state.mode);
  else{showQuestion();go($("quiz"))}
 };
 const acceptAnswer=(message,correct)=>{
  if(verified)return;
  verified=true;
  if(correct)state.done++;
  feedback.hidden=false;explainMarkup(feedback,message);
  card.append(next);
  go(feedback);
 };
 if(q.type==="open"){
  const hint=make("p","small","Напиши відповідь власними словами — ШІ перевірить розуміння, а не дослівний збіг.");
  const input=make("textarea","written");input.rows=5;input.maxLength=1800;
  input.placeholder="Моя відповідь…";
  const check=make("button","primary","Перевірити письмову відповідь");
  check.onclick=async()=>{
   if(verified)return;
   const answer=input.value.trim();
   if(answer.length<5){feedback.hidden=false;feedback.textContent="Напиши хоча б одне речення.";return}
   check.disabled=true;input.readOnly=true;
   feedback.hidden=false;feedback.textContent="ШІ читає відповідь…";
   const version=loadToken;
   try{
    const response=await aiCall("check-open",{
     text:current.text.slice(0,14700),question:q.question,
     studentAnswer:answer,referenceAnswer:q.referenceAnswer
    });
    if(version!==loadToken)return;
    acceptAnswer(response.answer||"Відповідь прийнята.",true);
   }catch(error){
    if(version!==loadToken)return;
    acceptAnswer("Зв’язок із ШІ перервався. Орієнтовна відповідь: "+q.referenceAnswer,false);
   }
  };
  card.append(hint,input,check,skipOne,feedback);return;
 }
 let chosen=-1;
 const answers=make("div","answers");
 const buttons=q.options.map((answer,i)=>{
  const button=make("button","choice");button.type="button";
  button.append(make("b",null,"АБВГ"[i]),make("span",null,answer));
  button.onclick=()=>{
   if(verified)return;
   chosen=i;
   buttons.forEach(b=>b.classList.remove("selected"));button.classList.add("selected");
  };
  return button;
 });
 buttons.forEach(b=>answers.append(b));
 const check=make("button","primary","Перевірити відповідь");
 check.onclick=()=>{
  if(verified)return;
  if(chosen<0){feedback.hidden=false;feedback.textContent="Спочатку вибери відповідь.";return}
  buttons[q.correct].classList.add("correct");
  buttons[chosen].classList.add(chosen===q.correct?"correct":"wrong");
  buttons.forEach(b=>b.disabled=true);
  check.disabled=true;
  acceptAnswer((chosen===q.correct?"Правильно! ":"Не зовсім. ")+(q.explanation||""),chosen===q.correct);
 };
 card.append(answers,check,skipOne,feedback);
}
function finishQuiz(mode){
 const lesson=lessons[lessonIndex];
 if(mode==="point"){
  const key=lesson.id+":"+(pointIndex+1);
  if(quizState?.skipped){skipped.add(key);toStore(SKIPPED,[...skipped]);}
  else{skipped.delete(key);toStore(SKIPPED,[...skipped]);completed.add(key);toStore(DONE,[...completed]);}
  $("quiz").hidden=true;showCompletion(false);
  progress();return;
 }
 if(!quizState?.skipped){reviews.add(lesson.id);toStore(REVIEW_DONE,[...reviews]);}
 $("quiz").hidden=true;showReviewCompleted(Boolean(quizState?.skipped));
}
function showCompletion(already){
 $("readEnd").hidden=true;
 const host=$("finished");host.hidden=false;host.replaceChildren();
 const lesson=lessons[lessonIndex],key=lesson.id+":"+(pointIndex+1);
 const incomplete=skipped.has(key)&&!completed.has(key);
 host.append(make("div","doneIcon",incomplete?"↪":"✓"),
  make("h2",null,incomplete?"Перевірку пропущено":"Пункт завершено!"),
  make("p","small",incomplete
   ?"Можеш перейти далі без відповіді на запитання. Перевірку можна пройти пізніше."
   :already?"Результат збережено.":"Відповіді перевірені. Ти можеш продовжити читання."));
 const actions=make("div","actions");
 if(incomplete){
  const retry=make("button","secondary","Пройти перевірку пізніше");
  retry.onclick=startQuiz;actions.append(retry);
 }
 const length=(points[lesson.id]||[]).length;
 if(pointIndex===length-1){
  const test=make("button","secondary","📝 Самостійна робота");test.onclick=startParagraphReview;
  const retell=make("button","secondary","✍️ Переказати параграф");retell.onclick=openRetelling;
  actions.append(test,retell);
 }
 const goNext=make("button","primary",pointIndex<length-1?"Наступний пункт →":
  lessonIndex<lessons.length-1?"Наступний параграф →":"Книгу пройдено ✓");
 goNext.onclick=()=>nextPoint();
 actions.append(goNext);host.append(actions);
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
 const result=[];
 for(let i=0;i<length;i++)result.push((await fetchPoint(lessonIndex,i)).text);
 return result.join("\n\n").slice(0,14700);
}
async function startParagraphReview(){
 $("finished").hidden=true;$("review").hidden=false;
 const host=$("review");host.replaceChildren();
 host.append(make("h2",null,"Самостійна робота"),
  make("p","small","ШІ готує 6 запитань за всім параграфом…"));
 go(host);const version=loadToken;
 try{
  const text=await fullParagraphText();if(version!==loadToken)return;
  const data=await aiCall("paragraph-review",{text});
  if(version!==loadToken)return;
  if(!Array.isArray(data.questions)||data.questions.length!==6||
     !data.questions.every((q,i)=>validQuestion(q,i,"review")))
   throw Error("Некоректні запитання");
  quizState={questions:data.questions,index:0,mode:"review",done:0};
  host.hidden=true;$("quiz").hidden=false;showQuestion();go($("quiz"));
 }catch(error){
  if(version!==loadToken)return;
  host.replaceChildren();
  host.append(make("h2",null,"Самостійна поки недоступна"),make("p","small",error.message));
  const back=make("button","secondary","Повернутися");back.onclick=()=>{host.hidden=true;showCompletion(true)};
  host.append(back);
 }
}
function showReviewCompleted(partial=false){
 const host=$("review");host.hidden=false;host.replaceChildren();
 host.append(make("h2",null,partial?"Самостійна робота завершена з пропусками":"Самостійну роботу завершено!"),
  make("p","small",partial?"Пропущені запитання не зараховуються як правильні. Самостійну можна пройти ще раз.":"Результат збережено. Можеш переказати матеріал або перейти до наступного параграфа."));
 const actions=make("div","actions");
 const retell=make("button","secondary","Переказати параграф");
 retell.onclick=openRetelling;
 const next=make("button","primary","Продовжити читання →");next.onclick=nextPoint;
 actions.append(retell,next);host.append(actions);go(host);
}
function openRetelling(){
 const host=$("review");$("finished").hidden=true;host.hidden=false;host.replaceChildren();
 host.append(make("h2",null,"Переказ параграфа"),
  make("p","small","Спробуй своїми словами пояснити головні події та їхні причини. ШІ підкаже, чого не вистачає."));
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
 const back=make("button","secondary","Повернутися до пункту");
 back.onclick=()=>{host.hidden=true;showCompletion(true)};
 host.append(input,check,responseHost,back);go(host);
}
$("sendQuestion").onclick=async()=>{
 const question=$("studentQuestion").value.trim(),host=$("answerFromAI");
 if(question.length<3){host.hidden=false;host.textContent="Напиши своє запитання.";return}
 if(!current)return;
 const button=$("sendQuestion");button.disabled=true;
 host.hidden=false;host.textContent="ШІ шукає пояснення…";const version=loadToken;
 try{
  const data=await aiCall("ask-question",{text:current.text.slice(0,14700),question});
  if(version===loadToken)explainMarkup(host,data.answer||"Відповідь недоступна.");
 }catch(error){if(version===loadToken)host.textContent=error.message}
 finally{button.disabled=false}
};
async function init(){
 completed=new Set(fromStore(DONE,[]));reviews=new Set(fromStore(REVIEW_DONE,[]));skipped=new Set(fromStore(SKIPPED,[]));
 locallySavedQuestions=fromStore(QUIZ_CACHE,{});pointAttempts=fromStore(ATTEMPTS,{});
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
