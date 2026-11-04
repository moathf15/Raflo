# تقرير معالجة نتائج التدقيق الأمني والمنطقي — RIFLO

> **Note (Nov 2026 audit):** the lockout in 3.2 was later changed so a stranger cannot lock an owner out (finding S2). See [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

**المرجع:** RIFLO_Security_Logic_Audit_AR.docx · **تاريخ المعالجة:** 3 نوفمبر 2026

## الخلاصة

- عولجت كل النتائج المثبتة في التقرير (P0 وP1 وأقسام المنطق 5.1–5.7 والإنتاج 6.1–6.4)، ولكل إصلاح اختبار يمنع عودته كما طلب القسم 10.
- **قبل الإصلاح:** كُتبت اختبارات تعيد إنتاج كل مشكلة وشُغّلت على الكود الأصلي ← **18 اختبارًا فشلت**، أي أن المشكلات حقيقية وليست نظرية.
- **بعد الإصلاح:**

| المجموعة | النتيجة |
| --- | --- |
| اختبارات الـ API على PGlite | 58 / 58 ✅ |
| نفس الاختبارات على PostgreSQL 16 حقيقي عبر TLS | 58 / 58 ✅ |
| اختبار النظام الكامل في المتصفح (API + التطبيق + لوحة الإدارة) | 12 / 12 ✅ بلا أي خطأ في الـ console |
| فحص TypeScript للتطبيقات الثلاثة | ✅ |
| `npm audit` لاعتماديات الإنتاج | 0 ثغرات (كانت 7 عالية + 2 متوسطة) |

## 1. النتائج الأمنية (القسم 3)

| البند | المشكلة المثبتة | الإصلاح | الاختبار |
| --- | --- | --- | --- |
| 3.1 عدّ محاولات OTP | المحاولة الفاشلة كانت تُسجَّل داخل Transaction يُلغى، فبعد 5 أخطاء كان الرمز الصحيح ما زال يعمل | تسجيل الفشل خارج الـ Transaction؛ استهلاك الرمز بـ UPDATE مشروط (مرة واحدة حتى مع الطلبات المتزامنة)؛ إصدار رمز جديد يُبطل السابق | keeps failed attempts…، rejects an expired code، rejects a reused code، invalidates the previous code |
| 3.2 التخمين الموزّع | الحد كان لكل IP فقط | حدود لكل بريد: انتظار 60 ث بين الإرسال، 5 رموز/ساعة؛ قفل تدريجي من جدول `auth_failures` (10 ← 15 د، 20 ← ساعة، 30 ← 24 س) حتى من عناوين IP مختلفة؛ تخزين حدود المعدل في Redis عند تعدد الخوادم | limits codes per email…، enforces a resend cooldown، locks an email after 10 failures… |
| 3.3 الرمز في LocalStorage | أي XSS يسرق الجلسة | جلسات في الخادم (جدول `sessions`) وكوكي `HttpOnly; Secure; SameSite=Lax`؛ حماية CSRF بفحص Origin لكل طلب كتابة بالكوكي؛ نقطة `/v1/session` للضيوف | a cookie-authenticated change must come from an allowed origin؛ اختبار المتصفح: «الكوكي HttpOnly وغير مرئي للسكربت» |
| 3.4 نزاهة Passport | زيارات بتاريخ مستقبلي أو لأماكن خارج الرحلة | لا مستقبل (حسب توقيت المدينة)، لا أقدم من 365 يومًا، الرحلة يجب أن تكون للمستخدم والمكان فيها والتاريخ ضمنها؛ حد يومي؛ حقل `source = self_reported` حتى لا تُبنى مكافآت على زيارات غير موثّقة؛ تعديل وحذف الختم | rejects a visit dated in the future، rejects a tripId when the place is not in that trip |
| 3.5 أحداث Analytics | props بلا قيود | قائمة أحداث مسموحة بخصائص صارمة لكل حدث، حد 2KB للطلب، 300 حدث/يوم لكل هوية | rejects oversized props، rejects props that are not on the allowlist، caps events per anonymous id |
| 3.6 حدود البيانات وDoS | لا حدود لعدد الرحلات أو الزيارات | حصص: 30 رحلة/يوم، 200 إجمالًا، 50 زيارة/يوم، 300 في قائمة الأمنيات؛ حد الجسم 64KB؛ مهلات للطلب والاتصال | ضمن اختبارات الحصص والأحداث |
| 3.7 CSP | — | CSP صارم في الـ API (`default-src 'none'`) ووسم CSP مضمّن في بناء التطبيقين | فحص حي للترويسات |
| 3.7 إبطال الجلسات | تسجيل الخروج لا يبطل الرمز | إبطال الجلسة في الخادم، «الخروج من كل الأجهزة»، تعليق المستخدم يبطل جلساته فورًا | sign-out revokes the token on the server، sign out everywhere…، suspending a user signs them out immediately |
| 3.7 أقل صلاحية لقاعدة البيانات | التطبيق يتصل بمستخدم مالك | دوران: `riflo_owner` للترحيل و`riflo_app` للتشغيل (`ops/db/roles.sql`) | تحقق على PostgreSQL حقيقي: `riflo_app` لا يستطيع DDL ولا حذف الجداول ولا تعديل سجل التدقيق |
| 3.7 TLS لقاعدة البيانات | — | TLS مع التحقق من الشهادة إلزامي في الإنتاج، مع ملف CA اختياري | الاتصال بدون TLS مرفوض؛ الجلسات تعمل بـ TLS 1.3 |
| 3.7 حدود الاتصالات والاستعلامات | — | حجم الـ pool، مهلة الاستعلام 5 ث، مهلة الخمول داخل Transaction 15 ث، مهلة القفل 3 ث | استعلام `pg_sleep(10)` يُقطع عند 5 ث |
| 3.7 النسخ الاحتياطي والاستعادة | — | `ops/db/backup.sh` للنسخ والتحقق من الاستعادة في قاعدة فارغة | نُفّذت نسخة واستعادة فعلية ونجح التحقق |
| 3.7 حماية Audit Log | — | Trigger يمنع التعديل والحذف، وسحب صلاحيات UPDATE/DELETE من دور التطبيق | محاولة التعديل والحذف مرفوضة |
| 3.7 تنظيف OTP | تراكم السجلات | مهمة كل ساعة تحذف الرموز المنتهية والمحاولات القديمة والجلسات الميتة | — |
| 3.7 مراجعة الاعتماديات | `npm audit`: 7 عالية + 2 متوسطة في fastify وnodemailer وzod وreact-router | ترقية fastify 5.12.8، nodemailer 10.3.1، zod 4.6.7، react-router-dom 7.18.5 والإضافات المرتبطة | `npm audit`: 0 ثغرات |

## 2. الصلاحيات (القسم 4)

| المطلوب | الإصلاح | الاختبار |
| --- | --- | --- |
| منع ترقية الدور ذاتيًا | `PATCH /v1/me` يقبل الاسم فقط؛ المشرف لا يغيّر حسابه | a user cannot promote themselves through their own profile |
| منع إزالة آخر Admin | Trigger `keep_one_admin` في القاعدة نفسها ← 409 | the last active admin cannot be demoted or suspended |
| فصل editor عن admin واختبار رفض كل المسارات الإدارية | كل مسار إداري يفحص الدور | editors cannot manage users; users and guests cannot reach any admin route، blocks non-staff |

## 3. المنطق البرمجي (القسم 5)

| البند | الإصلاح | الاختبار |
| --- | --- | --- |
| 5.1 Trip Planner | احترام ساعات العمل عند وقت الوصول؛ لا زيارة تنتهي بعد 21:00؛ منع تكرار المكان في اليوم؛ توزيع متوازن بين الاهتمامات؛ مسار أقرب جار + 2-opt؛ ميزانية مفصّلة (دخول، تنقل، أماكن بتكلفة غير معروفة) | waits for opening time…، the generated plan never schedules a place outside its hours، alternates between the chosen interests…، rejects the same place twice in one day |
| 5.2 أوقات الصلاة | حساب فعلي لكل تاريخ بطريقة أم القرى وتوقيت المدينة؛ فاصل الصلاة لا يتداخل مع زيارة إلا داخل المسجد | uses prayer times for each date، never overlaps a prayer break with a visit… |
| 5.3 التواريخ | رفض التواريخ غير الصالحة مثل 2026-02-30 و2026-99-99 بـ 400 بدل 500 | rejects 2026-02-30 and 2026-99-99 with 400، accepts 29 February in a leap year، rejects an invalid visit date with 400, not 500 |
| 5.4 reusedFrom | يجب أن تكون الرحلة الأصلية ملك المستخدم، وإلا 404 | اختبار reusedFrom في audit.test.ts |
| 5.5 الأماكن والبلاغات | النشر لا يغلق البلاغات تلقائيًا؛ دورة بلاغ كاملة (جديد ← قيد المراجعة ← محلول/مرفوض بسبب إلزامي، وإعادة فتح)؛ حد أدنى للنشر (وصف، ساعات، تكلفة، مدة، موقع داخل نطاق المدينة) مع ذكر الناقص؛ مصدر البيانات وتاريخ التحقق؛ صفحة بلاغات في لوحة الإدارة | publishing a place does not silently close its reports، closing a report requires a reason…، a place cannot be published without the minimum data |
| 5.6 Passport | انظر 3.4 | — |
| 5.7 Analytics ولوحة الإدارة | تعريفات دقيقة: إكمال التخطيط لكل جلسة تخطيط، العودة خلال 90 يومًا، مستخدمون مسجّلون ونشطون، مع عرض التعريف في اللوحة | reports funnel and insights from real events, per planning session؛ اختبار المتصفح: KPIs = 1 / 1 / 1 / 100% / — |

## 4. الإنتاج والتشغيل (القسم 6)

| البند | الإصلاح | الاختبار |
| --- | --- | --- |
| 6.1 التحول الصامت إلى Mock | البيانات التجريبية فقط في التطوير أو مع `VITE_ALLOW_MOCK=true`؛ غير ذلك تظهر شاشة خطأ إعدادات واضحة؛ شريط «بيانات تجريبية» يظهر فقط في الوضع التجريبي | فُحص في المتصفح: بناء إنتاج بلا `VITE_API_URL` يعرض «تعذّر تشغيل RIFLO» ولا يظهر أي بيانات تجريبية |
| 6.2 مزود البريد | إرسال عبر SMTP بقالب عربي؛ الرمز لا يُطبع في السجلات؛ فشل المزود يعيد 503 ويحذف الرمز؛ مهلات اتصال 10 ث (اكتُشف أثناء الترقية أن المهلات كانت تُمرَّر في مكان خاطئ ولا تُطبَّق، وأُصلح) | codes reach the mailer, not the response، a provider failure answers 503…، اختباران على خادم SMTP محلي: التسليم الفعلي، والتخلي عن خادم لا يرد خلال 10 ث |
| 6.3 إعدادات البيئة | محلّل Boolean صارم ("false" كانت تُقرأ true)؛ الإنتاج يرفض التشغيل مع: سر JWT ضعيف أو افتراضي، رموز التطوير مفعّلة، لا SMTP، CORS بدون https، لا قاعدة بيانات، لا Redis | treats "false" as false…، refuses unsafe production settings |
| 6.4 Audit Log والمعاملات | كل تعديل إداري وسجله في Transaction واحدة مع القيم قبل/بعد | rolls back the admin change when the audit write fails |

## 5. ما لا يُحل بالكود ويحتاج إجراءً منك

| البند | السبب | ما المطلوب |
| --- | --- | --- |
| اختبار اختراق خارجي | القسم 10 يشترطه على بيئة منشورة | جهة مستقلة بعد النشر على بيئة اختبار |
| بيانات SMTP | حساب لدى مزود | SES (البحرين) أو SendGrid أو Postmark ← `SMTP_URL` و`EMAIL_FROM` |
| Redis | خدمة مُدارة | `REDIS_URL` (الكود جاهز) |
| ترويسات CSP وHSTS من الاستضافة | وسم meta لا يدعم `frame-ancestors` | إضافتها في إعدادات الاستضافة الثابتة (موثّقة في LAUNCH.md) |
| 6.5 الصور والتخزين | يحتاج خدمة تخزين | تخزين S3 + CDN، ثم نقطة رفع تتحقق من النوع الفعلي والحجم وتحوّل إلى WebP وترفض SVG |
| ترقيم صفحات قوائم الإدارة والمراقبة | ليس عاجلًا في حجم الإطلاق | عند تجاوز بضع مئات من السجلات؛ تنبيهات 5xx والقفل |

## 6. طريقة إعادة التحقق

```bash
npm test                                                    # 58 اختبارًا على PGlite
TEST_DATABASE_URL=postgres://… TEST_DATABASE_SSL_CA=ca.crt npm test -w @riflo/api   # على PostgreSQL حقيقي
tests/e2e/run.sh                                            # النظام كاملًا في المتصفح
npm run typecheck && npm audit --omit=dev
```
