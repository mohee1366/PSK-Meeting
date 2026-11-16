# راهنمای اجرای فوری PSK Meeting برای تحویل ۴۸ ساعته

## A) آماده‌سازی سرور
پیش‌نیاز: سرور Linux با Docker Engine و Docker Compose، دامنه سازمانی و امکان صدور TLS certificate.

1. ZIP سورس نسخه 0.3.0 را روی سرور استخراج کنید.
2. از `.env.example` یک `.env` بسازید.
3. رمزهای مستقل و تصادفی تولید کنید؛ نمونه روی Linux:
   - `openssl rand -hex 32` برای `POSTGRES_PASSWORD`
   - سه مقدار مستقل دیگر برای `JWT_SECRET`، `QR_HMAC_SECRET` و `OTP_HMAC_SECRET`
4. `WEB_ORIGIN` و `APP_PUBLIC_URL` را با origin واقعی وب‌اپ جایگزین کنید.
5. `EXPO_PUBLIC_API_URL` را فقط origin عمومی HTTPS API/وب‌اپ قرار دهید؛ مسیر `/api` را به انتهای آن اضافه نکنید.
6. `SMS_ENABLED=false` باقی بماند تا اعتبار Kavenegar و مجوز ارسال تأیید شود.
7. اجرا:
   ```bash
   docker compose up -d --build
   docker compose ps
   ```
8. سلامت API:
   ```bash
   curl -fsS https://YOUR_DOMAIN/health/ready
   ```
   باید وضعیت ready و database connected برگردد. TLS باید توسط reverse proxy سازمانی جلوی سرویس وب برقرار شود.

## B) ایجاد شعب و اتاق‌ها
پس از آماده‌شدن API و دیتابیس:
```bash
docker compose exec api pnpm --filter @psk/api seed:foundation
```
این دستور فقط دو شعبه و پنج اتاق مبنا را upsert می‌کند؛ کاربر یا رزروی نمی‌سازد.

## C) ایجاد مدیر کل اولیه
با ایمیل سازمانی مورد تأیید:
```bash
docker compose exec api pnpm --filter @psk/api seed:admin -- "نام مدیر سامانه" admin@YOUR_COMPANY_DOMAIN
```
رمز یک‌بارمصرف در خروجی ترمینال نمایش داده می‌شود. آن را در کانال امن تحویل دهید. در اولین ورود تغییر رمز اجباری است. خروجی ترمینال را در لاگ عمومی ذخیره نکنید.

## D) ورود کارکنان
1. مدیر کل در `https://YOUR_DOMAIN` وارد شود.
2. منوی «کاربران و دسترسی‌ها» را باز کند.
3. قالب `PSK_Employee_Import_Template.xlsx` را دانلود کند.
4. ستون‌ها را طبق برگه راهنما تکمیل کند.
5. فایل را انتخاب و «بررسی و پیش‌نمایش» را اجرا کند.
6. همه خطاها را اصلاح و Preview تازه بگیرد.
7. فقط پس از نمایش صفر خطا، Commit را اجرا کند.
8. فایل رمزهای موقت را امن نگه دارد و به هر کارمند از مسیر مورد تأیید سازمان تحویل دهد.
9. کارکنان در اولین ورود باید رمز خود را تغییر دهند.

## E) ساخت APK
پروفایل APK در `apps/mobile/eas.json` با نام `preview` آماده است.
برای EAS Build باید حساب سازمانی Expo/EAS و پروژه متصل باشد:
- `EXPO_TOKEN` را به‌صورت GitHub Repository Secret ثبت کنید.
- `EXPO_PROJECT_ID` را به‌صورت GitHub Repository Secret ثبت کنید.
- `EXPO_PUBLIC_API_URL` را به‌صورت GitHub Repository Variable و با HTTPS ثبت کنید.
- در GitHub Actions، workflow با نام `Build PSK Meeting Android APK` را اجرا کنید.
- خروجی EAS پس از اتمام Build لینک APK می‌دهد.

اگر مخزن GitHub هنوز ایجاد نشده، سورس را در یک مخزن خصوصی قرار دهید؛ فایل `.env` و رمزها را هرگز commit نکنید.

## F) کنترل‌های حیاتی
- ابتدا در staging، با 1 تا 2 حساب آزمایشی مورد تأیید سازمان، ورود و تغییر رمز را بررسی کنید.
- از دیتابیس قبل از import پشتیبان بگیرید و بازیابی آن را آزمایش کنید.
- فایل اصلی منابع انسانی باید از مرجع رسمی گرفته شود؛ تعداد تقریبی 420 رکورد قدیمی مبنای ورود نیست.
- Import فعلی فقط حساب جدید ایجاد می‌کند؛ اطلاعات موجود را update نمی‌کند.
- SMS واقعی تا تأیید سازمانی خاموش بماند.
- APK بدون نشانی HTTPS API صحیح، به سرویس واقعی متصل نمی‌شود.
