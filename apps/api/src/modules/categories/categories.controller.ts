import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { createCategorySchema, updateCategorySchema, type CreateCategoryInput, type UpdateCategoryInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { CategoriesService } from "./categories.service";

@Controller("categories")
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly svc: CategoriesService) {}
  @Get() async list(@UserId() u: string) { return { data: await this.svc.list(u) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createCategorySchema)) b: CreateCategoryInput) { return { data: await this.svc.create(u, b) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateCategorySchema)) b: UpdateCategoryInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
