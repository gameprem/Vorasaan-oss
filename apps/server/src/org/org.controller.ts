import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { User } from '@vorasaan/db';
import {
  AcceptInvitationInput,
  CreateFeatureInput,
  CreateInvitationInput,
  CreateProjectInput,
  CreateTeamInput,
  SetRoleOwnersInput,
  SetTeamRolesInput,
  UpdateFeatureInput,
  WriteSpecInput,
} from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser, Public } from '../auth/identity.guard.ts';
import { DeletionService } from './deletion.service.ts';
import { OrgService } from './org.service.ts';

@Controller()
export class OrgController {
  constructor(
    private readonly org: OrgService,
    private readonly deletion: DeletionService,
  ) {}

  // Projects & Teams

  @Get('projects')
  projects(@CurrentUser() user: User) {
    return this.org.listProjects(user);
  }

  @AdminOnly()
  @Post('projects')
  createProject(@Body({ schema: CreateProjectInput }) body: CreateProjectInput) {
    return this.org.createProject(body);
  }

  /** Deletes the Project with its Teams and Features (ticket 0049): Admins only. */
  @AdminOnly()
  @Delete('projects/:id')
  @HttpCode(204)
  async deleteProject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.deletion.deleteProject(user, id);
  }

  @AdminOnly()
  @Post('projects/:id/teams')
  createTeam(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body({ schema: CreateTeamInput }) body: CreateTeamInput,
  ) {
    return this.org.createTeam(user, projectId, body.name);
  }

  @Get('me/teams')
  myTeams(@CurrentUser() user: User) {
    return this.org.listMyTeams(user);
  }

  @Get('teams/:id')
  team(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.org.getTeam(user, id);
  }

  @Put('teams/:id/members/:userId')
  setTeamRoles(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body({ schema: SetTeamRolesInput }) body: SetTeamRolesInput,
  ) {
    return this.org.setTeamRoles(user, teamId, userId, body);
  }

  @Post('teams/:id/features')
  createFeature(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) teamId: string,
    @Body({ schema: CreateFeatureInput }) body: CreateFeatureInput,
  ) {
    return this.org.createFeature(user, teamId, body);
  }

  // Members & invitations

  @Get('members')
  members(@CurrentUser() user: User) {
    return this.org.listMembers(user);
  }

  @AdminOnly()
  @Get('invitations')
  invitations(@CurrentUser() user: User) {
    return this.org.listInvitations(user);
  }

  @AdminOnly()
  @Post('invitations')
  invite(
    @CurrentUser() user: User,
    @Body({ schema: CreateInvitationInput }) body: CreateInvitationInput,
  ) {
    return this.org.createInvitation(user, body);
  }

  @AdminOnly()
  @Delete('invitations/:id')
  @HttpCode(204)
  async revokeInvitation(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.org.revokeInvitation(user, id);
  }

  @Public()
  @Get('invite/:token')
  previewInvitation(@Param('token') token: string) {
    return this.org.previewInvitation(token);
  }

  @Public()
  @Post('invite/:token')
  acceptInvitation(
    @Param('token') token: string,
    @Body({ schema: AcceptInvitationInput }) body: AcceptInvitationInput,
  ) {
    return this.org.acceptInvitation(token, body);
  }

  // Features

  @Patch('features/:id')
  updateFeature(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: UpdateFeatureInput }) body: UpdateFeatureInput,
  ) {
    return this.org.updateFeature(user, id, body);
  }

  @Get('features/:id/role-owners')
  roleOwners(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.org.listRoleOwners(user, id);
  }

  @Put('features/:id/role-owners')
  setRoleOwners(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SetRoleOwnersInput }) body: SetRoleOwnersInput,
  ) {
    return this.org.setRoleOwners(user, id, body);
  }

  @Post('features/:id/spec-versions')
  writeSpec(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: WriteSpecInput }) body: WriteSpecInput,
  ) {
    return this.org.writeSpec(user, id, body);
  }
}
