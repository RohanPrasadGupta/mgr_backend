import { Controller, Get } from "@nestjs/common";
import { buildOpenApi } from "@moneymgr/shared";
import { Public } from "../auth/auth.guard";

const doc = buildOpenApi(); // static: derived from the route registry in @moneymgr/shared

/** The machine-readable contract that web and mobile generate their typed clients from. */
@Public()
@Controller()
export class OpenApiController {
  @Get("openapi.json")
  spec() { return doc; }
}
