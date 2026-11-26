/** Embedded in report.html so the page also works when copied or opened offline. */
export const css = `
:root {
  color-scheme:light dark; --bg:#f9faf6; --paper:#fff; --ink:#172e36; --sub:#4f6366;
  --green:#16665c; --line:#cdd8d3; --tint:#e4f1eb; --area:#dceae3; --warm:#855126; --accent:#16665c;
}
@media(prefers-color-scheme:dark) { :root {
  --bg:#152320; --paper:#1e302d; --ink:#ebf5ef; --sub:#bdcfc8; --green:#98dcca;
  --line:#465d56; --tint:#243e36; --area:#355348; --warm:#eabc90;
} }
* {box-sizing:border-box}
body {margin:0 auto;max-width:1280px;padding:0 clamp(18px,4.375vw,56px);background:var(--bg);color:var(--ink);
  font:17px/1.58 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Segoe UI",sans-serif;
  font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
a,summary {color:var(--green)}
a:focus-visible,summary:focus-visible {outline:3px solid var(--warm);outline-offset:3px}
header,.hero,.topic {border-bottom:1px solid var(--line)}
header,footer,.ends,.ruler-head,.reading {display:flex;align-items:center;justify-content:space-between;gap:12px}
header {min-height:75px;flex-wrap:wrap}
.brand {display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--ink);font-size:21px;font-weight:700}
.brand span {font-size:17px;font-weight:400;padding-left:20px;margin-left:16px;border-left:1px solid var(--line);color:var(--sub)}
small,.muted,.intro,.deck,.ends {color:var(--sub)}
small,.muted,.ends,summary,.footline,.button {font-size:15px}
.hero {padding:36px 0 20px}
.hero h1,.hero-title {font-size:clamp(29px,3.125vw,40px);line-height:1.25;margin:18px 0}
.deck,.intro {font-size:19px;margin:0}.hero .deck+.deck {margin-top:24px}
.eyebrow {font-size:14px;font-weight:650;letter-spacing:1px;color:var(--green);margin:0}
.stale,.verdict {color:var(--warm)}
h2 {font-size:25px;line-height:1.35;margin:0 0 14px}
h3,.big {font-size:29px;line-height:1.35;margin:14px 0 18px}
.spine {padding-top:25px}
.layout {display:grid;grid-template-columns:minmax(0,709fr) minmax(0,419fr);gap:40px;align-items:start}
.rail {position:relative;padding-left:54px}
.rail:before {content:"";position:absolute;left:22px;top:20px;bottom:20px;border-left:2px solid var(--line)}
.card,.panel,.lesson {background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:22px 25px}
.card {position:relative;padding-block:19px 17px}.card+.card {margin-top:30px}
.card:before,.ruler i {width:10px;height:10px;background:var(--green);border:3px solid var(--bg);outline:2px solid var(--green);border-radius:50%}
.card:before {content:"";position:absolute;left:-37px;top:31px}
.card h3 {margin:9px 0 14px}.reading {line-height:1.45;margin:12px 0}.card .reading {margin:9px 0}
.reading b {font-size:18px}.reading small {flex-shrink:0}.card .muted {margin:9px 0}
.button {display:inline-block;padding:9px 22px;border-radius:8px;background:var(--accent);color:white;text-decoration:none;margin-top:3px;min-width:156px;text-align:center}
.workload h2 {margin-bottom:0}.workload h3 {margin:25px 0 12px}.workload .muted {margin:5px 0}
.workload svg {width:100%;height:auto;display:block;margin-top:8px}
.area {fill:var(--area)}.trend {stroke:var(--green);stroke-width:2.5;stroke-linejoin:round;fill:none}
.marker {stroke:var(--warm);stroke-dasharray:3 4}.dot {fill:var(--green)}.ends {margin:4px 0}
.footline {border-top:1px solid var(--line);padding-top:13px;margin:12px 0 0}
.lesson,.tint,.after {background:var(--tint)}.lesson {padding:16px 19px}.lesson p {margin:5px 0 0}.side>.lesson {margin-top:16px}
.topic {padding:38px 0}.topic h2 {margin:9px 0}.intro {margin:0 0 18px}
.jump {display:flex;flex-wrap:wrap;gap:8px 18px;padding:20px 0;border-block:1px solid var(--line);margin:32px 0 0}
.day li {margin:.45rem 0}.day time {color:var(--sub)}details {margin:12px 0}summary {cursor:pointer;font-weight:600}
.scroll {overflow-x:auto}table {width:100%;border-collapse:collapse;margin:.4rem 0;background:var(--paper)}
th,td {text-align:start;padding:7px 12px;border-bottom:1px solid var(--line)}th {font-size:15px;color:var(--green)}
.pair,.notes-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.checks {margin-top:18px}.checks h3,.topic .panel h3 {font-size:22px}
.detail {display:none;padding-bottom:24px;scroll-margin-top:75px}.detail:target {display:block;outline:none}
body:has(.detail:target) main {display:none}.back {float:right;font-size:15px}
.ruler-head {margin:30px 0 24px}.ruler-head h2 {margin:0}
.ruler {position:relative;list-style:none;margin:0 0 30px;padding:0;height:86px}
.ruler:before,.ruler.partial:after {content:"";position:absolute;top:39px;left:6%;right:6%;height:2px;background:var(--green)}
.ruler.partial:after {left:65.5%;right:6.5%;background:var(--bg);border-top:2px dashed var(--line)}
.ruler li {position:absolute;width:118px;transform:translateX(-50%);text-align:center;font-size:15px;color:var(--sub)}
.ruler li:first-child {left:6%}.ruler li:nth-child(2) {left:50%}.ruler li:nth-child(3) {left:65%}.ruler li:last-child {left:94%}
.ruler time {color:var(--green);white-space:nowrap}.ruler i {display:block;position:relative;margin:11px auto}
.compare h3 {border-bottom:1px solid var(--line);padding-bottom:12px}.compare .reading {min-height:32px}.detail>.eyebrow {margin-bottom:8px}
.notes-grid {margin:16px 0}.notes-grid .lesson {font-size:16px}
footer {font-size:14px;margin-top:24px;padding:18px 0 25px;color:var(--sub);border-top:1px solid var(--line)}
@media(max-width:850px) {
 .layout,.pair,.notes-grid {grid-template-columns:1fr}.layout {gap:22px}.rail {padding-left:27px}.rail:before {left:7px}.card:before {left:-26px}
 .reading {flex-wrap:wrap}.ruler-head,footer {align-items:flex-start;flex-direction:column}
}
@media(max-width:640px) {
 header {padding:12px 0;gap:5px}.hero {padding:24px 0}.brand span {margin-left:4px;padding-left:10px}
 .card,.panel {padding:16px}.ruler {height:auto}.ruler:before,.ruler:after,.ruler li i {display:none}
 .ruler li {position:static;width:auto;transform:none;display:flex;align-items:center;gap:8px;text-align:left}
 .card h3 {font-size:23px}.back {float:none;display:block;margin-bottom:8px}
}
`;
