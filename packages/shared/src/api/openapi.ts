import { z } from "zod";
import { ErrorBody } from "./responses";
import { routes, type RouteDef } from "./routes";

type Json = Record<string, any>;
const SAFE_INT = 9007199254740991;
const FORMATS_WITH_NOISY_PATTERN = new Set(["uuid", "date-time", "date", "email"]);

/** Zod's JSON Schema output is correct but noisy; trim what only bloats the generated client. */
function clean(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(clean);
  if (!node || typeof node !== "object") return;
  const o = node as Json;
  if (typeof o.format === "string" && FORMATS_WITH_NOISY_PATTERN.has(o.format)) delete o.pattern;
  if (o.minimum === -SAFE_INT) delete o.minimum;
  if (o.maximum === SAFE_INT) delete o.maximum;
  delete o.$schema;
  delete o.additionalProperties;
  for (const v of Object.values(o)) clean(v);
}
const rewriteRefs = (node: unknown): unknown => JSON.parse(JSON.stringify(node).replaceAll("#/$defs/", "#/components/schemas/"));

function toSchema(schema: z.ZodType, io: "input" | "output", defs: Json): Json {
  const js = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
    unrepresentable: "any",
    override: (ctx) => { if (ctx.zodSchema._zod.def.type === "date") { ctx.jsonSchema.type = "string"; ctx.jsonSchema.format = "date-time"; } },
  }) as Json;
  clean(js.$defs);
  Object.assign(defs, js.$defs ?? {});
  delete js.$defs;
  clean(js);
  return rewriteRefs(js) as Json;
}

export function buildOpenApi(version = "0.1.0"): Json {
  const defs: Json = {};
  const paths: Json = {};
  const errorRef = toSchema(ErrorBody, "output", defs);

  for (const route of routes) {
    const pathItem = (paths[route.path] ??= {});
    const params: Json[] = [];
    for (const m of route.path.matchAll(/\{(\w+)\}/g)) params.push({ name: m[1], in: "path", required: true, schema: { type: "string", format: "uuid" } });
    if (route.query) {
      const q = toSchema(route.query, "input", defs);
      for (const [name, schema] of Object.entries<Json>(q.properties ?? {})) params.push({ name, in: "query", required: (q.required ?? []).includes(name), schema });
    }
    const op: Json = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.public ? { security: [] } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(route.body ? { requestBody: { required: true, content: { "application/json": { schema: toSchema(route.body, "input", defs) } } } } : {}),
      responses: {
        [String(route.status)]: route.response
          ? { description: "Success", content: { "application/json": { schema: toSchema(route.response, "output", defs) } } }
          : { description: "Success (no content)" },
        default: { description: "Error", content: { "application/json": { schema: errorRef } } },
      },
    };
    pathItem[route.method] = op;
  }

  return {
    openapi: "3.1.0",
    info: { title: "MoneyMgr API", version, description: "Personal finance API. Amounts are integer minor units; every success body is `{ data }`." },
    servers: [{ url: "/v1" }],
    security: [{ bearerAuth: [] }],
    tags: [...new Set(routes.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, rewriteRefs(v)])),
    },
  };
}

/** Find the route that serves `method path` (path without the /v1 prefix or query string). Static paths beat `{id}` paths. */
export function matchRoute(method: string, path: string): RouteDef | undefined {
  const m = method.toLowerCase();
  const candidates = routes.filter((r) => r.method === m && new RegExp(`^${r.path.replace(/\{\w+\}/g, "[^/]+")}$`).test(path));
  return candidates.sort((a, b) => Number(a.path.includes("{")) - Number(b.path.includes("{")))[0];
}
