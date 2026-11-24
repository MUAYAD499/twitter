import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  HelpCircle,
  KeyRound,
  LogOut,
  Mail,
  Phone,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { AuthDeliveryInfo, AuthorizedUser } from "../types";

interface ConnectionPanelProps {
  apiId: string;
  setApiId: (v: string) => void;
  apiHash: string;
  setApiHash: (v: string) => void;
  phoneNumber: string;
  setPhoneNumber: (v: string) => void;
  botToken: string;
  setBotToken: (v: string) => void;
  adminChatId: string;
  setAdminChatId: (v: string) => void;
  savedSession: string;
  onSessionSaved: (session: string) => void;
  user: AuthorizedUser | null;
  onUserChanged: (user: AuthorizedUser | null) => void;
  onNavigateNext: () => void;
}

type AuthMethod = "phone" | "qr" | "session";
type AuthStep = "credentials" | "setup_email" | "setup_email_code" | "code" | "password";

export const ConnectionPanel: React.FC<ConnectionPanelProps> = ({
  apiId,
  setApiId,
  apiHash,
  setApiHash,
  phoneNumber,
  setPhoneNumber,
  botToken,
  setBotToken,
  adminChatId,
  setAdminChatId,
  savedSession,
  onSessionSaved,
  user,
  onUserChanged,
  onNavigateNext,
}) => {
  const [authMethod, setAuthMethod] = useState<AuthMethod>("phone");
  const [authStep, setAuthStep] = useState<AuthStep>("credentials");

  const [phoneCode, setPhoneCode] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupEmailCode, setSetupEmailCode] = useState("");
  const [twoFaPassword, setTwoFaPassword] = useState("");
  const [passwordHint, setPasswordHint] = useState("");

  const [deliveryInfo, setDeliveryInfo] = useState<AuthDeliveryInfo | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrActive, setQrActive] = useState(false);

  const [manualSessionInput, setManualSessionInput] = useState("");
  const [showSavedSessionBox, setShowSavedSessionBox] = useState(false);
  const [copiedSession, setCopiedSession] = useState(false);

  const [showSecrets, setShowSecrets] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");

  const [botLoading, setBotLoading] = useState(false);
  const [botStatus, setBotStatus] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  // عداد تنازلي لإتاحة زر إعادة الإرسال عبر القناة البديلة (SMS / مكالمة)
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // استطلاع حالة مسح رمز QR تلقائياً كل 2.5 ثانية عند تفعيل QR
  useEffect(() => {
    if (!qrActive || user || authMethod !== "qr" || authStep !== "credentials") {
      return;
    }

    let cancelled = false;
    const interval = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch("/api/auth/qr/poll", { method: "POST" });
          const data = await res.json();
          if (cancelled) return;

          if (!res.ok) {
            setQrActive(false);
            setAuthError(data.error || "انتهت صلاحية رمز QR. اضغط لتوليد رمز جديد.");
            return;
          }

          if (data.status === "authorized") {
            setQrActive(false);
            setQrDataUrl("");
            onUserChanged(data.user);
            if (data.sessionString) onSessionSaved(data.sessionString);
            setAuthNotice("تم تسجيل الدخول بنجاح عبر رمز QR.");
            return;
          }

          if (data.status === "password_required") {
            setQrActive(false);
            setPasswordHint(data.hint || "");
            setAuthStep("password");
            setAuthNotice("تم مسح الرمز بنجاح. أدخل كلمة مرور التحقق بخطوتين (2FA) لإتمام الدخول.");
            return;
          }

          if (data.status === "qr_pending" && data.qrDataUrl) {
            setQrDataUrl(data.qrDataUrl);
          }
        } catch {
          // تجاهل أخطاء الشبكة العابرة أثناء الاستطلاع
        }
      })();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [qrActive, user, authMethod, authStep, onUserChanged, onSessionSaved]);

  const cancelPendingCodeOnServer = async () => {
    try {
      await fetch("/api/auth/cancel-code", { method: "POST" });
    } catch {
      // تجاهل
    }
  };

  const switchAuthMethod = async (nextMethod: AuthMethod) => {
    if (nextMethod === authMethod) return;
    if (qrActive) setQrActive(false);
    if (authStep !== "credentials") {
      await cancelPendingCodeOnServer();
    }
    setAuthMethod(nextMethod);
    setAuthStep("credentials");
    setAuthError("");
    setAuthNotice("");
  };

  const applyCodeResponse = (data: {
    status: string;
    deliveryInfo?: AuthDeliveryInfo;
    user?: AuthorizedUser;
    sessionString?: string;
    hint?: string;
  }) => {
    if (data.status === "authorized" && data.user) {
      onUserChanged(data.user);
      if (data.sessionString) onSessionSaved(data.sessionString);
      setAuthStep("credentials");
      setPhoneCode("");
      setAuthNotice("تم تسجيل الدخول بنجاح.");
      return;
    }

    if (data.status === "password_required") {
      setPasswordHint(data.hint || "");
      setAuthStep("password");
      setAuthNotice("الحساب محمي بالتحقق بخطوتين (2FA). أدخل كلمة المرور للمتابعة.");
      return;
    }

    if (data.status === "setup_email_required") {
      setDeliveryInfo(data.deliveryInfo ?? null);
      setAuthStep("setup_email");
      setAuthNotice(
        data.deliveryInfo?.detail ||
          "تيليجرام يطلب تأكيد بريد إلكتروني لهذا الرقم قبل إرسال الكود."
      );
      return;
    }

    if (data.status === "code_required") {
      const info = data.deliveryInfo ?? null;
      setDeliveryInfo(info);
      setResendCooldown(info?.timeoutSeconds && info.timeoutSeconds > 0 ? info.timeoutSeconds : 60);
      setAuthStep("code");
      setAuthNotice(info?.detail || "تم إرسال طلب رمز التحقق من خوادم تيليجرام.");
    }
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);

    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiId: apiId.trim(),
          apiHash: apiHash.trim(),
          phoneNumber: phoneNumber.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "تعذر إرسال رمز التحقق.");
        return;
      }
      applyCodeResponse(data);
    } catch {
      setAuthError("تعذر الاتصال بالخادم. يرجى المحاولة مرة أخرى.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleResendCode = async () => {
    setAuthError("");
    setAuthNotice("");
    setResendLoading(true);

    try {
      const res = await fetch("/api/auth/resend-code", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "تعذر إعادة إرسال الكود عبر القناة البديلة.");
        return;
      }
      applyCodeResponse(data);
    } catch {
      setAuthError("تعذر الاتصال بالخادم لإعادة الإرسال.");
    } finally {
      setResendLoading(false);
    }
  };

  const handleSendSetupEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);

    try {
      const res = await fetch("/api/auth/setup-email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: setupEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "تعذر إرسال رمز التحقق للبريد الإلكتروني.");
        return;
      }
      setAuthStep("setup_email_code");
      setAuthNotice(`تم إرسال رمز مكون من 6 أرقام إلى بريدك (${data.email}).`);
    } catch {
      setAuthError("تعذر الاتصال بالخادم.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifySetupEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);

    try {
      const res = await fetch("/api/auth/setup-email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: setupEmailCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "رمز البريد الإلكتروني غير صحيح.");
        return;
      }
      setSetupEmailCode("");
      applyCodeResponse(data);
    } catch {
      setAuthError("تعذر التحقق من رمز البريد الإلكتروني.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);

    try {
      const res = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneCode: phoneCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "رمز التحقق غير صحيح.");
        return;
      }
      applyCodeResponse(data);
    } catch {
      setAuthError("حدث خطأ أثناء التحقق من الرمز.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);

    try {
      const res = await fetch("/api/auth/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: twoFaPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "كلمة المرور غير صحيحة.");
        return;
      }

      if (data.status === "authorized") {
        onUserChanged(data.user);
        if (data.sessionString) onSessionSaved(data.sessionString);
        setAuthStep("credentials");
        setTwoFaPassword("");
        setPhoneCode("");
        setQrActive(false);
        setQrDataUrl("");
        setAuthNotice("تم التحقق بنجاح وتسجيل الدخول.");
      }
    } catch {
      setAuthError("تعذر التحقق من كلمة المرور.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleStartQr = async () => {
    if (!apiId.trim() || !apiHash.trim()) {
      setAuthError("يرجى إدخال API ID و API Hash أولاً قبل توليد رمز QR.");
      return;
    }
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);
    setQrActive(false);
    setQrDataUrl("");

    try {
      const res = await fetch("/api/auth/qr/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiId: apiId.trim(),
          apiHash: apiHash.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "تعذر توليد رمز QR.");
        return;
      }

      if (data.status === "authorized") {
        onUserChanged(data.user);
        if (data.sessionString) onSessionSaved(data.sessionString);
        setAuthNotice("تم تسجيل الدخول بنجاح.");
        return;
      }

      if (data.status === "qr_ready" && data.qrDataUrl) {
        setQrDataUrl(data.qrDataUrl);
        setQrActive(true);
        setAuthNotice(
          "امسح الرمز الآن من تطبيق تيليجرام على هاتفك: الإعدادات ← الأجهزة ← ربط جهاز سطح المكتب."
        );
      }
    } catch {
      setAuthError("تعذر الاتصال بالخادم لتوليد رمز QR.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRestoreSession = async (sessionToUse: string) => {
    const cleanSession = sessionToUse.trim();
    if (!cleanSession || !apiId.trim() || !apiHash.trim()) {
      setAuthError("يرجى إدخال API ID و API Hash وكود الجلسة (StringSession) قبل الاستعادة.");
      return;
    }
    setAuthError("");
    setAuthNotice("");
    setAuthLoading(true);

    try {
      const res = await fetch("/api/auth/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiId: apiId.trim(),
          apiHash: apiHash.trim(),
          sessionString: cleanSession,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "تعذر استعادة الجلسة المحفوظة.");
        return;
      }
      onUserChanged(data.user);
      if (data.sessionString) onSessionSaved(data.sessionString);
      setManualSessionInput("");
      setAuthNotice("تم تسجيل الدخول عبر الجلسة المحفوظة بنجاح.");
    } catch {
      setAuthError("تعذر الاتصال بالخادم لاستعادة الجلسة.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleCopySession = async () => {
    if (!savedSession) return;
    try {
      await navigator.clipboard.writeText(savedSession);
      setCopiedSession(true);
      setTimeout(() => setCopiedSession(false), 2000);
    } catch {
      // تجاهل إذا منع المتصفح النسخ
    }
  };

  const handleLogout = async () => {
    setAuthLoading(true);
    setQrActive(false);
    setQrDataUrl("");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      onUserChanged(null);
      onSessionSaved("");
      setAuthStep("credentials");
      setDeliveryInfo(null);
      setResendCooldown(0);
      setAuthNotice("تم تسجيل الخروج وإغلاق الجلسة بأمان.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleTestBot = async () => {
    setBotStatus(null);
    if (!botToken.trim() || !adminChatId.trim()) {
      setBotStatus({ type: "err", text: "يرجى إدخال توكن البوت ومعرّف حسابك أولاً." });
      return;
    }
    setBotLoading(true);
    try {
      const res = await fetch("/api/bot/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken, adminChatId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBotStatus({
          type: "err",
          text: `فشل الاختبار: ${data.error || "تأكد من صحة التوكن والضغط على Start داخل البوت."}`,
        });
        return;
      }
      setBotStatus({
        type: "ok",
        text: "تم إرسال رسالة اختبارية إلى تيليجرام بنجاح.",
      });
    } catch {
      setBotStatus({ type: "err", text: "تعذر الاتصال بخدمة تيليجرام." });
    } finally {
      setBotLoading(false);
    }
  };

  const switchToQrDirectly = async () => {
    await cancelPendingCodeOnServer();
    setAuthStep("credentials");
    setAuthMethod("qr");
    setAuthError("");
    setAuthNotice("");
    await handleStartQr();
  };

  return (
    <div className="space-y-6">
      {/* رأس القسم */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            ربط حساب تيليجرام وبوت الإشعارات
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            يدعم الدخول برقم الهاتف (تطبيق / بريد إلكتروني / SMS / اتصال)، أو الدخول الفوري المضمون عبر رمز QR، أو استيراد جلسة محفوظة.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <HelpCircle className="h-4 w-4 text-sky-600" />
          <span>{showGuide ? "إخفاء شرح استخراج البيانات" : "كيف أحصل على API و BOT TOKEN؟"}</span>
        </button>
      </div>

      {/* دليل مبسط للاستخراج */}
      {showGuide && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">
            خطوات سريعة للحصول على بيانات الربط
          </h2>
          <div className="mt-4 grid gap-6 md:grid-cols-3 text-sm text-slate-600 leading-relaxed">
            <div>
              <p className="font-semibold text-slate-900">1. استخراج API ID و API Hash</p>
              <p className="mt-1">
                افتح الموقع الرسمي{" "}
                <span className="font-mono text-slate-800">my.telegram.org</span>{" "}
                وسجّل برقم هاتفك، ثم اختر{" "}
                <span className="font-medium text-slate-800">API development tools</span>{" "}
                وأنشئ تطبيقاً لتنسخ الرقمين.
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-900">2. إنشاء بوت الإشعارات (BOT_TOKEN)</p>
              <p className="mt-1">
                راسل{" "}
                <span className="font-mono text-slate-800">@BotFather</span>{" "}
                على تيليجرام وأرسل الأمر{" "}
                <span className="font-mono text-slate-800">/newbot</span>{" "}
                ثم انسخ التوكن. لا تنس فتح البوت الجديد والضغط على{" "}
                <span className="font-medium text-slate-800">ابدأ / Start</span>.
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-900">3. معرفة معرّفك (ADMIN_CHAT_ID)</p>
              <p className="mt-1">
                أرسل أي رسالة إلى{" "}
                <span className="font-mono text-slate-800">@userinfobot</span>{" "}
                وسيرد عليك فوراً برقم <span className="font-mono text-slate-800">Id</span>{" "}
                الخاص بحسابك لاستقبال تقارير النشر.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* الشبكة الرئيسية: بطاقة حساب تيليجرام + بطاقة بوت الإشعارات */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* حساب تيليجرام (MTProto) */}
        <section className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2.5">
              <KeyRound className="h-5 w-5 text-sky-600" />
              <h2 className="text-base font-semibold text-slate-900">
                حساب النشر على تيليجرام
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setShowSecrets((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 whitespace-nowrap shrink-0"
            >
              {showSecrets ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              <span>{showSecrets ? "إخفاء المفاتيح" : "إظهار المفاتيح"}</span>
            </button>
          </div>

          {authError && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-2">
                <p>{authError}</p>
                {authMethod !== "qr" && !user && (
                  <button
                    type="button"
                    onClick={() => void switchToQrDirectly()}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700 underline hover:text-sky-900"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    <span>جرّب الدخول الفوري عبر رمز QR (لا يحتاج وصول كود SMS/إيميل)</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {authNotice && !authError && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{authNotice}</span>
            </div>
          )}

          {user ? (
            <div className="mt-5 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-6 w-6 text-emerald-600 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      متصل باسم: {user.firstName} {user.lastName}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600 tabular-nums">
                      {user.username ? `@${user.username}` : "بدون معرف"} · +{user.phone} · ID:{" "}
                      <span className="font-mono">{user.id}</span>
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={authLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>تسجيل الخروج</span>
                </button>
              </div>

              {/* نسخ الجلسة المحفوظة كنسخة احتياطية للاستعادة الفورية مستقبلاً */}
              {savedSession && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold text-slate-900">
                        كود الجلسة الاحتياطي (StringSession)
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        احتفظ بهذا الكود للدخول المباشر لاحقاً دون الحاجة لطلب رمز تحقق أو مسح QR.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowSavedSessionBox((v) => !v)}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                      >
                        {showSavedSessionBox ? "إخفاء الكود" : "عرض الكود"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCopySession}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                      >
                        {copiedSession ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                            <span>تم النسخ</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>نسخ الجلسة</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  {showSavedSessionBox && (
                    <textarea
                      readOnly
                      dir="ltr"
                      rows={3}
                      value={savedSession}
                      className="mt-3 w-full rounded-lg border border-slate-200 bg-white p-2.5 text-xs font-mono text-slate-700 outline-none"
                    />
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <p className="text-xs text-slate-500">
                  تم حفظ الجلسة تلقائياً في متصفحك لتسهيل إعادة الاتصال بنقرة واحدة.
                </p>
                <button
                  type="button"
                  onClick={onNavigateNext}
                  className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-700 whitespace-nowrap shrink-0"
                >
                  المتابعة إلى إعداد القوالب
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              {/* استعادة الجلسة المحفوظة تلقائياً بنقرة واحدة */}
              {savedSession && authStep === "credentials" && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50/60 p-4">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      توجد جلسة سابقة محفوظة في المتصفح
                    </p>
                    <p className="text-xs text-slate-600">
                      يمكنك استعادتها بنقرة واحدة دون طلب رمز تحقق جديد.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRestoreSession(savedSession)}
                    disabled={authLoading}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${authLoading ? "animate-spin" : ""}`} />
                    <span>استعادة الجلسة</span>
                  </button>
                </div>
              )}

              {/* مفاتيح API المشتركة لجميع طرق الدخول */}
              {authStep === "credentials" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      Telegram API ID
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      required
                      value={apiId}
                      onChange={(e) => setApiId(e.target.value)}
                      placeholder="12345678"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      Telegram API Hash
                    </label>
                    <input
                      type={showSecrets ? "text" : "password"}
                      dir="ltr"
                      required
                      value={apiHash}
                      onChange={(e) => setApiHash(e.target.value)}
                      placeholder="0123456789abcdef..."
                      className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                    />
                  </div>
                </div>
              )}

              {/* تبويبات طرق تسجيل الدخول */}
              {authStep === "credentials" && (
                <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1">
                  <button
                    type="button"
                    onClick={() => void switchAuthMethod("phone")}
                    className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                      authMethod === "phone"
                        ? "bg-white text-slate-900 shadow-xs border border-slate-200"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <span>رقم الهاتف والكود</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void switchAuthMethod("qr")}
                    className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                      authMethod === "qr"
                        ? "bg-white text-sky-700 shadow-xs border border-slate-200"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <QrCode className="h-3.5 w-3.5 shrink-0" />
                    <span>رمز QR (مضمون)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void switchAuthMethod("session")}
                    className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                      authMethod === "session"
                        ? "bg-white text-slate-900 shadow-xs border border-slate-200"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <Upload className="h-3.5 w-3.5 shrink-0" />
                    <span>استيراد جلسة</span>
                  </button>
                </div>
              )}

              {/* الطريقة 1: رقم الهاتف والكود */}
              {authStep === "credentials" && authMethod === "phone" && (
                <form onSubmit={handleSendCode} className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      رقم الهاتف (بالصيغة الدولية)
                    </label>
                    <div className="relative">
                      <Phone className="pointer-events-none absolute top-3 left-3.5 h-4 w-4 text-slate-400" />
                      <input
                        type="tel"
                        dir="ltr"
                        required
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        placeholder="+966501234567"
                        className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3.5 pl-10 text-sm font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                      />
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500">
                      يدعم الأرقام العربية والإنجليزية وصيغة <span className="font-mono">00</span> أو{" "}
                      <span className="font-mono">+</span>، وكذلك الحسابات المرتبطة ببريد إلكتروني.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {authLoading ? "جاري إرسال الطلب..." : "إرسال رمز التحقق"}
                    </button>

                    <button
                      type="button"
                      onClick={() => void switchToQrDirectly()}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 hover:text-sky-900 whitespace-nowrap"
                    >
                      <QrCode className="h-3.5 w-3.5" />
                      <span>أو سجّل الدخول بمسح QR دون انتظار كود</span>
                    </button>
                  </div>
                </form>
              )}

              {/* الطريقة 2: الدخول السريع عبر QR */}
              {authStep === "credentials" && authMethod === "qr" && (
                <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-5">
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold text-slate-900">
                      الدخول الفوري بمسح رمز QR (لا يتأثر بحجب الأكواد أو البريد)
                    </p>
                    <p className="text-xs leading-relaxed text-slate-600">
                      إذا تأخر وصول رمز التحقق أو حجبته خوادم تيليجرام على رقم معين، امسح هذا الرمز من تطبيق تيليجرام المفتوح على هاتفك لتسجيل الدخول فوراً وبشكل مضمون.
                    </p>
                  </div>

                  {qrDataUrl ? (
                    <div className="flex flex-col items-center gap-4 pt-2 sm:flex-row sm:items-start">
                      <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-3">
                        <img
                          src={qrDataUrl}
                          alt="رمز QR لتسجيل الدخول إلى تيليجرام"
                          className="h-52 w-52 object-contain"
                        />
                      </div>
                      <div className="space-y-3 text-xs leading-relaxed text-slate-700">
                        <p className="font-semibold text-slate-900">خطوات المسح من هاتفك:</p>
                        <ol className="list-decimal space-y-1.5 pr-4">
                          <li>افتح تطبيق <span className="font-semibold">تيليجرام</span> على هاتفك.</li>
                          <li>انتقل إلى <span className="font-semibold">الإعدادات (Settings)</span> ← <span className="font-semibold">الأجهزة (Devices)</span>.</li>
                          <li>اضغط على <span className="font-semibold">ربط جهاز سطح المكتب (Link Desktop Device)</span>.</li>
                          <li>وجّه الكاميرا نحو الرمز ليتم الدخول تلقائياً خلال ثوانٍ.</li>
                        </ol>
                        <p className="font-medium text-sky-700">
                          {qrActive ? "بانتظار مسح الرمز من هاتفك..." : "توقف فحص الرمز."}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => void handleStartQr()}
                            disabled={authLoading}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${authLoading ? "animate-spin" : ""}`} />
                            <span>تحديث رمز QR</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setQrActive(false);
                              setQrDataUrl("");
                              void cancelPendingCodeOnServer();
                            }}
                            className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 whitespace-nowrap"
                          >
                            إلغاء
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <button
                        type="button"
                        onClick={() => void handleStartQr()}
                        disabled={authLoading}
                        className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        <QrCode className="h-4 w-4" />
                        <span>{authLoading ? "جاري توليد رمز QR..." : "توليد رمز QR للدخول الآن"}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* الطريقة 3: استيراد جلسة محفوظة */}
              {authStep === "credentials" && authMethod === "session" && (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      كود الجلسة المحفوظ (StringSession)
                    </label>
                    <textarea
                      dir="ltr"
                      rows={3}
                      value={manualSessionInput}
                      onChange={(e) => setManualSessionInput(e.target.value)}
                      placeholder="1BVtsOH..."
                      className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                    />
                    <p className="mt-1.5 text-xs text-slate-500">
                      إذا كان لديك كود جلسة من تشغيل سابق أو من نفس النظام، الصقه هنا للدخول فوراً دون أي كود.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRestoreSession(manualSessionInput)}
                    disabled={authLoading}
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Upload className="h-4 w-4" />
                    <span>{authLoading ? "جاري التحقق من الجلسة..." : "دخول بالجلسة المحفوظة"}</span>
                  </button>
                </div>
              )}

              {/* خطوة إضافية: إذا طلب تيليجرام ربط بريد إلكتروني للرقم (SentCodeTypeSetUpEmailRequired) */}
              {authStep === "setup_email" && (
                <form onSubmit={handleSendSetupEmail} className="space-y-4">
                  <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 text-xs leading-relaxed text-amber-900">
                    <p className="font-semibold">تيليجرام يطلب تأكيد بريد إلكتروني لهذا الرقم</p>
                    <p className="mt-1">
                      أدخل بريدك الإلكتروني لإرسال رمز تأكيد إليه، أو يمكنك تجاوز هذه الخطوة تماماً باستخدام الدخول عبر QR.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      البريد الإلكتروني
                    </label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute top-3 left-3.5 h-4 w-4 text-slate-400" />
                      <input
                        type="email"
                        dir="ltr"
                        required
                        autoFocus
                        value={setupEmail}
                        onChange={(e) => setSetupEmail(e.target.value)}
                        placeholder="name@example.com"
                        className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3.5 pl-10 text-sm font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {authLoading ? "جاري الإرسال..." : "إرسال رمز للبريد"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void switchToQrDirectly()}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-sky-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      الدخول عبر QR بدلاً من ذلك
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void cancelPendingCodeOnServer();
                        setAuthStep("credentials");
                        setAuthError("");
                      }}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      رجوع
                    </button>
                  </div>
                </form>
              )}

              {authStep === "setup_email_code" && (
                <form onSubmit={handleVerifySetupEmail} className="space-y-4">
                  <p className="text-sm text-slate-600">
                    أدخل رمز التحقق المرسل إلى بريدك الإلكتروني (<span className="font-mono">{setupEmail}</span>):
                  </p>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    required
                    autoFocus
                    value={setupEmailCode}
                    onChange={(e) => setSetupEmailCode(e.target.value)}
                    placeholder="123456"
                    className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-center text-lg font-mono tracking-widest text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {authLoading ? "جاري التأكيد..." : "تأكيد رمز البريد"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuthStep("setup_email")}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      تغيير البريد
                    </button>
                  </div>
                </form>
              )}

              {/* خطوة إدخال رمز التحقق + تشخيص قناة الوصول + إعادة الإرسال */}
              {authStep === "code" && (
                <form onSubmit={handleVerifyCode} className="space-y-4">
                  {deliveryInfo && (
                    <div
                      className={`rounded-lg border p-4 text-xs leading-relaxed ${
                        deliveryInfo.deliveryType === "firebase"
                          ? "border-amber-200 bg-amber-50/70 text-amber-900"
                          : "border-slate-200 bg-slate-50 text-slate-700"
                      }`}
                    >
                      <p className="font-semibold text-slate-900">
                        قناة التوصيل الحالية من تيليجرام: {deliveryInfo.label}
                      </p>
                      <p className="mt-1">{deliveryInfo.detail}</p>
                      {deliveryInfo.emailPattern && (
                        <p className="mt-1 font-mono text-slate-800">
                          البريد المستهدف: {deliveryInfo.emailPattern}
                        </p>
                      )}
                      {deliveryInfo.fragmentUrl && (
                        <a
                          href={deliveryInfo.fragmentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1 font-semibold text-sky-700 underline"
                        >
                          <span>فتح صفحة Fragment لاستلام الكود</span>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      رمز التحقق (من التطبيق أو البريد الإلكتروني أو SMS)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      required
                      autoFocus
                      value={phoneCode}
                      onChange={(e) => setPhoneCode(e.target.value)}
                      placeholder={deliveryInfo?.codeLength === 6 ? "123456" : "12345"}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-center text-lg font-mono tracking-widest text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {authLoading ? "جاري التحقق..." : "تأكيد الرمز"}
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleResendCode()}
                      disabled={resendLoading || resendCooldown > 0}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 tabular-nums"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${resendLoading ? "animate-spin" : ""}`} />
                      <span>
                        {resendCooldown > 0
                          ? `إعادة الإرسال (${resendCooldown}ث)`
                          : `لم يصلني؟ أعد الإرسال عبر ${deliveryInfo?.nextTypeLabel || "قناة بديلة"}`}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        void cancelPendingCodeOnServer();
                        setAuthStep("credentials");
                        setDeliveryInfo(null);
                        setResendCooldown(0);
                        setAuthError("");
                      }}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      تعديل الرقم
                    </button>
                  </div>

                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => void switchToQrDirectly()}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 hover:text-sky-900"
                    >
                      <QrCode className="h-3.5 w-3.5" />
                      <span>لم يصل الكود نهائياً؟ انتقل للدخول الفوري عبر رمز QR</span>
                    </button>
                  </div>
                </form>
              )}

              {/* خطوة كلمة مرور التحقق بخطوتين 2FA */}
              {authStep === "password" && (
                <form onSubmit={handleVerifyPassword} className="space-y-4">
                  <p className="text-sm text-slate-600">
                    أدخل كلمة مرور التحقق بخطوتين (2FA) لحسابك:
                    {passwordHint ? (
                      <span className="mr-1 font-medium text-slate-800">
                        (تلميح: {passwordHint})
                      </span>
                    ) : null}
                  </p>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">
                      كلمة المرور السحابية
                    </label>
                    <input
                      type={showSecrets ? "text" : "password"}
                      dir="ltr"
                      required
                      autoFocus
                      value={twoFaPassword}
                      onChange={(e) => setTwoFaPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {authLoading ? "جاري الدخول..." : "دخول بالحساب"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void cancelPendingCodeOnServer();
                        setAuthStep("credentials");
                        setTwoFaPassword("");
                        setAuthError("");
                      }}
                      className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      البدء من جديد
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </section>

        {/* بوت الإشعارات الفورية */}
        <section className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-center gap-2.5 border-b border-slate-100 pb-4">
            <Bell className="h-5 w-5 text-sky-600" />
            <h2 className="text-base font-semibold text-slate-900">
              بوت إشعارات التقدم الفوري
            </h2>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                توكن البوت (BOT_TOKEN)
              </label>
              <input
                type={showSecrets ? "text" : "password"}
                dir="ltr"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="7123456789:AAH..."
                className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">
                معرّف حسابك الشخصي (ADMIN_CHAT_ID)
              </label>
              <input
                type="text"
                dir="ltr"
                value={adminChatId}
                onChange={(e) => setAdminChatId(e.target.value)}
                placeholder="123456789"
                className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-mono text-slate-900 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-600/15"
              />
            </div>

            {botStatus && (
              <div
                className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-xs ${
                  botStatus.type === "ok"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {botStatus.type === "ok" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{botStatus.text}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleTestBot}
              disabled={botLoading}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
            >
              {botLoading ? "جاري إرسال الاختبار..." : "اختبار إرسال إشعار على تيليجرام"}
            </button>

            <p className="text-xs leading-relaxed text-slate-500">
              يُستخدم هذا البوت لإرسال تنبيهات فورية إليك عند نجاح النشر، أو تخطي مجموعة مقيدة، أو حدوث توقف FloodWait، بالإضافة إلى الملخص الختامي.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};
