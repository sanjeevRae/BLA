import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton (server-only). All data access goes through this
 * client via the repository/service layer — never from Client Components.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
