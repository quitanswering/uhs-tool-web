"use strict";
const ORDER = ["02","03","A1","A2","A3","A4","A5","A6"];
const BYTES = {"02":32,"03":32,"A1":20,"A2":12,"A3":8,"A4":11,"A5":32,"A6":12};
const DESC = {
  "02":"Предупреждения на дисплее",
  "03":"Предупреждения (расширенный набор)",
  "A1":"Меню на дисплее и HUD",
  "A2":"Маски кодов неисправности (DTC/FTB)",
  "A3":"Меню на дисплее",
  "A4":"Функции",
  "A5":"Настройки элементов управления",
  "A6":"Индикаторы"
};

let MAP = {};           // block -> [ {n,udd,uhs,param,en,ru} ]
let HIST = {};          // block -> { bitNumber: ISO timestamp }
let cur = {};           // block -> Uint8Array (as read)
let edited = {};        // block -> Uint8Array (working copy)
let openBlocks = {};    // block -> bool
let filter = "all", query = "";
let adapterOn = true;
try{ adapterOn = localStorage.getItem("uhs_adapter") !== "off"; }catch(e){}

// When served from GitHub Pages (static), drive a local backend running next to
// the adapter; when served by that backend itself, same-origin. If the backend
// is unreachable the page still works read-only (param map + saved configs).
const API = (location.hostname.endsWith("github.io") || location.protocol === "file:")
  ? "http://127.0.0.1:8777" : "";
function parseBackupText(txt){
  const blocks = {};
  for(const line of txt.split(/\r?\n/)){
    const m = line.match(/^\s*([0-9A-Fa-f]{2})\s*=\s*([0-9A-Fa-f ]+)/);
    if(m && !line.trim().startsWith("#")) blocks[m[1].toUpperCase()] = m[2].replace(/\s+/g,"").toUpperCase();
  }
  return blocks;
}

const $ = id => document.getElementById(id);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

function hexToBytes(h, len){ const a = new Uint8Array(len); for (let i=0;i<len;i++){ a[i]=parseInt(h.substr(i*2,2),16)||0; } return a; }
function getBit(a,n){ return (a[(n-1)>>3] >> (7-((n-1)&7))) & 1; }
function setBit(a,n,v){ const i=(n-1)>>3, s=7-((n-1)&7); a[i] = v ? (a[i]|(1<<s)) : (a[i]&~(1<<s)); }
function setField(a,lo,hi,v){ for(let n=lo;n<=hi;n++) setBit(a,n,(v>>(hi-n))&1); }  // MSB = lo
function field(a,lo,hi){ let v=0; for(let n=lo;n<=hi;n++) v=(v<<1)|getBit(a,n); return v; }
function parseN(n){ const m=String(n).trim().replace(/\.0+$/,"").match(/^(\d+)(?:\s*-\s*(\d+))?$/); return m ? [ +m[1], m[2]?+m[2]:+m[1] ] : null; }
function changedBlock(b){ const a=cur[b], e=edited[b]; if(!a) return false; for(let i=0;i<a.length;i++) if(a[i]!==e[i]) return true; return false; }

function msg(text, kind){ const m=$("msg"); m.className="msg show "+(kind||""); m.textContent=text; }
function clearMsg(){ $("msg").className="msg"; }

async function load(){
  MAP = await fetch("param_map.json").then(r=>r.json());
  await loadHist();
  await loadBackups();
}
async function loadBackups(){
  const sel = $("backupSel");
  let files = null;
  try{ const r = await fetch(API+"/api/backups").then(r=>r.json()); if(r && r.ok) files = r.files; }catch(e){}
  if(!files){ try{ files = await fetch("backups/index.json").then(r=>r.json()); }catch(e){} }  // static (Pages)
  if(files){ for(const f of files){ const o=el("option",null,f); o.value=f; sel.appendChild(o); } }
}
async function applyBackup(name){
  if(!name) return;
  clearMsg();
  try{
    let blocks = null;
    try{ const r = await fetch(API+"/api/backup?name="+encodeURIComponent(name)).then(r=>r.json()); if(r && r.ok) blocks = r.blocks; }catch(e){}
    if(!blocks){ const txt = await fetch("backups/"+encodeURIComponent(name)).then(r=>r.text()); blocks = parseBackupText(txt); }  // static (Pages)
    if(!blocks || !Object.keys(blocks).length) throw new Error("бэкап пуст или недоступен");
    for(const b of ORDER){
      const hx = blocks[b]; if(hx==null) continue;
      edited[b] = hexToBytes(hx, BYTES[b]);
      if(!cur[b]) cur[b] = edited[b].slice();   // no live read yet → use as baseline
    }
    render();
    const anyChg = ORDER.some(b=>cur[b] && changedBlock(b));
    msg("Загружен сохранённый конфиг: "+name+". "+(anyChg
        ? "Отличия от текущего подсвечены — можно записать в приборку."
        : "Нажми «Считать», затем снова загрузи этот конфиг, чтобы увидеть отличия от живой приборки и записать."), "ok");
  }catch(e){ msg("Не удалось загрузить бэкап: "+e.message, "err"); }
}
async function loadHist(){
  HIST = await fetch("/history.json").then(r=>r.json()).catch(()=>({})) || {};
}
function lastChanged(b, lo, hi){
  const h = HIST[b]; if(!h) return null;
  let best = null;
  for(let n=lo;n<=hi;n++){ const t=h[String(n)]; if(t && (!best || t>best)) best=t; }
  return best;
}
function fmtTs(iso){
  try{ const d=new Date(iso); return d.toLocaleDateString("ru-RU")+" "+d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}); }
  catch(e){ return iso; }
}

async function read(){
  if(!adapterOn){ msg("Адаптер отключён — включи его кнопкой «Адаптер».", "err"); return; }
  clearMsg(); $("btnRead").disabled=true; $("status").textContent="читаю…";
  try{
    const r = await fetch(API+"/api/read").then(r=>r.json());
    if(!r.ok) throw new Error(r.error);
    await loadHist();
    cur={}; edited={};
    for(const b of ORDER){ cur[b]=hexToBytes(r.blocks[b]||"", BYTES[b]); edited[b]=cur[b].slice(); }
    $("status").textContent="считано "+new Date().toLocaleTimeString();
    render();
  }catch(e){ msg("Ошибка чтения: "+e.message+". Нужен запущенный локальный сервер с адаптером (зажигание вкл, HELPGM закрыт).", "err"); $("status").textContent="нет связи с адаптером"; }
  finally{ $("btnRead").disabled=false; }
}

function rowMatch(row, val, unknown){
  if(filter==="on" && !val) return false;
  if(filter==="named" && unknown) return false;
  if(filter==="unk" && !unknown) return false;
  if(query){
    const hay=((row.param||"")+" "+(row.ru||"")+" "+(row.en||"")).toLowerCase();
    if(!hay.includes(query)) return false;
  }
  return true;
}

function render(){
  const root=$("blocks"); root.innerHTML="";
  let anyChanged=false;
  for(const b of ORDER){
    if(!cur[b]) continue;
    const rows=MAP[b]||[];
    const chg=changedBlock(b); if(chg) anyChanged=true;
    let onCount=0; for(const r of rows){ const p=parseN(r.n); if(p && p[0]===p[1] && getBit(edited[b],p[0])) onCount++; }

    const card=el("div","block");
    const head=el("div","bhead");
    head.appendChild(el("span","tag",b));
    const d=el("div","d"); d.appendChild(el("div","t",DESC[b]||b));
    d.appendChild(el("div","s","DID 0x"+b+" · "+BYTES[b]+" байт"));
    head.appendChild(d);
    if(chg) head.appendChild(el("span","chgmark","● изменён"));
    head.appendChild(el("span","cnt","вкл "+onCount));
    head.onclick=()=>{ openBlocks[b]=!openBlocks[b]; render(); };
    card.appendChild(head);

    // hex line with changed bytes highlighted
    const hex=el("div","hex");
    for(let i=0;i<edited[b].length;i++){
      const s=edited[b][i].toString(16).toUpperCase().padStart(2,"0");
      if(cur[b][i]!==edited[b][i]){ const it=el("i",null,s); hex.appendChild(it); } else hex.appendChild(document.createTextNode(s));
      hex.appendChild(document.createTextNode(" "));
    }
    card.appendChild(hex);

    if(openBlocks[b]){
      const box=el("div","rows");
      for(const r of rows){
        const p=parseN(r.n); if(!p) continue;
        const [lo,hi]=p; if(hi>BYTES[b]*8) continue;
        const single=lo===hi;
        const named = r.param && r.param!=="UNKNOWN";
        const described = r.ru && r.ru.trim() && r.ru.trim().toLowerCase()!=="неизвестно";
        const unknown = !named && !described;   // truly unknown = no name AND no description
        const val = single ? getBit(edited[b],lo) : field(edited[b],lo,hi);
        if(!rowMatch(r,val,unknown)) continue;
        const changed = single ? (getBit(cur[b],lo)!==getBit(edited[b],lo))
                                : (field(cur[b],lo,hi)!==field(edited[b],lo,hi));

        const row=el("div","row"+(unknown?" unknown":"")+(changed?" changed":""));
        row.appendChild(el("div","n","№"+r.n));
        if(single){
          const cb=el("input"); cb.type="checkbox"; cb.checked=!!val;
          cb.onchange=()=>{ setBit(edited[b],lo,cb.checked?1:0); render(); };
          row.appendChild(cb);
        } else {
          const width=hi-lo+1;
          if(width<=4){
            const max=(1<<width)-1;
            const sel=el("select","fieldsel");
            for(let v=0;v<=max;v++){ const o=el("option",null,String(v)); o.value=String(v); if(v===val)o.selected=true; sel.appendChild(o); }
            sel.onchange=()=>{ setField(edited[b],lo,hi,parseInt(sel.value,10)); render(); };
            row.appendChild(sel);
          } else if(width<=16){
            const mx=(1<<width)-1;
            const inp=el("input","fieldsel"); inp.type="number"; inp.min="0"; inp.max=String(mx); inp.step="1"; inp.value=String(val);
            inp.onchange=()=>{ let v=parseInt(inp.value,10); if(!(v>=0))v=0; if(v>mx)v=mx; setField(edited[b],lo,hi,v); render(); };
            row.appendChild(inp);
          } else {
            row.appendChild(el("div","fieldval","="+val));
          }
        }
        const nm=el("div","nm");
        nm.appendChild(el("div","ru", r.ru || r.param || "Неизвестно"));
        if(named) nm.appendChild(el("div","p", r.param));
        const ts=lastChanged(b,lo,hi);
        if(ts) nm.appendChild(el("div","ts","изменён: "+fmtTs(ts)));
        row.appendChild(nm);
        const badges=el("div","badges");
        // original UHS state from the stock config (spreadsheet column C)
        const uhs=(r.uhs==null?"":String(r.uhs)).trim();
        if(single){
          const on=uhs==="✔";
          const ub=el("span","b "+(on?"uhson":"uhsoff"), on?"UHS ●":"UHS ○");
          ub.title = on ? "В стоковой UHS: включён" : "В стоковой UHS: выключен";
          badges.appendChild(ub);
        } else if(uhs){
          const ub=el("span","b uhsval","UHS: "+uhs);
          ub.title = "Исходное значение поля в стоковой UHS";
          badges.appendChild(ub);
        }
        if(unknown) badges.appendChild(el("span","b unk","UNK"));
        if(!single) badges.appendChild(el("span","b fld","поле "+r.n));
        row.appendChild(badges);
        box.appendChild(row);
      }
      card.appendChild(box);
    }
    root.appendChild(card);
  }
  $("btnWrite").disabled=!anyChanged || !adapterOn;
  $("btnWrite").textContent = anyChanged ? "Записать изменения" : "Нет изменений";
}

function bytesToHex(a){ return [...a].map(x=>x.toString(16).toUpperCase().padStart(2,"0")).join(" "); }

async function write(){
  const changes={};
  const names=[];
  for(const b of ORDER){ if(cur[b] && changedBlock(b)){ changes[b]=bytesToHex(edited[b]); names.push(b); } }
  if(!names.length) return;
  if(!confirm("Записать в приборку секции: "+names.join(", ")+"?\nБудет сделан бэкап и сверка.")) return;
  clearMsg(); $("btnWrite").disabled=true; $("status").textContent="пишу…";
  try{
    const r=await fetch(API+"/api/write",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({changes})}).then(r=>r.json());
    if(!r.ok) throw new Error(r.error);
    const res=r.result.blocks;
    const oks=Object.entries(res).map(([k,v])=>k+": "+v).join(" · ");
    msg("Готово. Бэкап: "+r.result.backup+". "+oks, "ok");
    await read();
  }catch(e){ msg("Ошибка записи: "+e.message, "err"); $("status").textContent="ошибка"; }
  finally{ render(); }
}

document.querySelectorAll(".chip").forEach(c=>{
  c.onclick=()=>{ document.querySelectorAll(".chip").forEach(x=>x.setAttribute("aria-pressed","false")); c.setAttribute("aria-pressed","true"); filter=c.dataset.f; render(); };
});
$("q").oninput=e=>{ query=e.target.value.trim().toLowerCase(); render(); };
$("btnRead").onclick=read;
$("btnWrite").onclick=write;
$("backupSel").onchange=e=>{ $("btnLoad").disabled=!e.target.value; };
$("btnLoad").onclick=()=>applyBackup($("backupSel").value);
function renderAdapter(){
  const b=$("btnAdapter");
  b.textContent = adapterOn ? "Адаптер: подключён ●" : "Адаптер: отключён ○";
  b.classList.toggle("off", !adapterOn);
  $("btnRead").disabled = !adapterOn;
  if(!adapterOn){ const e=$("vbatt"); e.textContent="АКБ: — В"; e.className="vbatt"; }
}
$("btnAdapter").onclick=()=>{
  adapterOn=!adapterOn;
  try{ localStorage.setItem("uhs_adapter", adapterOn?"on":"off"); }catch(e){}
  renderAdapter();
  if(Object.keys(cur).length) render();
};
renderAdapter();

let busy=false;
async function pollVbatt(){
  if(busy || !adapterOn) return;
  try{
    const r=await fetch(API+"/api/vbatt").then(r=>r.json());
    const el=$("vbatt");
    if(r.ok){
      el.textContent="АКБ: "+r.volts.toFixed(2)+" В";
      el.className="vbatt "+(r.volts<11.8?"low":(r.volts>=12.2?"ok":""));
    } else { el.textContent="АКБ: — В"; el.className="vbatt"; }
  }catch(e){}
}
// wrap read/write so vbatt polling pauses during device ops
const _read=read, _write=write;
read=async function(){ busy=true; try{ return await _read(); } finally{ busy=false; } };
write=async function(){ busy=true; try{ return await _write(); } finally{ busy=false; } };
$("btnRead").onclick=read; $("btnWrite").onclick=write;
pollVbatt(); setInterval(pollVbatt, 5000);

load().catch(()=>msg("Не удалось загрузить карту параметров (param_map.json).","err"));
