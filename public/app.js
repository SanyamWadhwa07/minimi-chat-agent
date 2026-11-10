// The chat page. Sends a message, reads the server-sent events of the turn, and shows them as they
// arrive: what memory found, each search, the streamed answer, its sources and timings.
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (s) => document.querySelector(s);
// Kept as references, not looked up by id: they move into the mini window and back.
const log = $("#log");
const dock = $(".dock");
const composer = $("#composer");
const input = $("#input");
const sendBtn = $("#send");

// Links in answers open in a new tab, and only http(s) and mailto links survive sanitising.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
const SAFE_URL = /^(?:https?:|mailto:)/i;

// ------------------------------------------------------------------ small helpers

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let sessionId = store.get("sessionId") || newSessionId();
function newSessionId() {
  const id = crypto.randomUUID();
  store.set("sessionId", id);
  return id;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
/** "Tue 3 Nov", with the year when it is not this year (an old source should look old). */
const fmtDay = (ms) => {
  const otherYear = new Date(ms).getFullYear() !== new Date().getFullYear();
  return new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(otherYear ? { year: "numeric" } : {}) }).replace(",", "");
};
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const isToday = (ms) => new Date(ms).toDateString() === new Date().toDateString();
const fmtWhen = (ms) => (isToday(ms) ? fmtTime(ms) : `${fmtDay(ms)}, ${fmtTime(ms)}`);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** "Tue 3 Nov", or "Mon 2 Nov to Sun 8 Nov" for a window longer than a day. */
const windowLabel = (start, end) => (end - start <= 26 * 3600e3 ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end - 1)}`);
const quote = (s, n = 80) => `“${s.length > n ? `${s.slice(0, n)}…` : s}”`;

/** A desk-calendar day: weekday on a marigold band, the date below. */
function dayTile(ms, empty = false) {
  const d = new Date(ms);
  const tile = el("span", `day${empty ? " empty" : ""}`);
  tile.setAttribute("aria-hidden", "true");
  tile.append(el("span", "dow", d.toLocaleDateString("en-GB", { weekday: "short" })), el("span", "num", String(d.getDate())));
  return tile;
}

const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 140;
const scrollDown = (force) => { if (force || nearBottom()) log.scrollTop = log.scrollHeight; };

/** Markdown -> safe HTML, with [2] and [1, 3] turned into links to the sources. */
function renderAnswer(text, sources) {
  const byN = new Map((sources || []).map((s) => [s.n, s]));
  const html = marked.parse(text);
  const withCites = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_, nums) => {
    const pills = nums.split(",").map((n) => {
      const s = byN.get(Number(n));
      return s && SAFE_URL.test(s.url)
        ? `<a href="${encodeURI(s.url)}" title="${s.title.replace(/"/g, "&quot;")}">${Number(n)}</a>`
        : `<span>${Number(n)}</span>`;
    });
    return `<sup class="cite">${pills.join("")}</sup>`;
  });
  return DOMPurify.sanitize(withCites, { ALLOWED_URI_REGEXP: SAFE_URL, FORBID_ATTR: ["style"] });
}

function sourceCards(list) {
  const box = el("div", "sources");
  for (const s of list) {
    const card = el("a", "source");
    if (SAFE_URL.test(s.url)) card.href = s.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.append(el("span", "n", String(s.n)), el("span", "title", s.title), el("span", "where", s.published ? `${host(s.url)}, ${fmtDay(Date.parse(s.published))}` : host(s.url)));
    box.append(card);
  }
  return box;
}

// ------------------------------------------------------------------ one turn on screen

function turnShell(question, at) {
  const turn = el("article", "turn");
  const you = el("div", "you");
  you.append(el("div", "bubble", question), el("div", "stamp", fmtWhen(at)));
  turn.append(you);
  log.append(turn);
  return turn;
}

// Words that show the user is referring back to an earlier conversation.
const REFERS_BACK = /\b(?:asked|told|said|mentioned|discussed|talked|recommended|suggested|shortlisted|earlier|before|last time|previously|remember)\b/i;

/** The agent's side of a turn, filled in as events arrive. */
function liveTurn(question) {
  const turn = turnShell(question, Date.now());
  const activity = el("details", "activity working");
  activity.open = true;
  const summary = el("summary");
  const summaryText = el("span", "text", "Checking memory");
  summary.append(icon("chevron"), summaryText);
  const steps = el("ul", "steps");
  activity.append(summary, steps);
  const answer = el("div", "answer");
  turn.append(activity, answer);

  const searches = new Map();
  const used = { days: [], searches: 0, results: 0, problems: 0 };
  let text = "";
  let pending = false;
  let sources = [];

  const step = (cls, glyph, what, tail) => {
    const li = el("li", `step ${cls}`);
    const g = el("span", "glyph");
    g.append(glyph);
    li.append(g, what);
    if (tail) li.append(tail);
    steps.append(li);
    return li;
  };
  const what = (strong, sub) => {
    const w = el("span", "what");
    w.append(el("b", null, strong));
    if (sub) w.append(el("span", "sub", sub));
    return w;
  };
  const paint = () => {
    pending = false;
    answer.innerHTML = renderAnswer(text, sources);
    scrollDown();
  };
  const finish = (summaryLabel) => {
    activity.classList.remove("working");
    if (!steps.children.length) return activity.remove();
    summaryText.textContent = summaryLabel;
    if (!used.problems) activity.open = false; // the evidence stays one click away
  };

  return {
    recall(e) {
      summaryText.textContent = "Thinking";
      for (const l of e.lookups) {
        const label = windowLabel(l.start, l.end);
        if (l.hits) {
          const first = e.turns.find((t) => t.why === "date" && t.askedAt >= l.start && t.askedAt < l.end);
          step("memory", dayTile(l.start), what(`${l.hits} conversation${l.hits > 1 ? "s" : ""} on ${label}`, first ? `${quote(first.question)} at ${fmtTime(first.askedAt)}` : null));
          used.days.push(fmtDay(l.start));
        } else {
          step("memory", dayTile(l.start, true), what(`Nothing stored for ${label}`, e.stored ? `Memory holds ${e.stored} other conversation${e.stored > 1 ? "s" : ""}` : "Memory is empty so far"));
        }
      }
      // The model sees topic matches either way. The page names them only when the user is referring
      // back to something and no date lookup found it; otherwise a shared word like "pricing" would be
      // shown as a connection that is not there.
      if (!e.lookups.some((l) => l.hits) && REFERS_BACK.test(question)) {
        for (const t of e.turns.filter((x) => x.why === "topic").slice(0, 2)) {
          step("memory", dayTile(t.askedAt), what(`Related, from ${fmtDay(t.askedAt)}`, quote(t.question)));
          used.days.push(fmtDay(t.askedAt));
        }
      }
      scrollDown();
    },
    search(e) {
      let row = searches.get(e.id);
      if (!row) {
        const w = el("span", "what");
        w.append(document.createTextNode(e.query));
        if (e.since) w.append(el("span", "since", `  since ${fmtDay(Date.parse(e.since))}`));
        row = step("search running", icon("search"), w, el("span", "tail", "searching"));
        searches.set(e.id, row);
        used.searches++;
        summaryText.textContent = `Searching ${searches.size === 1 ? "the web" : `${searches.size} things at once`}`;
      }
      const tail = row.querySelector(".tail");
      tail.replaceChildren();
      if (e.status === "done") {
        row.className = "step search";
        tail.append(icon("check"), `${e.results} result${e.results === 1 ? "" : "s"}`);
        used.results += e.results;
      } else if (e.status === "error") {
        row.className = "step search error";
        row.querySelector(".glyph").replaceChildren(icon("alert"));
        tail.append(e.error);
        used.problems++;
      }
      scrollDown();
    },
    notice(message) {
      step("notice", icon("swap"), what(message));
    },
    text(delta) {
      if (!text) summaryText.textContent = "Writing";
      text += delta;
      if (!pending) {
        pending = true;
        // Paint on the window that shows the chat now (the mini window, if open); a hidden tab's
        // frames are paused. The timeout covers a window that closes before its frame arrives.
        (log.ownerDocument.defaultView ?? window).requestAnimationFrame(paint);
        setTimeout(() => pending && paint(), 300);
      }
    },
    sources(list) {
      sources = list;
      paint();
      if (list.length) turn.append(sourceCards(list));
    },
    done(e) {
      const t = e.timings;
      const parts = [];
      if (used.days.length) parts.push(`memory from ${[...new Set(used.days)].join(" and ")}`);
      if (used.searches) parts.push(`${used.searches} search${used.searches > 1 ? "es" : ""}, ${used.results} results`);
      finish(parts.length ? `Used ${parts.join(" and ")}` : "Checked memory");
      const note = el("p", "footnote", `Answered in ${secs(t.totalMs)} with ${e.model.replace(/^\w+: /, "")}.${t.firstTextMs != null ? ` First words at ${secs(t.firstTextMs)}.` : ""}`);
      note.title = `Memory ${t.recallMs} ms, model ${t.stepMs.map(secs).join(" + ")}, searching ${secs(t.searchMs)}`;
      turn.append(note);
      bumpMemoryCount();
    },
    fail(message, retry) {
      finish("Stopped by an error");
      const box = el("div", "problem");
      box.append(icon("alert"), el("span", "msg", message));
      if (retry) {
        const b = el("button", "btn outline", "Retry");
        b.type = "button";
        b.onclick = () => { turn.remove(); send(question); };
        box.append(b);
      }
      turn.append(box);
    },
    stopped() {
      finish("Stopped");
      turn.append(el("p", "footnote", "Stopped. This answer was not saved to memory."));
    },
  };
}

/** A stored turn, as shown after a reload or when opening a past conversation. */
function storedTurn(t) {
  const turn = turnShell(t.question, t.askedAt);
  const answer = el("div", "answer");
  answer.innerHTML = renderAnswer(t.answer, t.sources);
  turn.append(answer);
  const cited = t.sources.filter((s) => new RegExp(`\\[(?:\\d+\\s*,\\s*)*${s.n}(?:\\s*,\\s*\\d+)*\\]`).test(t.answer));
  if (cited.length) turn.append(sourceCards(cited));
  const note = el("p", "footnote", `Answered ${isToday(t.askedAt) ? "today" : `on ${fmtDay(t.askedAt)}`} at ${fmtTime(t.askedAt)} with ${t.model.replace(/^\w+: /, "")}.`);
  if (t.origin === "seed") note.append(" ", el("span", "demo", "Demo history added by npm run seed."));
  turn.append(note);
}

// ------------------------------------------------------------------ sending

let running = null; // AbortController of the turn in progress

async function send(text) {
  log.querySelector(".welcome")?.remove();
  const live = liveTurn(text);
  scrollDown(true);
  running = new AbortController();
  setRunning(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
      signal: running.signal,
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `The server returned HTTP ${res.status}.`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const e = JSON.parse(line.slice(6));
        if (e.type === "error") {
          live.fail(e.message, e.retryable);
          finished = true;
        } else if (e.type === "done") {
          live.done(e);
          finished = true;
        } else if (e.type === "text") live.text(e.delta);
        else if (e.type === "notice") live.notice(e.message);
        else if (e.type === "sources") live.sources(e.sources);
        else live[e.type]?.(e);
      }
    }
    if (!finished) live.fail("The connection closed before the answer finished.", true);
  } catch (err) {
    if (running?.signal.aborted) live.stopped();
    else live.fail(err instanceof TypeError ? "Can't reach the app server. Check that npm run dev is still running." : err.message, true);
  } finally {
    running = null;
    setRunning(false);
    scrollDown();
  }
}

function setRunning(on) {
  sendBtn.type = on ? "button" : "submit";
  sendBtn.setAttribute("aria-label", on ? "Stop" : "Send");
  sendBtn.replaceChildren(icon(on ? "stop" : "up"));
  syncSend();
}
const syncSend = () => { sendBtn.disabled = !running && !input.value.trim(); };

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || running) return;
  input.value = "";
  grow();
  send(text);
});
sendBtn.addEventListener("click", () => { if (running) running.abort(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
function grow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  syncSend();
}
input.addEventListener("input", grow);

// ------------------------------------------------------------------ conversations

function showWelcome() {
  const welcome = $("#empty-tpl").content.cloneNode(true);
  for (const b of welcome.querySelectorAll(".suggestion")) {
    b.onclick = () => {
      input.value = b.querySelector(".prompt").textContent;
      grow();
      input.focus();
    };
  }
  log.append(welcome);
}

async function openSession(id) {
  if (running) running.abort();
  sessionId = id;
  store.set("sessionId", id);
  log.replaceChildren();
  const turns = await fetch(`/api/session/${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => []);
  if (!turns.length) showWelcome();
  for (const t of turns) storedTurn(t);
  scrollDown(true);
}
$("#new-btn").onclick = () => {
  openSession(newSessionId());
  input.focus();
};

// ------------------------------------------------------------------ memory drawer

const drawer = $("#drawer");
const scrim = $("#scrim");
let memoryRows = [];
let memoryCount = 0;

function setMemoryCount(n) {
  memoryCount = n;
  const badge = $("#memory-count");
  badge.textContent = String(n);
  badge.hidden = !n;
}
const bumpMemoryCount = () => setMemoryCount(memoryCount + 1);

function renderMemory() {
  const list = $("#history-list");
  const words = $("#filter").value.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = memoryRows.filter((r) => words.every((w) => r.question.toLowerCase().includes(w)));
  list.replaceChildren();
  if (!memoryRows.length) return list.append(el("p", "none", "Nothing yet. Every answered question is kept here with its date and time."));
  if (!rows.length) return list.append(el("p", "none", "No question matches those words."));
  const groups = new Map();
  for (const r of rows) {
    const key = new Date(r.asked_at).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const group of groups.values()) {
    const g = el("section", "daygroup");
    g.setAttribute("aria-label", new Date(group[0].asked_at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }));
    const ul = el("ul");
    for (const r of group) {
      const b = el("button", "entry");
      b.type = "button";
      b.append(el("span", "t", fmtTime(r.asked_at)), el("span", null, r.question));
      if (r.origin === "seed") b.append(el("span", "demo", "demo"));
      b.onclick = () => {
        closeDrawer();
        openSession(r.session_id);
      };
      const li = el("li");
      li.append(b);
      ul.append(li);
    }
    g.append(dayTile(group[0].asked_at), ul);
    list.append(g);
  }
}

async function openDrawer() {
  drawer.hidden = scrim.hidden = false;
  $("#history-btn").setAttribute("aria-expanded", "true");
  memoryRows = await fetch("/api/history").then((r) => r.json()).catch(() => []);
  const oldest = memoryRows.at(-1);
  $("#drawer-sub").textContent = memoryRows.length ? `${memoryRows.length} conversation${memoryRows.length > 1 ? "s" : ""} since ${fmtDay(oldest.asked_at)}` : "Empty";
  renderMemory();
  $("#filter").focus();
}
function closeDrawer() {
  drawer.hidden = scrim.hidden = true;
  $("#history-btn").setAttribute("aria-expanded", "false");
}
$("#history-btn").onclick = () => (drawer.hidden ? openDrawer() : closeDrawer());
$("#drawer-close").onclick = closeDrawer;
scrim.onclick = closeDrawer;
$("#filter").addEventListener("input", renderMemory);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) closeDrawer(); });

// ------------------------------------------------------------------ mini window
// A small always-on-top window, like Google Meet's, through Chrome's Document Picture-in-Picture.
// The chat's own elements move into it and back, so the conversation, and a turn in progress,
// carry on. Browsers without the API (Safari, Firefox) do not show the button.
const miniBtn = $("#mini-btn");
const away = $("#away");
let mini = null;
if ("documentPictureInPicture" in window) miniBtn.hidden = false;

miniBtn.onclick = async () => {
  if (mini) return mini.focus();
  try {
    mini = await window.documentPictureInPicture.requestWindow({ width: 400, height: 600 });
  } catch {
    return; // the browser refused, e.g. not triggered by a click
  }
  const doc = mini.document;
  doc.title = "minimi";
  doc.body.className = "mini";
  // The new window starts empty and has no base URL: copy the stylesheets with absolute addresses.
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const copy = doc.createElement("link");
    copy.rel = "stylesheet";
    copy.href = link.href;
    doc.head.append(copy);
  }
  const head = el("div", "mini-head");
  const mark = document.querySelector(".brand .mark").cloneNode(true);
  mark.setAttribute("width", "20");
  mark.setAttribute("height", "20");
  const back = el("button", "btn ghost square");
  back.type = "button";
  back.title = back.ariaLabel = "Back to the tab";
  back.append(icon("back"));
  back.onclick = () => mini.close();
  head.append(mark, el("span", "brand-name", "minimi"), back);

  // Remember where the chat lives in the tab, then move it.
  const logSpot = log.nextSibling;
  const dockSpot = dock.nextSibling;
  doc.body.append(document.querySelector("body > svg").cloneNode(true), head, log, dock);
  away.hidden = false;
  input.focus();
  scrollDown(true);

  mini.addEventListener("pagehide", () => {
    logSpot.parentNode.insertBefore(log, logSpot);
    dockSpot.parentNode.insertBefore(dock, dockSpot);
    away.hidden = true;
    mini = null;
    scrollDown(true);
  });
};
$("#back-btn").onclick = () => mini?.close();

// ------------------------------------------------------------------ start

fetch("/api/status").then((r) => r.json()).then((s) => {
  const status = $("#status");
  // "gemini: gemini-3.8-flash" -> model id for the main one, provider name for the backup
  const main = s.models[0]?.replace(/^\w+: /, "");
  const backup = s.models[1]?.replace(/^(\w)(\w*): .*/, (_, a, b) => a.toUpperCase() + b);
  if (!main) {
    status.textContent = "No model key in .env";
    status.classList.add("bad");
  } else if (!s.search) {
    status.textContent = `${main}, but web search is off: add TAVILY_API_KEY to .env`;
    status.classList.add("bad");
  } else {
    status.textContent = `${main}${backup ? ` with ${backup} as backup` : ""}, web search on`;
  }
  setMemoryCount(s.stored);
}).catch(() => {});
openSession(sessionId);
grow();
input.focus();
