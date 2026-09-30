import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
  WriteSpecInput,
} from '@vorasaan/shared';
import { AdminOnly } from '../auth/admin.guard.ts';
import { CurrentUser, Public } from '../auth/identity.guard.ts';
import { OrgService } from './org.service.ts';

@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  // Projects & Teams

  @Get('projects')
  projects() {
    return this.org.listProjects();
  }

  @AdminOnly()
  @Post('projects')
  createProject(@Body({ schema: CreateProjectInput }) body: CreateProjectInput) {
    return this.org.createProject(body);
  }

  @AdminOnly()
  @Post('projects/:id/teams')
  createTeam(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body({ schema: CreateTeamInput }) body: CreateTeamInput,
  ) {
    return this.org.createTeam(projectId, body.name);
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
  members() {
    return this.org.listMembers();
  }

  @AdminOnly()
  @Get('invitations')
  invitations() {
    return this.org.listInvitations();
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
  async revokeInvitation(@Param('id', ParseUUIDPipe) id: string) {
    await this.org.revokeInvitation(id);
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

  @Get('features/:id/role-owners')
  roleOwners(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.listRoleOwners(id);
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
