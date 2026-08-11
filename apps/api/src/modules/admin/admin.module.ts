import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS, reasonSchema } from '@labsetu/contracts';
import { AdminService } from './admin.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const createUserSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(2).max(120),
  roleIds: z.array(z.string().uuid()).min(1),
  labId: z.string().uuid().optional(),
  qualification: z.string().trim().max(120).optional(),
  registrationNo: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(20).optional(),
});

const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  qualification: z.string().trim().max(120).nullable().optional(),
  registrationNo: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']).optional(),
});

const setRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).min(1),
  labId: z.string().uuid().optional(),
});

const grantCompetencySchema = z.object({
  userId: z.string().uuid(),
  testDefinitionIds: z.array(z.string().uuid()).min(1),
  level: z.enum(['PERFORM', 'VERIFY', 'AUTHORIZE']),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  // Not optional: ISO 15189 wants the evidence named, not merely asserted.
  evidenceNote: z
    .string()
    .trim()
    .min(10, 'Name the assessment evidence — an assessor will ask for it')
    .max(500),
});

const reasonBody = z.object({ reason: reasonSchema });

const accessReviewSchema = z.object({
  /// Required, and long enough to say something. "Reviewed" is not a review.
  note: z
    .string()
    .trim()
    .min(20, 'Describe what was checked — an assessor reads this, not the timestamp'),
  actions: z.string().trim().max(2000).optional(),
});

@Controller({ path: 'admin', version: '1' })
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @RequirePermissions(PERMISSIONS.USER_READ)
  @Get('users')
  listUsers(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('role') roleCode?: string,
  ) {
    return this.admin.listUsers({ status, search, roleCode });
  }

  /**
   * Periodic access review — §11.300(a). USER_MANAGE rather than USER_READ:
   * recording that access was reviewed is an assertion, not a lookup.
   */
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @Post('access-review')
  recordAccessReview(@Body(zodPipe(accessReviewSchema)) body: z.infer<typeof accessReviewSchema>) {
    return this.admin.recordAccessReview(body);
  }

  @RequirePermissions(PERMISSIONS.USER_READ)
  @Get('access-review')
  listAccessReviews() {
    return this.admin.listAccessReviews();
  }

  @RequirePermissions(PERMISSIONS.USER_READ)
  @Get('roles')
  listRoles() {
    return this.admin.listRoles();
  }

  /** Declared before `users/:id` so "competency" is never parsed as a UUID. */
  @RequirePermissions(PERMISSIONS.USER_READ)
  @Get('competency')
  matrix() {
    return this.admin.competencyMatrix();
  }

  @RequirePermissions(PERMISSIONS.USER_READ)
  @Get('users/:id')
  getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getUser(id);
  }

  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @Post('users')
  createUser(@Body(zodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>) {
    return this.admin.createUser(body);
  }

  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @Patch('users/:id')
  updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>,
  ) {
    return this.admin.updateUser(id, body);
  }

  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @Post('users/:id/reset-password')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(reasonBody)) body: { reason: string },
  ) {
    return this.admin.resetPassword(id, body.reason);
  }

  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  @Post('users/:id/roles')
  setRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(setRolesSchema)) body: z.infer<typeof setRolesSchema>,
  ) {
    return this.admin.setRoles(id, body.roleIds, body.labId);
  }

  @RequirePermissions(PERMISSIONS.COMPETENCY_MANAGE)
  @Post('competency')
  grant(@Body(zodPipe(grantCompetencySchema)) body: z.infer<typeof grantCompetencySchema>) {
    return this.admin.grantCompetency(body);
  }

  @RequirePermissions(PERMISSIONS.COMPETENCY_MANAGE)
  @Post('competency/:id/revoke')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(reasonBody)) body: { reason: string },
  ) {
    return this.admin.revokeCompetency(id, body.reason);
  }
}

@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
