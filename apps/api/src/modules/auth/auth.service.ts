import type { PrismaClient, User } from "@prisma/client";
import type { UserDto } from "@localmind/shared";
import { AppError, conflict, forbidden } from "../../lib/errors.js";
import { hashPassword, verifyPassword } from "./password.js";

// Pre-computed hash used to equalise timing when the email doesn't exist.
let dummyHash: Promise<string> | undefined;

export function toUserDto(u: Pick<User, "id" | "email" | "role" | "createdAt">): UserDto {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt.toISOString() };
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly allowRegistration: boolean,
  ) {}

  async register(email: string, password: string): Promise<User> {
    if (!this.allowRegistration) throw forbidden("Registration is disabled on this instance");
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    // The very first account becomes the instance administrator.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const isFirst = (await tx.user.count()) === 0;
        return tx.user.create({ data: { email: normalized, passwordHash, role: isFirst ? "ADMIN" : "USER" } });
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

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, createdAt: true } });
  }
}
