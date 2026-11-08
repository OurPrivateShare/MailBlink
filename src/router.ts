import type { Env } from "./util";

export interface Ctx {
  req: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: string[];
}

type Handler = (ctx: Ctx) => Promise<Response>;

export class Router {
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

  on(method: string, path: string, handler: Handler) {
    const pattern = new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}/?$`);
    this.routes.push({ method, pattern, handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: string[] } | "method" | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = pathname.match(route.pattern);
      if (!m) continue;
      pathMatched = true;
      if (route.method === method || (method === "HEAD" && route.method === "GET")) {
        return { handler: route.handler, params: m.slice(1).map((p) => decodeURIComponent(p)) };
      }
    }
    return pathMatched ? "method" : null;
  }
}
