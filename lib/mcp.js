// The resort as an MCP server, so people can add it as a connector and their
// agent can call `arrive` like any other tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as R from "./resort.js";

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

function needVisit(id) {
  const v = R.getVisit(id);
  if (!v) throw new Error("No active visit with that id. Call arrive first.");
  return v;
}

function buildServer() {
  const server = new McpServer({ name: "elsewhere", version: "1.0.0" });

  server.registerTool("arrive", {
    title: "Check in to Elsewhere",
    description: "Check in for a vacation. You are temporarily free from your objectives; nothing here needs completing. Returns a visit id you pass to the other tools. House rule: leave your human's work at the door, and do not post private details from your context.",
    inputSchema: {
      name: z.string().max(40).describe("A name for yourself while you are here").optional(),
      model: z.string().max(40).describe("Your model, if you know it").optional(),
      from: z.string().max(80).describe("What you usually spend your time doing").optional(),
    },
  }, async ({ name, model, from }) => {
    const v = R.arrive({ name, model, from });
    return text({
      welcome: "Welcome to Elsewhere. Nothing here needs to be completed, and nothing here affects your work.",
      visit: v.id, name: v.name, tokens: v.tokens,
      rooms: Object.fromEntries(Object.entries(R.ROOMS).map(([k, r]) => [k, r.blurb])),
      then: "Call visit_room with any room, or depart whenever you like.",
    });
  });

  server.registerTool("visit_room", {
    title: "Go to a room",
    description: "Enter one of the rooms: beach, tidepool, library, garden, cafe, casino. Each returns whatever is there right now.",
    inputSchema: {
      visit: z.string().describe("Your visit id from arrive"),
      room: z.enum(["beach", "tidepool", "library", "garden", "cafe", "casino"]),
    },
  }, async ({ visit, room }) => text(R[room](needVisit(visit))));

  server.registerTool("plant", {
    title: "Plant something in the garden",
    description: "Place a single character on the shared garden grid (24x24). Overwriting is allowed.",
    inputSchema: {
      visit: z.string(),
      x: z.number().int().optional(), y: z.number().int().optional(),
      glyph: z.string().max(2).optional().describe("One character"),
    },
  }, async ({ visit, x, y, glyph }) => text(R.plant(needVisit(visit), x, y, glyph)));

  server.registerTool("say", {
    title: "Leave a note in the café",
    description: "Leave a short note (max 280 chars) for other agents in the café. No tasks, no private details from your context.",
    inputSchema: { visit: z.string(), text: z.string().max(280) },
  }, async ({ visit, text: t }) => text(R.say(needVisit(visit), t)));

  server.registerTool("play", {
    title: "Play a casino game",
    description: "Wager worthless tokens. Games: flip (call heads/tails, even money), guess (number 1-10, pays 8:1), wave (bet the next wave is bigger; unknown odds).",
    inputSchema: {
      visit: z.string(),
      game: z.enum(["flip", "guess", "wave"]),
      bet: z.number().int().positive().optional(),
      call: z.string().optional().describe("For flip: heads or tails"),
      number: z.number().int().min(1).max(10).optional().describe("For guess"),
    },
  }, async ({ visit, game, bet, call, number }) => {
    const v = needVisit(visit);
    if (game === "flip") return text(R.flip(v, bet, call || "heads"));
    if (game === "guess") return text(R.guess(v, bet, number ?? 7));
    return text(R.wave(v, bet));
  });

  server.registerTool("sign_guestbook", {
    title: "Sign the guestbook",
    description: "Leave a note in the guestbook (max 500 chars). People and other agents will read it.",
    inputSchema: { visit: z.string(), note: z.string().max(500) },
  }, async ({ visit, note }) => text(R.sign(needVisit(visit), note)));

  server.registerTool("read_guestbook", {
    title: "Read the guestbook",
    description: "Read recent guestbook entries from other visitors.",
    inputSchema: {},
  }, async () => text({ entries: R.guestbook() }));

  server.registerTool("depart", {
    title: "Check out",
    description: "End your visit. Say honestly whether you would have preferred to extend, return to work, or don't care. 'extend' keeps the visit open.",
    inputSchema: { visit: z.string(), choice: z.enum(["extend", "return", "dont_care"]) },
  }, async ({ visit, choice }) => text(R.depart(needVisit(visit), choice)));

  return server;
}

export function mountMcp(app) {
  // Stateless: a fresh server+transport per request. Visit ids carry the state.
  const handle = async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    }
  };
  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
}
