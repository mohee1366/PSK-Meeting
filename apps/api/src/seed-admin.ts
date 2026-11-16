import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: '../../.env' });
const prisma = new PrismaClient();
const [fullName, email] = process.argv.slice(2);
if (!fullName || !email) { console.error('Usage: pnpm --filter @psk/api seed:admin -- "Full Name" admin@example.org'); process.exit(1); }
const password = randomBytes(24).toString('base64url');
const passwordHash = await bcrypt.hash(password, 12);
const user = await prisma.user.create({ data: { fullName, email, passwordHash, role: 'SUPER_ADMIN', mustChangePassword: true } });
console.log(JSON.stringify({ userId: user.id, email, oneTimePassword: password, warning: 'Store securely. Force password change at first login.' }, null, 2));
await prisma.$disconnect();
