import type { Classification, PrismaClient, User } from "@prisma/client";
import type { UserDto } from "@clbuddy/shared";
import { AppError, conflict, forbidden } from "../../lib/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { UserProfile } from "../access/access.service.js";

// Pre-computed hash used to equalise timing when the email doesn't exist.
let dummyHash: Promise<string> | undefined;

export function toUserDto(u: UserProfile): UserDto {
  return { id: u.id, email: u.email, role: u.role, clearance: u.clearance, groups: u.groups, createdAt: u.createdAt.toISOString() };
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registration: "open" | "closed" | "first-user",
  ) {}

  async register(email: string, password: string): Promise<User> {
    if (this.registration === "closed") throw forbidden("Registration is disabled on this instance. Ask an administrator to add you.");
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    // The very first account becomes the instance administrator.
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise registrations so two simultaneous first sign-ups can't both become ADMIN.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(727372)`;
        const isFirst = (await tx.user.count()) === 0;
        if (!isFirst && this.registration === "first-user") {
          throw forbidden("Sign-up is closed. Ask an administrator to add you.");
        }
        // New members start with INTERNAL clearance; the first admin gets full clearance.
        return tx.user.create({
          data: { email: normalized, passwordHash, role: isFirst ? "ADMIN" : "USER", clearance: isFirst ? "RESTRICTED" : "INTERNAL" },
        });
      });
    } catch (err) {
      // Deliberately vague (don't confirm which emails exist). With open sign-up the status code
      // still differs, which is why "first-user" mode is the default.
      if ((err as { code?: string }).code === "P2002") throw conflict("Unable to create an account with these details");
      throw err;
    }
  }

  /** Admin-created account (the normal way to add people when sign-up is closed). */
  async createUser(input: { email: string; password: string; role: "USER" | "ADMIN"; clearance: Classification }): Promise<User> {
    try {
      return await this.prisma.user.create({
        data: { email: input.email.trim().toLowerCase(), passwordHash: await hashPassword(input.password), role: input.role, clearance: input.clearance },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw conflict("An account with this email already exists");
      throw err;
    }
  }

  async login(email: string, password: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) {
      dummyHash ??= hashPassword("timing-equaliser");
      await verifyPassword(password, await dummyHash);
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    return user;
  }
}
