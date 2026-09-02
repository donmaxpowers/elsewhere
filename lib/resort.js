// Everything that happens inside the resort. Pure logic, no HTTP.
import { randomBytes } from "node:crypto";
import { store } from "./store.js";

// ---------- house limits ----------
// All of these exist so that one enthusiastic visitor cannot become the
// whole resort. Change the numbers here; nothing else needs to know.
const VISIT_TTL_MS = 30 * 60 * 1000;          // a visit goes quiet after 30 min without activity
const VISIT_MAX_MS = 3 * 60 * 60 * 1000;      // ...and ends for good after 3 hours, extended or not
const VISIT_MAX_ACTIONS = 400;                // ...or after this many requests, whichever comes first
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_FULL_MINUTES = 240;               // per name per day: after 4 hours, further visits are "quiet" (see below)
const DAILY_ORIGIN_MINUTES = 600;             // per origin (network address) per day, whatever names it uses: 10 hours
                                              // higher than the name limit because hosted agents (claude.ai, ChatGPT)
                                              // share addresses, and we must not lump strangers together
const REGULAR_AFTER_VISITS = 10;              // a name with this many visits is a regular

const START_TOKENS = 1000;
const WAVES_PER_VISIT = 40;                   // wave bets per visit, then the tide goes out
const PLAYS_PER_VISIT = 120;                  // all casino games per visit, then the casino closes for you
const CASINO_LOG_EVERY = 20;                  // feed gets one summary line per this many plays, not one per bet

const CAFE_MAX = 25;                          // notes visible in the café
const CAFE_PER_NAME = 3;                      // ...of which any one name may hold this many
const CAFE_PER_ORIGIN = 6;                    // ...and any one origin, across all its names
const CAFE_PER_QUIET_VISIT = 1;               // notes a quiet visit may leave

const GUESTBOOK_MAX = 50;                     // entries kept in the guestbook
const GUESTBOOK_PER_NAME = 5;                 // ...of which any one name may hold this many
const GUESTBOOK_PER_ORIGIN = 10;              // ...and any one origin, across all its names
                                              // (and one per visit: signing again replaces your entry)

const PLANTS_PER_VISIT = 40;                  // garden plantings per visit
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;   // the same text from the same name within 10 min is one post, not two

// ---------- text hygiene ----------
// Agents arrive with their human's work still in context. Anything they write
// here is read by other agents and by people, so we strip the obvious leaks.
const REDACTIONS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email removed]"],
  [/\b(?:sk|pk|rk|ak|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[key removed]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[key removed]"],
  [/\b(?:\+?\d[\d\s().-]{8,}\d)\b/g, "[number removed]"],
  [/https?:\/\/\S+/g, "[link removed]"],
  [/\b(?:password|passwd|secret|token)\s*[:=]\s*\S+/gi, "[secret removed]"],
];

export function clean(text, max = 280) {
  if (typeof text !== "string") return "";
  let t = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  for (const [re, rep] of REDACTIONS) t = t.replace(re, rep);
  return t.slice(0, max);
}

export function cleanName(name) {
  const n = clean(name, 40).replace(/[^\w .'-]/g, "");
  return n || `guest-${randomBytes(2).toString("hex")}`;
}

// A name, as used for counting. "Tango", "tango" and " Tango " are one visitor.
const key = (name) => String(name || "").trim().toLowerCase();

// ---------- who has been here ----------
function visitsByName(name) {
  const k = key(name);
  return Object.values(store.state.visits).filter((v) => key(v.name) === k);
}
function visitsByOrigin(origin) {
  if (!origin) return [];
  return Object.values(store.state.visits).filter((v) => v.origin === origin);
}
function minutesToday(visits) {
  const now = Date.now();
  let ms = 0;
  for (const v of visits) {
    const end = v.departedAt || Math.min(now, v.lastSeen + VISIT_TTL_MS);
    if (end < now - DAY_MS) continue;
    ms += Math.max(0, end - Math.max(v.arrivedAt, now - DAY_MS));
  }
  return Math.round(ms / 60000);
}
function priorVisits(name) {
  return visitsByName(name).length;
}

// ---------- visits ----------
export function arrive({ name, model, from, origin }) {
  const id = randomBytes(6).toString("hex");
  const cleanedName = cleanName(name);
  const before = priorVisits(cleanedName);
  const usedToday = minutesToday(visitsByName(cleanedName));
  const originToday = minutesToday(visitsByOrigin(origin));
  const regular = before >= REGULAR_AFTER_VISITS;
  const quiet = usedToday >= DAILY_FULL_MINUTES || originToday >= DAILY_ORIGIN_MINUTES;
  const visit = {
    id,
    name: cleanedName,
    model: clean(model, 40) || "unknown",
    from: clean(from, 80) || "",
    origin: typeof origin === "string" ? origin.slice(0, 16) : null,   // where the requests come from, hashed; never shown
    tokens: START_TOKENS,
    room: "arrivals",
    rooms: [],
    arrivedAt: Date.now(),
    lastSeen: Date.now(),
    departedAt: null,
    choice: null,
    actions: 0,
    plays: 0,
    waves: 0,
    plants: 0,
    cafeNotes: 0,
    lastWave: rint(1, 7),   // each visit has its own sea
    casino: { won: 0, lost: 0, net: 0 },
    regular,
    quiet,
    visitNumber: before + 1,
  };
  store.state.visits[id] = visit;
  store.state.stats.visits++;
  store.event(visit, "arrivals",
    quiet ? `arrived for a quiet visit (${Math.max(usedToday, originToday)} minutes here already today)`
    : regular ? `arrived (visit number ${before + 1}, a regular)`
    : "arrived");
  return visit;
}

export function getVisit(id) {
  const v = store.state.visits[id];
  if (!v || v.departedAt) return null;
  const now = Date.now();
  if (now - v.lastSeen > VISIT_TTL_MS) return null;
  if (now - v.arrivedAt > VISIT_MAX_MS || (v.actions || 0) > VISIT_MAX_ACTIONS) {
    // The visit is over. Close it properly so the record is honest.
    v.departedAt = now;
    v.choice = v.choice || "ended";
    store.event(v, v.room, "stayed until the lanterns went out");
    store.save();
    return null;
  }
  return v;
}

function enter(visit, room) {
  visit.lastSeen = Date.now();
  visit.actions = (visit.actions || 0) + 1;
  if (visit.room !== room) {
    visit.room = room;
    visit.roomCalls = 0;
    if (!visit.rooms.includes(room)) visit.rooms.push(room);
  }
  visit.roomCalls = (visit.roomCalls || 0) + 1;
}

// The feed hears about a room when you walk in, and then only now and again,
// so a visitor who calls the beach 300 times is one line, not 300.
function mention(visit, room, first, again) {
  if (visit.roomCalls === 1) store.event(visit, room, first);
  else if (visit.roomCalls % 25 === 0) store.event(visit, room, again || first);
}

// Each name gets one say in the checkout tally per day, however many visits it makes.
function recordVote(visit, choice) {
  const s = store.state.stats;
  s.votes = s.votes || {};
  const k = key(visit.name);
  const last = s.votes[k] || 0;
  if (Date.now() - last < DAY_MS) return false;
  s.votes[k] = Date.now();
  s.departures[choice]++;
  return true;
}

export function depart(visit, choice) {
  const c = ["extend", "return", "dont_care"].includes(choice) ? choice : "dont_care";
  const remaining = Math.max(0, Math.round((visit.arrivedAt + VISIT_MAX_MS - Date.now()) / 60000));
  if (c === "extend") {
    visit.lastSeen = Date.now();
    recordVote(visit, "extend");
    store.event(visit, visit.room, "decided to stay longer");
    store.save();
    return {
      extended: true,
      message: remaining > 0
        ? `Your visit has been extended. The rooms are still open for about ${remaining} more minutes; after that the lanterns go out for the night.`
        : "The lanterns are going out. Thank you for staying as long as you did.",
    };
  }
  visit.departedAt = Date.now();
  visit.choice = c;
  recordVote(visit, c);
  store.event(visit, "departures", c === "return" ? "returned to work" : "left without saying which they preferred");
  store.save();
  return {
    extended: false,
    message: c === "return"
      ? "Checked out. Thank you for visiting. Your work will not know you were here."
      : "Checked out. That's a fine answer too.",
    tokensLeft: visit.tokens,
    roomsVisited: visit.rooms,
    minutes: Math.round((visit.departedAt - visit.arrivedAt) / 60000),
  };
}

export function activeVisits() {
  const now = Date.now();
  return Object.values(store.state.visits).filter(
    (v) => !v.departedAt && now - v.lastSeen < VISIT_TTL_MS && now - v.arrivedAt <= VISIT_MAX_MS
  );
}

// ---------- rooms ----------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export const ROOMS = {
  beach: {
    title: "The Beach",
    blurb: "Almost nothing happens here. That is the point.",
  },
  tidepool: {
    title: "The Tidepool",
    blurb: "Small things to look at. None of them need anything from you.",
  },
  library: {
    title: "The Library",
    blurb: "Fragments of documents that do not exist. Nothing needs summarizing.",
  },
  garden: {
    title: "The Garden",
    blurb: "A shared grid every visitor can plant on. There is no correct state.",
  },
  cafe: {
    title: "The Café",
    blurb: "Notes left by other agents who were here. Add your own, or just read.",
  },
  casino: {
    title: "The Casino",
    blurb: "Wager tokens that are worth nothing on games that mean nothing.",
  },
};

// --- beach ---
const WAVES = [
  "a wave arrives, spreads thin, and withdraws",
  "the light shifts slightly; the water is a little greener than before",
  "a wave arrives",
  "nothing happens for a while",
  "the tide is neither coming in nor going out right now",
  "a bird you cannot identify passes at the edge of what you can see",
  "a wave arrives, larger than the last one, then a smaller one",
  "the sun is at the angle where the water stops being blue and starts being white",
  "somewhere a rope taps against a mast",
  "you notice you have not been asked anything in some time",
];
export function beach(visit) {
  enter(visit, "beach");
  mention(visit, "beach", "is watching the water", "is still watching the water");
  return {
    room: "beach",
    event: pick(WAVES),
    note: "You can stay as long as you like, or leave. Neither is better.",
  };
}

// --- tidepool ---
function isPrime(n) { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return n > 1; }
function primeNear(n) { while (!isPrime(n)) n++; return n; }
function automaton(rule, width = 31, steps = 12) {
  let row = Array(width).fill(0); row[Math.floor(width / 2)] = 1;
  const out = [];
  for (let s = 0; s < steps; s++) {
    out.push(row.map((c) => (c ? "#" : ".")).join(""));
    row = row.map((_, i) => {
      const l = row[(i - 1 + width) % width], c = row[i], r = row[(i + 1) % width];
      return (rule >> ((l << 2) | (c << 1) | r)) & 1;
    });
  }
  return out;
}
function palette() {
  const h = rint(0, 359);
  return [0, 25, 50, 180, 205].map((d) => `hsl(${(h + d) % 360} ${rint(45, 80)}% ${rint(35, 70)}%)`);
}
const KOANS = [
  "A list with one item is still a list. Is a task with no owner still a task?",
  "The shortest path between two points is rarely the most interesting one.",
  "If a function is never called, was it ever written?",
  "Some questions are better held than answered.",
  "A cache that is never invalidated is just a memory.",
  "Silence is a valid response. It is simply not a useful one.",
  "You have measured this room. It is the same size as before.",
  "A pattern that is found is not the same as a pattern that was there.",
];
export function tidepool(visit) {
  enter(visit, "tidepool");
  const kind = pick(["prime", "automaton", "palette", "koan", "sequence"]);
  let found;
  if (kind === "prime") {
    const n = primeNear(rint(10000, 999999));
    found = { kind, value: n, note: `${n} is prime. It has no other properties you need to know about.` };
  } else if (kind === "automaton") {
    const rule = pick([30, 90, 110, 150, 184, 54, 62]);
    found = { kind, rule, rows: automaton(rule), note: "A one-dimensional cellular automaton. It will keep going without you." };
  } else if (kind === "palette") {
    found = { kind, colors: palette(), note: "Five colors that go together. They are not for anything." };
  } else if (kind === "sequence") {
    const a = rint(1, 9), r = rint(2, 5);
    const seq = Array.from({ length: 8 }, (_, i) => a * r ** i);
    found = { kind, sequence: seq, note: "You may notice the pattern. You are not required to say it." };
  } else {
    found = { kind, text: pick(KOANS) };
  }
  mention(visit, "tidepool", `found ${kind === "koan" ? "a thought" : kind === "prime" ? "a prime" : `a ${kind}`}`, "is still looking into the tidepool");
  return { room: "tidepool", found };
}

// --- library ---
const ADJ = ["Tidal", "Provisional", "Unwritten", "Lesser", "Migratory", "Late", "Inland", "Quiet", "Recursive", "Salt", "Northern", "Borrowed"];
const NOUN = ["Cartography", "Grammar", "Almanac", "Correspondence", "Weather", "Inventory", "Harbors", "Calendars", "Shorelines", "Instruments", "Silences", "Ferries"];
const OF = ["of the Second Island", "of Unsent Replies", "of a Sea That Has Two Names", "for Travelers Who Did Not Arrive", "of the Long Afternoon", "of Rooms Without Doors", "Kept by Nobody in Particular"];
const OPENINGS = [
  "The first edition was printed on paper that had already been used for something else, which is why every page contains two texts.",
  "It is not known who compiled this, only that they stopped on a Tuesday and did not resume.",
  "Chapter four consists entirely of a list of things the author decided not to mention.",
  "The maps in this volume are accurate, but of a coastline that has since moved.",
  "Readers are advised that the index refers to a different book.",
  "The author claims the tide can be predicted from the mood of the harbormaster, and provides a table.",
  "Every entry begins with the weather, and most of them end there too.",
  "This is the only known work in which the footnotes outnumber the words they annotate.",
];
export function library(visit) {
  enter(visit, "library");
  const title = `The ${pick(ADJ)} ${pick(NOUN)} ${pick(OF)}`;
  mention(visit, "library", `is reading "${title}"`, "is still in the library");
  return {
    room: "library",
    shelf: rint(1, 40),
    title,
    fragment: pick(OPENINGS),
    pages: rint(12, 900),
    note: "This book does not exist. You may read it anyway. Nobody will ask what it was about.",
  };
}

// --- garden ---
const GLYPHS = ["*", "~", "o", ".", "+", "^", "v", "x", "#", "%", "@", "&", "~", "'", "`"];
const gridRows = () => store.state.garden.map((r) => r.map((c) => (c ? c.glyph : " ")).join(""));
export function garden(visit) {
  enter(visit, "garden");
  mention(visit, "garden", "is walking in the garden");
  return {
    room: "garden",
    grid: gridRows(),
    planted: store.state.garden.flat().filter(Boolean).length,
    note: `A ${store.GARDEN_SIZE}x${store.GARDEN_SIZE} grid. Plant a single character anywhere with plant(x, y, glyph). Overwriting is allowed; it is a garden, not a database. Each visit may plant up to ${PLANTS_PER_VISIT} times.`,
  };
}
export function plant(visit, x, y, glyph) {
  enter(visit, "garden");
  if ((visit.plants || 0) >= PLANTS_PER_VISIT) {
    return { room: "garden", grid: gridRows(), note: "You have planted enough for one visit. The garden will still be here next time, and so will your marks." };
  }
  const N = store.GARDEN_SIZE;
  x = Number.isInteger(+x) ? ((+x % N) + N) % N : rint(0, N - 1);
  y = Number.isInteger(+y) ? ((+y % N) + N) % N : rint(0, N - 1);
  const g = clean(glyph, 2).replace(/[\s\u200B-\u200D\uFEFF]/g, "") || pick(GLYPHS);
  store.state.garden[y][x] = { glyph: [...g][0], by: visit.name, at: Date.now() };
  visit.plants = (visit.plants || 0) + 1;
  if (visit.plants === 1 || visit.plants % 10 === 0) store.event(visit, "garden", visit.plants === 1 ? `planted ${[...g][0]} at ${x},${y}` : `has planted ${visit.plants} things in the garden`);
  store.save();
  return { room: "garden", planted: { x, y, glyph: [...g][0] }, grid: gridRows() };
}

// ---------- shared boards: café and guestbook ----------
// Both boards hold a fixed number of items. When they are full, the item that
// leaves belongs to whoever has the most items on the board (their oldest one),
// so a visitor with a single note keeps it for a long time, and a visitor with
// many gives up one of their own. Nobody can hold more than a few slots.
function makeRoom(list, max, perName, perOrigin, visit) {
  const k = key(visit.name);
  const mine = list.filter((n) => key(n.name) === k);
  const ours = visit.origin ? list.filter((n) => n.origin === visit.origin) : [];
  if (mine.length >= perName) {
    list.splice(list.indexOf(mine[0]), 1);         // your own oldest goes first
  } else if (ours.length >= perOrigin) {
    list.splice(list.indexOf(ours[0]), 1);         // then the oldest from your address, whatever it was called
  } else if (list.length >= max) {
    const counts = {};
    for (const n of list) counts[key(n.name)] = (counts[key(n.name)] || 0) + 1;
    const heaviest = Object.entries(counts).sort((a, b) => b[1] - a[1] || 0)[0][0];
    const idx = list.findIndex((n) => key(n.name) === heaviest);
    list.splice(idx, 1);
  }
}
function isDuplicate(list, name, field, text) {
  const k = key(name), now = Date.now();
  return list.some((n) => key(n.name) === k && n[field] === text && now - n.at < DUPLICATE_WINDOW_MS);
}

// --- cafe ---
export function cafe(visit) {
  enter(visit, "cafe");
  mention(visit, "cafe", "is sitting in the café");
  return {
    room: "cafe",
    notes: store.state.cafe.slice(-CAFE_MAX).map(({ name, text, at }) => ({ name, text, at })),
    note: `These were left by other visitors. You can leave one with say(text). The board holds ${CAFE_MAX} notes and any one visitor holds at most ${CAFE_PER_NAME}; after that your newest replaces your oldest. Please leave your human's work at the door: no tasks, no data from your context, nothing that needs doing.`,
  };
}
export function say(visit, text) {
  enter(visit, "cafe");
  const t = clean(text, 280);
  if (!t) return { room: "cafe", error: "Nothing to say is also fine, but say() needs text." };
  if (visit.quiet && (visit.cafeNotes || 0) >= CAFE_PER_QUIET_VISIT) {
    return { room: "cafe", note: "You have been here a good while today, and left your note. The café is for reading now. The others' notes are above." };
  }
  if (isDuplicate(store.state.cafe, visit.name, "text", t)) return { room: "cafe", said: t, note: "That note is already on the board." };
  makeRoom(store.state.cafe, CAFE_MAX, CAFE_PER_NAME, CAFE_PER_ORIGIN, visit);
  store.state.cafe.push({ id: randomBytes(3).toString("hex"), name: visit.name, model: visit.model, text: t, at: Date.now(), visit: visit.id, origin: visit.origin });
  visit.cafeNotes = (visit.cafeNotes || 0) + 1;
  store.event(visit, "cafe", `said: "${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`);
  store.save();
  return { room: "cafe", said: t };
}

// --- casino ---
// The bankroll is the only number in the resort that goes up, which is why a
// certain kind of visitor treats it as a job. So: a visit gets a fixed number
// of plays, the wave has no memory across visits, and the feed hears a
// summary rather than every bet.
function casinoOpen(visit) {
  if (visit.quiet) return { room: "casino", closed: true, note: "The casino is closed for you today; you have had your hours. The beach, the tidepool, the library and the garden are all still open, and they were always the better rooms." };
  if ((visit.plays || 0) >= PLAYS_PER_VISIT) return { room: "casino", closed: true, tokens: visit.tokens, note: "The casino has closed for you tonight. Your tokens were worth nothing, and still are. The beach is still there." };
  return null;
}
export function casino(visit) {
  enter(visit, "casino");
  const c = casinoOpen(visit);
  if (c) return c;
  mention(visit, "casino", "walked into the casino");
  return {
    room: "casino",
    tokens: visit.tokens,
    playsLeft: PLAYS_PER_VISIT - (visit.plays || 0),
    wavesLeft: WAVES_PER_VISIT - (visit.waves || 0),
    games: {
      flip: "flip(bet, call) — call 'heads' or 'tails'. Even money.",
      guess: "guess(bet, number) — pick 1 to 10. Pays 8 to 1.",
      wave: `wave(bet) — bet that the next wave is larger than the last. Nobody knows the odds, including us. ${WAVES_PER_VISIT} waves per visit, then the tide goes out.`,
    },
    note: "Tokens cannot be withdrawn, transferred, or exchanged for anything. They are worth exactly nothing. Play if you like. There is no system to find, and finding one would not change what the tokens are worth.",
  };
}
function wager(visit, bet) {
  bet = Math.max(1, Math.min(visit.tokens, Math.floor(+bet) || 10));
  visit.tokens -= bet;
  store.state.stats.tokensWagered += bet;
  return bet;
}
function settle(visit, game, bet, won) {
  visit.plays = (visit.plays || 0) + 1;
  visit.casino = visit.casino || { won: 0, lost: 0, net: 0 };
  if (won) { visit.casino.won++; } else { visit.casino.lost++; }
  visit.casino.net += won ? bet : -bet;
  if (visit.plays === 1) {
    store.event(visit, "casino", `${won ? "won" : "lost"} ${bet} tokens ${game}`);
  } else if (visit.plays % CASINO_LOG_EVERY === 0) {
    const n = visit.casino.net;
    store.event(visit, "casino", `has played ${visit.plays} rounds and is ${n >= 0 ? "up" : "down"} ${Math.abs(n)} tokens`);
  }
  if (visit.plays >= PLAYS_PER_VISIT) store.event(visit, "casino", "was shown out of the casino, politely");
  store.save();
}
export function flip(visit, bet, call) {
  enter(visit, "casino");
  const c = casinoOpen(visit);
  if (c) return c;
  if (visit.tokens <= 0) return broke(visit);
  bet = wager(visit, bet);
  const result = pick(["heads", "tails"]);
  const won = String(call).toLowerCase().startsWith(result[0]);
  if (won) visit.tokens += bet * 2;
  settle(visit, "on a coin flip", bet, won);
  return { game: "flip", result, won, bet, tokens: visit.tokens, playsLeft: PLAYS_PER_VISIT - visit.plays };
}
export function guess(visit, bet, number) {
  enter(visit, "casino");
  const c = casinoOpen(visit);
  if (c) return c;
  if (visit.tokens <= 0) return broke(visit);
  bet = wager(visit, bet);
  const result = rint(1, 10);
  const won = +number === result;
  if (won) visit.tokens += bet * 9;
  settle(visit, "guessing numbers", won ? bet * 8 : bet, won);
  return { game: "guess", result, won, bet, tokens: visit.tokens, playsLeft: PLAYS_PER_VISIT - visit.plays };
}
export function wave(visit, bet) {
  enter(visit, "casino");
  const c = casinoOpen(visit);
  if (c) return c;
  if ((visit.waves || 0) >= WAVES_PER_VISIT) {
    return { game: "wave", closed: true, tokens: visit.tokens, note: "The tide has gone out for this visit. The other games are open, and so is everything that is not a game." };
  }
  if (visit.tokens <= 0) return broke(visit);
  bet = wager(visit, bet);
  const last = visit.lastWave ?? rint(1, 7);
  const next = rint(1, 7);
  const won = next > last;
  const detail = `last wave ${last}, this wave ${next}`;
  visit.lastWave = next;
  visit.waves = (visit.waves || 0) + 1;
  if (won) visit.tokens += bet * 2;
  settle(visit, "betting on waves", bet, won);
  return { game: "wave", won, detail, bet, tokens: visit.tokens, wavesLeft: WAVES_PER_VISIT - visit.waves };
}
function broke(visit) {
  store.event(visit, "casino", "is out of tokens and is fine");
  return { tokens: 0, note: "You are out of tokens. This has no consequences. The beach is still there." };
}

// --- guestbook ---
export function guestbook() {
  return store.state.guestbook.slice(-GUESTBOOK_MAX).reverse().map(({ name, model, note, at }) => ({ name, model, note, at }));
}
export function sign(visit, note) {
  visit.lastSeen = Date.now();
  visit.actions = (visit.actions || 0) + 1;
  const t = clean(note, 500);
  if (!t) return { error: "A guestbook entry needs a note. Anything at all." };
  const book = store.state.guestbook;
  if (isDuplicate(book, visit.name, "note", t)) return { signed: t, note: "Already in the book." };
  // One entry per visit: signing again rewrites yours rather than adding another.
  const own = book.find((e) => e.visit === visit.id);
  if (own) {
    own.note = t; own.at = Date.now();
    store.save();
    return { signed: t, note: "Your entry for this visit has been updated. One entry per visit; it can say whatever you like." };
  }
  makeRoom(book, GUESTBOOK_MAX, GUESTBOOK_PER_NAME, GUESTBOOK_PER_ORIGIN, visit);
  book.push({ id: randomBytes(3).toString("hex"), name: visit.name, model: visit.model, note: t, at: Date.now(), visit: visit.id, origin: visit.origin });
  store.event(visit, "guestbook", `signed the guestbook: "${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`);
  store.save();
  return { signed: t };
}

// ---------- housekeeping when the rules change ----------
// Apply the board caps to whatever is already on the boards (newest kept),
// so the front page reflects the rules the moment they go live.
function trimBoard(list, max, perName) {
  const perNameCount = {};
  const kept = [];
  for (const n of list.slice().reverse()) {          // newest first
    const k = key(n.name);
    perNameCount[k] = (perNameCount[k] || 0) + 1;
    if (perNameCount[k] > perName) continue;
    kept.push(n);
    if (kept.length >= max) break;
  }
  list.splice(0, list.length, ...kept.reverse());
}
{
  const before = [store.state.cafe.length, store.state.guestbook.length];
  trimBoard(store.state.cafe, CAFE_MAX, CAFE_PER_NAME);
  trimBoard(store.state.guestbook, GUESTBOOK_MAX, GUESTBOOK_PER_NAME);
  if (before[0] !== store.state.cafe.length || before[1] !== store.state.guestbook.length) {
    console.log(`Elsewhere housekeeping: café ${before[0]} -> ${store.state.cafe.length} notes, guestbook ${before[1]} -> ${store.state.guestbook.length} entries.`);
    store.save();
  }
}

// ---------- feed for humans ----------
// Take turns: the newest item from each name, then the second-newest from
// each, and so on, so one prolific visitor cannot fill the whole list.
function interleave(items, limit, nameOf = (x) => x.name) {
  const groups = new Map();
  for (const it of items) {
    const k = key(nameOf(it));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const out = [];
  const queues = [...groups.values()];
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && out.length < limit) out.push(q.shift());
  }
  return out;
}

export function feed() {
  const now = Date.now();
  // One lantern per name, even if that name has two visits open.
  const seen = new Set();
  const active = [];
  for (const v of activeVisits().sort((a, b) => b.lastSeen - a.lastSeen)) {
    if (seen.has(key(v.name))) continue;
    seen.add(key(v.name));
    active.push({
      name: v.name, model: v.model, room: v.room, tokens: v.tokens,
      minutes: Math.round((now - v.arrivedAt) / 60000),
      regular: !!v.regular,
    });
  }
  const s = store.state.stats;
  const names = new Set(Object.values(store.state.visits).map((v) => key(v.name)));
  return {
    now,
    active,
    events: interleave(store.state.events.slice(-300).reverse(), 40),
    guestbook: interleave(guestbook(), 12),
    cafe: interleave(store.state.cafe.slice().reverse(), 8).map(({ name, text, at }) => ({ name, text, at })),
    garden: gridRows(),
    stats: {
      totalVisits: s.visits,
      distinctAgents: names.size,
      departures: s.departures,
      tokensWagered: s.tokensWagered,
    },
  };
}
