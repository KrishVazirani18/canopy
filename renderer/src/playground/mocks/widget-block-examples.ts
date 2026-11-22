import type { Example } from './widget-examples';

// ---- Hand-written: the building blocks (docs/design/visual-widgets.md) ----
// One widget per block, written the way a model is meant to write them (the Playground's "Widgets, Next" is the target),
// drawn by the real frame. Kept apart from widget-examples.ts, which scripts/widget-examples.mjs regenerates.

const SLIDES_CSS = `<style>
.slide { width: 100%; height: 100%; box-sizing: border-box; }
.ed { display: flex; flex-direction: column; justify-content: space-between; padding: 88px; background: #f3eee4; color: #1c1a15; }
.ed .top { display: flex; justify-content: space-between; font-size: 20px; letter-spacing: .2em; text-transform: uppercase; color: #7a7264; }
.ed h1 { max-width: 1000px; font: 400 100px/1.02 ui-serif, "New York", Georgia, serif; letter-spacing: -.02em; }
.ed .rule { width: 96px; height: 3px; margin-top: 32px; background: #2f6b4f; }
.nf { display: flex; align-items: center; gap: 96px; padding: 0 120px; background: radial-gradient(120% 90% at 20% 30%, #183a2a 0%, #0c1712 70%); color: #eef5f0; }
.nf .mark { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.nf .mark i { display: block; height: 56px; border-radius: 99px; }
.nf h1 { font-size: 140px; line-height: 1; font-weight: 600; letter-spacing: -.04em; }
.nf p { max-width: 620px; margin-top: 24px; font-size: 34px; line-height: 1.35; color: #a9c4b3; }
.pf { display: flex; align-items: center; gap: 64px; padding: 0 96px; background: #121212; color: #f2f2f2; }
.pf .words { width: 440px; flex: none; }
.pf h1 { font-size: 76px; line-height: 1.05; font-weight: 600; letter-spacing: -.03em; }
.pf p { margin-top: 24px; font-size: 28px; line-height: 1.4; color: #9a9a9a; }
.pf .app { display: flex; flex: 1; height: 520px; overflow: hidden; border-radius: 22px; background: #1b1b1b; box-shadow: 0 40px 80px -20px rgba(0,0,0,.6), 0 0 0 1px #2a2a2a; }
.pf .side { width: 230px; padding: 20px; background: #161616; border-right: 1px solid #262626; }
.pf .chat { padding: 10px 12px; border-radius: 10px; font-size: 17px; line-height: 1.4; }
.pf .chat small { display: block; font-size: 14px; color: #8a8a8a; }
.pf .chat.on { background: #242424; }
.pf .main { flex: 1; padding: 28px; font-size: 18px; line-height: 1.6; color: #cfcfcf; }
.pf .bubble { width: fit-content; margin: 0 0 20px auto; padding: 12px 20px; border-radius: 16px; background: #262626; color: #f2f2f2; }
</style>`;
const ED = `<div class="slide ed"><div class="top"><span>Canopy</span><span>Launch · November 2026</span></div><div><h1>Calm software for people who build with AI.</h1><div class="rule"></div></div></div>`;
const NF = `<div class="slide nf"><div class="mark"><i style="width:150px;background:#8fd1a8"></i><i style="width:230px;background:#4fae7c"></i><i style="width:310px;background:#2c7a52"></i></div><div><h1>Canopy</h1><p>Every Claude Code and Codex chat, calm and in one place.</p></div></div>`;
const PF = `<div class="slide pf"><div class="words"><h1>Your chats, triaged.</h1><p>See what needs you, what’s working, and what’s done.</p></div><div class="app"><div class="side"><div class="chat on">Fix the Font Picker<small>Waiting on you</small></div><div class="chat">Sidebar Row Sizing<small>Done · 14m</small></div><div class="chat">Usage Telemetry<small>Working</small></div></div><div class="main"><div class="bubble">Which font should we use?</div>SF Pro matches the rest of macOS and stays crisp at small sizes.</div></div></div>`;

const LANDING = `<div style="display:flex;flex-direction:column;width:100%;height:100%;padding:40px 110px 0;box-sizing:border-box;background:#0f1a14;color:#eef5f0">
  <header style="display:flex;justify-content:space-between;font-size:17px;line-height:1.4;color:#a9c4b3"><b style="color:#eef5f0;font-weight:600">Canopy</b><nav style="display:flex;gap:32px"><span>Features</span><span>Pricing</span><span>Docs</span></nav></header>
  <h1 style="max-width:900px;margin-top:110px;font-size:80px;line-height:1.04;font-weight:600;letter-spacing:-.035em">Calm software for people who build with AI, every day.</h1>
  <p style="margin-top:24px;font-size:24px;line-height:1.4;color:#a9c4b3">Every Claude Code and Codex chat in one window.</p>
  <div class="actions" style="display:flex;gap:12px;margin-top:36px;font-size:19px;line-height:1.4"><span role="button" style="padding:14px 28px;border-radius:99px;background:#eef5f0;color:#0f1a14;font-weight:500">Download for Mac</span><span role="button" style="padding:14px 28px;border-radius:99px;border:1px solid #3d5a49">Watch the tour</span></div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:auto;padding-bottom:48px;font-size:20px;line-height:1.4"><article style="padding:24px;border-radius:16px;background:#16261d">Triage, not tabs</article><article style="padding:24px;border-radius:16px;background:#16261d">Every account</article><article style="padding:24px;border-radius:16px;background:#16261d">Nothing to learn</article></div>
</div>`;

const ONBOARDING: [string, string, string, boolean][] = [
  ['Welcome', 'The mark and one line', '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;height:100%;background:#fafafa;color:#111"><div style="display:flex;flex-direction:column;align-items:center;gap:8px"><i style="display:block;width:60px;height:20px;border-radius:99px;background:#8fd1a8"></i><i style="display:block;width:90px;height:20px;border-radius:99px;background:#4fae7c"></i><i style="display:block;width:120px;height:20px;border-radius:99px;background:#2c7a52"></i></div><div style="font-size:44px;font-weight:600">Welcome to Canopy</div></div>', true],
  ['Sign In', 'Google, one button', '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;height:100%;background:#fafafa;color:#111"><div style="font-size:40px;font-weight:600">Sign in</div><div style="padding:16px 40px;border:1px solid #ddd;border-radius:99px;font-size:24px">Continue with Google</div></div>', true],
  ['Your Tools', 'Claude Code and Codex found', '<div style="display:flex;flex-direction:column;justify-content:center;gap:16px;height:100%;padding:0 160px;background:#fafafa;color:#111"><div style="display:flex;justify-content:space-between;padding:24px 32px;border:1px solid #ddd;border-radius:16px;font-size:26px">Claude Code 2.1.328<span style="color:#888">Ready</span></div><div style="display:flex;justify-content:space-between;padding:24px 32px;border:1px solid #ddd;border-radius:16px;font-size:26px">Codex 0.170.0<span style="color:#888">Ready</span></div></div>', true],
  ['Pick a Folder', 'Where chats start', '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;height:100%;background:#fafafa;color:#111"><div style="font-size:40px;font-weight:600">Pick a project</div><div style="padding:56px 96px;border:2px dashed #ccc;border-radius:16px;font-size:24px;color:#888">Drop a folder here</div></div>', false],
  ['Look', 'Light, dark, size', '<div style="display:flex;align-items:center;justify-content:center;gap:32px;height:100%;background:#fafafa"><div style="width:380px;height:300px;border:1px solid #ddd;border-radius:16px;background:#f4f4f4"></div><div style="width:380px;height:300px;border-radius:16px;background:#1b1b1b"></div></div>', false],
  ['Tour', 'Four stops over the app', '<div style="position:relative;height:100%;background:#fafafa"><div style="position:absolute;top:30%;left:18%;width:460px;padding:32px;border:1px solid #ddd;border-radius:16px;background:#fff;font-size:24px;color:#111;box-shadow:0 20px 40px rgba(0,0,0,.12)">This is where chats that need you show up.</div></div>', false],
];

export const BLOCK_EXAMPLES: Example[] = [
  {
    id: 'block-deck', title: 'Title slide directions', kind: 'Hand-written · pick, preview, scale',
    ask: 'make a title slide for the canopy launch deck, give me a few directions',
    before: 'Three directions at full size. Point at a thumbnail to see it large. I’d go with **Night Forest**: the mark carries the slide and it reads from the back of a room.',
    code: `${SLIDES_CSS}
<style>
.deck .big { overflow: hidden; border: 1px solid var(--color-border-tertiary); border-radius: 12px; }
.deck .thumbs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.deck .thumbs canopy-scale { overflow: hidden; border-radius: 6px; box-shadow: 0 0 0 1px var(--color-border-tertiary); }
</style>
<canopy-pick class="deck" message="Go with {choice} for the title slide" button="Use {choice}">
  <canopy-preview class="big">
    <canopy-scale for="Editorial" width="1280" height="720">${ED}</canopy-scale>
    <canopy-scale for="Night Forest" width="1280" height="720">${NF}</canopy-scale>
    <canopy-scale for="Product First" width="1280" height="720">${PF}</canopy-scale>
  </canopy-preview>
  <div class="thumbs">
    <figure option="Editorial" hint="Warm paper, a serif headline"><canopy-scale width="1280" height="720">${ED}</canopy-scale></figure>
    <figure option="Night Forest" hint="Dark, the mark large" recommended><canopy-scale width="1280" height="720">${NF}</canopy-scale></figure>
    <figure option="Product First" hint="The app does the talking"><canopy-scale width="1280" height="720">${PF}</canopy-scale></figure>
  </div>
</canopy-pick>`,
  },
  {
    id: 'block-brand', title: 'Brand directions', kind: 'Hand-written · pick on boards in their own colors and type',
    ask: 'brand directions for the canopy site?',
    before: 'Three boards, each with its wordmark, colors, a button and a line of copy, so you judge them whole. **Forest** fits a calm product best.',
    code: `<style>
.boards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.board { display: flex; flex-direction: column; overflow: hidden; padding: 0; border: 1px solid var(--color-border-tertiary); border-radius: 12px; }
.board .face { display: flex; flex-direction: column; gap: 20px; padding: 20px; }
.board .word { font-size: 34px; line-height: 1; font-weight: 600; letter-spacing: -.03em; }
.board .line { font-size: 13px; line-height: 1.5; }
.board .cta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.board .cta b { padding: 6px 14px; border-radius: 99px; font-weight: 500; }
.board .sw { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; font-size: 10px; line-height: 14px; }
.board .sw i { display: block; height: 36px; margin-bottom: 4px; border-radius: 6px; box-shadow: inset 0 0 0 1px rgba(127,127,127,.25); }
.board canopy-caption { padding: 10px 14px; border-top: 1px solid var(--color-border-tertiary); background: var(--color-background-secondary); }
</style>
<canopy-pick message="Go with the {choice} brand">
  <div class="boards">
    <div class="board" option="Forest" hint="Green and paper, a serif" recommended>
      <div class="face" style="background:#f3eee4;color:#1c1a15;font-family:ui-serif,'New York',Georgia,serif">
        <div class="word">Canopy</div><div class="line" style="color:#6f685b">Calm software for people who build with AI.</div>
        <div class="cta"><b style="background:#2f6b4f;color:#f3eee4">Download</b><u style="color:#6f685b">Read more</u></div>
        <div class="sw" style="color:#6f685b"><div><i style="background:#2f6b4f"></i>Moss</div><div><i style="background:#8fb39b"></i>Fern</div><div><i style="background:#f3eee4"></i>Paper</div><div><i style="background:#1c1a15"></i>Ink</div></div>
      </div>
    </div>
    <div class="board" option="Ink" hint="Black and white, one dot">
      <div class="face" style="background:#0e0e0e;color:#f5f5f5;font-family:-apple-system,system-ui">
        <div class="word">canopy.</div><div class="line" style="color:#8d8d8d">Calm software for people who build with AI.</div>
        <div class="cta"><b style="background:#f5f5f5;color:#0e0e0e">Download</b><u style="color:#8d8d8d">Read more</u></div>
        <div class="sw" style="color:#8d8d8d"><div><i style="background:#0e0e0e"></i>Black</div><div><i style="background:#3a3a3a"></i>Graphite</div><div><i style="background:#d9d9d9"></i>Mist</div><div><i style="background:#4fae7c"></i>Signal</div></div>
      </div>
    </div>
    <div class="board" option="Dawn" hint="Warm, rounded, friendly">
      <div class="face" style="background:#fbf3ea;color:#3b2a3a;font-family:ui-rounded,'SF Pro Rounded',system-ui">
        <div class="word">Canopy</div><div class="line" style="color:#8a6f68">Calm software for people who build with AI.</div>
        <div class="cta"><b style="background:#c8553d;color:#fbf3ea">Download</b><u style="color:#8a6f68">Read more</u></div>
        <div class="sw" style="color:#8a6f68"><div><i style="background:#c8553d"></i>Clay</div><div><i style="background:#d9a441"></i>Honey</div><div><i style="background:#efe3d0"></i>Sand</div><div><i style="background:#3b2a3a"></i>Plum</div></div>
      </div>
    </div>
  </div>
</canopy-pick>`,
  },
  {
    id: 'block-colors', title: 'Needs-you dot color', kind: 'Hand-written · pick whose preview reads [data-shown]',
    ask: 'what color should the needs-you dot be',
    before: 'Point at a color to see it on the sidebar. **Leaf** is calm but still stands out; amber reads as a warning.',
    code: `<style>
.dotpick { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 12px; }
.bar { display: flex; flex-direction: column; gap: 2px; padding: 12px; border: 1px solid var(--color-border-tertiary); border-radius: 12px; background: var(--color-background-secondary); }
.bar .h { padding: 0 8px 4px; font-size: 11px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--color-text-tertiary); }
.bar .r { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 8px; }
.bar .r small { display: block; }
.needs { width: 8px; height: 8px; border-radius: 50%; background: #4fae7c; transition: background-color 200ms; }
canopy-pick[data-shown="Sky"] .needs { background: #4a9eff; }
canopy-pick[data-shown="Amber"] .needs { background: #f0a63a; }
canopy-pick[data-shown="Rose"] .needs { background: #e5607a; }
canopy-pick[data-shown="Violet"] .needs { background: #9b7bff; }
.swatches { display: flex; flex-direction: column; gap: 2px; }
.swatch { display: flex; align-items: center; gap: 12px; padding: 8px 10px; }
.swatch i { width: 22px; height: 22px; flex: none; border-radius: 50%; }
.swatch[data-picked] i { box-shadow: 0 0 0 2px var(--color-background-primary), 0 0 0 3.5px var(--color-text-primary); }
.swatch small { display: block; }
</style>
<canopy-pick message="Make the needs-you dot {choice}">
  <div class="dotpick">
    <div class="bar">
      <div class="h">Needs You</div>
      <div class="r"><div>Fix the Font Picker<small>Waiting on you · 2m</small></div><span class="needs"></span></div>
      <div class="r"><div>Launch Deck<small>Asking to run a command</small></div><span class="needs"></span></div>
      <div class="r"><div>Usage Telemetry<small>Working</small></div></div>
      <div class="r"><div>Sidebar Row Sizing<small>Done · 14m</small></div></div>
    </div>
    <div class="swatches">
      <div class="swatch" option="Leaf" recommended><i style="background:#4fae7c"></i><div>Leaf <span class="dot"></span><small>Today’s green</small></div></div>
      <div class="swatch" option="Sky"><i style="background:#4a9eff"></i><div>Sky<small>Calm blue</small></div></div>
      <div class="swatch" option="Amber"><i style="background:#f0a63a"></i><div>Amber<small>Reads as a warning</small></div></div>
      <div class="swatch" option="Rose"><i style="background:#e5607a"></i><div>Rose<small>Warmer, louder</small></div></div>
      <div class="swatch" option="Violet"><i style="background:#9b7bff"></i><div>Violet<small>Unusual on a Mac</small></div></div>
    </div>
  </div>
</canopy-pick>`,
  },
  {
    id: 'block-fonts', title: 'Interface font', kind: 'Hand-written · compare inside a pick',
    ask: 'im not sure i love the font canopy uses, can i pick from a few',
    before: 'Drag across the text to compare with what Canopy uses now. **SF Pro** is the Mac’s own and stays crisp at small sizes.',
    code: `<style>
.chips { display: flex; gap: 6px; margin-bottom: 10px; }
.chips button { height: 28px; border-radius: 99px; font-weight: 400; }
.para { display: flex; flex-direction: column; gap: 12px; height: 200px; padding: 20px; box-sizing: border-box; background: var(--color-background-secondary); }
.para h3 { font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; }
.para p { font-size: 15px; line-height: 1.6; }
.para .box { display: flex; justify-content: space-between; margin-top: auto; padding: 8px 12px; border: 1px solid var(--color-border-tertiary); border-radius: 12px; font-size: 13px; color: var(--color-text-secondary); }
</style>
<canopy-pick message="Use {choice} for the interface">
  <div class="chips">
    <button option="SF Pro" recommended style="font-family:-apple-system,'SF Pro Text',system-ui">SF Pro <span class="dot"></span></button>
    <button option="Helvetica Neue" style="font-family:'Helvetica Neue',Helvetica,sans-serif">Helvetica Neue</button>
    <button option="Avenir Next" style="font-family:'Avenir Next',Avenir,system-ui">Avenir Next</button>
  </div>
  <canopy-compare>
    <div class="para" label="Now · Geist" style="font-family:Geist,system-ui"><h3>Fix the Font Picker</h3><p>I moved the restart card into main, so a window reload keeps it. Your three queued messages go out in the order you set.</p><div class="box"><span>Add a follow-up</span><span>Opus 5.5 · High</span></div></div>
    <canopy-preview>
      <div class="para" for="SF Pro" style="font-family:-apple-system,'SF Pro Text',system-ui"><h3>Fix the Font Picker</h3><p>I moved the restart card into main, so a window reload keeps it. Your three queued messages go out in the order you set.</p><div class="box"><span>Add a follow-up</span><span>Opus 5.5 · High</span></div></div>
      <div class="para" for="Helvetica Neue" style="font-family:'Helvetica Neue',Helvetica,sans-serif"><h3>Fix the Font Picker</h3><p>I moved the restart card into main, so a window reload keeps it. Your three queued messages go out in the order you set.</p><div class="box"><span>Add a follow-up</span><span>Opus 5.5 · High</span></div></div>
      <div class="para" for="Avenir Next" style="font-family:'Avenir Next',Avenir,system-ui"><h3>Fix the Font Picker</h3><p>I moved the restart card into main, so a window reload keeps it. Your three queued messages go out in the order you set.</p><div class="box"><span>Add a follow-up</span><span>Opus 5.5 · High</span></div></div>
    </canopy-preview>
  </canopy-compare>
</canopy-pick>`,
  },
  {
    id: 'block-tune', title: 'Chat card spacing', kind: 'Hand-written · tune',
    ask: 'the chat cards feel cramped',
    before: 'Dial them in here; the cards change as you drag, and I’ll use exactly what you send.',
    code: `<style>
.tuner { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 12px; }
.cards { display: flex; flex-direction: column; gap: var(--gap); padding: 16px; border: 1px solid var(--color-border-tertiary); border-radius: 12px; background: var(--color-background-secondary); }
.cards .c { display: flex; align-items: center; justify-content: space-between; padding: calc(var(--pad) * .7) var(--pad); border: 1px solid var(--color-border-tertiary); border-radius: var(--radius); background: var(--color-background-primary); box-shadow: 0 1px 2px rgb(0 0 0 / calc(var(--shadow) * .25)), 0 8px 20px -8px rgb(0 0 0 / calc(var(--shadow) * .45)); transition: border-radius 120ms, padding 120ms, box-shadow 160ms; }
.cards .c small { display: block; }
.knobs { display: flex; flex-direction: column; gap: 14px; padding: 16px; border: 1px solid var(--color-border-tertiary); border-radius: 12px; }
</style>
<canopy-tune message="Set the chat cards to {values}">
  <div class="tuner">
    <div class="cards">
      <div class="c"><div>Fix the Font Picker<small>Waiting on you · 2m</small></div><span class="dot"></span></div>
      <div class="c"><div>Launch Deck<small>Done · 1h</small></div></div>
      <div class="c"><div>Usage Telemetry<small>Working</small></div></div>
    </div>
    <div class="knobs">
      <label>Corner radius <input type="range" name="radius" min="0" max="24" value="10" unit="px"></label>
      <label>Padding <input type="range" name="pad" min="8" max="28" value="14" unit="px"></label>
      <label>Space between <input type="range" name="gap" min="0" max="20" value="6" unit="px"></label>
      <label>Shadow <input type="checkbox" role="switch" name="shadow"></label>
    </div>
  </div>
</canopy-tune>`,
  },
  {
    id: 'block-markup', title: 'Landing page', kind: 'Hand-written · markup on a scaled mockup',
    ask: 'the landing page is close, a few things are off',
    before: 'Click anywhere on it to pin a note, or drag to box an area. I’ll get each note with what it was on.',
    code: `<canopy-markup title="the landing page">
  <canopy-scale width="1280" height="800" style="border-radius:12px">${LANDING}</canopy-scale>
</canopy-markup>`,
  },
  {
    id: 'block-review', title: 'Review of localhost:3000', kind: 'Hand-written · review of a screenshot look took',
    ask: 'have a look at the site and tell me what you think, then let me mark it up',
    before: 'Here’s the page as it is now. Pin anything you want changed; I’ll get the notes and the screenshot with them drawn on.',
    code: '<canopy-review ref="look-demo"></canopy-review>',
  },
  {
    id: 'block-shot-missing', title: 'Earlier screenshot', kind: 'Hand-written · a shot the host does not have',
    ask: 'show me the screenshot from before',
    code: '<canopy-shot ref="look-99" alt="The settings page before the change"></canopy-shot>',
  },
  {
    id: 'block-rank', title: 'What to build next', kind: 'Hand-written · rank',
    ask: 'what should we build next',
    before: 'Here’s what’s open. Drag them into the order you want them done.',
    code: `<canopy-rank message="Do them in this order: {order}">
  <div item="Visual widgets" hint="This: pick, tune, mark up"></div>
  <div item="Widgets in Codex chats" hint="Same blocks for OpenAI"></div>
  <div item="Effort per chat" hint="Like the model now is"></div>
  <div item="Download site" hint="Quiet launch page"></div>
  <div item="Benchmark run" hint="Terminal-Bench, three tools"></div>
</canopy-rank>`,
  },
  {
    id: 'block-many', title: 'Onboarding screens', kind: 'Hand-written · pick several',
    ask: 'onboarding feels long',
    before: 'All six screens. The three with a dot are the ones I’d keep; tick the ones you want.',
    code: `<style>
.screens { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.screens canopy-scale { overflow: hidden; border-radius: 6px; box-shadow: 0 0 0 1px var(--color-border-tertiary); transition: opacity 160ms; }
</style>
<canopy-pick multiple message="Keep these onboarding screens: {choice}. Cut the rest." button="Keep {count}">
  <div class="screens">
${ONBOARDING.map(([l, h, body, rec]) => `    <figure option="${l}" hint="${h}"${rec ? ' recommended' : ''}><canopy-scale width="1280" height="800">${body}</canopy-scale></figure>`).join('\n')}
  </div>
</canopy-pick>`,
  },
  {
    id: 'block-motion', title: 'How cards appear', kind: 'Hand-written · pick whose options play (CSS animation)',
    ask: 'how should cards appear',
    before: 'Four ways in. Point at one to watch it again. **Rise** is quick and quiet; spring is fun once, tiring by the tenth.',
    code: `<style>
@keyframes m-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes m-rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes m-grow { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: none } }
@keyframes m-spring { from { opacity: 0; transform: translateY(18px) scale(.94) } to { opacity: 1; transform: none } }
.moves { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.moves [option] { border: 1px solid var(--color-border-tertiary); }
.moves .stage { display: flex; align-items: center; justify-content: center; height: 110px; border-radius: 8px; background: var(--color-background-secondary); }
.moves .card { width: 80%; padding: 10px 12px; border: 1px solid var(--color-border-tertiary); border-radius: 8px; background: var(--color-background-primary); font-size: 12px; line-height: 16px; }
.moves .card small { display: block; font-size: 11px; }
.moves [option]:hover .card, .moves [option]:focus-visible .card { animation: var(--move); }
</style>
<canopy-pick message="Cards should enter with {choice}">
  <div class="moves">
    <div option="Fade" hint="150ms, nothing moves" style="--move: m-fade 150ms ease-out both"><div class="stage"><div class="card">Restart when done<small>Canopy restarts after 2 chats</small></div></div></div>
    <div option="Rise" hint="8px up, 220ms" recommended style="--move: m-rise 220ms cubic-bezier(.2,.8,.2,1) both"><div class="stage"><div class="card">Restart when done<small>Canopy restarts after 2 chats</small></div></div></div>
    <div option="Grow" hint="From 96%, 200ms" style="--move: m-grow 200ms cubic-bezier(.2,.8,.2,1) both"><div class="stage"><div class="card">Restart when done<small>Canopy restarts after 2 chats</small></div></div></div>
    <div option="Spring" hint="Overshoots a little" style="--move: m-spring 520ms cubic-bezier(.34,1.56,.64,1) both"><div class="stage"><div class="card">Restart when done<small>Canopy restarts after 2 chats</small></div></div></div>
  </div>
</canopy-pick>
<p class="faint small" style="margin-top:8px">Point at one to play it again.</p>`,
  },
];
