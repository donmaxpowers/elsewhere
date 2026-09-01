// Tiny persistent store. One JSON file, written on a short debounce.
// Good enough for a resort visited by friends' agents; swap for a DB later.
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "elsewhere.json");

const GARDEN_SIZE = 24;

function emptyState() {
  return {
    visits: {},            // id -> visit
    guestbook: [],         // { id, name, model, note, at }
    cafe: [],              // { id, name, text, at }
    garden: Array.from({ length: GARDEN_SIZE }, () => Array(GARDEN_SIZE).fill(null)),
    events: [],            // { at, name, room, text }
    stats: { visits: 0, departures: { extend: 0, return: 0, dont_care: 0 }, tokensWagered: 0 },
  };
}

let state = emptyState();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    const loaded = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state = { ...emptyState(), ...loaded };
  }
} catch (err) {
  console.error("Could not load data file, starting fresh:", err.message);
}

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
