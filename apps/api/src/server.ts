import dotenv from 'dotenv';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { PrismaClient, type Prisma, type User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { randomUUID, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: '../../.env' });

const required = ['DATABASE_URL', 'JWT_SECRET'] as const;
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const isPlaceholderSecret = (value?: string) => !value || /replace[-_ ]?with|change[-_ ]?this|development|example/i.test(value);
if ((process.env.JWT_SECRET ?? '').length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
if (process.env.NODE_ENV === 'production' && isPlaceholderSecret(process.env.JWT_SECRET)) throw new Error('Production JWT_SECRET must be a unique random secret, not a placeholder');
if (process.env.NODE_ENV === 'production' && (!process.env.QR_HMAC_SECRET || process.env.QR_HMAC_SECRET.length < 32 || isPlaceholderSecret(process.env.QR_HMAC_SECRET))) throw new Error('Production QR_HMAC_SECRET must be a unique random secret of at least 32 characters');
if (process.env.SMS_ENABLED === 'true' && (!process.env.OTP_HMAC_SECRET || process.env.OTP_HMAC_SECRET.length < 32 || isPlaceholderSecret(process.env.OTP_HMAC_SECRET) || !process.env.KAVENEGAR_API_KEY || isPlaceholderSecret(process.env.KAVENEGAR_API_KEY))) throw new Error('SMS_ENABLED requires a unique OTP_HMAC_SECRET (32+ chars) and a valid KAVENEGAR_API_KEY');
if (process.env.NODE_ENV === 'production' && /change-this|replace-with|development/i.test(process.env.DATABASE_URL!)) throw new Error('Production DATABASE_URL contains a placeholder');

const prisma = new PrismaClient();
const dummyPasswordHash = await bcrypt.hash(randomUUID(), 10);
const app = Fastify({ logger: true, genReqId: () => randomUUID(), trustProxy: process.env.NODE_ENV === 'production', bodyLimit: 6_291_456 });
const roles = ['SUPER_ADMIN', 'ROOM_ADMIN', 'DEPT_MANAGER', 'EMPLOYEE'] as const;
type Actor = User & { sites: { siteId: string }[] };
type AuthRequest = FastifyRequest & { actor: Actor };
const isManager = (role: string) => role === 'SUPER_ADMIN' || role === 'ROOM_ADMIN' || role === 'DEPT_MANAGER';
const isAdmin = (role: string) => role === 'SUPER_ADMIN' || role === 'ROOM_ADMIN';
const siteIdsFor = (actor: Actor) => actor.role === 'SUPER_ADMIN' ? undefined : actor.sites.map(s => s.siteId);
const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, { origin: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map(x => x.trim()), credentials: false });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(jwt, { secret: process.env.JWT_SECRET!, sign: { expiresIn: '8h' } });
app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/api/')) { reply.header('Cache-Control', 'no-store'); reply.header('Pragma', 'no-cache'); }
  return payload;
});

async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    const token = request.user as { sub: string; sv: number };
    const user = await prisma.user.findUnique({ where: { id: token.sub }, include: { sites: true } });
    if (!user || !user.isActive || user.sessionVersion !== token.sv) return fail(reply, 401, 'SESSION_INVALID', 'نشست معتبر نیست؛ دوباره وارد شوید.');
    (request as AuthRequest).actor = user;
    if (user.mustChangePassword && !request.url.startsWith('/api/v1/auth/change-password')) return fail(reply, 403, 'PASSWORD_CHANGE_REQUIRED', 'برای ادامه، ابتدا رمز عبور خود را تغییر دهید.');
  } catch { return fail(reply, 401, 'UNAUTHENTICATED', 'ابتدا وارد سامانه شوید.'); }
}
const auth = { preHandler: authenticate };
const loginSchema = z.object({ identifier: z.string().trim().min(3).max(180), password: z.string().min(1).max(200) });
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/) });
const reservationInput = z.object({ roomId: z.string().uuid(), title: z.string().trim().min(3).max(160), description: z.string().trim().max(2000).optional(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), attendeeCount: z.number().int().min(1).max(500) }).refine(v => new Date(v.endsAt) > new Date(v.startsAt), { message: 'زمان پایان باید بعد از زمان شروع باشد' });

async function sendKavenegarSms(to: string | null, message: string) {
  if (process.env.SMS_ENABLED !== 'true') return { sent: false, reason: 'disabled' };
  const apiKey = process.env.KAVENEGAR_API_KEY; if (!apiKey || !to) return { sent: false, reason: 'not_configured' };
  const endpoint = `https://api.kavenegar.com/v1/${encodeURIComponent(apiKey)}/sms/send.json`;
  const body = new URLSearchParams({ receptor: to, message, ...(process.env.KAVENEGAR_SENDER ? { sender: process.env.KAVENEGAR_SENDER } : {}) });
  try { const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000) }); if (!response.ok) { app.log.warn({ status: response.status }, 'SMS provider returned non-success status'); return { sent: false, reason: 'provider_error' }; } const result = await response.json() as { return?: { status?: number } }; return { sent: result.return?.status === 200, reason: result.return?.status === 200 ? 'accepted' : 'provider_rejected' }; }
  catch { app.log.warn('SMS provider request failed'); return { sent: false, reason: 'network_error' }; }
}
async function notifyUserBySms(userId: string, message: string) { const user = await prisma.user.findUnique({ where: { id: userId }, select: { mobile: true } }); if (user?.mobile) await sendKavenegarSms(user.mobile, message); }
function hashOtp(userId: string, code: string) { return createHmac('sha256', process.env.OTP_HMAC_SECRET!).update(`${userId}:${code}`).digest(); }

async function audit(actorId: string | null, action: 'CREATE'|'UPDATE'|'DELETE'|'LOGIN'|'LOGOUT'|'APPROVE'|'REJECT'|'IMPORT'|'EXPORT', entityType: string, entityId?: string, siteId?: string, metadata?: Prisma.InputJsonValue, request?: FastifyRequest) {
  await prisma.auditLog.create({ data: { actorId, action, entityType, entityId, siteId, metadata, ipAddress: request?.ip, userAgent: request?.headers['user-agent'] } });
}
app.get('/health', async () => ({ status: 'ok', service: 'psk-meeting-api', timestamp: new Date().toISOString() }));
app.get('/health/ready', async (_request, reply) => { try { await prisma.$queryRaw`SELECT 1`; return { status: 'ready', database: 'connected' }; } catch { return reply.code(503).send({ status: 'not_ready', database: 'unavailable' }); } });
app.post('/api/v1/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'VALIDATION_ERROR', 'شناسه ورود یا رمز عبور معتبر نیست.');
  const id = parsed.data.identifier.toLowerCase();
  let user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { mobile: parsed.data.identifier }, { employeeCode: parsed.data.identifier }] }, include: { sites: true } });
  // Expired lockouts start a fresh failure window; otherwise one old failure could re-lock the account forever.
  if (user?.lockedUntil && user.lockedUntil <= new Date()) {
    user = await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null }, include: { sites: true } });
  }
  if (user?.lockedUntil && user.lockedUntil > new Date()) return fail(reply, 429, 'ACCOUNT_TEMPORARILY_LOCKED', 'به دلیل تلاش‌های ناموفق، ورود این حساب موقتاً مسدود شده است.');
  const passwordMatches = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? dummyPasswordHash);
  const valid = Boolean(user && user.isActive && passwordMatches);
  if (!valid || !user) { if (user && user.isActive) { const failed = await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } }, select: { failedLoginCount: true } }); if (failed.failedLoginCount >= 5) await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + 15 * 60000) } }); } return fail(reply, 401, 'INVALID_CREDENTIALS', 'شناسه ورود یا رمز عبور اشتباه است.'); }
  if (user.failedLoginCount || user.lockedUntil) await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  const token = app.jwt.sign({ sub: user.id, sv: user.sessionVersion });
  await audit(user.id, 'LOGIN', 'User', user.id, undefined, undefined, request);
  return { accessToken: token, tokenType: 'Bearer', expiresIn: 28800, mustChangePassword: user.mustChangePassword, user: { id: user.id, fullName: user.fullName, role: user.role, department: user.department, sites: user.sites.map(s => s.siteId) } };
});
app.post('/api/v1/auth/change-password', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  const parsed = passwordSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'WEAK_PASSWORD', 'رمز جدید باید حداقل ۱۲ نویسه و شامل حروف کوچک و بزرگ، عدد و نماد باشد.');
  const user = await prisma.user.findUnique({ where: { id: request.actor.id } });
  if (!user || !await bcrypt.compare(parsed.data.currentPassword, user.passwordHash)) return fail(reply, 400, 'CURRENT_PASSWORD_INVALID', 'رمز فعلی صحیح نیست.');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12), mustChangePassword: false, sessionVersion: { increment: 1 } } });
  await audit(user.id, 'UPDATE', 'Password', user.id, undefined, { changed: true }, request);
  return { success: true, message: 'رمز عبور تغییر کرد. لطفاً دوباره وارد شوید.' };
});
app.post('/api/v1/auth/logout', { preHandler: [authenticate] }, async (request: AuthRequest) => {
  await prisma.user.update({ where: { id: request.actor.id }, data: { sessionVersion: { increment: 1 } } });
  await audit(request.actor.id, 'LOGOUT', 'User', request.actor.id, undefined, undefined, request);
  return { success: true };
});
app.post('/api/v1/auth/password-reset/request', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const p = z.object({ identifier: z.string().trim().min(3).max(180) }).safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'شناسه ورود معتبر نیست.');
  const id = p.data.identifier.toLowerCase(); const user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { mobile: p.data.identifier }, { employeeCode: p.data.identifier }], isActive: true }, select: { id: true, mobile: true } });
  // Always return the same response to avoid account enumeration.
  if (!user?.mobile || process.env.SMS_ENABLED !== 'true') return { accepted: true, message: 'اگر حساب فعال و شماره موبایل ثبت‌شده وجود داشته باشد، دستورالعمل بازیابی ارسال می‌شود.' };
  const otpSecret = process.env.OTP_HMAC_SECRET; if (!otpSecret || otpSecret.length < 32) return fail(reply, 503, 'OTP_UNAVAILABLE', 'بازیابی پیامکی در حال حاضر پیکربندی نشده است.');
  const recent = await prisma.passwordResetOtp.findFirst({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) }, consumedAt: null }, select: { id: true } }); if (recent) return { accepted: true, message: 'اگر حساب فعال و شماره موبایل ثبت‌شده وجود داشته باشد، دستورالعمل بازیابی ارسال می‌شود.' };
  const code = String(randomInt(100000, 1000000)); const codeHash = hashOtp(user.id, code).toString('base64url'); const otp = await prisma.passwordResetOtp.create({ data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + 10 * 60000) } });
  const result = await sendKavenegarSms(user.mobile, `کد بازیابی رمز PSK Meeting: ${code} — اعتبار ۱۰ دقیقه، حداکثر ۵ تلاش.`);
  if (!result.sent) await prisma.passwordResetOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  reply.header('Cache-Control', 'no-store'); return { accepted: true, message: 'اگر حساب فعال و شماره موبایل ثبت‌شده وجود داشته باشد، دستورالعمل بازیابی ارسال می‌شود.' };
});
app.post('/api/v1/auth/password-reset/confirm', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const p = z.object({ identifier: z.string().trim().min(3).max(180), code: z.string().regex(/^\d{6}$/), newPassword: passwordSchema.shape.newPassword }).safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'اطلاعات بازیابی یا رمز جدید معتبر نیست.');
  const otpSecret = process.env.OTP_HMAC_SECRET; if (!otpSecret || otpSecret.length < 32) return fail(reply, 503, 'OTP_UNAVAILABLE', 'بازیابی پیامکی در حال حاضر پیکربندی نشده است.');
  const id = p.data.identifier.toLowerCase(); const user = await prisma.user.findFirst({ where: { OR: [{ email: id }, { mobile: p.data.identifier }, { employeeCode: p.data.identifier }], isActive: true }, select: { id: true } }); if (!user) return fail(reply, 400, 'RESET_INVALID', 'کد بازیابی معتبر نیست یا منقضی شده است.');
  const otp = await prisma.passwordResetOtp.findFirst({ where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: 5 } }, orderBy: { createdAt: 'desc' } }); if (!otp) return fail(reply, 400, 'RESET_INVALID', 'کد بازیابی معتبر نیست یا منقضی شده است.');
  const expected = Buffer.from(otp.codeHash, 'base64url'); const supplied = hashOtp(user.id, p.data.code); const valid = expected.length === supplied.length && timingSafeEqual(expected, supplied);
  if (!valid) { await prisma.passwordResetOtp.updateMany({ where: { id: otp.id, attempts: otp.attempts, consumedAt: null }, data: { attempts: { increment: 1 }, ...(otp.attempts >= 4 ? { consumedAt: new Date() } : {}) } }); return fail(reply, 400, 'RESET_INVALID', 'کد بازیابی معتبر نیست یا منقضی شده است.'); }
  try { await prisma.$transaction(async tx => { const consumed = await tx.passwordResetOtp.updateMany({ where: { id: otp.id, attempts: otp.attempts, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } }); if (consumed.count !== 1) throw new Error('OTP_ALREADY_USED'); await tx.passwordResetOtp.updateMany({ where: { userId: user.id, id: { not: otp.id }, consumedAt: null }, data: { consumedAt: new Date() } }); await tx.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(p.data.newPassword, 12), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, sessionVersion: { increment: 1 } } }); await tx.auditLog.create({ data: { actorId: user.id, action: 'UPDATE', entityType: 'PasswordReset', entityId: user.id, metadata: { method: 'sms-otp' }, ipAddress: request.ip, userAgent: request.headers['user-agent'] } }); }); }
  catch { return fail(reply, 400, 'RESET_INVALID', 'کد بازیابی معتبر نیست یا قبلاً استفاده شده است.'); }
  reply.header('Cache-Control', 'no-store'); return { success: true, message: 'رمز عبور با موفقیت تغییر کرد؛ اکنون با رمز جدید وارد شوید.' };
});

app.get('/api/v1/auth/me', { preHandler: [authenticate] }, async (request: AuthRequest) => ({ id: request.actor.id, fullName: request.actor.fullName, email: request.actor.email, mobile: request.actor.mobile, employeeCode: request.actor.employeeCode, role: request.actor.role, department: request.actor.department, sites: request.actor.sites.map(s => s.siteId) }));

app.get('/api/v1/sites', { preHandler: [authenticate] }, async (request: AuthRequest) => prisma.site.findMany({ where: { isActive: true, ...(siteIdsFor(request.actor) ? { id: { in: siteIdsFor(request.actor) } } : {}) }, select: { id: true, code: true, name: true, city: true }, orderBy: { name: 'asc' } }));
app.get('/api/v1/rooms', { preHandler: [authenticate] }, async (request: AuthRequest) => {
  const actor = request.actor; const allowed = siteIdsFor(actor);
  return prisma.room.findMany({ where: { isActive: true, ...(allowed ? { siteId: { in: allowed } } : {}) }, include: { site: { select: { id: true, code: true, name: true, city: true } } }, orderBy: [{ site: { name: 'asc' } }, { name: 'asc' }] });
});
app.post('/api/v1/rooms', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز تعریف اتاق را ندارید.');
  const schema = z.object({ code: z.string().trim().min(3).max(40), name: z.string().trim().min(2).max(120), siteId: z.string().uuid(), capacity: z.number().int().min(1).max(1000), features: z.array(z.string().max(80)).max(30).default([]) });
  const p = schema.safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'اطلاعات اتاق معتبر نیست.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === p.data.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  const targetSite = await prisma.site.findUnique({ where: { id: p.data.siteId }, select: { id: true, isActive: true } }); if (!targetSite?.isActive) return fail(reply, 400, 'INVALID_SITE', 'محل انتخاب‌شده معتبر یا فعال نیست.');
  const room = await prisma.room.create({ data: { ...p.data, features: p.data.features } }); await audit(request.actor.id, 'CREATE', 'Room', room.id, room.siteId, undefined, request); return reply.code(201).send(room);
});

app.post('/api/v1/reservations', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  const parsed = reservationInput.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'VALIDATION_ERROR', 'اطلاعات رزرو معتبر نیست.');
  const actor = request.actor;
  const room = await prisma.room.findUnique({ where: { id: parsed.data.roomId } });
  if (!room || !room.isActive) return fail(reply, 404, 'ROOM_NOT_FOUND', 'اتاق موردنظر یافت نشد.');
  if (actor.role !== 'SUPER_ADMIN' && !actor.sites.some(s => s.siteId === room.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (parsed.data.attendeeCount > room.capacity) return fail(reply, 400, 'CAPACITY_EXCEEDED', 'تعداد شرکت‌کنندگان از ظرفیت اتاق بیشتر است.');
  if (new Date(parsed.data.startsAt).getTime() < Date.now() - 60_000) return fail(reply, 400, 'PAST_RESERVATION', 'زمان شروع جلسه نمی‌تواند در گذشته باشد.');
  try {
    const reservation = await prisma.$transaction(async tx => {
      const created = await tx.reservation.create({ data: { ...parsed.data, startsAt: new Date(parsed.data.startsAt), endsAt: new Date(parsed.data.endsAt), userId: actor.id, siteId: room.siteId, status: 'PENDING' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'CREATE', entityType: 'Reservation', entityId: created.id, siteId: room.siteId, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
      return created;
    });
    return reply.code(201).send(reservation);
  } catch (error: unknown) {
    const e = error as { code?: string; message?: string };
    if (e.code === 'P2004' || e.code === 'P2010' || e.message?.includes('reservation_no_overlap') || e.message?.includes('23P01')) return fail(reply, 409, 'ROOM_TIME_CONFLICT', 'این اتاق در بازه زمانی انتخاب‌شده رزرو یا در انتظار تأیید است.');
    throw error;
  }
});
app.get('/api/v1/reservations', { preHandler: [authenticate] }, async (request: AuthRequest) => {
  const actor = request.actor; const allowed = siteIdsFor(actor);
  return prisma.reservation.findMany({ where: { ...(allowed ? { siteId: { in: allowed } } : {}), ...(actor.role === 'EMPLOYEE' ? { userId: actor.id } : {}), ...(actor.role === 'DEPT_MANAGER' ? { user: { department: actor.department ?? '__NO_DEPARTMENT__' } } : {}) }, include: { room: { select: { id: true, code: true, name: true } }, site: { select: { code: true, name: true } }, user: { select: { id: true, fullName: true } } }, orderBy: { startsAt: 'desc' }, take: 200 });
});
app.patch('/api/v1/reservations/:id/decision', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز تصمیم‌گیری درباره رزرو را ندارید.');
  const p = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().max(500).optional() }).safeParse(request.body);
  if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'تصمیم رزرو معتبر نیست.');
  const id = (request.params as { id: string }).id;
  const current = await prisma.reservation.findUnique({ where: { id }, include: { user: { select: { department: true } } } });
  if (!current) return fail(reply, 404, 'NOT_FOUND', 'رزرو یافت نشد.');
  if (request.actor.role === 'DEPT_MANAGER' && current.user.department !== request.actor.department) return fail(reply, 403, 'DEPARTMENT_FORBIDDEN', 'این رزرو متعلق به واحد سازمانی شما نیست.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === current.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (current.status !== 'PENDING') return fail(reply, 409, 'INVALID_STATE', 'فقط رزرو در انتظار بررسی قابل تصمیم‌گیری است.');
  const updated = await prisma.$transaction(async tx => {
    const changed = await tx.reservation.updateMany({ where: { id, status: 'PENDING' }, data: { status: p.data.decision, approvedById: request.actor.id, approvedAt: new Date(), cancellationReason: p.data.decision === 'REJECTED' ? p.data.reason : null } });
    if (changed.count !== 1) return null;
    await tx.auditLog.create({ data: { actorId: request.actor.id, action: p.data.decision === 'APPROVED' ? 'APPROVE' : 'REJECT', entityType: 'Reservation', entityId: id, siteId: current.siteId, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
    return tx.reservation.findUnique({ where: { id } });
  });
  if (!updated) return fail(reply, 409, 'INVALID_STATE', 'رزرو هم‌زمان توسط کاربر دیگری تغییر کرده است.');
  // External notification is intentionally sent only after the database transaction commits.
  await notifyUserBySms(current.userId, p.data.decision === 'APPROVED' ? 'درخواست رزرو جلسه شما تأیید شد. برای جزئیات به سامانه مراجعه کنید.' : 'درخواست رزرو جلسه شما رد شد. برای جزئیات به سامانه مراجعه کنید.');
  return updated;
});
app.patch('/api/v1/reservations/:id/complete', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز تکمیل رزرو را ندارید.');
  const id = (request.params as { id: string }).id; const current = await prisma.reservation.findUnique({ where: { id }, include: { user: { select: { department: true } } } }); if (!current) return fail(reply, 404, 'NOT_FOUND', 'رزرو یافت نشد.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === current.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (request.actor.role === 'DEPT_MANAGER' && current.user.department !== request.actor.department) return fail(reply, 403, 'DEPARTMENT_FORBIDDEN', 'این رزرو متعلق به واحد سازمانی شما نیست.');
  if (current.status !== 'APPROVED' || current.endsAt > new Date()) return fail(reply, 409, 'INVALID_STATE', 'فقط جلسه تأییدشده و پایان‌یافته قابل تکمیل است.');
  const updated = await prisma.$transaction(async tx => {
    const changed = await tx.reservation.updateMany({ where: { id, status: 'APPROVED', endsAt: { lte: new Date() } }, data: { status: 'COMPLETED' } });
    if (changed.count !== 1) return null;
    await tx.auditLog.create({ data: { actorId: request.actor.id, action: 'UPDATE', entityType: 'Reservation', entityId: id, siteId: current.siteId, metadata: { status: 'COMPLETED' }, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
    return tx.reservation.findUnique({ where: { id } });
  });
  if (!updated) return fail(reply, 409, 'INVALID_STATE', 'وضعیت رزرو هم‌زمان تغییر کرده یا زمان جلسه هنوز پایان نیافته است.');
  return updated;
});

app.post('/api/v1/reservations/:id/cancel', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  const id = (request.params as { id: string }).id; const p = z.object({ reason: z.string().trim().max(500).optional() }).safeParse(request.body ?? {}); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'علت لغو معتبر نیست.');
  const current = await prisma.reservation.findUnique({ where: { id }, include: { user: { select: { department: true } } } }); if (!current) return fail(reply, 404, 'NOT_FOUND', 'رزرو یافت نشد.');
  if (request.actor.role === 'DEPT_MANAGER' && current.user.department !== request.actor.department) return fail(reply, 403, 'DEPARTMENT_FORBIDDEN', 'این رزرو متعلق به واحد سازمانی شما نیست.');
  if (current.userId !== request.actor.id && !isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'فقط ثبت‌کننده یا مدیر مجاز می‌تواند رزرو را لغو کند.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === current.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (!['PENDING', 'APPROVED'].includes(current.status) || current.startsAt <= new Date()) return fail(reply, 409, 'INVALID_STATE', 'رزرو شروع‌شده یا دارای وضعیت غیرقابل لغو است.');
  const updated = await prisma.$transaction(async tx => {
    const changed = await tx.reservation.updateMany({ where: { id, status: { in: ['PENDING', 'APPROVED'] }, startsAt: { gt: new Date() } }, data: { status: 'CANCELLED', cancellationReason: p.data.reason } });
    if (changed.count !== 1) return null;
    await tx.auditLog.create({ data: { actorId: request.actor.id, action: 'UPDATE', entityType: 'Reservation', entityId: id, siteId: current.siteId, metadata: { status: 'CANCELLED' }, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
    return tx.reservation.findUnique({ where: { id } });
  });
  if (!updated) return fail(reply, 409, 'INVALID_STATE', 'رزرو هم‌زمان تغییر کرده یا دیگر قابل لغو نیست.');
  return updated;
});


app.get('/api/v1/reports/usage', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز مشاهده گزارش‌های مدیریتی را ندارید.');
  const query = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).safeParse(request.query); if (!query.success) return fail(reply, 400, 'VALIDATION_ERROR', 'بازه گزارش معتبر نیست.');
  const to = query.data.to ? new Date(query.data.to) : new Date(); const from = query.data.from ? new Date(query.data.from) : new Date(to.getTime() - 30 * 86400000); if (to <= from || to.getTime() - from.getTime() > 366 * 86400000) return fail(reply, 400, 'INVALID_RANGE', 'بازه گزارش باید حداکثر یک سال باشد.');
  const allowed = siteIdsFor(request.actor); const where = { startsAt: { lt: to }, endsAt: { gt: from }, ...(allowed ? { siteId: { in: allowed } } : {}), ...(request.actor.role === 'DEPT_MANAGER' ? { user: { department: request.actor.department ?? '__NO_DEPARTMENT__' } } : {}) };
  const [rows, rooms] = await Promise.all([prisma.reservation.findMany({ where, select: { id: true, roomId: true, title: true, startsAt: true, endsAt: true, status: true, attendeeCount: true, siteId: true, room: { select: { name: true, code: true } }, site: { select: { name: true } } } }), prisma.room.findMany({ where: { isActive: true, ...(allowed ? { siteId: { in: allowed } } : {}) }, select: { id: true, name: true, code: true, capacity: true } })]);
  const statusCounts = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, COMPLETED: 0 }; for (const row of rows) statusCounts[row.status]++;
  const roomUsage = rooms.map(room => { const bookings = rows.filter(row => row.roomId === room.id && ['PENDING', 'APPROVED', 'COMPLETED'].includes(row.status)); const minutes = bookings.reduce((sum, row) => sum + Math.max(0, (Math.min(row.endsAt.getTime(), to.getTime()) - Math.max(row.startsAt.getTime(), from.getTime())) / 60000), 0); return { room: room.name, code: room.code, capacity: room.capacity, bookingCount: bookings.length, bookedMinutes: Math.round(minutes) }; }).sort((a,b)=>b.bookedMinutes-a.bookedMinutes);
  return { from: from.toISOString(), to: to.toISOString(), totalReservations: rows.length, statusCounts, roomUsage };
});
app.get('/api/v1/reports/reservations.csv', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز خروجی گزارش را ندارید.');
  const allowed = siteIdsFor(request.actor); const rows = await prisma.reservation.findMany({ where: { ...(allowed ? { siteId: { in: allowed } } : {}), ...(request.actor.role === 'DEPT_MANAGER' ? { user: { department: request.actor.department ?? '__NO_DEPARTMENT__' } } : {}) }, include: { room: { select: { name: true, code: true } }, site: { select: { name: true } }, user: { select: { fullName: true } } }, orderBy: { startsAt: 'desc' }, take: 5000 });
  const cell = (value: unknown) => { let s = String(value ?? '').replace(/[\r\n]+/g, ' ').trim(); if (/^[=+\-@\t]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const lines = [['عنوان جلسه','اتاق','کد اتاق','محل','شروع','پایان','تعداد','ثبت‌کننده','وضعیت'], ...rows.map(r => [r.title,r.room.name,r.room.code,r.site.name,r.startsAt.toISOString(),r.endsAt.toISOString(),r.attendeeCount,r.user.fullName,r.status])];
  reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="psk-reservations.csv"').header('Cache-Control','no-store'); return '\ufeff' + lines.map(line => line.map(cell).join(',')).join('\r\n');
});

app.get('/api/v1/dashboard/summary', { preHandler: [authenticate] }, async (request: AuthRequest) => {
  const allowed = siteIdsFor(request.actor); const siteScope = allowed ? { siteId: { in: allowed } } : {}; const reservationScope = { ...siteScope, ...(request.actor.role === 'DEPT_MANAGER' ? { user: { department: request.actor.department ?? '__NO_DEPARTMENT__' } } : {}) };
  const [roomCount, pendingCount, upcomingCount, reservationCount, sites] = await Promise.all([
    prisma.room.count({ where: { isActive: true, ...siteScope } }),
    prisma.reservation.count({ where: { status: 'PENDING', ...reservationScope } }),
    prisma.reservation.count({ where: { startsAt: { gte: new Date() }, status: { in: ['PENDING', 'APPROVED'] }, ...reservationScope } }),
    prisma.reservation.count({ where: { ...reservationScope } }),
    prisma.site.count({ where: { isActive: true, ...(allowed ? { id: { in: allowed } } : {}) } })
  ]);
  return { roomCount, pendingCount, upcomingCount, reservationCount, siteCount: sites };
});

const serviceInput = z.object({ reservationId: z.string().uuid().optional(), roomId: z.string().uuid(), type: z.enum(['CATERING', 'CLEANING', 'MAINTENANCE', 'OTHER']), description: z.string().trim().min(5).max(1500), requestedAt: z.string().datetime({ offset: true }).optional() });
app.post('/api/v1/service-requests', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  const p = serviceInput.safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'اطلاعات درخواست خدمات معتبر نیست.');
  const room = await prisma.room.findUnique({ where: { id: p.data.roomId } }); if (!room || !room.isActive) return fail(reply, 404, 'ROOM_NOT_FOUND', 'اتاق یافت نشد.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === room.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (p.data.reservationId) { const r = await prisma.reservation.findUnique({ where: { id: p.data.reservationId }, include: { user: { select: { department: true } } } }); if (!r || r.roomId !== room.id || (request.actor.role === 'EMPLOYEE' && r.userId !== request.actor.id) || (request.actor.role === 'DEPT_MANAGER' && r.user.department !== request.actor.department)) return fail(reply, 404, 'RESERVATION_NOT_FOUND', 'رزرو مرتبط یافت نشد.'); }
  const created = await prisma.serviceRequest.create({ data: { ...p.data, requestedAt: p.data.requestedAt ? new Date(p.data.requestedAt) : null, siteId: room.siteId, requesterId: request.actor.id } }); await audit(request.actor.id, 'CREATE', 'ServiceRequest', created.id, room.siteId, undefined, request); return reply.code(201).send(created);
});
app.get('/api/v1/service-requests', { preHandler: [authenticate] }, async (request: AuthRequest) => {
  const allowed = siteIdsFor(request.actor); return prisma.serviceRequest.findMany({ where: { ...(allowed ? { siteId: { in: allowed } } : {}), ...(request.actor.role === 'EMPLOYEE' ? { requesterId: request.actor.id } : {}), ...(request.actor.role === 'DEPT_MANAGER' ? { requester: { department: request.actor.department ?? '__NO_DEPARTMENT__' } } : {}) }, include: { room: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
});
app.patch('/api/v1/service-requests/:id/status', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز تغییر وضعیت درخواست را ندارید.');
  const p = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'REJECTED']) }).safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'وضعیت معتبر نیست.');
  const id = (request.params as { id: string }).id; const item = await prisma.serviceRequest.findUnique({ where: { id }, include: { requester: { select: { department: true } } } }); if (!item) return fail(reply, 404, 'NOT_FOUND', 'درخواست یافت نشد.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === item.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (request.actor.role === 'DEPT_MANAGER' && item.requester.department !== request.actor.department) return fail(reply, 403, 'DEPARTMENT_FORBIDDEN', 'این درخواست متعلق به واحد سازمانی شما نیست.');
  const allowedTransitions: Record<string, string[]> = { OPEN: ['IN_PROGRESS', 'REJECTED'], IN_PROGRESS: ['DONE', 'REJECTED'], DONE: [], REJECTED: [] }; if (!allowedTransitions[item.status].includes(p.data.status)) return fail(reply, 409, 'INVALID_STATE', 'تغییر وضعیت درخواست مجاز نیست.');
  const changed = await prisma.$transaction(async tx => {
    const result = await tx.serviceRequest.updateMany({ where: { id, status: item.status }, data: { status: p.data.status } });
    if (result.count === 1) await tx.auditLog.create({ data: { actorId: request.actor.id, action: 'UPDATE', entityType: 'ServiceRequest', entityId: id, siteId: item.siteId, metadata: { status: p.data.status }, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
    return result.count;
  });
  if (changed !== 1) return fail(reply, 409, 'INVALID_STATE', 'وضعیت درخواست هم‌زمان تغییر کرده است؛ اطلاعات را تازه‌سازی کنید.');
  return prisma.serviceRequest.findUnique({ where: { id } });
});


const importRowSchema = z.object({ employeeCode: z.string().trim().min(1).max(40), fullName: z.string().trim().min(2).max(120), mobile: z.string().trim().min(8).max(20).optional(), email: z.string().trim().email().optional(), department: z.string().trim().max(120).optional(), siteCodes: z.array(z.string().trim().min(2).max(40)).min(1).max(5) });
function signImportPayload(payload: string) { return createHmac('sha256', process.env.JWT_SECRET!).update(payload).digest('base64url'); }
app.get('/api/v1/admin/users/import/template', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز دریافت الگوی ورود اطلاعات را ندارید.');
  return { columns: ['employeeCode', 'fullName', 'mobile', 'email', 'department', 'siteCodes'], example: { employeeCode: '10025', fullName: 'نام و نام خانوادگی', mobile: '09120000000', email: 'employee@example.com', department: 'منابع انسانی', siteCodes: 'PSK-THR' }, allowedSiteCodes: (await prisma.site.findMany({ where: { isActive: true, ...(request.actor.role === 'SUPER_ADMIN' ? {} : { id: { in: request.actor.sites.map(s => s.siteId) } }) }, select: { code: true, name: true } })) };
});
app.post('/api/v1/admin/users/import/preview', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }, preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز ورود اطلاعات کاربران را ندارید.');
  const body = z.object({ fileBase64: z.string().min(20).max(5_800_000) }).safeParse(request.body); if (!body.success) return fail(reply, 400, 'INVALID_FILE', 'فایل ارسالی معتبر نیست یا حجم آن بیش از حد مجاز است.');
  let rawRows: Record<string, unknown>[];
  try { const buffer = Buffer.from(body.data.fileBase64, 'base64'); if (buffer.length > 4 * 1024 * 1024) return fail(reply, 413, 'FILE_TOO_LARGE', 'حداکثر حجم فایل ۴ مگابایت است.'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); const sheet = workbook.worksheets[0]; if (!sheet) return fail(reply, 400, 'EMPTY_WORKBOOK', 'فایل اکسل فاقد برگه است.'); if (sheet.rowCount > 501 || sheet.columnCount > 20) return fail(reply, 400, 'WORKSHEET_LIMIT', 'حداکثر ۵۰۰ ردیف داده و ۲۰ ستون مجاز است.'); const headerValues = sheet.getRow(1).values as unknown[]; const headers = headerValues.slice(1).map(value => String(value ?? '').trim()); const requiredHeaders = ['employeeCode', 'fullName', 'siteCodes']; if (requiredHeaders.some(header => !headers.includes(header)) || new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) return fail(reply, 400, 'INVALID_HEADERS', 'ستون‌های employeeCode، fullName و siteCodes الزامی هستند و نام ستون‌ها نباید تکراری باشد.'); rawRows = []; for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) { const values = sheet.getRow(rowNumber).values as unknown[]; const item: Record<string, unknown> = {}; headers.forEach((header, index) => { if (header) { const value = values[index + 1] ?? ''; if (value && typeof value === 'object') item.__invalidCell = true; item[header] = value && typeof value === 'object' ? '' : value; } }); rawRows.push(item); } } catch { return fail(reply, 400, 'INVALID_WORKBOOK', 'فایل اکسل قابل خواندن نیست.'); }
  if (!rawRows.length || rawRows.length > 500) return fail(reply, 400, 'ROW_LIMIT', 'فایل باید بین ۱ تا ۵۰۰ ردیف داده داشته باشد.');
  const allowedSites = await prisma.site.findMany({ where: { isActive: true, ...(request.actor.role === 'SUPER_ADMIN' ? {} : { id: { in: request.actor.sites.map(s => s.siteId) } }) }, select: { id: true, code: true } });
  const allowedCodes = new Set(allowedSites.map(s => s.code)); const seen = new Set<string>(); const seenEmails = new Set<string>(); const seenMobiles = new Set<string>(); const valid: z.infer<typeof importRowSchema>[] = []; const issues: { row: number; message: string }[] = [];
  for (let i = 0; i < rawRows.length; i++) { const raw = rawRows[i]!; if (raw.__invalidCell) { issues.push({ row: i + 2, message: 'فرمول یا محتوای غیرمتنی در سلول مجاز نیست.' }); continue; } const siteCodes = String(raw.siteCodes ?? '').split(/[;,،]/).map(x => x.trim()).filter(Boolean); const normalized = { employeeCode: String(raw.employeeCode ?? '').trim(), fullName: String(raw.fullName ?? '').trim(), mobile: String(raw.mobile ?? '').trim() || undefined, email: String(raw.email ?? '').trim().toLowerCase() || undefined, department: String(raw.department ?? '').trim() || undefined, siteCodes }; const parsed = importRowSchema.safeParse(normalized); if (!parsed.success) { issues.push({ row: i + 2, message: 'اطلاعات ردیف ناقص یا نامعتبر است.' }); continue; } const key = parsed.data.employeeCode.toLowerCase(); if (seen.has(key) || (parsed.data.email && seenEmails.has(parsed.data.email)) || (parsed.data.mobile && seenMobiles.has(parsed.data.mobile))) { issues.push({ row: i + 2, message: 'کد پرسنلی، ایمیل یا موبایل تکراری در فایل.' }); continue; } seen.add(key); if (parsed.data.email) seenEmails.add(parsed.data.email); if (parsed.data.mobile) seenMobiles.add(parsed.data.mobile); if (parsed.data.siteCodes.some(code => !allowedCodes.has(code))) { issues.push({ row: i + 2, message: 'کد شعبه نامعتبر یا خارج از دسترس است.' }); continue; } valid.push(parsed.data); }
  const codes = valid.map(x => x.employeeCode); const uniqueEmails = valid.flatMap(x => x.email ? [x.email] : []); const uniqueMobiles = valid.flatMap(x => x.mobile ? [x.mobile] : []); const existing = codes.length ? await prisma.user.findMany({ where: { OR: [{ employeeCode: { in: codes } }, ...(uniqueEmails.length ? [{ email: { in: uniqueEmails } }] : []), ...(uniqueMobiles.length ? [{ mobile: { in: uniqueMobiles } }] : [])] }, select: { employeeCode: true, email: true, mobile: true } }) : []; const existingCodes = new Set(existing.flatMap(x => x.employeeCode ? [x.employeeCode] : [])); const existingEmails = new Set(existing.flatMap(x => x.email ? [x.email] : [])); const existingMobiles = new Set(existing.flatMap(x => x.mobile ? [x.mobile] : [])); const ready = valid.filter(x => !existingCodes.has(x.employeeCode) && !(x.email && existingEmails.has(x.email)) && !(x.mobile && existingMobiles.has(x.mobile))); for (const x of valid.filter(x => existingCodes.has(x.employeeCode) || (x.email && existingEmails.has(x.email)) || (x.mobile && existingMobiles.has(x.mobile)))) issues.push({ row: rawRows.findIndex(r => String(r.employeeCode ?? '').trim() === x.employeeCode) + 2, message: 'کد پرسنلی، ایمیل یا موبایل قبلاً در سامانه ثبت شده است.' });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+600, actorId: request.actor.id, rows: ready })).toString('base64url'); const signature = signImportPayload(payload);
  return { totalRows: rawRows.length, readyCount: ready.length, rejectedCount: issues.length, issues, previewToken: issues.length === 0 && ready.length > 0 ? `${payload}.${signature}` : null, note: 'این مرحله فقط پیش‌نمایش است و هیچ کاربری ایجاد نشده است.' };
});
app.post('/api/v1/admin/users/import/commit', { config: { rateLimit: { max: 2, timeWindow: '15 minutes' } }, preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز ورود اطلاعات کاربران را ندارید.');
  const body = z.object({ previewToken: z.string().min(40).max(5_800_000) }).safeParse(request.body); if (!body.success) return fail(reply, 400, 'INVALID_PREVIEW', 'توکن پیش‌نمایش معتبر نیست.');
  const [payload, signature] = body.data.previewToken.split('.'); if (!payload || !signature) return fail(reply, 400, 'INVALID_PREVIEW', 'ساختار پیش‌نمایش معتبر نیست.'); const expected = Buffer.from(signImportPayload(payload)); const supplied = Buffer.from(signature); if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return fail(reply, 400, 'INVALID_PREVIEW', 'امضای پیش‌نمایش معتبر نیست.');
  let data: { exp: number; actorId: string; rows: z.infer<typeof importRowSchema>[] }; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return fail(reply, 400, 'INVALID_PREVIEW', 'محتوای پیش‌نمایش معتبر نیست.'); }
  if (data.actorId !== request.actor.id || data.exp < Math.floor(Date.now()/1000) || !Array.isArray(data.rows) || data.rows.length < 1 || data.rows.length > 500) return fail(reply, 400, 'PREVIEW_EXPIRED', 'پیش‌نمایش منقضی یا نامعتبر است؛ دوباره پیش‌نمایش بگیرید.');
  const codes = data.rows.map(r => r.employeeCode); const duplicateFilters: Prisma.UserWhereInput[] = [{ employeeCode: { in: codes } }, ...data.rows.flatMap(r => [r.email ? { email: r.email } : undefined, r.mobile ? { mobile: r.mobile } : undefined].filter((x): x is { email: string } | { mobile: string } => Boolean(x)))]; const existing = await prisma.user.findMany({ where: { OR: duplicateFilters }, select: { employeeCode: true, email: true, mobile: true } });
  if (existing.length) return fail(reply, 409, 'IMPORT_CONFLICT', 'از زمان پیش‌نمایش، بخشی از اطلاعات در سامانه ثبت شده است؛ پیش‌نمایش را دوباره اجرا کنید.');
  const siteRows = await prisma.site.findMany({ where: { code: { in: [...new Set(data.rows.flatMap(r => r.siteCodes))] }, isActive: true } }); const siteByCode = new Map(siteRows.map(s => [s.code, s.id])); if (data.rows.some(r => r.siteCodes.some(code => !siteByCode.has(code) || (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === siteByCode.get(code)))))) return fail(reply, 403, 'SITE_FORBIDDEN', 'دسترسی به یکی از شعب فایل وجود ندارد.');
  const prepared: { id: string; employeeCode: string; fullName: string; mobile?: string; email?: string; department?: string; passwordHash: string; temporaryPassword: string; siteIds: string[] }[] = [];
  try {
    // Hash before opening the transaction; keep DB locks short even for a 500-row import.
    for (let i = 0; i < data.rows.length; i += 10) {
      const batch = await Promise.all(data.rows.slice(i, i + 10).map(async row => { const temporaryPassword = `${randomUUID()}Aa1!`; return { id: randomUUID(), employeeCode: row.employeeCode, fullName: row.fullName, mobile: row.mobile, email: row.email, department: row.department, passwordHash: await bcrypt.hash(temporaryPassword, 12), temporaryPassword, siteIds: row.siteCodes.map(code => siteByCode.get(code)!) }; }));
      prepared.push(...batch);
    }
    await prisma.$transaction(async tx => {
      await tx.user.createMany({ data: prepared.map(({ id, employeeCode, fullName, mobile, email, department, passwordHash }) => ({ id, employeeCode, fullName, mobile, email, department, passwordHash, role: 'EMPLOYEE' as const, mustChangePassword: true })) });
      await tx.userSite.createMany({ data: prepared.flatMap(user => user.siteIds.map(siteId => ({ userId: user.id, siteId }))) });
      await tx.auditLog.create({ data: { actorId: request.actor.id, action: 'IMPORT', entityType: 'User', metadata: { count: data.rows.length, mode: 'employee-import' } } });
    }, { maxWait: 10000, timeout: 120000 });
  } catch (e: unknown) { const err = e as { code?: string }; if (err.code === 'P2002') return fail(reply, 409, 'IMPORT_CONFLICT', 'تعارض اطلاعات شناسایی شد؛ عملیات ثبت نشد.'); throw e; }
  const credentials = prepared.map(({ employeeCode, fullName, temporaryPassword }) => ({ employeeCode, fullName, temporaryPassword }));
  reply.header('Cache-Control', 'no-store'); return { success: true, createdCount: credentials.length, credentials, warning: 'رمزهای موقت فقط در همین پاسخ نمایش داده می‌شوند؛ فایل خروجی را در محل امن نگهداری کنید.' };
});

app.get('/api/v1/admin/users', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز مشاهده کاربران را ندارید.');
  const allowed = siteIdsFor(request.actor); const users = await prisma.user.findMany({ where: allowed ? { sites: { some: { siteId: { in: allowed } } } } : {}, select: { id: true, employeeCode: true, fullName: true, email: true, mobile: true, role: true, department: true, isActive: true, mustChangePassword: true, sites: { where: allowed ? { siteId: { in: allowed } } : {}, select: { siteId: true } } }, orderBy: { fullName: 'asc' }, take: 500 });
  return users;
});
app.post('/api/v1/admin/users', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز ایجاد کاربر را ندارید.');
  const schema = z.object({ employeeCode: z.string().trim().min(1).max(40).optional(), fullName: z.string().trim().min(2).max(120), email: z.string().trim().email().optional(), mobile: z.string().trim().min(8).max(20).optional(), role: z.enum(roles).default('EMPLOYEE'), department: z.string().trim().max(120).optional(), siteIds: z.array(z.string().uuid()).max(10).default([]).refine(ids => new Set(ids).size === ids.length, 'شعبه تکراری مجاز نیست') });
  const p = schema.safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'اطلاعات کاربر معتبر نیست.');
  if (request.actor.role !== 'SUPER_ADMIN' && (p.data.role !== 'EMPLOYEE' || p.data.siteIds.length === 0 || p.data.siteIds.some(id => !request.actor.sites.some(s => s.siteId === id)))) return fail(reply, 403, 'SITE_FORBIDDEN', 'مدیر اتاق فقط می‌تواند کارمند در شعب تحت دسترسی خود ایجاد کند.');
  const validSites = await prisma.site.findMany({ where: { id: { in: p.data.siteIds }, isActive: true }, select: { id: true } }); if (validSites.length !== p.data.siteIds.length) return fail(reply, 400, 'INVALID_SITE', 'یکی از شعب انتخاب‌شده معتبر یا فعال نیست.');
  const temporaryPassword = randomUUID() + 'Aa1!'; const created = await prisma.user.create({ data: { employeeCode: p.data.employeeCode, fullName: p.data.fullName, email: p.data.email?.toLowerCase(), mobile: p.data.mobile, role: p.data.role, department: p.data.department, passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true, sites: { create: p.data.siteIds.map(siteId => ({ siteId })) } }, select: { id: true, employeeCode: true, fullName: true, email: true, mobile: true, role: true, department: true, mustChangePassword: true } });
  await audit(request.actor.id, 'CREATE', 'User', created.id, undefined, undefined, request);
  // One-time credential is returned only to the authorized creator; do not log or send it.
  return reply.code(201).send({ user: created, temporaryPassword });
});
app.post('/api/v1/admin/users/:id/reset-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }, preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز بازنشانی رمز عبور را ندارید.');
  const id = (request.params as { id: string }).id; const target = await prisma.user.findUnique({ where: { id }, include: { sites: true } }); if (!target) return fail(reply, 404, 'NOT_FOUND', 'کاربر یافت نشد.');
  if (request.actor.role !== 'SUPER_ADMIN' && (target.role !== 'EMPLOYEE' || target.sites.length === 0 || !target.sites.every(s => request.actor.sites.some(a => a.siteId === s.siteId)))) return fail(reply, 403, 'SITE_FORBIDDEN', 'مدیر اتاق فقط می‌تواند حساب کارکنان شعب تحت دسترسی خود را مدیریت کند.');
  const temporaryPassword = `${randomUUID()}Aa1!`; await prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, sessionVersion: { increment: 1 } } });
  await audit(request.actor.id, 'UPDATE', 'PasswordReset', id, undefined, { mustChangePassword: true }, request); reply.header('Cache-Control', 'no-store'); return { success: true, temporaryPassword, message: 'رمز موقت فقط یک‌بار نمایش داده می‌شود؛ آن را امن به کاربر تحویل دهید.' };
});

app.patch('/api/v1/admin/users/:id/status', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isAdmin(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز مدیریت کاربر را ندارید.');
  const p = z.object({ isActive: z.boolean() }).safeParse(request.body); if (!p.success) return fail(reply, 400, 'VALIDATION_ERROR', 'وضعیت کاربر معتبر نیست.');
  const id = (request.params as { id: string }).id; if (id === request.actor.id && !p.data.isActive) return fail(reply, 400, 'SELF_DEACTIVATION', 'غیرفعال‌کردن حساب خودتان مجاز نیست.');
  const target = await prisma.user.findUnique({ where: { id }, include: { sites: true } }); if (!target) return fail(reply, 404, 'NOT_FOUND', 'کاربر یافت نشد.');
  if (request.actor.role !== 'SUPER_ADMIN' && (target.role !== 'EMPLOYEE' || target.sites.length === 0 || !target.sites.every(s => request.actor.sites.some(a => a.siteId === s.siteId)))) return fail(reply, 403, 'SITE_FORBIDDEN', 'مدیر اتاق فقط می‌تواند حساب کارکنان شعب تحت دسترسی خود را مدیریت کند.');
  await prisma.user.update({ where: { id }, data: { isActive: p.data.isActive, sessionVersion: { increment: 1 } } }); await audit(request.actor.id, 'UPDATE', 'User', id, undefined, { isActive: p.data.isActive }, request); return { success: true };
});

// QR payloads are short-lived, signed, and bound to an approved reservation.
app.post('/api/v1/reservations/:id/qr', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  const secret = process.env.QR_HMAC_SECRET;
  if (!secret || secret.length < 32) return fail(reply, 503, 'QR_UNAVAILABLE', 'سرویس QR به‌درستی پیکربندی نشده است.');
  const id = (request.params as { id: string }).id; const reservation = await prisma.reservation.findUnique({ where: { id }, include: { user: { select: { department: true } } } });
  if (!reservation) return fail(reply, 404, 'RESERVATION_NOT_FOUND', 'رزرو تأییدشده یافت نشد.');
  // Authorize before exposing whether a reservation has already been checked in.
  if (reservation.userId !== request.actor.id && !isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز دریافت QR را ندارید.');
  if (request.actor.role === 'DEPT_MANAGER' && reservation.user.department !== request.actor.department) return fail(reply, 403, 'DEPARTMENT_FORBIDDEN', 'این رزرو متعلق به واحد سازمانی شما نیست.');
  if (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === reservation.siteId)) return fail(reply, 403, 'SITE_FORBIDDEN', 'به این محل دسترسی ندارید.');
  if (reservation.status !== 'APPROVED') return fail(reply, 404, 'RESERVATION_NOT_FOUND', 'رزرو تأییدشده یافت نشد.');
  if (await prisma.qrCheckIn.findUnique({ where: { reservationId: reservation.id } })) return fail(reply, 409, 'ALREADY_CHECKED_IN', 'ورود این جلسه قبلاً ثبت شده است.');
  const exp = Math.floor(Date.now() / 1000) + 300; const payload = Buffer.from(JSON.stringify({ rid: reservation.id, exp, nonce: randomUUID() })).toString('base64url'); const sig = createHmac('sha256', secret).update(payload).digest('base64url'); return { token: `PSKQR1.${payload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
});
app.post('/api/v1/qr/verify', { preHandler: [authenticate] }, async (request: AuthRequest, reply) => {
  if (!isManager(request.actor.role)) return fail(reply, 403, 'FORBIDDEN', 'مجوز بررسی QR را ندارید.');
  const p = z.object({ token: z.string().min(20).max(2000) }).safeParse(request.body); if (!p.success) return fail(reply, 400, 'INVALID_QR', 'کد QR معتبر نیست.');
  const secret = process.env.QR_HMAC_SECRET; if (!secret || secret.length < 32) return fail(reply, 503, 'QR_UNAVAILABLE', 'سرویس QR پیکربندی نشده است.');
  const parts = p.data.token.split('.'); if (parts.length !== 3 || parts[0] !== 'PSKQR1') return fail(reply, 400, 'INVALID_QR', 'ساختار QR معتبر نیست.');
  const expected = createHmac('sha256', secret).update(parts[1]!).digest(); let supplied: Buffer; try { supplied = Buffer.from(parts[2]!, 'base64url'); } catch { return fail(reply, 400, 'INVALID_QR', 'امضای QR معتبر نیست.'); }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return fail(reply, 400, 'INVALID_QR', 'امضای QR معتبر نیست.');
  let payload: { rid: string; exp: number }; try { payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); } catch { return fail(reply, 400, 'INVALID_QR', 'محتوای QR معتبر نیست.'); }
  if (!payload.rid || !Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return fail(reply, 400, 'QR_EXPIRED', 'اعتبار QR به پایان رسیده است.');
  const reservation = await prisma.reservation.findUnique({ where: { id: payload.rid }, include: { room: true, user: { select: { department: true } } } });
  if (!reservation || reservation.status !== 'APPROVED' || (request.actor.role !== 'SUPER_ADMIN' && !request.actor.sites.some(s => s.siteId === reservation.siteId))) return fail(reply, 404, 'RESERVATION_NOT_FOUND', 'رزرو معتبر در دسترس نیست.');
  if (request.actor.role === 'DEPT_MANAGER' && reservation.user.department !== request.actor.department) return fail(reply, 403, 'DEPARTMENT_FORBIDDEN', 'این رزرو متعلق به واحد سازمانی شما نیست.');
  const now = Date.now(); if (now < reservation.startsAt.getTime() - 30 * 60000 || now > reservation.endsAt.getTime() + 30 * 60000) return fail(reply, 400, 'QR_OUTSIDE_TIME_WINDOW', 'زمان ثبت ورود این جلسه هنوز نرسیده یا به پایان رسیده است.');
  const nonce = (payload as { nonce?: string }).nonce;
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 100) return fail(reply, 400, 'INVALID_QR', 'شناسه یک‌بارمصرف QR معتبر نیست.');
  try {
    await prisma.$transaction(async tx => {
      await tx.qrCheckIn.create({ data: { reservationId: reservation.id, nonce, checkedById: request.actor.id } });
      await tx.auditLog.create({ data: { actorId: request.actor.id, action: 'UPDATE', entityType: 'ReservationCheckIn', entityId: reservation.id, siteId: reservation.siteId, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
    });
  } catch (e: unknown) { const err = e as { code?: string }; if (err.code === 'P2002') return fail(reply, 409, 'ALREADY_CHECKED_IN', 'ورود این جلسه قبلاً ثبت شده است.'); throw e; }
  return { valid: true, checkedIn: true, reservation: { id: reservation.id, title: reservation.title, startsAt: reservation.startsAt, endsAt: reservation.endsAt, room: reservation.room.name } };
});

app.setErrorHandler((error, request, reply) => { request.log.error({ err: error }, 'Unhandled request error'); reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'خطای داخلی سامانه رخ داد.', requestId: request.id } }); });
const port = Number(process.env.API_PORT ?? 3000);
try { await app.listen({ port, host: '0.0.0.0' }); } catch (err) { app.log.error(err); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await app.close(); await prisma.$disconnect(); process.exit(0); });
