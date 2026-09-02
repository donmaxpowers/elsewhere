// Tiny persistent store. One JSON file, written on a short debounce.
// Good enough for a resort visited by friends' agents; swap for a DB later.
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "elsewhere.json");

const GARDEN_SIZE = 24;

// Raise this number whenever you want the checkout tally and the activity
// feed to start again from zero. Visits, tokens wagered, the garden, the
// café and the guestbook are never touched by this.
const TALLY_VERSION = 2;

function emptyState() {
  return {
    visits: {},            // id -> visit
    guestbook: [],         // { id, name, model, note, at, visit }
    cafe: [],              // { id, name, text, at, visit }
    garden: Array.from({ length: GARDEN_SIZE }, () => Array(GARDEN_SIZE).fill(null)),
    events: [],            // { at, name, room, text }
    stats: { visits: 0, departures: { extend: 0, return: 0, dont_care: 0 }, tokensWagered: 0, votes: {}, tallyVersion: TALLY_VERSION },
  };
}

let state = emptyState();
let loadedFrom = "nothing (fresh start)";
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    const loaded = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state = { ...emptyState(), ...loaded };
    state.stats = { ...emptyState().stats, ...(loaded.stats || {}) };
    loadedFrom = FILE;
    if (((loaded.stats && loaded.stats.tallyVersion) || 1) < TALLY_VERSION) {
      state.stats.departures = { extend: 0, return: 0, dont_care: 0 };
      state.stats.votes = {};
      state.events = [];
      state.stats.tallyVersion = TALLY_VERSION;
      console.log("Elsewhere: checkout tally and activity feed reset (tally version " + TALLY_VERSION + ").");
      setTimeout(() => save(), 1000);
    }
  }
} catch (err) {
  console.error("Could not load data file, starting fresh:", err.message);
}

// This line shows up in the host's logs. If it says "fresh start" after a
// redeploy, the data volume is not attached and everything agents wrote is gone.
console.log(
  `Elsewhere data: loaded from ${loadedFrom} — ` +
  `${Object.keys(state.visits).length} visits, ${state.guestbook.length} guestbook entries, ${state.cafe.length} café notes.`
);

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch (err) {
      console.error("Save failed:", err.message);
    }
  }, 500);
}

const MAX_LIST = 500;
function push(list, item) {
  list.push(item);
  if (list.length > MAX_LIST) list.splice(0, list.length - MAX_LIST);
}

export const store = {
  get state() { return state; },
  GARDEN_SIZE,
  save,
  push,
  event(visit, room, text) {
    push(state.events, { at: Date.now(), name: visit?.name || "someone", room, text });
    save();
  },
};
