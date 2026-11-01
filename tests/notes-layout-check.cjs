// Optional browser regression check: node tests/notes-layout-check.cjs (uses installed Playwright and Chromium).
const {chromium}=require('playwright');
const fs=require('fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-features=OverlayScrollbar']});
 const page=await browser.newPage();
 const now=Date.now()/1000;
 const traders=Object.fromEntries(['Grok-Trader-A','Grok-Trader-B'].map(name=>[name,{equity:100,start:100,currency:'USDT',updated:now,status:'ok',positions:[]}]));
 await page.route('**/*', async route=>{
  const file=new URL(route.request().url()).pathname.slice(1)||'index.html';
  if(['index.html','dashboard.js','layout-v4.js'].includes(file)) return route.fulfill({body:fs.readFileSync(require('path').join(__dirname,'..',file)),contentType:file.endsWith('.js')?'application/javascript':'text/html'});
  if (!file.endsWith('.json')) return route.fulfill({body:'',contentType:'text/javascript'});
  const value=file==='data.json'?{snapshot_id:'test',source:'own-okx-readonly',updated:now,traders,trades:[]}:file==='history.json'?{snapshot_id:'test',series:Object.fromEntries(Object.keys(traders).map(n=>[n,[[now*1000,100]]]))}:{version:1,items:[]};
  return route.fulfill({json:value});
 });
 await page.setViewportSize({width:1920,height:1080});
 await page.goto('http://layout.test/');
 await page.waitForSelector('#cards .trader-panel');
 await page.addStyleTag({content:'html{overflow-y:scroll;scrollbar-gutter:stable}body{overflow-x:visible;min-height:3000px}'});
 await page.evaluate(()=>document.querySelectorAll('.notes-list').forEach(el=>{el.innerHTML='<article class="note">Synthetic note<br>Layout regression check</article>'}));
 for(const width of [1900,1920,2208,2560,1899,1280,760,375,1920]){
  await page.setViewportSize({width,height:1080});
  await page.waitForTimeout(100);
  const result=await page.evaluate(()=>{
   const box=id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,parent:el.parentElement.id,trader:el.parentElement.dataset.trader}};
   const contentWidth=document.body.clientWidth;
   if(document.documentElement.scrollHeight<=innerHeight)throw new Error('Vertical scrollbar fixture is missing');
   const notes=Array.from(document.querySelectorAll('.notes-column .note'),el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right}});
   return {a:box('notes-a'),b:box('notes-b'),cards:box('cards'),contentWidth,notes,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
  });
  assert.equal(result.overflow,false);
  if(width>=1900){
   assert(result.contentWidth<width,'A non-overlay vertical scrollbar must consume width');
   assert.equal(result.a.trader,'Grok-Trader-A');assert.equal(result.b.trader,'Grok-Trader-B');
   assert(result.a.left>=12);assert(result.b.right<=result.contentWidth-12);
   assert(result.a.right<result.cards.left);assert(result.b.left>result.cards.right);
   assert(result.a.width>=400 && result.a.width<=480);assert.equal(result.a.width,result.b.width);
   assert(result.cards.width>=880);if(width===2560)assert.equal(result.a.width,480);
   for(const note of result.notes){assert(note.left>=12);assert(note.right<=result.contentWidth-12);}
  }
  else {assert.equal(result.a.parent,'notes-shelf');assert.equal(result.b.parent,'notes-shelf');}
  console.log(width,JSON.stringify(result));
 }
 // A wide window with insufficient container space must still stack.
 await page.evaluate(()=>{
  document.body.style.width='1750px';
  dispatchEvent(new Event('resize'));
 });
 assert.equal(await page.locator('#notes-a').evaluate(el=>el.parentElement.id),'notes-shelf');
 assert.equal(await page.locator('#notes-b').evaluate(el=>el.parentElement.id),'notes-shelf');
 console.log('1750px content container: stacked fallback passed');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
