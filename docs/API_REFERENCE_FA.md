# مرجع API سامانه PSK Meeting

پیشوند همه مسیرهای نسخه اول: `/api/v1`. به‌جز ورود و درخواست/تأیید بازیابی رمز، مسیرها نیازمند `Authorization: Bearer <accessToken>` هستند.

## سلامت سرویس

| Method | Path | توضیح |
|---|---|---|
| GET | `/health` | زنده بودن پردازش API |
| GET | `/health/ready` | آمادگی API و اتصال PostgreSQL |

## احراز هویت و رمز

| Method | Path | توضیح |
|---|---|---|
| POST | `/auth/login` | ورود با employeeCode/email/mobile و password |
| GET | `/auth/me` | اطلاعات حساب جاری و شعب مجاز |
| POST | `/auth/change-password` | تغییر رمز در نشست معتبر؛ ابطال نشست‌های قبلی |
| POST | `/auth/logout` | ابطال همه نشست‌های کاربر با افزایش sessionVersion |
| POST | `/auth/password-reset/request` | درخواست OTP پیامکی؛ پاسخ عمومی ضد user-enumeration |
| POST | `/auth/password-reset/confirm` | تأیید OTP و تغییر رمز |

سیاست OTP: کد شش‌رقمی، HMAC-SHA256، اعتبار ۱۰ دقیقه، حداکثر ۵ تلاش، محدودیت درخواست مجدد ۶۰ ثانیه و rate limit مبتنی بر IP. OTP فقط با `SMS_ENABLED=true` و پیکربندی Kavenegar و `OTP_HMAC_SECRET` فعال است.

## سایت، اتاق و رزرو

| Method | Path | توضیح |
|---|---|---|
| GET | `/sites` | سایت‌های فعال و مجاز |
| GET | `/rooms` | اتاق‌های فعال در سایت‌های مجاز |
| POST | `/rooms` | ایجاد اتاق توسط SUPER_ADMIN/ROOM_ADMIN |
| GET | `/reservations` | رزروهای قابل مشاهده با فیلتر نقش/سایت/واحد |
| POST | `/reservations` | ثبت رزرو در وضعیت PENDING |
| PATCH | `/reservations/:id/decision` | تأیید یا رد رزرو در انتظار |
| POST | `/reservations/:id/cancel` | لغو رزرو پیش از شروع جلسه |
| PATCH | `/reservations/:id/complete` | تکمیل جلسه تأییدشده پس از پایان |
| POST | `/reservations/:id/qr` | تولید QR امضاشده پنج‌دقیقه‌ای برای رزرو تأییدشده |
| POST | `/qr/verify` | اعتبارسنجی و ثبت check-in یک‌باره توسط مدیر مجاز |

محدودیت تداخل در PostgreSQL با Exclusion Constraint اعمال می‌شود؛ کنترل رابط کاربری به‌تنهایی مرجع جلوگیری از هم‌پوشانی نیست.

## خدمات، گزارش و مدیریت

| Method | Path | توضیح |
|---|---|---|
| POST | `/service-requests` | ثبت درخواست CATERING/CLEANING/MAINTENANCE/OTHER |
| GET | `/service-requests` | مشاهده درخواست‌های مجاز |
| PATCH | `/service-requests/:id/status` | گردش‌کار OPEN → IN_PROGRESS → DONE یا REJECTED |
| GET | `/dashboard/summary` | شاخص‌های پایه داشبورد |
| GET | `/reports/usage` | گزارش استفاده از اتاق‌ها در بازه حداکثر یک‌ساله |
| GET | `/reports/reservations.csv` | خروجی CSV با خنثی‌سازی فرمول‌های Excel |
| GET | `/admin/users` | فهرست کاربران برای مدیر مجاز |
| POST | `/admin/users` | ایجاد حساب و تولید رمز موقت یک‌بارنمایش |
| POST | `/admin/users/:id/reset-password` | تولید رمز موقت و ابطال نشست‌های کاربر |
| PATCH | `/admin/users/:id/status` | فعال/غیرفعال‌سازی با ابطال نشست‌ها |
| GET | `/admin/users/import/template` | قالب و کدهای شعب مجاز |
| POST | `/admin/users/import/preview` | اعتبارسنجی Excel بدون ایجاد رکورد |
| POST | `/admin/users/import/commit` | ورود تراکنشی پس از پیش‌نمایش معتبر |

## قرارداد خطا

پاسخ خطا به شکل زیر است:

```json
{
  "error": {
    "code": "ROOM_TIME_CONFLICT",
    "message": "این اتاق در بازه زمانی انتخاب‌شده رزرو یا در انتظار تأیید است.",
    "requestId": "شناسه درخواست"
  }
}
```

پیام داخلی دیتابیس، stack trace و داده محرمانه در پاسخ عمومی بازگردانده نمی‌شود.
