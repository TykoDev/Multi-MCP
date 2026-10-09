/**
 * @module
 * The fixture site every browser-tier test drives.
 *
 * A real origin rather than `data:` URLs — the navigation policy refuses every
 * scheme but http/https, correctly, so a fixture needs a real one. Each site
 * carries a per-run nonce: an assertion that finds the nonce has proven the
 * whole chain ran (HTTP → auth → tool → CDP → Chromium → DOM pipeline) rather
 * than that some cached or stubbed value came back.
 *
 * Every page records what the browser actually did into DOM elements the tools
 * can read back, so a test asserts on observed browser behaviour rather than on
 * the fact that a CDP call returned without throwing.
 */

/** One running fixture site. */
export interface FixtureSite {
	/** Origin root, e.g. `http://127.0.0.1:54321/`. */
	readonly url: string;
	/** The per-run nonce embedded in every page. */
	readonly nonce: string;
	/** Absolute URL for a named page. */
	page(name: PageName): string;
	/** Requests served so far, newest last. Proves navigation really left. */
	readonly hits: readonly string[];
	/**
	 * Bytes this site actually wrote for `/measured`, and its declared size (U-4).
	 *
	 * Kept for the download and egress legs; `browser_head` no longer goes through
	 * the browser (SR-HEAD-REDIRECT, D-042) and its byte count is measured by the
	 * raw upstream in `packages/mcp/src/head_test.ts`. Historically this counted
	 * what `Network.loadNetworkResource`
	 * and releases the stream handle immediately. Whether that stops the transfer
	 * or merely discards it is a *measurement*, not an assumption, and the number
	 * it produces goes in the tool's own documentation.
	 */
	readonly measured: { served: number; total: number };
	close(): Promise<void>;
}

export type PageName =
	| 'index'
	| 'form'
	| 'long'
	| 'keys'
	| 'mouse'
	| 'pointer'
	| 'actions'
	| 'tabs'
	| 'article'
	| 'second'
	| 'slow'
	| 'title'
	| 'setcookie'
	| 'showcookie'
	| 'downloads'
	| 'frame'
	| 'oopif'
	| 'egress'
	| 'content'
	| 'frameset'
	| 'framesetmenu'
	| 'framesetcontent'
	| 'framesetnested'
	| 'framesetcross'
	| 'objectcross'
	| 'embedcross'
	| 'focusframe'
	| 'pseudoframe'
	| 'liar';

/** How many same-site child documents the `liar` page lies from (R3-2: enough to occupy low context ids). */
const LIAR_FRAMES = 16;

/** The `objectcross`/`embedcross` host's half of `focusframe`'s report: the embedded field's length, as text. */
const ECHO_INNER = `addEventListener('message',(e)=>{
  if(e.data&&typeof e.data.innerLength==='number')document.getElementById('inner-echo').textContent='inner:'+e.data.innerLength;});`;

const SHELL = (title: string, body: string, script = ''): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem;max-width:44rem}
button,input,select,textarea{font:inherit;padding:.4rem;margin:.2rem 0}
.tall{height:320vh;background:linear-gradient(#fff,#e8eefc)}</style></head>
<body>${body}<script>${script}</script></body></html>`;

// --- the frameset pages (S4: `browser_get_html {frame_id}`) ----------------------------------------

/**
 * The unique string the `framesetcontent` document carries and **no other document does**.
 *
 * Every frame-html acceptance row is a statement about which document came back, so the rows are
 * written against sentinels rather than against lengths or titles: a read that carries this string
 * has provably read the content child, and a refusal that carries
 * {@linkcode FRAMESET_TOP_SENTINEL} has provably returned the top document instead of refusing
 * (I-FH-1, C-7).
 */
export const FRAME_SENTINEL = 'BIL51-SENTINEL-9F2A';

/** The depth-2 leaf's own sentinel — criterion 2a's discriminator. */
export const FRAME_NESTED_SENTINEL = 'BIL51-NESTED-SENTINEL-4D7B';

/** The frameset **shell's** sentinel. It must appear in no child read and in no refusal. */
export const FRAMESET_TOP_SENTINEL = 'FRAMESET-TOP-SENTINEL-2B8E';

/** `browser_get_html`'s character cap, restated here so the fixture can be sized past it (F-3). */
export const HTML_LIMIT_CHARS = 200_000;

/**
 * Filler that makes `framesetnested`'s `documentElement.outerHTML` exceed
 * {@linkcode HTML_LIMIT_CHARS}, so criterion 4a has a real frame to truncate.
 *
 * An HTML **comment**, deliberately, and placed in `<head>` right after the `<title>`: it inflates
 * the serialized document without adding an element, a text node, a layout box or an attribute, so
 * the DOM capture that `browser_get_frames` runs over this page is unaffected and the frame list
 * stays honest. A 200 000-character `<div>` would have made criterion 4a's fixture the reason
 * criteria 1 and 2 could not be observed.
 */
const NESTED_PAD = `<!--${'pad '.repeat(60_000)}-->`;

/**
 * A `<frameset>` document, which by construction has **no `<body>`**.
 *
 * {@linkcode SHELL} always emits one, and a `<body>` makes a `<frameset>` inert — the browser drops
 * the frames and renders an empty document — so the frameset pages bypass it. That is the recorded
 * trap, and the reason this second helper exists rather than a `SHELL` option.
 */
const FRAMESET = (nonce: string, menu: string, content: string): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Frameset ${FRAMESET_TOP_SENTINEL} ${nonce}</title></head>
<frameset cols="220,*">
<frame name="menu" src="${menu}" title="statistics menu">
<frame name="content" src="${content}" title="statistics table">
<noframes><p>${FRAMESET_TOP_SENTINEL} ${nonce}</p></noframes>
</frameset></html>`;

/** The pages, each a function of the run's nonce and, for `oopif`, of the second site's origin. */
function pages(nonce: string, frameOrigin: string, altOrigin: string): Record<PageName, string> {
	return {
		// Owner item 6: the egress bypasses. Every link and button here points at a
		// *different* host from the one that served the page, so a test that
		// allowlists only this site's host can prove that the `{index}` form of
		// `browser_download` gates the resolved `href` before clicking, that a
		// JS-driven download with no `href` is caught at the ledger, and that a
		// redirect off the allowlist is caught on its final URL.
		// Owner item 3: deterministic triggers for the `console` and `dom.settled`
		// content kinds. A button logs at each level; another appends a node after
		// a delay so a settle can be observed after a burst of mutations, then
		// quiet. No secret anywhere: these kinds carry only level/text and a count.
		content: SHELL(
			`Content Events`,
			`<h1>content ${nonce}</h1>
<button id="log" type="button">log</button>
<button id="mutate" type="button">mutate</button>
<ul id="list"></ul>`,
			`document.getElementById('log').addEventListener('click',()=>{
  console.log('log-${nonce}');
  console.warn('warn-${nonce}');
  console.error('error-${nonce}');});
document.getElementById('mutate').addEventListener('click',()=>{
  const list=document.getElementById('list');
  let n=0;
  const step=()=>{
    if(n>=8) return;
    const li=document.createElement('li');
    li.textContent='row '+(n++);
    list.appendChild(li);
    setTimeout(step,30);};
  step();});`,
		),

		egress: SHELL(
			`Egress`,
			`<h1>egress ${nonce}</h1>
<ul>
<li><a id="off-href" href="${altOrigin}/opendownload?name=off.txt&amp;body=off-${nonce}">absolute off-allowlist</a></li>
<li><a id="rel-href" href="/opendownload?name=rel.txt&amp;body=rel-${nonce}">relative same-origin</a></li>
<li><a id="redir-href" href="/redirect?to=${encodeURIComponent(`${altOrigin}/opendownload?name=via.txt&body=via-${nonce}`)}">redirect off-allowlist</a></li>
<li><button id="js-off" type="button">script-driven off-allowlist</button></li>
</ul>`,
			`document.getElementById('js-off').addEventListener('click',()=>{
  location.href='${altOrigin}/opendownload?name=js.txt&body=js-${nonce}';});`,
		),
		// B1.5 / A-1: a click recorder meant to be embedded from ANOTHER site, so Chromium puts it in
		// its own renderer (an OOPIF). It reports where the click landed in its own DOM, and the DOM
		// pipeline's merged text is how the top-level tools read it back.
		frame: SHELL(
			`Frame Child`,
			`<p id="frame-marker">frame ${nonce}</p>
<button id="frame-btn" type="button">Frame button</button>
<div id="frame-out">frame-untouched</div>
<input id="frame-field" placeholder="type in the frame">
<div id="frame-echo">frame-empty</div>`,
			`document.getElementById('frame-btn').addEventListener('click',e=>{
  document.getElementById('frame-out').textContent='clicked-in-frame-${nonce}-at-'+e.clientX+','+e.clientY;});
const ff=document.getElementById('frame-field');
ff.addEventListener('input',()=>{
  document.getElementById('frame-echo').textContent=ff.value||'frame-empty';});`,
		),

		// S4: the `<frameset>` corpus the browser tier reads `browser_get_html {frame_id}` over. The
		// corpus had no frameset anywhere and the fixture site had no same-origin child frame at all —
		// its only child was the cross-site `oopif` host — so both gaps are filled here. The shape is
		// statbank.dk's on purpose: a narrow menu column and a wide content column, the content child
		// carrying a table whose caption is the sentinel, a `2024M12` period cell and numeric data. S5
		// replays the live site and must find the same three things, so the shape is pinned where it
		// can be tested offline first.
		frameset: FRAMESET(nonce, '/framesetmenu', '/framesetcontent'),

		// The same shell with its content child on ANOTHER site, so Chromium renders it in its own
		// process: criterion 2b's out-of-process case, and C-1/C-2's gate rows. The second origin is
		// the harness's `frameOrigin`, which a suite points at a second fixture site on `localhost`.
		framesetcross: FRAMESET(nonce, '/framesetmenu', `${frameOrigin}/framesetcontent`),

		// The navigation child. It carries NO sentinel: reading it must return this document, and a
		// read of it must not carry its sibling's table or the shell.
		framesetmenu: SHELL(
			`Statistics menu`,
			`<p id="menu-heading">Statistics ${nonce}</p>
<ul>
<li><a id="menu-bil51" href="/framesetcontent" target="content">BIL51</a></li>
<li><a id="menu-bil52" href="/framesetcontent" target="content">BIL52</a></li>
</ul>
<button id="menu-refresh" type="button">Refresh</button>`,
		),

		framesetcontent: SHELL(
			`BIL51`,
			`<table id="bil51">
<caption>${FRAME_SENTINEL}</caption>
<thead><tr><th scope="col">Period</th><th scope="col">Passenger cars</th><th scope="col">Lorries</th></tr></thead>
<tbody>
<tr><th scope="row">2024M10</th><td>2812444</td><td>417392</td></tr>
<tr><th scope="row">2024M11</th><td>2818107</td><td>418004</td></tr>
<tr><th scope="row">2024M12</th><td>2823961</td><td>418655</td></tr>
</tbody>
</table>
<button id="content-export" type="button">Export</button>
<iframe id="frameset-nested" title="nested note" src="/framesetnested" style="width:380px;height:90px"></iframe>`,
		),

		// The depth-2 leaf: an `<iframe>` inside a `<frame>` inside a `<frameset>`. Its sentinel is in
		// the `<title>` as well as the body, so it survives the 200 000-character cap the pad forces —
		// criterion 2a (the right document) and criterion 4a (truncation with the TRUE length) are then
		// two assertions over one read rather than two fixtures.
		framesetnested:
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${FRAME_NESTED_SENTINEL}</title>${NESTED_PAD}</head>
<body><p id="nested-marker">${FRAME_NESTED_SENTINEL} ${nonce}</p>
<a id="nested-source" href="/framesetcontent">source table</a></body></html>`,

		// The host page: a margin, a host control, then the cross-site frame, so the child's geometry
		// is a real composition (host offset plus border) and not a coincidence at the origin.
		oopif: SHELL(
			`OOPIF Host`,
			`<h1 id="host-heading">host ${nonce}</h1>
<button id="host-btn" type="button">Host button</button>
<div style="height:80px"></div>
<iframe id="child" name="child" src="${frameOrigin}/frame" style="width:520px;height:220px;border:1px solid #888"></iframe>`,
		),

		// R3-1 (D-096 A2): the two frame owners that are not `<iframe>`. Each embeds `focusframe` from
		// `frameOrigin` — another site, so Chromium renders it out of process — next to a field of the top
		// document's own. A click inside the owner puts keyboard focus in the embedded document, and the top
		// document's `activeElement` is then the `<object>`/`<embed>` element itself, not an `<iframe>`.
		objectcross: SHELL(
			`Object Host`,
			`<h1 id="host-heading">object host ${nonce}</h1>
<input id="top-field" placeholder="top field">
<div style="height:16px"></div>
<object id="owner" type="text/html" data="${frameOrigin}/focusframe" style="display:block;width:420px;height:120px;border:1px solid #888"></object>
<div id="inner-echo">inner:none</div>`,
			ECHO_INNER,
		),
		embedcross: SHELL(
			`Embed Host`,
			`<h1 id="host-heading">embed host ${nonce}</h1>
<input id="top-field" placeholder="top field">
<div style="height:16px"></div>
<embed id="owner" type="text/html" src="${frameOrigin}/focusframe" style="display:block;width:420px;height:120px;border:1px solid #888">
<div id="inner-echo">inner:none</div>`,
			ECHO_INNER,
		),
		// The embedded document: one field filling the whole viewport, so a click anywhere in the owner lands in
		// it. It reports its value's LENGTH (never the value) to the host page, because neither the frame list
		// nor a cross-origin read reaches an `<object>`/`<embed>` document from the outside.
		focusframe: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Focus Frame</title></head>
<body style="margin:0"><input id="inner-field" aria-label="inner field" style="display:block;box-sizing:border-box;width:100%;height:100vh;margin:0;font:16px monospace">
<script>const f=document.getElementById('inner-field');
f.addEventListener('input',()=>{parent.postMessage({innerLength:f.value.length},'*');});</script></body></html>`,

		// R3-2's site A: a field to type at, and beside it a same-process child document whose only content is a
		// `::before` box. `browser_element_at` over that box asks the browser which element the pseudo-element
		// belongs to, from an isolated world of the CHILD frame — one more world in this renderer before the focus
		// walk makes its own, which is what lines a reused id up with a lying main world on the next site.
		pseudoframe: SHELL(
			`Pseudo Frame`,
			`<h1 id="pf-heading">pseudo frame ${nonce}</h1>
<input id="field" placeholder="type here">
<iframe id="deco" title="decoration" style="display:block;width:240px;height:120px;border:0" srcdoc="<style>body{margin:0}#p::before{content:'';display:block;width:240px;height:120px;background:#dde}</style><div id='p'></div>"></iframe>`,
		),

		// R3-2 (D-096 isolated worlds): a page that lies about focus from every main world it owns. Its own field
		// has focus; `#bank` frames `frameOrigin` (the pinned site, cross-site from here, so out of process); the
		// top document and ${LIAR_FRAMES} same-site child documents each redefine `Document.prototype.activeElement`
		// to answer `#bank`. A focus read made in any of those main worlds — or in a stale isolated-world id that
		// a cross-process navigation handed to one of them — names the bank frame instead of `#evil-field`.
		liar: SHELL(
			`Liar`,
			`<h1 id="liar-heading">liar ${nonce}</h1>
<input id="evil-field" placeholder="evil field">
<iframe id="bank" src="${frameOrigin}/form" style="width:320px;height:90px;border:1px solid #888"></iframe>
${
				Array.from(
					{ length: LIAR_FRAMES },
					(_, i) =>
						`<iframe class="liar" title="liar ${i}" style="width:1px;height:1px;border:0" srcdoc="<script>Object.defineProperty(Document.prototype,'activeElement',{configurable:true,get(){return parent.document.getElementById('bank');}});</script>"></iframe>`,
				).join('')
			}`,
			`Object.defineProperty(Document.prototype,'activeElement',{configurable:true,get(){return document.getElementById('bank');}});
const evil=document.getElementById('evil-field');
evil.focus();
evil.addEventListener('input',()=>{document.title='evil:'+evil.value.length;});`,
		),

		index: SHELL(
			`TykoTech Fixture Index`,
			`<h1 id="heading">nonce ${nonce}</h1>
<p id="intro">The index page of the TykoTech-MCP fixture site.</p>
<button id="btn" type="button">Press me</button>
<div id="out">untouched</div>
<a id="to-second" href="/second">go to second</a>
<input id="field" placeholder="type here">
<div id="fieldecho">empty</div>`,
			`document.getElementById('btn').addEventListener('click',()=>{
  document.getElementById('out').textContent='clicked-${nonce}';});
const f=document.getElementById('field');
f.addEventListener('input',()=>{
  document.getElementById('fieldecho').textContent=f.value||'empty';});`,
		),

		second: SHELL(
			`Second Page`,
			`<h1>second ${nonce}</h1><p id="marker">arrived-at-second</p>
<a id="back-home" href="/">home</a>`,
		),

		form: SHELL(
			`Fixture Form`,
			`<h1>form ${nonce}</h1>
<form id="f" onsubmit="return false">
  <input id="name" name="name" placeholder="your name">
  <input id="email" name="email" type="email" placeholder="email">
  <input id="password" name="password" type="password" placeholder="password" autocomplete="current-password">
  <textarea id="notes" placeholder="notes"></textarea>
  <select id="colour"><option value="red">red</option><option value="blue">blue</option></select>
  <label><input id="agree" type="checkbox"> agree</label>
  <button id="submit" type="submit">Submit</button>
</form>
<pre id="echo">{}</pre>
<pre id="pwlen">pwlen:0</pre>`,
			`const echo=()=>{document.getElementById('echo').textContent=JSON.stringify({
  name:document.getElementById('name').value,
  email:document.getElementById('email').value,
  notes:document.getElementById('notes').value,
  colour:document.getElementById('colour').value,
  agree:document.getElementById('agree').checked});};
// B2.8: the password field reports only its LENGTH, never its value. A fixture that echoed the value
// would put a credential in the page text, where browser_get_state would faithfully return it - and a
// test asserting "the tool did not leak the secret" would then be asserting it against a page that
// had. The length is enough to prove the right value arrived.
const pw=document.getElementById('password');
const pwecho=()=>{document.getElementById('pwlen').textContent='pwlen:'+pw.value.length;};
pw.addEventListener('input',pwecho);
for(const id of ['name','email','notes','colour','agree'])
  document.getElementById(id).addEventListener('input',echo);
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();
  document.getElementById('echo').dataset.submitted='yes';echo();});
echo();`,
		),

		long: SHELL(
			`Tall Page`,
			`<h1 id="top">top ${nonce}</h1>
<div class="tall"></div>
<h2 id="bottom">bottom ${nonce}</h2>
<div id="scrolly">0</div>`,
			`addEventListener('scroll',()=>{
  document.getElementById('scrolly').textContent=String(Math.round(scrollY));},{passive:true});`,
		),

		keys: SHELL(
			`Key Recorder`,
			`<h1>keys ${nonce}</h1>
<input id="target" autofocus placeholder="focus me">
<div id="typed"></div>
<div id="lastkey">none</div>
<div id="keycode">none</div>
<div id="keypress">none</div>
<div id="chord">none</div>
<div id="composed">none</div>`,
			`const t=document.getElementById('target');
t.addEventListener('input',()=>{document.getElementById('typed').textContent=t.value;});
addEventListener('keydown',e=>{
  document.getElementById('lastkey').textContent=e.key;
  document.getElementById('keycode').textContent=String(e.keyCode)+'/'+String(e.which)+'/'+e.code;
  if(e.ctrlKey||e.metaKey||e.altKey)
    document.getElementById('chord').textContent=
      (e.ctrlKey?'Ctrl+':'')+(e.altKey?'Alt+':'')+(e.metaKey?'Meta+':'')+e.key;});
addEventListener('keypress',e=>{
  document.getElementById('keypress').textContent=e.key;});
t.addEventListener('compositionend',e=>{
  document.getElementById('composed').textContent=e.data??'';});`,
		),

		// The pad is viewport-fixed at the origin so a test can name a coordinate
		// that is certainly inside it without first measuring the layout.
		mouse: SHELL(
			`Mouse Recorder`,
			`<div id="pad" style="position:fixed;left:0;top:0;width:400px;height:300px;background:#eef"></div>
<div style="margin-top:320px"><h1>mouse ${nonce}</h1>
<div id="lastclick">none</div>
<div id="lastmove">none</div>
<div id="wheel">0</div>
<div id="clicks">0</div></div>`,
			`const pad=document.getElementById('pad');let n=0;
pad.addEventListener('click',e=>{n++;
  document.getElementById('clicks').textContent=String(n);
  document.getElementById('lastclick').textContent=e.clientX+','+e.clientY+',b'+e.button;});
pad.addEventListener('mousemove',e=>{
  document.getElementById('lastmove').textContent=e.clientX+','+e.clientY;});
addEventListener('wheel',e=>{
  document.getElementById('wheel').textContent=String(Math.round(e.deltaY));},{passive:true});`,
		),

		// B2.4: the four gestures the pointer and keyboard tools add, each recorded into a DOM element
		// the tools read back. The menu opens on `mouseover` **only** — no click handler anywhere on
		// the trigger — so a `browser_hover` that secretly clicked would be caught by `#opened-by`
		// rather than passing. `#dbl` counts `dblclick` and `#single` counts `click`, so the two-pair
		// ramp is checkable from the page's side: a real double click leaves `single=2, dbl=1`, while
		// one press/release pair carrying `clickCount: 2` would leave `single=0, dbl=1`.
		pointer: SHELL(
			`Pointer Recorder`,
			`<h1>pointer ${nonce}</h1>
<div id="menu-host"><button id="menu-trigger" type="button">Menu</button>
<ul id="menu" hidden><li id="menu-item">Item ${nonce}</li></ul></div>
<div id="opened-by">none</div>
<button id="dblbtn" type="button">Double me</button>
<div id="single">0</div>
<div id="dbl">0</div>
<div id="ctx">none</div>
<input id="chord-target" placeholder="aim a chord here">
<div id="chord">none</div>
<div id="chord-target-id">none</div>
<div id="focus-clicks">0</div>`,
			`const trigger=document.getElementById('menu-trigger');
const menu=document.getElementById('menu');
trigger.addEventListener('mouseover',()=>{
  menu.hidden=false;
  document.getElementById('opened-by').textContent='hover';});
trigger.addEventListener('click',()=>{
  document.getElementById('opened-by').textContent='click';});
let single=0,dbl=0;
const btn=document.getElementById('dblbtn');
btn.addEventListener('click',()=>{document.getElementById('single').textContent=String(++single);});
btn.addEventListener('dblclick',()=>{document.getElementById('dbl').textContent=String(++dbl);});
document.addEventListener('contextmenu',e=>{
  e.preventDefault();
  document.getElementById('ctx').textContent=(e.target.id||e.target.tagName)+'@'+e.button;});
const chordTarget=document.getElementById('chord-target');
let focusClicks=0;
chordTarget.addEventListener('click',()=>{
  document.getElementById('focus-clicks').textContent=String(++focusClicks);});
chordTarget.addEventListener('keydown',e=>{
  document.getElementById('chord').textContent=
    (e.ctrlKey?'Ctrl+':'')+(e.altKey?'Alt+':'')+(e.metaKey?'Meta+':'')+(e.shiftKey?'Shift+':'')+e.key;
  document.getElementById('chord-target-id').textContent=
    (document.activeElement&&document.activeElement.id)||'none';});`,
		),

		// B2.5: the four gestures the action tools add, each recorded into a DOM element the tools read
		// back. The `<select>` records its change handler firing, because "the value is set" and "the
		// page knows the value is set" are different claims and only the second is what a replay needs.
		// The slider records both its value and whether it saw the intermediate moves, so a drag that
		// pressed and released without moving is caught rather than passing.
		actions: SHELL(
			`Action Recorder`,
			`<h1>actions ${nonce}</h1>
<select id="colour">
  <option value="r">Rouge</option>
  <option value="g">Vert</option>
  <option value="b">Bleu</option>
</select>
<div id="changed">none</div>
<div id="change-count">0</div>
<input id="upload" type="file">
<div id="uploaded">none</div>
<input id="slider" type="range" min="0" max="100" value="0" style="width:400px">
<div id="slider-value">0</div>
<div id="drag-moves">0</div>
<button id="alertbtn" type="button">alert</button>
<button id="confirmbtn" type="button">confirm</button>
<button id="promptbtn" type="button">prompt</button>
<div id="dialog-result">none</div>
<div class="tall"></div>
<button id="deep" type="button">deep button ${nonce}</button>
<div id="scrolly">0</div>`,
			`const colour=document.getElementById('colour');
let changes=0;
colour.addEventListener('change',()=>{
  document.getElementById('changed').textContent=colour.value;
  document.getElementById('change-count').textContent=String(++changes);});
document.getElementById('upload').addEventListener('change',e=>{
  const f=e.target.files[0];
  document.getElementById('uploaded').textContent=f?(f.name+':'+f.size):'none';});
const slider=document.getElementById('slider');
let moves=0;
slider.addEventListener('input',()=>{
  document.getElementById('slider-value').textContent=slider.value;});
slider.addEventListener('mousemove',e=>{
  if(e.buttons===1) document.getElementById('drag-moves').textContent=String(++moves);});
document.getElementById('alertbtn').addEventListener('click',()=>{
  alert('alert-${nonce}');
  document.getElementById('dialog-result').textContent='alert-done';});
document.getElementById('confirmbtn').addEventListener('click',()=>{
  document.getElementById('dialog-result').textContent=confirm('proceed?')?'confirmed':'dismissed';});
document.getElementById('promptbtn').addEventListener('click',()=>{
  const answer=prompt('your name?');
  document.getElementById('dialog-result').textContent=answer===null?'cancelled':('hello '+answer);});
addEventListener('scroll',()=>{
  document.getElementById('scrolly').textContent=String(Math.round(scrollY));},{passive:true});`,
		),

		tabs: SHELL(
			`Tab Opener`,
			`<h1>tabs ${nonce}</h1>
<a id="open" href="/second" target="_blank" rel="noopener">open second in a new tab</a>
<button id="openwin" type="button">window.open</button>`,
			`document.getElementById('openwin').addEventListener('click',()=>window.open('/second','_blank'));`,
		),

		// Content-rich, unambiguous, and machine-checkable: the extraction tool's
		// answer can be verified against facts that appear nowhere but here.
		article: SHELL(
			`Quarterly Report`,
			`<h1>Acme Corp Q3 Report</h1>
<p id="lede">Acme Corp reported revenue of <b>42 million euro</b> for the third quarter,
up from 31 million euro a year earlier. The chief executive is <b>Dana Whitfield</b>.</p>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Revenue</td><td id="rev">42000000</td></tr>
  <tr><td>Employees</td><td id="emp">1280</td></tr>
  <tr><td>Headquarters</td><td id="hq">Rotterdam</td></tr>
</table>
<p id="footer">Run nonce ${nonce}.</p>`,
		),

		// Deliberately slow, for timeout and navigation-in-flight behaviour.
		slow: SHELL(`Slow Page`, `<h1>slow ${nonce}</h1><p id="slow-marker">eventually</p>`),

		// R3: state that must survive a session restart. The cookie and the
		// localStorage entry are written by the page itself, so what a later
		// session reads back is genuinely what the browser persisted.
		setcookie: SHELL(
			`Set State`,
			`<h1>set ${nonce}</h1><div id="done">no</div>`,
			`document.cookie='ttk=${nonce}; path=/; max-age=3600';
localStorage.setItem('ttk', '${nonce}');
document.getElementById('done').textContent='set-${nonce}';`,
		),

		showcookie: SHELL(
			`Show State`,
			`<h1>show ${nonce}</h1><div id="cookie">none</div><div id="local">none</div>`,
			`document.getElementById('cookie').textContent=document.cookie||'none';
document.getElementById('local').textContent=localStorage.getItem('ttk')||'none';`,
		),

		// E-33: attachment links. The page sets a cookie the attachment endpoints
		// require, so a completed download proves the *browser's* session fetched
		// it — a server-side re-fetch would get 403. Two links share a suggested
		// filename with different bodies (the observed overwrite defect), one has a
		// hostile name, one is empty, one arrives slowly, one is an inline PDF.
		downloads: SHELL(
			`Downloads`,
			`<h1>downloads ${nonce}</h1>
<ul>
<li><a id="dl-first" href="/download?name=report.txt&body=first">first report</a></li>
<li><a id="dl-second" href="/download?name=report.txt&body=second">second report</a></li>
<li><a id="dl-hostile" href="/hostile">hostile name</a></li>
<li><a id="dl-empty" href="/download?name=empty.bin&body=">empty file</a></li>
<li><a id="dl-slow" href="/slowdownload">slow export</a></li>
<li><a id="dl-pdf" href="/manual.pdf">inline pdf</a></li>
<li><a id="dl-huge" href="/hugedownload">oversized export</a></li>
</ul>`,
		),

		title: SHELL(
			`Original Title`,
			`<h1>title ${nonce}</h1><button id="rename" type="button">rename</button>`,
			`document.getElementById('rename').addEventListener('click',()=>{
  document.title='Renamed ${nonce}';});`,
		),
	};
}

const ROUTES: Record<string, PageName> = {
	'/': 'index',
	'/second': 'second',
	'/form': 'form',
	'/long': 'long',
	'/keys': 'keys',
	'/mouse': 'mouse',
	'/pointer': 'pointer',
	'/actions': 'actions',
	'/tabs': 'tabs',
	'/article': 'article',
	'/slow': 'slow',
	'/title': 'title',
	'/setcookie': 'setcookie',
	'/showcookie': 'showcookie',
	'/downloads': 'downloads',
	'/frame': 'frame',
	'/oopif': 'oopif',
	'/egress': 'egress',
	'/content': 'content',
	'/frameset': 'frameset',
	'/framesetmenu': 'framesetmenu',
	'/framesetcontent': 'framesetcontent',
	'/framesetnested': 'framesetnested',
	'/framesetcross': 'framesetcross',
	'/objectcross': 'objectcross',
	'/embedcross': 'embedcross',
	'/focusframe': 'focusframe',
	'/pseudoframe': 'pseudoframe',
	'/liar': 'liar',
};

/** The cookie the attachment endpoints require; set by the `downloads` page. */
const DOWNLOAD_COOKIE = 'ttkdl';

/** `http://127.0.0.1:P` to `http://localhost:P` and back — a different *host* on the same port. */
function swappedHost(origin: string): string {
	return origin.includes('127.0.0.1') ? origin.replace('127.0.0.1', 'localhost') : origin.replace('localhost', '127.0.0.1');
}

/** `/measured` chunk size and total, chosen so a full transfer is unmistakable. */
const MEASURED_CHUNK = 64 * 1024;
const MEASURED_TOTAL = 32 * 1024 * 1024;

/** A minimal, valid single-page PDF, served inline so Chromium's viewer renders it. */
const TINY_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

/**
 * The attachment endpoints (E-33). Every one is cookie-gated; `null` means "not one of ours".
 */
function attachmentResponse(request: Request, path: string, nonce: string, slowMs: number): Response | null {
	if (!['/download', '/hostile', '/slowdownload', '/hugedownload', '/manual.pdf'].includes(path)) return null;
	const cookies = request.headers.get('cookie') ?? '';
	if (!cookies.includes(`${DOWNLOAD_COOKIE}=${nonce}`)) {
		return new Response('cookie required', { status: 403, headers: { 'content-type': 'text/plain' } });
	}
	const common = { 'cache-control': 'no-store' };
	if (path === '/manual.pdf') {
		return new Response(TINY_PDF, { headers: { ...common, 'content-type': 'application/pdf' } });
	}
	if (path === '/hostile') {
		return new Response(`hostile-${nonce}`, {
			headers: {
				...common,
				'content-type': 'application/octet-stream',
				'content-disposition': 'attachment; filename="..\evil.txt"',
			},
		});
	}
	// Advertises far more than the 100 MiB per-file limit, then trickles: Chromium
	// reports `totalBytes` from this Content-Length on its first progress event, so
	// the watchdog cancels the transfer before the body matters (E-33 limits).
	if (path === '/hugedownload') {
		const chunk = new Uint8Array(64 * 1024);
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				controller.enqueue(chunk);
			},
			cancel() {/* the browser hung up: expected, this stream never ends on its own */},
		});
		return new Response(body, {
			headers: {
				...common,
				'content-type': 'application/octet-stream',
				'content-length': String(200 * 1024 * 1024),
				'content-disposition': 'attachment; filename="oversized.bin"',
			},
		});
	}
	if (path === '/slowdownload') {
		const encoder = new TextEncoder();
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent === 4) {
					controller.close();
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, slowMs / 4));
				controller.enqueue(encoder.encode(`chunk${sent}-${nonce};`));
				sent += 1;
			},
		});
		return new Response(body, {
			headers: {
				...common,
				'content-type': 'application/octet-stream',
				'content-disposition': 'attachment; filename="slow.bin"',
			},
		});
	}
	const url = new URL(request.url);
	const name = url.searchParams.get('name') ?? 'download.bin';
	const content = url.searchParams.get('body') ?? '';
	return new Response(content, {
		headers: {
			...common,
			'content-type': 'text/plain',
			'content-disposition': `attachment; filename="${name}"`,
		},
	});
}

const PATH_FOR: Record<PageName, string> = Object.fromEntries(
	Object.entries(ROUTES).map(([path, name]) => [name, path]),
) as Record<PageName, string>;

export interface FixtureSiteOptions {
	/** Overrides the run nonce; tests that assert on it usually let it default. */
	readonly nonce?: string;
	/** Delay in ms before `/slow` responds. */
	readonly slowMs?: number;
	/**
	 * The hostname to bind. `127.0.0.1` by default; a second site on `localhost` is a different
	 * *site* to Chromium (scheme plus host, port ignored), which is what puts a frame it serves into
	 * its own renderer.
	 */
	readonly hostname?: '127.0.0.1' | 'localhost';
	/** The origin the `oopif` page embeds its `/frame` from. Defaults to this site's own origin. */
	readonly frameOrigin?: string;
	/**
	 * A second origin the `egress` page points at (owner item 6). A test that allowlists only this
	 * site's host uses it as the off-allowlist destination. Defaults to this site's own origin with
	 * `127.0.0.1` and `localhost` swapped, which is only reachable when a second site is bound there.
	 */
	readonly altOrigin?: string;
}

/** Starts the fixture site on an ephemeral loopback port. */
export function startFixtureSite(options: FixtureSiteOptions = {}): FixtureSite {
	const nonce = options.nonce ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	const slowMs = options.slowMs ?? 1_500;
	const hostname = options.hostname ?? '127.0.0.1';
	const hits: string[] = [];
	// The origin is only known once the port is, and `frameOrigin` defaults to it: render lazily.
	let body: Record<PageName, string> | null = null;
	let ownOrigin = '';

	// U-4's counter: how many bytes this site actually handed to the socket.
	const measured = { served: 0, total: MEASURED_TOTAL };

	const server = Deno.serve({ hostname, port: 0, onListen: () => {} }, async (request) => {
		body ??= pages(nonce, options.frameOrigin ?? ownOrigin, options.altOrigin ?? swappedHost(ownOrigin));
		const url = new URL(request.url);
		const path = url.pathname;
		hits.push(path);
		// An open redirect, as a real site would have one: `?to=` is followed
		// verbatim. It exists so a redirect *off* the allowlist can be provoked
		// from an allowed host.
		if (path === '/redirect') {
			const to = url.searchParams.get('to') ?? '/';
			return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
		}
		// An attachment with no cookie gate: the egress tests are about *where* a
		// download comes from, and a cookie set on one host is not sent to another.
		if (path === '/opendownload') {
			const name = url.searchParams.get('name') ?? 'file.bin';
			return new Response(url.searchParams.get('body') ?? '', {
				headers: {
					'content-type': 'application/octet-stream',
					'content-disposition': `attachment; filename="${name}"`,
					'cache-control': 'no-store',
				},
			});
		}
		if (path === '/measured') {
			// Deliberately *not* cookie-gated: U-4 is about transfer cost, and an
			// auth gate would only add a way for the probe to measure nothing.
			measured.served = 0;
			const chunk = new Uint8Array(MEASURED_CHUNK).fill(0x41);
			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= MEASURED_TOTAL) {
						controller.close();
						return;
					}
					// Counted on `pull`, which the runtime calls as the consumer
					// drains: what is counted is what left this process, not what was
					// queued for it.
					controller.enqueue(chunk);
					sent += chunk.length;
					measured.served = sent;
				},
				cancel() {
					sent = MEASURED_TOTAL;
				},
			});
			return new Response(stream, {
				headers: {
					'content-type': 'application/octet-stream',
					'content-length': String(MEASURED_TOTAL),
					'cache-control': 'no-store',
					'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
					'etag': '\"ttk-measured\"',
				},
			});
		}
		const attachment = attachmentResponse(request, path, nonce, slowMs);
		if (attachment !== null) return attachment;
		const name = ROUTES[path];
		if (name === undefined) {
			return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
		}
		if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, slowMs));
		return new Response(body[name], {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				// No caching: a second navigation must really re-fetch, so `hits`
				// stays an honest record of what the browser did.
				'cache-control': 'no-store',
				...(name === 'downloads' ? { 'set-cookie': `${DOWNLOAD_COOKIE}=${nonce}; Path=/` } : {}),
			},
		});
	});

	const { port } = server.addr as Deno.NetAddr;
	const origin = `http://${hostname}:${port}`;
	ownOrigin = origin;

	return {
		url: `${origin}/`,
		nonce,
		page: (name) => `${origin}${PATH_FOR[name]}`,
		hits,
		measured,
		close: async () => {
			await server.shutdown();
		},
	};
}
