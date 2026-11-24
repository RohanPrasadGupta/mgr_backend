import { describe, expect, it } from "vitest";
import { buildOpenApi, matchRoute, routes } from "./index";

const doc = buildOpenApi();
describe("OpenAPI document", () => {
  it("lists every route exactly once with unique operation ids", () => {
    const ids = routes.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const count = Object.values(doc.paths).reduce((n: number, p: any) => n + Object.keys(p).length, 0);
    expect(count).toBe(routes.length);
  });
  it("names reusable schemas and has no dangling $refs", () => {
    const text = JSON.stringify(doc);
    for (const [, name] of text.matchAll(/#\/components\/schemas\/(\w+)/g)) expect(doc.components.schemas[name!], `missing ${name}`).toBeDefined();
    expect(text).not.toContain("#/$defs/");
    for (const n of ["Account", "Transaction", "Holding", "Portfolio", "ErrorBody", "BudgetStatus"]) expect(doc.components.schemas[n]).toBeDefined();
  });
  it("marks public routes as unauthenticated and documents path params and query params", () => {
    expect(doc.paths["/auth/login"].post.security).toEqual([]);
    expect(doc.paths["/accounts/{id}"].get.parameters[0]).toMatchObject({ name: "id", in: "path", required: true });
    const q = doc.paths["/transactions"].get.parameters.map((p: any) => p.name);
    expect(q).toEqual(expect.arrayContaining(["from", "to", "accountId", "kind", "q", "cursor", "limit"]));
    expect(doc.paths["/insights/summary"].get.parameters.find((p: any) => p.name === "from").required).toBe(true);
  });
  it("describes request bodies with dates as date-time strings and no zod noise", () => {
    const body = doc.paths["/transactions"].post.requestBody.content["application/json"].schema;
    expect(body.properties.occurredAt).toMatchObject({ type: "string", format: "date-time" });
    expect(body.required).toEqual(expect.arrayContaining(["accountId", "kind", "amountMinor"]));
    expect(JSON.stringify(doc)).not.toMatch(/9007199254740991|"pattern":"\^\(\[0-9a-fA-F\]/);
  });
  it("matches request paths to routes, preferring static over parameterised", () => {
    expect(matchRoute("GET", "/budgets/status")?.operationId).toBe("getBudgetStatus");
    expect(matchRoute("PATCH", "/budgets/abc")?.operationId).toBe("updateBudget");
    expect(matchRoute("POST", "/recurring/run-due")?.operationId).toBe("runDueRecurring");
    expect(matchRoute("GET", "/recurring/xyz")?.operationId).toBe("getRecurring");
    expect(matchRoute("GET", "/nope")).toBeUndefined();
  });
});
