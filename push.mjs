// FILE: C:\faris-api\push.mjs
// إرسال إشعارات فورية (Push) عبر Firebase Cloud Messaging — إضافي بحت.
// لو لم تُضبط بيانات اعتماد Firebase (متغيّر بيئة)، تعمل هذه الوحدة كـ no-op
// بصمت: لا تكسر أي شيء، فقط لا تُرسل إشعارات فورية — الإشعار داخل النظام
// (جدول notifications) يستمر بالعمل كما هو دائمًا بغض النظر عن Push.
//
// لتفعيلها: أنشئ مشروع Firebase خاص بك (مجاني)، فعّل Cloud Messaging،
// نزّل ملف Service Account JSON من إعدادات المشروع → Service Accounts،
// وضع محتواه كاملاً (سطر واحد) في متغيّر بيئة FIREBASE_SERVICE_ACCOUNT_JSON
// على Render. لا يوجد أي مفتاح Firebase مكتوب داخل الكود.

let appPromise = null;

async function getApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      console.log("ℹ️ push: FIREBASE_SERVICE_ACCOUNT_JSON غير مضبوط — الإشعارات الفورية معطّلة (الإشعارات داخل النظام تعمل كالمعتاد).");
      return null;
    }
    try {
      const admin = await import("firebase-admin");
      const serviceAccount = JSON.parse(raw);
      const app = admin.default.initializeApp({ credential: admin.default.credential.cert(serviceAccount) });
      console.log("✅ push: Firebase Admin جاهز");
      return { admin: admin.default, app };
    } catch (e) {
      console.error("push: تعذّر تهيئة Firebase Admin:", e.message);
      return null;
    }
  })();
  return appPromise;
}

/**
 * يرسل إشعار Push لكل الأجهزة المسجَّلة لمستخدم معيّن. لا يرمي أي خطأ أبدًا —
 * فشل الإرسال (أو غياب الإعداد أصلاً) لا يجب أن يوقف أي عملية أساسية.
 */
export async function sendPushToUser(pool, userId, { title, body, link }) {
  try {
    const ctx = await getApp();
    if (!ctx) return; // Firebase غير مُعدّ — لا شيء نفعله

    const tokens = await pool.query(`SELECT token FROM public.device_tokens WHERE user_id = $1`, [Number(userId)]);
    if (!tokens.rowCount) return;

    const messages = tokens.rows.map((r) => ({
      token: r.token,
      notification: { title: String(title || "").slice(0, 200), body: String(body || "").slice(0, 500) },
      data: link ? { link: String(link) } : {},
    }));

    for (const msg of messages) {
      try {
        await ctx.admin.messaging().send(msg);
      } catch (e) {
        // توكن منتهي/غير صالح؟ احذفه بصمت حتى لا نعيد المحاولة عليه لاحقًا.
        if (String(e.message || "").includes("registration-token-not-registered")) {
          await pool.query(`DELETE FROM public.device_tokens WHERE token = $1`, [msg.token]).catch(() => {});
        } else {
          console.error("push send error:", e.message);
        }
      }
    }
  } catch (e) {
    console.error("sendPushToUser error:", e.message);
  }
}
