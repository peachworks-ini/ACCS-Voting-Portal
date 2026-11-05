import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
let focused=true, active=true, visible=true, saves=0;
const body={dataset:{readSuggestion:'post',readKind:'post'}};
const comment={dataset:{readSuggestion:'post',readKind:'comment',readComment:'2'}};
const nodes=[body,comment];
const context={PASS_TIME_MS:604800000,window:{},performance:{now:()=>0},console,document:{
  get visibilityState(){return active?'visible':'hidden';},hasFocus:()=>focused,
  getElementById:()=>({style:{display:'flex'}}),querySelector:()=>null,
  querySelectorAll:()=>nodes
}};
vm.createContext(context);
vm.runInContext(html.slice(html.indexOf('window.app = {'),html.indexOf('    const app = window.app;'))+'\nvar app=window.app;',context);
const app=context.app;
app.userData={mcUsername:'reader'};
app.suggestions=[{id:'post',status:'active',authorAccountKey:'author',createdAt:100,title:'Title',body:'Text',comments:[
  {accountKey:'reader',createdAt:101,body:'Joined'},
  {accountKey:'author',createdAt:102,body:'Earlier hidden reply'},
  {accountKey:'other',createdAt:103,body:'Visible later reply'}
]}];
app.saveReadState=()=>{saves++;};app.refreshUnreadBadges=()=>{};app.renderNotifications=()=>{};
app.readItemIsVisible=()=>visible;
app.scanVisibleReadItems(0);app.scanVisibleReadItems(1999);
assert.equal(saves,0,'Must wait two full seconds');
app.scanVisibleReadItems(2000);
assert.equal(saves,1);
assert.equal(app.readState.post,100,'Reading the post must not advance the reply cursor');
assert.equal(app.unreadActivity(app.suggestions[0]).label,'1 new reply in your thread','Earlier hidden reply remains unread');
assert.ok(app.seenComments.post.includes('103:2'));
app.markVisibleItemRead('post','comment',1);
assert.equal(app.unreadActivity(app.suggestions[0]),null);
app.suggestions[0].comments.push({accountKey:'author',createdAt:104,body:'Brand new reply'});
assert.equal(app.unreadActivity(app.suggestions[0]).label,'1 new reply in your thread');
app.visibleReadItems.clear();app.seenComments={};app.readState={};
focused=false;app.scanVisibleReadItems(3000);app.scanVisibleReadItems(6000);
assert.equal(app.visibleReadItems.size,0,'Unfocused tab does not accumulate read time');
focused=true;active=false;app.scanVisibleReadItems(7000);
assert.equal(app.visibleReadItems.size,0);
active=true;visible=true;app.scanVisibleReadItems(8000);
visible=false;app.scanVisibleReadItems(9000);
visible=true;app.scanVisibleReadItems(10000);app.scanVisibleReadItems(11999);
assert.equal(app.readState.post,undefined,'Scrolling away resets continuous dwell');
app.scanVisibleReadItems(12000);assert.equal(app.readState.post,100);
app.adminAccounts.add('author');
let markup=app.renderBox(app.suggestions[0],'vote');
assert.ok(markup.includes('admin-surface'));
assert.ok(markup.includes('<span class="admin-label">ADMIN</span>'));
assert.ok(markup.includes('member-surface'));
app.adminAccounts.clear();app.suggestions[0].isAdmin=true;
markup=app.renderBox(app.suggestions[0],'vote');
assert.ok(!markup.includes('admin-surface'),'Untrusted post role flags must not confer admin styling');
assert.ok(markup.includes('class="admin-label" hidden'));
// Geometry checks include clipping in a scrollable content pane.
context.window.innerWidth=800;context.window.innerHeight=600;
context.getComputedStyle=()=>({overflowY:'auto',overflowX:'visible',display:'block',visibility:'visible'});
const parent={parentElement:null,getBoundingClientRect:()=>({top:100,bottom:300,left:0,right:800})};
const el={isConnected:true,getClientRects:()=>[{}],parentElement:parent,getBoundingClientRect:()=>({top:350,bottom:450,left:0,right:300,width:300,height:100})};
const geometryContext={...context};vm.createContext(geometryContext);
vm.runInContext(html.slice(html.indexOf('window.app = {'),html.indexOf('    const app = window.app;'))+'\nvar app=window.app;',geometryContext);
assert.equal(geometryContext.app.readItemIsVisible(el),false,'Below a scroll pane is not visible');
el.getBoundingClientRect=()=>({top:150,bottom:250,left:0,right:300,width:300,height:100});
assert.equal(geometryContext.app.readItemIsVisible(el),true);
el.getClientRects=()=>[];
assert.equal(geometryContext.app.readItemIsVisible(el),false,'Collapsed comments are never read');
console.log('Visibility and roles checks passed: dwell, scrolling, background tabs, hidden and out-of-order replies, fresh replies, clipping, and trusted role styling.');
