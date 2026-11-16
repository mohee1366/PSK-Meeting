# PSK Meeting Enterprise — v0.3.0

**نسخه سورس: 0.3.0 — آماده‌سازی ورود کارکنان و APK**

سامانه یکپارچه مدیریت اتاق‌های جلسات شرکت پاک سیمین کویر؛ شامل وب‌اپلیکیشن/PWA، اپلیکیشن Android و iOS، API مرکزی و PostgreSQL.

> **وضعیت انتشار:** این مخزن یک نسخه توسعه‌یافته و قابل ادامه است، اما هنوز Build واقعی، تست اتصال به PostgreSQL، آزمون بار، تست نفوذ مستقل، ساخت APK/AAB/IPA و استقرار سازمانی روی سرور PSK در این محیط اجرا نشده‌اند. آن را تا عبور از چک‌لیست Go-Live به‌عنوان سامانه عملیاتی استفاده نکنید.

## دامنه و داده‌های مبنا

- محل‌ها: تهران و کاشان.
- اتاق‌ها: `PSK-THR-101`، `PSK-THR-102`، `PSK-THR-103`، `PSK-KSH-201`، `PSK-KSH-202`.
- ظرفیت‌های مبنا: ۱۶، ۱۲، ۶، ۱۰ و ۸ نفر.
- حدود ۴۲۰ رکورد کاربری در سوابق پروژه گزارش شده است؛ واقعی/فعال بودن تک‌تک رکوردها اثبات نشده و هیچ کارمند واقعی در Seed ایجاد نمی‌شود.
- نقش‌ها: `SUPER_ADMIN`، `ROOM_ADMIN`، `DEPT_MANAGER`، `EMPLOYEE`.

## معماری

- Monorepo: pnpm workspaces.
- API: Node.js 22، TypeScript، Fastify، Zod، JWT و Prisma.
- Database: PostgreSQL 16؛ قیود SQL برای جلوگیری از رزرو هم‌پوشان.
- Web/PWA: React 19، TypeScript، Vite، RTL فارسی.
- Mobile: React Native، Expo Router، SecureStore، Camera و QR code.
- Deployment: Docker Compose و Nginx reverse proxy.

## قابلیت‌های موجود در سورس این نسخه

- ورود با کد پرسنلی، ایمیل یا موبایل؛ نشست JWT هشت‌ساعته، قفل موقت پس از پنج تلاش ناموفق و ابطال نشست با `sessionVersion`.
- بازیابی رمز با OTP پیامکی HMAC‌شده، انقضای ۱۰ دقیقه‌ای، حداکثر پنج تلاش و مصرف یک‌باره (فعال‌سازی وابسته به پیکربندی Kavenegar).
- الزام تغییر رمز موقت در اولین ورود؛ سیاست رمز قوی.
- کنترل نقش، شعبه و واحد سازمانی در مسیرهای API اصلی.
- فهرست سایت‌ها و اتاق‌ها، رزرو، تأیید/رد، لغو و تکمیل.
- جلوگیری از رزرو هم‌پوشان در سطح PostgreSQL با Exclusion Constraint.
- ثبت رویدادهای حساس در Audit Log.
- درخواست خدمات پذیرایی، نظافت و تعمیر و نگهداری.
- QR امضاشده با HMAC، اعتبار پنج‌دقیقه‌ای، محدودیت زمانی جلسه و ثبت Check-in یک‌باره.
- ورود گروهی Excel تا ۵۰۰ ردیف با Preview، اعتبارسنجی کد شعبه، کنترل تکراری‌ها و Commit تراکنشی.
- گزارش استفاده اتاق‌ها و خروجی CSV با خنثی‌سازی Formula Injection.
- اتصال اختیاری Kavenegar؛ ارسال پیامک به‌صورت پیش‌فرض غیرفعال است.
- وب‌اپ نصب‌شدنی PWA و اپ موبایل با ذخیره امن توکن در SecureStore.

## اجرای محلی

نیازمندی‌ها: Node.js 22، pnpm 10، Docker و Docker Compose.

```bash
cp .env.example .env
# برای POSTGRES_PASSWORD، JWT_SECRET، QR_HMAC_SECRET و OTP_HMAC_SECRET چهار مقدار مستقل بسازید:
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32

docker compose up -d postgres
corepack enable
pnpm install
pnpm db:generate
pnpm --filter @psk/api build
pnpm db:migrate
pnpm db:seed-foundation
pnpm dev
```

- وب‌اپ: `http://localhost:5173`
- وب‌سایت معرفی: `http://localhost:5174`
- API: `http://localhost:3000`
- Health: `http://localhost:3000/health`

در اجرای محلی، `VITE_API_URL=http://localhost:3000` را در `apps/web/.env.local` و `VITE_APP_URL=http://localhost:5173` را در `apps/website/.env.local` قرار دهید. برای اپ موبایل روی دستگاه واقعی، `EXPO_PUBLIC_API_URL` را در `apps/mobile/.env` روی آدرس قابل دسترس وب‌اپ/API قرار دهید؛ `localhost` روی گوشی به خود گوشی اشاره می‌کند، نه کامپیوتر توسعه‌دهنده.

## راه‌اندازی Docker

1. `.env` را بسازید و مقادیر امن واقعی وارد کنید. از رمزهای نمونه استفاده نکنید.
2. دامنه عمومی و `WEB_ORIGIN` را تنظیم کنید.
3. اجرا:

```bash
docker compose up -d --build
```

4. داده مرجع پنج اتاق و دو سایت (بدون کاربر) را ایجاد کنید:

```bash
docker compose run --rm api pnpm --filter @psk/api seed:foundation
```

5. مدیر کل اولیه را به‌صورت دستی بسازید:

```bash
docker compose run --rm api pnpm --filter @psk/api seed:admin -- "مدیر سامانه" admin@your-company.example
```

اسکریپت رمز تصادفی یک‌بارمصرف تولید می‌کند. آن را فقط از خروجی امن ترمینال دریافت و در اولین ورود تغییر دهید. حساب پیش‌فرض یا رمز ثابت در سورس وجود ندارد.

### TLS و شبکه

Compose وب‌اپ را روی پورت ۸۰۸۰ و وب‌سایت معرفی را روی پورت ۸۰۸۱ ارائه می‌کند. پیش از بهره‌برداری، آن را پشت Reverse Proxy سازمانی با TLS 1.2+، گواهی معتبر، محدودیت دسترسی شبکه، HSTS و سیاست فایروال قرار دهید. پورت PostgreSQL را به اینترنت منتشر نکنید. API از طریق Nginx وب با مسیر `/api/` پراکسی می‌شود.

## ساخت اپلیکیشن موبایل

برای ساخت، حساب Expo/EAS و تنظیم شناسه‌های Bundle/Package متعلق به سازمان لازم است. آدرس API باید در متغیر محیطی EAS با نام `EXPO_PUBLIC_API_URL` تنظیم شود.

```bash
corepack enable
pnpm install
pnpm --filter @psk/mobile start

# Android APK برای توزیع داخلی
npx eas build --platform android --profile preview

# Android AAB برای انتشار فروشگاهی
npx eas build --platform android --profile production

# iOS؛ نیازمند Apple Developer و اعتبارنامه امضای معتبر
npx eas build --platform ios --profile production
```

فایل IPA به‌صورت خروجی سرویس EAS و با امضای معتبر اپل ساخته می‌شود؛ ساخت/انتشار iOS بدون حساب Apple Developer ممکن نیست.

## ورود گروهی کارکنان

- ابتدا `seed:foundation` اجرا شود تا کدهای `PSK-THR` و `PSK-KSH` موجود باشند.
- فایل `.xlsx` باید ستون‌های انگلیسی زیر را داشته باشد؛ فایل‌های دارای فرمول در سلول‌های داده رد می‌شوند:
  - `employeeCode` (اجباری)
  - `fullName` (اجباری)
  - `mobile` (اختیاری)
  - `email` (اختیاری)
  - `department` (اختیاری)
  - `siteCodes` (اجباری؛ یک یا چند کد با کاما/نقطه‌ویرگول جدا شوند)
- حداکثر ۵۰۰ ردیف و ۴ مگابایت. ستون‌های `employeeCode` و `mobile` را در Excel از نوع Text تنظیم کنید تا صفر ابتدایی حذف نشود.
- Preview هیچ داده‌ای ایجاد نمی‌کند. Commit فقط وقتی فعال است که تمام ردیف‌ها معتبر باشند.
- Commit تراکنشی است؛ رمزهای موقت فقط یک بار در پاسخ بازگردانده می‌شوند و باید در محل امن نگهداری شوند. کاربران در اولین ورود مجبور به تغییر رمز هستند.
- اجرای واقعی Import روی اطلاعات کارکنان نیازمند تأیید سازمانی و تطبیق فایل با فهرست منابع انسانی است؛ هیچ فایل یا داده کارکنان در این مخزن گنجانده نشده است.

## پیامک Kavenegar

در `.env`، `SMS_ENABLED=false` باقی بماند تا زمانی که سازمان کلید API، خط ارسال، الگوی پیام و سیاست رضایت/اطلاع‌رسانی را تأیید کند. برای فعال‌سازی، `SMS_ENABLED=true` و `KAVENEGAR_API_KEY` و در صورت نیاز `KAVENEGAR_SENDER` را تنظیم کنید. هیچ پیامک تستی در فرایند Build یا Seed ارسال نمی‌شود.

## پشتیبان‌گیری و بازیابی

```bash
./scripts/backup-db.sh
# بازیابی فقط پس از تأیید مقصد و بررسی فایل:
CONFIRM_RESTORE=YES ./scripts/restore-db.sh backups/psk_meeting_YYYYMMDDTHHMMSSZ.dump
```

پیش از هر Migration و به‌صورت روزانه از PostgreSQL نسخه پشتیبان تهیه کنید. فایل پشتیبان باید رمزگذاری شده، خارج از سرور اصلی نگهداری و بازیابی آن در محیط جداگانه تمرین شود. از پشتیبان‌گیری تنها به‌عنوان موفقیت بازیابی یاد نکنید؛ آزمون Restore الزامی است.

## کنترل‌های قبل از بهره‌برداری

- [ ] Build و typecheck همه workspaceها در CI سبز باشد.
- [ ] Migration روی دیتابیس خالی و نسخه آزمایشی کپی‌شده با موفقیت اجرا شود.
- [ ] آزمون هم‌زمانی رزرو و Exclusion Constraint با PostgreSQL واقعی.
- [ ] آزمون دسترسی بین شعب و بین واحدها برای تمام endpointها.
- [ ] آزمون OTP/بازیابی رمز و محدودیت تلاش ورود (در فاز بعدی تکمیل شود).
- [ ] تست QR منقضی، امضای جعلی، تکرار اسکن و بازه زمانی خارج از جلسه.
- [ ] تست Excel با داده تکراری، ردیف خراب، فرمول مخرب و فایل حجیم.
- [ ] تست پیامک فقط با Mock؛ پیامک واقعی پس از تأیید و در محیط عملیاتی.
- [ ] آزمون بار متناسب با ۴۰۰ کاربر هم‌زمان/دوره اوج، پایش DB و ظرفیت سرور.
- [ ] Restore پشتیبان و تأیید RPO/RTO.
- [ ] بررسی امنیت مستقل و تأیید کتبی Go-Live.

## دستورات بررسی

```bash
pnpm typecheck
pnpm build
pnpm db:generate
pnpm db:migrate
```

در محیط فعلی به‌دلیل نبود دسترسی شبکه برای دریافت وابستگی‌ها، نصب pnpm packages و اجرای Build/Prisma/DB واقعی انجام نشده است. آزمون‌های ایستای داخلی (`pnpm test:static`) قابل اجرا بدون وابستگی و در این تحویل سبز هستند. فایل‌های سورس از نظر نحو TypeScript/TSX با transpile checker بررسی شده‌اند؛ این بررسی جایگزین typecheck و تست واقعی نیست.
