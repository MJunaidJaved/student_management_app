/**
 * The composition root (Part 4.4).
 *
 * Everything is constructed here and passed down through constructors. No
 * module imports a singleton of anything stateful, which is what lets a test
 * build the same graph with a null cache and a null rate limiter rather than
 * reaching into module internals to reset them.
 */

import {
  InProcessCacheStore,
  NullCacheStore,
  type CacheStore,
} from './core/cache/cache';
import {
  InProcessRateLimiterStore,
  NullRateLimiterStore,
  type RateLimiterStore,
} from './core/rate-limit/rate-limiter';
import { InProcessTokenDenylist, type TokenDenylistStore } from './core/auth/token-denylist';
import { PermissionService } from './core/authz/permission-service';
import { SectionPolicy, StaffPolicy, StudentPolicy, UserPolicy } from './core/policy/policy';
import { AuthRepository } from './modules/auth/auth.repository';
import { AuthService } from './modules/auth/auth.service';
import { RolesRepository } from './modules/roles/roles.repository';
import { RolesService } from './modules/roles/roles.service';
import { SettingsService } from './modules/settings/settings.service';
import { AuditService } from './modules/audit/audit.service';
import {
  AcademicYearRepository,
  ClassRepository,
  ClassSubjectRepository,
  RoomRepository,
  SectionRepository,
  SubjectRepository,
  SubjectTeacherRepository,
  TermRepository,
} from './modules/academic/academic.repository';
import { AcademicService } from './modules/academic/academic.service';

export type Container = {
  cache: CacheStore;
  rateLimiter: RateLimiterStore;
  denylist: TokenDenylistStore;
  permissions: PermissionService;
  policies: {
    student: StudentPolicy;
    section: SectionPolicy;
    staff: StaffPolicy;
    user: UserPolicy;
  };
  repositories: {
    auth: AuthRepository;
    roles: RolesRepository;
    sections: SectionRepository;
  };
  services: {
    auth: AuthService;
    roles: RolesService;
    settings: SettingsService;
    audit: AuditService;
    academic: AcademicService;
  };
};

export type ContainerOptions = {
  /**
   * Disable the cache and rate limiter.
   *
   * Tests want both off: a cached permission set leaking between cases looks
   * like an authorization bug, and a tripped rate limiter looks like a logic
   * bug. Neither is what the test is checking.
   */
  forTests?: boolean;
};

export function buildContainer(options: ContainerOptions = {}): Container {
  const cache: CacheStore = options.forTests ? new NullCacheStore() : new InProcessCacheStore();
  const rateLimiter: RateLimiterStore = options.forTests
    ? new NullRateLimiterStore()
    : new InProcessRateLimiterStore();

  const denylist = new InProcessTokenDenylist();
  const permissions = new PermissionService(cache);

  const authRepository = new AuthRepository();
  const rolesRepository = new RolesRepository();

  const academicYears = new AcademicYearRepository();
  const terms = new TermRepository();
  const classes = new ClassRepository();
  const sections = new SectionRepository();
  const subjects = new SubjectRepository();
  const classSubjects = new ClassSubjectRepository();
  const subjectTeachers = new SubjectTeacherRepository();
  const rooms = new RoomRepository();

  return {
    cache,
    rateLimiter,
    denylist,
    permissions,
    policies: {
      student: new StudentPolicy(cache, permissions),
      section: new SectionPolicy(cache, permissions),
      staff: new StaffPolicy(cache, permissions),
      user: new UserPolicy(cache, permissions),
    },
    repositories: {
      auth: authRepository,
      roles: rolesRepository,
      sections,
    },
    services: {
      auth: new AuthService(authRepository, permissions, denylist),
      roles: new RolesService(rolesRepository, permissions),
      settings: new SettingsService(cache),
      audit: new AuditService(),
      academic: new AcademicService(
        academicYears,
        terms,
        classes,
        sections,
        subjects,
        classSubjects,
        subjectTeachers,
        rooms,
        cache,
      ),
    },
  };
}
