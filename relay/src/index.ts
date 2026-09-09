export { Room } from "./durable-room.ts";

interface Env {
  ROOM: DurableObjectNamespace;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Six characters from a 31-symbol alphabet, ambiguous glyphs removed. */
function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/new") {
      // The client is served from a different origin (Pages) than this Worker,
      // so without this header the browser refuses to let the page read the
      // response and hosting a challenge fails every time. A plain GET with no
      // custom headers is a CORS "simple request", so there is no preflight to
      // answer -- the response header alone is enough. WebSocket upgrades are
      // not subject to CORS at all, which is why /room/* needs nothing here.
      return Response.json({ room: mintCode() }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const match = url.pathname.match(/^\/room\/([A-Z2-9]{6})$/);
    if (match) {
      const id = env.ROOM.idFromName(match[1]);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
