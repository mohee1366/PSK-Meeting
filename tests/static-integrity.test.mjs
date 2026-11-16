import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const get = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('production API keeps Prisma CLI available for runtime migrations', async () => {
  const pkg = JSON.parse(await get('apps/api/package.json'));
  assert.ok(pkg.dependencies.prisma, 'Prisma CLI must be a production dependency because container startup runs migrate deploy');
  assert.equal(pkg.scripts['db:migrate'], 'prisma migrate deploy');
});

test('production secrets are validated before the API starts', async () => {
  const api = await get('apps/api/src/server.ts');
  assert.match(api, /Production QR_HMAC_SECRET must be a unique random secret/);
  assert.match(api, /SMS_ENABLED requires a unique OTP_HMAC_SECRET/);
  assert.match(api, /KAVENEGAR_API_KEY/);
});

test('expired login lockout resets the failure window', async () => {
  const api = await get('apps/api/src/server.ts');
  assert.match(api, /Expired lockouts start a fresh failure window/);
  assert.match(api, /failedLoginCount: 0, lockedUntil: null/);
});

test('web and mobile logout revoke server sessions', async () => {
  const web = await get('apps/web/src/main.tsx');
  const mobile = await get('apps/mobile/app/index.tsx');
  assert.match(web, /api\/v1\/auth\/logout/);
  assert.match(mobile, /api\/v1\/auth\/logout/);
});

test('reservation exclusion constraint exists in the initial migration', async () => {
  const migration = await get('apps/api/prisma/migrations/0001_init/migration.sql');
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  assert.match(migration, /EXCLUDE USING gist/);
  assert.match(migration, /tsrange\("startsAt","endsAt",'\[\)'\)/);
});

test('schema additions have matching migrations', async () => {
  const schema = await get('apps/api/prisma/schema.prisma');
  const migration4 = await get('apps/api/prisma/migrations/0004_login_lockout/migration.sql');
  const migration5 = await get('apps/api/prisma/migrations/0005_password_reset_otp/migration.sql');
  assert.match(schema, /failedLoginCount\s+Int/);
  assert.match(schema, /lockedUntil\s+DateTime\?/);
  assert.match(migration4, /"failedLoginCount"/);
  assert.match(migration4, /"lockedUntil"/);
  assert.match(schema, /model PasswordResetOtp/);
  assert.match(migration5, /CREATE TABLE "PasswordResetOtp"/);
});

test('PWA cleanup only removes this product cache namespace', async () => {
  const sw = await get('apps/web/public/sw.js');
  assert.match(sw, /key\.startsWith\('psk-meeting-'\)/);
});

test('no default real-user seed is included', async () => {
  const seed = await get('apps/api/src/seed-foundation.ts');
  assert.match(seed, /No users or reservations were created/);
  assert.doesNotMatch(seed, /passwordHash|employeeCode/);
});


test('room administrators cannot grant elevated roles or manage other administrators', async () => {
  const api = await get('apps/api/src/server.ts');
  assert.match(api, /مدیر اتاق فقط می‌تواند کارمند در شعب تحت دسترسی خود ایجاد کند/);
  assert.match(api, /target\.role !== 'EMPLOYEE' \|\| target\.sites\.length === 0/);
});

test('QR issuance authorizes the actor before revealing check-in state', async () => {
  const api = await get('apps/api/src/server.ts');
  const route = api.slice(api.indexOf("app.post('/api/v1/reservations/:id/qr'"), api.indexOf("app.post('/api/v1/qr/verify'"));
  assert.ok(route.indexOf('مجوز دریافت QR را ندارید') < route.indexOf('ALREADY_CHECKED_IN'));
});


test('API responses are marked non-cacheable', async () => {
  const api = await get('apps/api/src/server.ts');
  assert.match(api, /Cache-Control', 'no-store'/);
  assert.match(api, /Pragma', 'no-cache'/);
});

test('mobile build fails visibly when its public API URL is not configured', async () => {
  const mobile = await get('apps/mobile/app/index.tsx');
  assert.match(mobile, /EXPO_PUBLIC_API_URL/);
  assert.match(mobile, /نشانی سرویس سازمانی در نسخه موبایل تنظیم نشده است/);
});


test('production rejects placeholder cryptographic secrets', async () => {
  const api = await get('apps/api/src/server.ts');
  assert.match(api, /isPlaceholderSecret/);
  assert.match(api, /Production JWT_SECRET must be a unique random secret/);
  assert.match(api, /Production QR_HMAC_SECRET must be a unique random secret/);
  assert.match(api, /unique OTP_HMAC_SECRET/);
});


test('service request transitions are compare-and-set and audit atomically', async () => {
  const api = await get('apps/api/src/server.ts');
  const route = api.slice(api.indexOf("app.patch('/api/v1/service-requests/:id/status'"), api.indexOf('const importRowSchema'));
  assert.match(route, /serviceRequest\.updateMany\(\{ where: \{ id, status: item\.status \}/);
  assert.match(route, /tx\.auditLog\.create/);
  assert.match(route, /وضعیت درخواست هم‌زمان تغییر کرده است/);
});

test('QR check-in requires a nonce and persists check-in plus audit in one transaction', async () => {
  const api = await get('apps/api/src/server.ts');
  const route = api.slice(api.indexOf("app.post('/api/v1/qr/verify'"), api.indexOf('app.setErrorHandler'));
  assert.match(route, /typeof nonce !== 'string' \|\| nonce\.length < 16/);
  assert.match(route, /prisma\.\$transaction\(async tx/);
  assert.match(route, /tx\.qrCheckIn\.create/);
  assert.match(route, /tx\.auditLog\.create/);
});

test('all migration directories have a lock file and sequential numbering', async () => {
  const { readdir } = await import('node:fs/promises');
  const dirs = await readdir(new URL('../apps/api/prisma/migrations/', import.meta.url), { withFileTypes: true });
  const names = dirs.filter(x => x.isDirectory()).map(x => x.name).sort();
  assert.deepEqual(names, ['0001_init','0002_service_requests','0003_qr_checkin','0004_login_lockout','0005_password_reset_otp']);
  assert.ok((await get('apps/api/prisma/migrations/migration_lock.toml')).includes('provider = "postgresql"'));
});


test('reservation decisions commit state and audit atomically before SMS notification', async () => {
  const api = await get('apps/api/src/server.ts');
  const start = api.indexOf("app.patch('/api/v1/reservations/:id/decision'");
  const end = api.indexOf("app.patch('/api/v1/reservations/:id/complete'");
  const route = api.slice(start, end);
  assert.match(route, /prisma\.\$transaction\(async tx/);
  assert.match(route, /tx\.reservation\.updateMany/);
  assert.match(route, /tx\.auditLog\.create/);
  assert.ok(route.indexOf('notifyUserBySms') > route.indexOf('prisma.$transaction'));
});

test('reservation completion and cancellation use compare-and-set with transactional audit', async () => {
  const api = await get('apps/api/src/server.ts');
  const complete = api.slice(api.indexOf("app.patch('/api/v1/reservations/:id/complete'"), api.indexOf("app.post('/api/v1/reservations/:id/cancel'"));
  const cancel = api.slice(api.indexOf("app.post('/api/v1/reservations/:id/cancel'"), api.indexOf("app.get('/api/v1/reports/usage'"));
  for (const route of [complete, cancel]) {
    assert.match(route, /prisma\.\$transaction\(async tx/);
    assert.match(route, /tx\.reservation\.updateMany/);
    assert.match(route, /tx\.auditLog\.create/);
    assert.match(route, /if \(!updated\) return fail\(reply, 409/);
  }
});


test('workspace and native app versions are synchronized', async () => {
  const rootPkg = JSON.parse(await get('package.json'));
  const app = JSON.parse(await get('apps/mobile/app.json'));
  assert.equal(rootPkg.version, '0.3.0');
  assert.equal(app.expo.version, rootPkg.version);
  for (const name of ['@psk/api','@psk/web','@psk/mobile','@psk/website','@psk/contracts']) {
    const candidates = ['apps/api/package.json','apps/web/package.json','apps/mobile/package.json','apps/website/package.json','packages/contracts/package.json'];
    const found = await Promise.all(candidates.map(async f => JSON.parse(await get(f))));
    assert.equal(found.find(x => x.name === name)?.version, rootPkg.version, `${name} version mismatch`);
  }
});

test('CI workflow validates schema and applies migrations on PostgreSQL before build', async () => {
  const ci = await get('.github/workflows/ci.yml');
  assert.match(ci, /postgres:16/);
  assert.match(ci, /prisma validate/);
  assert.match(ci, /pnpm db:migrate/);
  assert.match(ci, /pnpm typecheck/);
  assert.match(ci, /pnpm build/);
  assert.match(ci, /pnpm test:static/);
  assert.match(ci, /SMS_ENABLED: "false"/);
});


test('employee import template is an actual XLSX file served by the web application', async () => {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(new URL('../apps/web/public/templates/PSK_Employee_Import_Template.xlsx', import.meta.url));
  assert.equal(bytes.subarray(0, 2).toString('hex'), '504b');
  const web = await get('apps/web/src/main.tsx');
  assert.match(web, /PSK_Employee_Import_Template\.xlsx/);
  assert.match(web, /accept="\.xlsx"/);
});

test('employee import help uses the canonical Tehran and Kashan site codes', async () => {
  const web = await get('apps/web/src/main.tsx');
  assert.match(web, /PSK-THR/);
  assert.match(web, /PSK-KSH/);
  assert.match(web, /employeeCode/);
  assert.match(web, /siteCodes/);
});

test('employee import API limits batch size and creates employee-only accounts with mandatory password change', async () => {
  const api = await get('apps/api/src/server.ts');
  const route = api.slice(api.indexOf("app.post('/api/v1/admin/users/import/commit'"), api.indexOf("app.get('/api/v1/admin/users'"));
  assert.match(route, /data\.rows\.length > 500/);
  assert.match(route, /role: 'EMPLOYEE'/);
  assert.match(route, /mustChangePassword: true/);
  assert.match(route, /tx\.auditLog\.create/);
  assert.match(route, /Cache-Control', 'no-store'/);
});


test('Android preview profile is configured to produce an APK and CI build requires EAS credentials', async () => {
  const eas = JSON.parse(await get('apps/mobile/eas.json'));
  assert.equal(eas.build.preview.distribution, 'internal');
  assert.equal(eas.build.preview.android.buildType, 'apk');
  const workflow = await get('.github/workflows/android-apk.yml');
  assert.match(workflow, /EXPO_TOKEN/);
  assert.match(workflow, /EXPO_PROJECT_ID/);
  assert.match(workflow, /--platform android --profile preview/);
  assert.match(workflow, /--wait/);
});


test('mobile app defaults to an offline demo with sample rooms and no production dependency', async () => {
  const mobile = await get('apps/mobile/app/index.tsx');
  assert.match(mobile, /EXPO_PUBLIC_DEMO_MODE!=='false'/);
  assert.match(mobile, /PSK-THR-101/);
  assert.match(mobile, /PSK-KSH-201/);
  assert.match(mobile, /psk-demo-session/);
  assert.match(mobile, /PSK-DEMO-QR-2026/);
});
