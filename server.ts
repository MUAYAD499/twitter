import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import telegramPkg from "telegram";
import type { Api as ApiType, TelegramClient as TelegramClientType } from "telegram";

const { TelegramClient, Api, sessions, password: passwordHelpers } = telegramPkg;
const { StringSession } = sessions;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==============================================================================
// أنواع البيانات والحالة الداخلية للخادم
// ==============================================================================
interface AuthorizedUser {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
}

interface TargetGroup {
  id: string;
  title: string;
  roleLabel: string;
  isAdmin: boolean;
  membersCount: number;
  username: string;
}

interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

type GroupDeliveryStatus = "pending" | "sending" | "sent" | "skipped" | "error";

interface TemplatePayload {
  title: string;
  content: string;
}

interface GroupStatusRecord {
  groupId: string;
  title: string;
  status: GroupDeliveryStatus;
  detail: string;
  assignedTemplateTitle: string;
  cycleNumber: number;
  updatedAt: string;
}

interface BroadcastState {
  status: "idle" | "running" | "waiting" | "flood_wait" | "completed" | "stopped";
  currentCycle: number;
  totalCyclesCompleted: number;
  totalTargets: number;
  processedCount: number;
  succeededCount: number;
  totalSentAllCycles: number;
  skippedCount: number;
  failedCount: number;
  floodWaitsCount: number;
  newGroupsDiscoveredCount: number;
  currentGroupTitle: string;
  countdownSeconds: number;
  countdownReason: string;
  startedAt: string | null;
  finishedAt: string | null;
  groupStatuses: Record<string, GroupStatusRecord>;
  logs: LogEntry[];
}

// ==============================================================================
// محرك تنويع وتنسيق المحتوى التعليمي
// ==============================================================================
const OPENERS = [
  "💡 <b>إضاءة تعليمية لمجموعة {group_name}:</b>",
  "📘 <b>ملخص معرفي وتقني — {group_name}:</b>",
  "✨ <b>تحديث مجتمعي مفيد لأعضاء {group_name}:</b>",
  "🚀 <b>فائدة سريعة ومشاركة تقنية:</b>",
  "📌 <b>نقطة تعليمية تستحق التأمل:</b>",
];

const CLOSERS = [
  "💬 شاركونا آراءكم وتجاربكم حول هذا الموضوع في التعليقات.",
  "🤝 نتمنى لكم الفائدة والتوفيق الدائم في {group_name}.",
  "🔖 احفظوا هذه الملاحظة للرجوع إليها لاحقاً.",
  "🌟 كل التوفيق للجميع، ونرحب بنقاشاتكم البنّاءة.",
  "📚 استمروا في التعلم والمشاركة، فالمعرفة تنمو بالتبادل.",
];

const DIVIDERS = ["───────────────", "• • • • • • •", "━━━━━━━━━━━━━━━", ""];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveSpintax(text: string): string {
  let result = text;
  const pattern = /\{([^{}|]+\|[^{}]+)\}/;
  let match = pattern.exec(result);
  let safetyCounter = 0;
  while (match && safetyCounter < 50) {
    safetyCounter += 1;
    const options = match[1].split("|");
    const chosen = options[Math.floor(Math.random() * options.length)] ?? "";
    result = result.slice(0, match.index) + chosen + result.slice(match.index + match[0].length);
    match = pattern.exec(result);
  }
  return result;
}

function formatMessageForGroup(
  template: string,
  groupTitle: string,
  useStructuralVariation: boolean
): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  let body = resolveSpintax(template).trim();
  body = body
    .replace(/\{group_name\}/g, groupTitle)
    .replace(/\{date\}/g, dateStr)
    .replace(/\{time\}/g, timeStr);

  if (!useStructuralVariation) {
    return escapeHtml(body);
  }

  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)].replace(
    /\{group_name\}/g,
    escapeHtml(groupTitle)
  );
  const closer = CLOSERS[Math.floor(Math.random() * CLOSERS.length)].replace(
    /\{group_name\}/g,
    escapeHtml(groupTitle)
  );
  const divider = DIVIDERS[Math.floor(Math.random() * DIVIDERS.length)];
  const safeBody = escapeHtml(body);

  const parts = [opener];
  if (divider) parts.push(divider);
  parts.push(safeBody);
  if (divider) parts.push(divider);
  parts.push(closer);

  return parts.join("\n\n");
}

// ==============================================================================
// إرسال إشعارات البوت عبر Telegram Bot API
// ==============================================================================
async function sendBotNotification(
  botToken: string,
  adminChatId: string,
  htmlMessage: string
): Promise<{ ok: boolean; error?: string }> {
  if (!botToken.trim() || !adminChatId.trim()) {
    return { ok: false, error: "بيانات البوت غير مكتملة." };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(
      `https://api.telegram.org/bot${botToken.trim()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminChatId.trim(),
          text: htmlMessage,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    const data = (await response.json()) as { ok: boolean; description?: string };
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        error: data.description || `رمز الاستجابة: ${response.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "خطأ في الاتصال بخدمة البوت",
    };
  }
}

// ==============================================================================
// إدارة جلسة Telethon/GramJS وحالة البث
// ==============================================================================
let activeClient: TelegramClientType | null = null;
let currentUser: AuthorizedUser | null = null;
let currentSessionString = "";
let cachedGroups: TargetGroup[] = [];
const entityMap = new Map<string, unknown>();

// حالة المصادقة المباشرة عبر MTProto (تدعم الهاتف، البريد الإلكتروني، ResendCode، 2FA، و QR)
type CodeDeliveryType =
  | "app"
  | "email"
  | "sms"
  | "call"
  | "fragment"
  | "firebase"
  | "setup_email"
  | "unknown";

interface SentCodeInfo {
  deliveryType: CodeDeliveryType;
  label: string;
  detail: string;
  emailPattern: string;
  fragmentUrl: string;
  codeLength: number;
  nextTypeLabel: string;
  timeoutSeconds: number;
}

interface PendingAuthFlow {
  mode: "phone" | "qr";
  apiId: number;
  apiHash: string;
  phoneNumber: string;
  phoneCodeHash: string;
  deliveryInfo?: SentCodeInfo;
  stage:
    | "idle"
    | "awaiting_code"
    | "awaiting_email_setup"
    | "awaiting_email_setup_code"
    | "awaiting_qr"
    | "awaiting_password"
    | "done"
    | "error";
  passwordHint?: string;
  qrExpiresAt?: number;
  qrAuthorizedUser?: AuthorizedUser;
}

let pendingAuth: PendingAuthFlow | null = null;

function convertArabicDigitsToAscii(input: string): string {
  const arabicIndic = "٠١٢٣٤٥٦٧٨٩";
  const easternArabic = "۰۱۲۳۴۵۶۷۸۹";
  return input
    .replace(/[٠-٩]/g, (d) => String(arabicIndic.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(easternArabic.indexOf(d)));
}

function normalizePhoneNumber(raw: string): string {
  let cleaned = convertArabicDigitsToAscii(raw).replace(/[\s\-().]/g, "").trim();
  if (cleaned.startsWith("00")) {
    cleaned = `+${cleaned.slice(2)}`;
  }
  if (cleaned && !cleaned.startsWith("+")) {
    cleaned = `+${cleaned}`;
  }
  return cleaned;
}

function normalizeNumericInput(raw: string): string {
  return convertArabicDigitsToAscii(raw).replace(/\s+/g, "").trim();
}

function createTelegramClient(
  sessionString: string,
  apiId: number,
  apiHash: string
): TelegramClientType {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    requestRetries: 5,
    deviceModel: "Telegram Desktop",
    systemVersion: "Windows 11",
    appVersion: "5.7.2 x64",
    langCode: "ar",
    systemLangCode: "ar",
  });
}

function mapNextCodeTypeLabel(nextType: unknown): string {
  if (!nextType || typeof nextType !== "object") return "";
  const cls = (nextType as { className?: string }).className ?? "";
  if (cls.includes("CodeTypeSms")) return "رسالة نصية SMS";
  if (cls.includes("CodeTypeCall")) return "اتصال صوتي";
  if (cls.includes("CodeTypeFlashCall")) return "مكالمة تحقق سريعة";
  if (cls.includes("CodeTypeMissedCall")) return "مكالمة فائتة";
  if (cls.includes("CodeTypeFragmentSms")) return "منصة Fragment";
  return "قناة بديلة";
}

function describeSentCode(sentCode: InstanceType<typeof Api.auth.SentCode>): SentCodeInfo {
  const typeObj = sentCode.type as unknown as {
    className?: string;
    length?: number;
    emailPattern?: string;
    url?: string;
  };
  const cls = typeObj?.className ?? "";
  const nextTypeLabel = mapNextCodeTypeLabel(sentCode.nextType);
  const timeoutSeconds = Number(sentCode.timeout ?? 60);
  const codeLength = Number(typeObj?.length ?? 5);

  if (cls.includes("SentCodeTypeApp")) {
    return {
      deliveryType: "app",
      label: "رسالة داخل تطبيق تيليجرام",
      detail:
        "تم إرسال الرمز إلى محادثة (Telegram) الرسمية داخل التطبيق المفتوح على هاتفك أو حاسوبك.",
      emailPattern: "",
      fragmentUrl: "",
      codeLength,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  if (cls.includes("SentCodeTypeEmailCode")) {
    const pattern = String(typeObj?.emailPattern ?? "");
    return {
      deliveryType: "email",
      label: "البريد الإلكتروني المرتبط بالحساب",
      detail: pattern
        ? `تم إرسال رمز التحقق إلى بريدك الإلكتروني (${pattern}). تفقد البريد الوارد والرسائل غير المرغوب فيها (Spam).`
        : "تم إرسال رمز التحقق إلى البريد الإلكتروني المرتبط بحسابك.",
      emailPattern: pattern,
      fragmentUrl: "",
      codeLength,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  if (cls.includes("SentCodeTypeSms")) {
    return {
      deliveryType: "sms",
      label: "رسالة نصية SMS",
      detail: "تم إرسال رمز التحقق برسالة نصية SMS إلى رقم هاتفك.",
      emailPattern: "",
      fragmentUrl: "",
      codeLength,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  if (
    cls.includes("SentCodeTypeCall") ||
    cls.includes("SentCodeTypeMissedCall") ||
    cls.includes("SentCodeTypeFlashCall")
  ) {
    return {
      deliveryType: "call",
      label: "مكالمة هاتفية",
      detail: "ستصلك مكالمة هاتفية من تيليجرام تحتوي على رمز التحقق.",
      emailPattern: "",
      fragmentUrl: "",
      codeLength,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  if (cls.includes("SentCodeTypeFragmentSms")) {
    const url = String(typeObj?.url ?? "");
    return {
      deliveryType: "fragment",
      label: "منصة Fragment",
      detail: "هذا الرقم مربوط بمنصة Fragment، يرجى استلام الكود من صفحة Fragment.",
      emailPattern: "",
      fragmentUrl: url,
      codeLength,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  if (cls.includes("SentCodeTypeFirebaseSms")) {
    return {
      deliveryType: "firebase",
      label: "تحقق أندرويد (Firebase)",
      detail:
        "تيليجرام أرسل طلباً لتطبيق أندرويد الرسمي وقد لا يصلك كود SMS عبر السيرفر. انتظر انتهاء العداد واضغط (إعادة إرسال عبر SMS/قناة بديلة) أو سجّل الدخول الفوري عبر رمز QR (مضمون 100%).",
      emailPattern: "",
      fragmentUrl: "",
      codeLength,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  if (cls.includes("SentCodeTypeSetUpEmailRequired")) {
    return {
      deliveryType: "setup_email",
      label: "مطلوب تأكيد بريد إلكتروني",
      detail:
        "تيليجرام يطلب التحقق من بريد إلكتروني لهذا الرقم قبل إرسال الكود، أو يمكنك تسجيل الدخول مباشرة عبر رمز QR.",
      emailPattern: "",
      fragmentUrl: "",
      codeLength: 6,
      nextTypeLabel,
      timeoutSeconds,
    };
  }

  return {
    deliveryType: "unknown",
    label: cls || "قناة تحقق تيليجرام",
    detail: "تم طلب رمز التحقق من خوادم تيليجرام.",
    emailPattern: "",
    fragmentUrl: "",
    codeLength,
    nextTypeLabel,
    timeoutSeconds,
  };
}

function translateTelegramError(err: unknown): { message: string; fatal: boolean } {
  const anyErr = err as { errorMessage?: string; message?: string; seconds?: number };
  const raw = anyErr?.errorMessage || (err instanceof Error ? err.message : String(err));
  const upper = raw.toUpperCase();

  if (upper.includes("API_ID_INVALID") || upper.includes("API_ID_PUBLISHED_FLOOD")) {
    return {
      message: "بيانات API ID أو API Hash غير صالحة. يرجى التحقق منها في my.telegram.org.",
      fatal: true,
    };
  }
  if (upper.includes("PHONE_NUMBER_INVALID")) {
    return {
      message: "رقم الهاتف غير صحيح. تأكد من إدخاله بالصيغة الدولية (مثال: +966501234567).",
      fatal: true,
    };
  }
  if (upper.includes("PHONE_NUMBER_BANNED")) {
    return {
      message: "هذا الرقم محظور من استخدام تيليجرام.",
      fatal: true,
    };
  }
  if (upper.includes("PHONE_CODE_INVALID")) {
    return {
      message: "رمز التحقق غير صحيح. يرجى التأكد من الرمز وإعادة المحاولة.",
      fatal: false,
    };
  }
  if (upper.includes("PHONE_CODE_EXPIRED")) {
    return {
      message: "انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد أو استخدام الدخول عبر QR.",
      fatal: true,
    };
  }
  if (upper.includes("CODE_INVALID") || upper.includes("EMAIL_HASH_EXPIRED")) {
    return {
      message: "رمز البريد الإلكتروني غير صحيح أو منتهي الصلاحية.",
      fatal: false,
    };
  }
  if (upper.includes("EMAIL_INVALID")) {
    return {
      message: "عنوان البريد الإلكتروني غير صالح.",
      fatal: false,
    };
  }
  if (upper.includes("EMAIL_NOT_ALLOWED")) {
    return {
      message: "لا يمكن استخدام هذا البريد الإلكتروني للتحقق حالياً.",
      fatal: false,
    };
  }
  if (upper.includes("PASSWORD_HASH_INVALID")) {
    return {
      message: "كلمة مرور التحقق بخطوتين (2FA) غير صحيحة. حاول مرة أخرى.",
      fatal: false,
    };
  }
  if (upper.includes("SEND_CODE_UNAVAILABLE")) {
    return {
      message:
        "تيليجرام حجب إرسال رسائل الكود لهذا الرقم عبر هذا الخادم مؤقتاً. استخدم (الدخول الفوري عبر رمز QR) كحل مضمون 100%.",
      fatal: true,
    };
  }
  if (upper.includes("AUTH_TOKEN_EXPIRED") || upper.includes("AUTH_TOKEN_INVALID")) {
    return {
      message: "انتهت صلاحية رمز QR. يرجى توليد رمز جديد ومسحه فوراً.",
      fatal: true,
    };
  }
  if (upper.includes("PHONE_NUMBER_FLOOD") || upper.includes("PHONE_PASSWORD_FLOOD")) {
    return {
      message: "تم تجاوز الحد المسموح لمحاولات هذا الرقم مؤقتاً. استخدم (الدخول الفوري عبر رمز QR) لتجاوز الحظر فوراً.",
      fatal: true,
    };
  }
  if (upper.includes("FLOOD_WAIT")) {
    const match = upper.match(/(\d+)/);
    const secs = anyErr?.seconds ?? (match ? match[1] : "بضع");
    return {
      message: `فرض تيليجرام فترة انتظار مؤقتة (${secs} ثانية) على هذا الرقم/الطلب. يمكنك استخدام الدخول عبر رمز QR فوراً أو الانتظار.`,
      fatal: true,
    };
  }
  return { message: `حدث خطأ من تيليجرام: ${raw}`, fatal: true };
}

async function cancelPendingPhoneCodeSafely(
  client: TelegramClientType | null,
  flow: PendingAuthFlow | null
): Promise<void> {
  if (!client || !flow || !flow.phoneNumber || !flow.phoneCodeHash) return;
  try {
    await client.invoke(
      new Api.auth.CancelCode({
        phoneNumber: flow.phoneNumber,
        phoneCodeHash: flow.phoneCodeHash,
      })
    );
  } catch {
    // تجاهل في حال انتهى الكود مسبقاً
  }
}

async function disconnectActiveClient(): Promise<void> {
  await cancelPendingPhoneCodeSafely(activeClient, pendingAuth);
  if (activeClient) {
    try {
      await activeClient.disconnect();
    } catch {
      // تجاهل أخطاء الإغلاق
    }
    activeClient = null;
  }
  currentUser = null;
  currentSessionString = "";
  cachedGroups = [];
  entityMap.clear();
  pendingAuth = null;
}

async function extractAuthorizedUser(client: TelegramClientType): Promise<AuthorizedUser> {
  const me = await client.getMe();
  const userObj = me as unknown as {
    id?: { toString: () => string };
    firstName?: string;
    lastName?: string;
    username?: string;
    phone?: string;
  };
  return {
    id: userObj.id?.toString() ?? "",
    firstName: userObj.firstName ?? "مستخدم",
    lastName: userObj.lastName ?? "",
    username: userObj.username ?? "",
    phone: userObj.phone ?? "",
  };
}

async function finalizeAuthorizedLogin(client: TelegramClientType): Promise<{
  status: "authorized";
  user: AuthorizedUser;
  sessionString: string;
}> {
  currentSessionString = String(client.session.save() ?? "");
  currentUser = await extractAuthorizedUser(client);
  if (pendingAuth) {
    pendingAuth.stage = "done";
  }
  return {
    status: "authorized",
    user: currentUser,
    sessionString: currentSessionString,
  };
}

async function getTwoFaHint(client: TelegramClientType): Promise<string> {
  try {
    const srp = await client.invoke(new Api.account.GetPassword());
    return String(srp.hint ?? "");
  } catch {
    return "";
  }
}

// ==============================================================================
// حالة البث وتدفق الأحداث المباشر (SSE)
// ==============================================================================
const sseClients = new Set<express.Response>();
let broadcastAbortController: AbortController | null = null;

let broadcastState: BroadcastState = {
  status: "idle",
  currentCycle: 0,
  totalCyclesCompleted: 0,
  totalTargets: 0,
  processedCount: 0,
  succeededCount: 0,
  totalSentAllCycles: 0,
  skippedCount: 0,
  failedCount: 0,
  floodWaitsCount: 0,
  newGroupsDiscoveredCount: 0,
  currentGroupTitle: "",
  countdownSeconds: 0,
  countdownReason: "",
  startedAt: null,
  finishedAt: null,
  groupStatuses: {},
  logs: [],
};

const keepAliveStats = {
  startedAt: new Date().toISOString(),
  pingCount: 0,
  lastPingAt: null as string | null,
};

function emitSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function appendLog(level: LogEntry["level"], message: string): void {
  const now = new Date();
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.toTimeString().slice(0, 8),
    level,
    message,
  };
  broadcastState.logs = [...broadcastState.logs.slice(-199), entry];
  console.log(`[${entry.timestamp}] [${level.toUpperCase()}] ${message}`);
  emitSSE("log", entry);
}

function syncBroadcastSnapshot(): void {
  emitSSE("state", broadcastState);
}

function sleepWithCountdown(
  totalSeconds: number,
  reason: string,
  stateMode: "waiting" | "flood_wait",
  signal: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted || totalSeconds <= 0) {
      broadcastState.countdownSeconds = 0;
      broadcastState.countdownReason = "";
      syncBroadcastSnapshot();
      resolve(!signal.aborted);
      return;
    }

    let remaining = Math.ceil(totalSeconds);
    broadcastState.status = stateMode;
    broadcastState.countdownSeconds = remaining;
    broadcastState.countdownReason = reason;
    syncBroadcastSnapshot();

    const interval = setInterval(() => {
      if (signal.aborted) {
        clearInterval(interval);
        broadcastState.countdownSeconds = 0;
        broadcastState.countdownReason = "";
        syncBroadcastSnapshot();
        resolve(false);
        return;
      }

      remaining -= 1;
      broadcastState.countdownSeconds = Math.max(0, remaining);
      syncBroadcastSnapshot();

      if (remaining <= 0) {
        clearInterval(interval);
        broadcastState.countdownReason = "";
        syncBroadcastSnapshot();
        resolve(true);
      }
    }, 1000);

    signal.addEventListener(
      "abort",
      () => {
        clearInterval(interval);
        broadcastState.countdownSeconds = 0;
        broadcastState.countdownReason = "";
        syncBroadcastSnapshot();
        resolve(false);
      },
      { once: true }
    );
  });
}

function extractFloodWaitSeconds(err: unknown): number | null {
  const anyErr = err as { seconds?: number; message?: string; errorMessage?: string };
  if (typeof anyErr?.seconds === "number" && anyErr.seconds > 0) {
    return anyErr.seconds;
  }
  const msg = `${anyErr?.errorMessage ?? ""} ${anyErr?.message ?? ""}`.toUpperCase();
  const match = msg.match(/FLOOD_WAIT[_\s]?(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function extractSlowModeSeconds(err: unknown): number | null {
  const anyErr = err as { seconds?: number; message?: string; errorMessage?: string };
  const msg = `${anyErr?.errorMessage ?? ""} ${anyErr?.message ?? ""}`.toUpperCase();
  if (msg.includes("SLOWMODE_WAIT")) {
    if (typeof anyErr?.seconds === "number") return anyErr.seconds;
    const match = msg.match(/SLOWMODE_WAIT[_\s]?(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
  return null;
}

function isRestrictionError(err: unknown): string | null {
  const anyErr = err as { message?: string; errorMessage?: string; constructor?: { name?: string } };
  const msg = `${anyErr?.errorMessage ?? ""} ${anyErr?.message ?? ""} ${anyErr?.constructor?.name ?? ""}`.toUpperCase();

  if (msg.includes("USER_BANNED_IN_CHANNEL")) return "الحساب محظور من النشر في هذه المجموعة";
  if (msg.includes("CHAT_WRITE_FORBIDDEN")) return "صلاحية الكتابة ممنوعة في هذه المجموعة";
  if (msg.includes("CHAT_SEND_PLAIN_FORBIDDEN")) return "إرسال الرسائل النصية مقيد في هذه المجموعة";
  if (msg.includes("CHAT_RESTRICTED")) return "المجموعة مقيدة حالياً";
  if (msg.includes("CHANNEL_PRIVATE")) return "المجموعة خاصة أو لم تعد عضواً فيها";
  if (msg.includes("CHAT_ADMIN_REQUIRED")) return "النشر يتطلب صلاحيات مشرف";
  return null;
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * توزيع القوالب على المجموعات في الدورة الواحدة:
 * - كل مجموعة تتلقى قالباً واحداً فقط في الدورة.
 * - يتم توزيع القوالب عشوائياً وبأكبر تنوع ممكن داخل الدورة.
 * - في الدورات التالية يتم تدوير القوالب بحيث لا تحصل المجموعة على نفس القالب المتتالي (عند وجود قالبين فأكثر).
 */
function assignTemplatesForCycle(
  activeGroups: TargetGroup[],
  templates: TemplatePayload[],
  lastTemplateIdxByGroup: Map<string, number>
): Map<string, { templateIndex: number; template: TemplatePayload }> {
  const tCount = templates.length;
  const gCount = activeGroups.length;
  const result = new Map<string, { templateIndex: number; template: TemplatePayload }>();

  if (tCount === 0 || gCount === 0) return result;

  // بناء رزمة متوازنة ومخلوطة عشوائياً من مؤشرات القوالب
  const deck: number[] = [];
  while (deck.length < gCount) {
    const indices = shuffleArray(Array.from({ length: tCount }, (_, idx) => idx));
    deck.push(...indices);
  }
  const assignedIndices = shuffleArray(deck.slice(0, gCount));

  // ضمان تبديل القالب عن الدورة السابقة لكل مجموعة عندما يتوفر قالبان فأكثر
  if (tCount >= 2) {
    for (let i = 0; i < gCount; i++) {
      const grpId = activeGroups[i].id;
      const prevIdx = lastTemplateIdxByGroup.get(grpId);
      if (prevIdx !== undefined && assignedIndices[i] === prevIdx) {
        let swapped = false;
        for (let j = 0; j < gCount; j++) {
          if (i === j) continue;
          const otherPrevIdx = lastTemplateIdxByGroup.get(activeGroups[j].id);
          if (assignedIndices[j] !== prevIdx && assignedIndices[i] !== otherPrevIdx) {
            [assignedIndices[i], assignedIndices[j]] = [assignedIndices[j], assignedIndices[i]];
            swapped = true;
            break;
          }
        }
        if (!swapped) {
          const candidates = Array.from({ length: tCount }, (_, idx) => idx).filter(
            (idx) => idx !== prevIdx
          );
          assignedIndices[i] = candidates[Math.floor(Math.random() * candidates.length)];
        }
      }
    }
  }

  for (let i = 0; i < gCount; i++) {
    const tIdx = assignedIndices[i];
    lastTemplateIdxByGroup.set(activeGroups[i].id, tIdx);
    result.set(activeGroups[i].id, {
      templateIndex: tIdx,
      template: templates[tIdx],
    });
  }

  return result;
}

async function scanAuthorizedGroups(
  client: TelegramClientType,
  adminOnly: boolean
): Promise<TargetGroup[]> {
  const dialogs = await client.getDialogs({ limit: 300 });
  const groups: TargetGroup[] = [];
  entityMap.clear();

  for (const dialog of dialogs) {
    if (!dialog.isGroup || !dialog.entity) continue;

    const entity = dialog.entity as unknown as {
      className?: string;
      id?: { toString: () => string };
      title?: string;
      username?: string;
      participantsCount?: number;
      creator?: boolean;
      left?: boolean;
      kicked?: boolean;
      deactivated?: boolean;
      adminRights?: { postMessages?: boolean };
      bannedRights?: { sendMessages?: boolean };
      defaultBannedRights?: { sendMessages?: boolean };
    };

    if (entity.left || entity.kicked || entity.deactivated) continue;

    const isCreator = Boolean(entity.creator);
    const isAdmin = Boolean(entity.adminRights);
    const userSendForbidden = Boolean(entity.bannedRights?.sendMessages);

    if (userSendForbidden && !isCreator) continue;

    let roleLabel = "";
    let allowed = false;

    if (isCreator) {
      roleLabel = "مالك المجموعة";
      allowed = true;
    } else if (isAdmin) {
      roleLabel = "مشرف بصلاحية النشر";
      allowed = true;
    } else if (!adminOnly) {
      const defaultSendForbidden = Boolean(entity.defaultBannedRights?.sendMessages);
      if (!defaultSendForbidden) {
        roleLabel = "عضو بصلاحية النشر";
        allowed = true;
      }
    }

    if (!allowed) continue;

    const idStr = dialog.id?.toString() ?? entity.id?.toString() ?? "";
    if (!idStr) continue;

    const groupInfo: TargetGroup = {
      id: idStr,
      title: dialog.title || entity.title || `مجموعة ${idStr}`,
      roleLabel,
      isAdmin: isCreator || isAdmin,
      membersCount: Number(entity.participantsCount ?? 0),
      username: entity.username ?? "",
    };

    groups.push(groupInfo);
    entityMap.set(idStr, dialog.entity);
  }

  cachedGroups = groups;
  return groups;
}

async function executeBroadcastJob(params: {
  groupIds: string[];
  templates: TemplatePayload[];
  minDelaySec: number;
  maxDelaySec: number;
  useVariation: boolean;
  adminOnly: boolean;
  autoIncludeNewGroups: boolean;
  botToken: string;
  adminChatId: string;
}): Promise<void> {
  const client = activeClient;
  if (!client) return;

  const controller = new AbortController();
  broadcastAbortController = controller;
  const skippedGroupIdsThisSession = new Set<string>();
  const lastTemplateIdxByGroup = new Map<string, number>();

  const knownGroupIds = new Set(cachedGroups.map((g) => g.id));
  const targetGroupIds = new Set(params.groupIds);

  let currentPool = cachedGroups.filter((g) => targetGroupIds.has(g.id));

  broadcastState = {
    status: "running",
    currentCycle: 1,
    totalCyclesCompleted: 0,
    totalTargets: currentPool.length,
    processedCount: 0,
    succeededCount: 0,
    totalSentAllCycles: 0,
    skippedCount: 0,
    failedCount: 0,
    floodWaitsCount: 0,
    newGroupsDiscoveredCount: 0,
    currentGroupTitle: "",
    countdownSeconds: 0,
    countdownReason: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    groupStatuses: {},
    logs: [],
  };
  syncBroadcastSnapshot();

  const minMinDisplay = (params.minDelaySec / 60).toFixed(1).replace(/\.0$/, "");
  const maxMinDisplay = (params.maxDelaySec / 60).toFixed(1).replace(/\.0$/, "");

  appendLog(
    "info",
    `بدء النظام المستمر في (${currentPool.length}) مجموعة باستخدام (${params.templates.length}) قوالب وبفاصل عشوائي ${minMinDisplay}–${maxMinDisplay} دقيقة.`
  );

  if (params.botToken && params.adminChatId) {
    await sendBotNotification(
      params.botToken,
      params.adminChatId,
      `🚀 <b>بدء نظام البث المجتمعي المستمر</b>\n• عدد المجموعات: <b>${currentPool.length}</b>\n• عدد القوالب المتاحة للتوزيع: <b>${params.templates.length}</b>\n• الفاصل الزمني العشوائي: <b>${minMinDisplay} - ${maxMinDisplay} دقيقة</b>\n• التحديث التلقائي للمجموعات الجديدة: <b>${params.autoIncludeNewGroups ? "مفعّل" : "معطّل"}</b>`
    );
  }

  let cycleNumber = 0;

  while (!controller.signal.aborted) {
    cycleNumber += 1;

    // إعادة فحص المجموعات تلقائياً مع بداية كل دورة لاكتشاف أي مجموعات جديدة انضم إليها الحساب
    if (params.autoIncludeNewGroups && cycleNumber > 1) {
      appendLog("info", `🔍 [الدورة #${cycleNumber}] جاري إعادة فحص المجموعات لاكتشاف أي مجموعات جديدة...`);
      try {
        const latestGroups = await scanAuthorizedGroups(client, params.adminOnly);
        emitSSE("groups", latestGroups);

        const newlyJoined: TargetGroup[] = [];
        for (const grp of latestGroups) {
          if (!knownGroupIds.has(grp.id)) {
            knownGroupIds.add(grp.id);
            if (!skippedGroupIdsThisSession.has(grp.id)) {
              targetGroupIds.add(grp.id);
              newlyJoined.push(grp);
            }
          }
        }

        currentPool = latestGroups.filter((g) => targetGroupIds.has(g.id));

        if (newlyJoined.length > 0) {
          broadcastState.newGroupsDiscoveredCount += newlyJoined.length;
          const names = newlyJoined.map((g) => g.title).join("، ");
          appendLog(
            "success",
            `🆕 تم اكتشاف (${newlyJoined.length}) مجموعة جديدة وإضافتها تلقائياً للدورة #${cycleNumber}: ${names}`
          );
          if (params.botToken && params.adminChatId) {
            await sendBotNotification(
              params.botToken,
              params.adminChatId,
              `🆕 <b>تم اكتشاف مجموعات جديدة وإضافتها تلقائياً</b>\n• الدورة: <b>#${cycleNumber}</b>\n• العدد المضاف: <b>${newlyJoined.length}</b>\n• المجموعات: <b>${escapeHtml(names)}</b>`
            );
          }
        } else {
          appendLog(
            "info",
            `تم تحديث القائمة للدورة #${cycleNumber}: (${currentPool.length}) مجموعة متاحة دون إضافات جديدة.`
          );
        }
      } catch (scanErr) {
        const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
        appendLog(
          "warning",
          `تعذر تحديث قائمة المجموعات في بداية الدورة #${cycleNumber} (${msg}) — المتابعة بالقائمة الحالية.`
        );
      }
    }

    // ترتيب عشوائي للمجموعات النشطة في كل دورة لمزيد من الطبيعية
    const activeTargets = shuffleArray(
      currentPool.filter((grp) => !skippedGroupIdsThisSession.has(grp.id))
    );

    if (activeTargets.length === 0) {
      appendLog(
        "warning",
        "تم إيقاف الحلقة المستمرة تلقائياً لأن جميع المجموعات المستهدفة أصبحت مقيدة الصلاحية في هذه الجلسة."
      );
      if (params.botToken && params.adminChatId) {
        await sendBotNotification(
          params.botToken,
          params.adminChatId,
          "⚠️ <b>توقف النظام المستمر</b>\nجميع المجموعات المحددة مقيدة الصلاحية في هذه الجلسة، ولا توجد مجموعات متاحة للنشر."
        );
      }
      break;
    }

    // توزيع القوالب على المجموعات لهذه الدورة (قالب واحد لكل مجموعة مع تبديل عن الدورة السابقة)
    const cycleAssignments = assignTemplatesForCycle(
      activeTargets,
      params.templates,
      lastTemplateIdxByGroup
    );

    broadcastState.status = "running";
    broadcastState.currentCycle = cycleNumber;
    broadcastState.totalTargets = activeTargets.length;
    broadcastState.processedCount = 0;
    broadcastState.succeededCount = 0;

    const cycleStatuses: Record<string, GroupStatusRecord> = {};
    for (const grp of currentPool) {
      if (skippedGroupIdsThisSession.has(grp.id)) {
        const prevSkipped = broadcastState.groupStatuses[grp.id];
        cycleStatuses[grp.id] = {
          groupId: grp.id,
          title: grp.title,
          status: "skipped",
          detail: prevSkipped?.detail || "تم التخطي للقيود في دورة سابقة",
          assignedTemplateTitle: "—",
          cycleNumber,
          updatedAt: prevSkipped?.updatedAt || new Date().toTimeString().slice(0, 8),
        };
      } else {
        const assignment = cycleAssignments.get(grp.id);
        cycleStatuses[grp.id] = {
          groupId: grp.id,
          title: grp.title,
          status: "pending",
          detail: "في انتظار دورها في هذه الدورة",
          assignedTemplateTitle: assignment?.template.title || "قالب تعليمي",
          cycleNumber,
          updatedAt: new Date().toTimeString().slice(0, 8),
        };
      }
    }
    broadcastState.groupStatuses = cycleStatuses;
    syncBroadcastSnapshot();

    appendLog(
      "info",
      `🔄 بدء الدورة رقم #${cycleNumber} — تم توزيع (${params.templates.length}) قوالب على (${activeTargets.length}) مجموعة نشطة.`
    );

    if (cycleNumber > 1 && params.botToken && params.adminChatId) {
      await sendBotNotification(
        params.botToken,
        params.adminChatId,
        `🔄 <b>بدء الدورة رقم #${cycleNumber}</b>\n• المجموعات النشطة: <b>${activeTargets.length}</b>\n• تم إعادة تدوير وتبديل القوالب على المجموعات بنجاح.`
      );
    }

    for (let i = 0; i < activeTargets.length; i++) {
      if (controller.signal.aborted) break;

      const group = activeTargets[i];
      const entity = entityMap.get(group.id);
      const assignment = cycleAssignments.get(group.id);
      const assignedTitle = assignment?.template.title || "قالب تعليمي";
      const assignedContent = assignment?.template.content || params.templates[0].content;

      broadcastState.status = "running";
      broadcastState.currentGroupTitle = group.title;

      if (!entity || skippedGroupIdsThisSession.has(group.id)) {
        broadcastState.processedCount += 1;
        broadcastState.skippedCount += 1;
        broadcastState.groupStatuses[group.id] = {
          groupId: group.id,
          title: group.title,
          status: "skipped",
          detail: "تم التخطي مسبقاً في هذه الجلسة",
          assignedTemplateTitle: assignedTitle,
          cycleNumber,
          updatedAt: new Date().toTimeString().slice(0, 8),
        };
        syncBroadcastSnapshot();
        continue;
      }

      broadcastState.groupStatuses[group.id] = {
        groupId: group.id,
        title: group.title,
        status: "sending",
        detail: `جاري إرسال "${assignedTitle}"...`,
        assignedTemplateTitle: assignedTitle,
        cycleNumber,
        updatedAt: new Date().toTimeString().slice(0, 8),
      };
      syncBroadcastSnapshot();

      const formattedMessage = formatMessageForGroup(
        assignedContent,
        group.title,
        params.useVariation
      );

      appendLog(
        "info",
        `[الدورة #${cycleNumber} · ${i + 1}/${activeTargets.length}] جاري إرسال "${assignedTitle}" إلى "${group.title}"...`
      );

      let sent = false;
      while (!sent && !controller.signal.aborted) {
        try {
          await client.sendMessage(entity as never, {
            message: formattedMessage,
            parseMode: "html",
            linkPreview: false,
          });

          sent = true;
          broadcastState.processedCount += 1;
          broadcastState.succeededCount += 1;
          broadcastState.totalSentAllCycles += 1;
          broadcastState.groupStatuses[group.id] = {
            groupId: group.id,
            title: group.title,
            status: "sent",
            detail: `تم نشر "${assignedTitle}" بنجاح`,
            assignedTemplateTitle: assignedTitle,
            cycleNumber,
            updatedAt: new Date().toTimeString().slice(0, 8),
          };
          appendLog(
            "success",
            `[الدورة #${cycleNumber}] تم نشر "${assignedTitle}" بنجاح في "${group.title}".`
          );
          syncBroadcastSnapshot();

          if (params.botToken && params.adminChatId) {
            await sendBotNotification(
              params.botToken,
              params.adminChatId,
              `✅ <b>تم النشر بنجاح (الدورة #${cycleNumber})</b> [${i + 1}/${activeTargets.length}]\n• المجموعة: <b>${escapeHtml(group.title)}</b>\n• القالب المخصص: <b>${escapeHtml(assignedTitle)}</b>`
            );
          }
        } catch (err) {
          const floodSecs = extractFloodWaitSeconds(err);
          if (floodSecs !== null) {
            const waitSeconds = floodSecs + 5;
            broadcastState.floodWaitsCount += 1;
            appendLog(
              "warning",
              `تنبيه FloodWait من تيليجرام: التوقف الإجباري لمدة ${waitSeconds} ثانية قبل استكمال "${group.title}".`
            );
            if (params.botToken && params.adminChatId) {
              await sendBotNotification(
                params.botToken,
                params.adminChatId,
                `⏳ <b>توقف مؤقت (FloodWait)</b>\n• المدة المطلوبة: <b>${waitSeconds} ثانية</b>\n• الدورة: <b>#${cycleNumber}</b> | المجموعة: <b>${escapeHtml(group.title)}</b>`
              );
            }

            const completedWait = await sleepWithCountdown(
              waitSeconds,
              `توقف مؤقت بسبب قيود معدل الطلبات (FloodWait) لـ "${group.title}"`,
              "flood_wait",
              controller.signal
            );
            if (!completedWait) break;
            continue;
          }

          const slowModeSecs = extractSlowModeSeconds(err);
          if (slowModeSecs !== null) {
            const reason = `الوضع البطيء مفعّل (${slowModeSecs} ثانية) — تخطي دون إعادة`;
            skippedGroupIdsThisSession.add(group.id);
            broadcastState.processedCount += 1;
            broadcastState.skippedCount += 1;
            broadcastState.groupStatuses[group.id] = {
              groupId: group.id,
              title: group.title,
              status: "skipped",
              detail: reason,
              assignedTemplateTitle: assignedTitle,
              cycleNumber,
              updatedAt: new Date().toTimeString().slice(0, 8),
            };
            appendLog("warning", `تخطي "${group.title}" (دون إعادة): ${reason}`);
            syncBroadcastSnapshot();

            if (params.botToken && params.adminChatId) {
              await sendBotNotification(
                params.botToken,
                params.adminChatId,
                `⏭️ <b>تم تخطي المجموعة (دون إعادة)</b>\n• المجموعة: <b>${escapeHtml(group.title)}</b>\n• السبب: ${escapeHtml(reason)}`
              );
            }
            break;
          }

          const restrictionReason = isRestrictionError(err);
          if (restrictionReason) {
            skippedGroupIdsThisSession.add(group.id);
            broadcastState.processedCount += 1;
            broadcastState.skippedCount += 1;
            broadcastState.groupStatuses[group.id] = {
              groupId: group.id,
              title: group.title,
              status: "skipped",
              detail: restrictionReason,
              assignedTemplateTitle: assignedTitle,
              cycleNumber,
              updatedAt: new Date().toTimeString().slice(0, 8),
            };
            appendLog(
              "warning",
              `تخطي "${group.title}" بسبب قيود الصلاحية (لن تتم إعادة المحاولة): ${restrictionReason}`
            );
            syncBroadcastSnapshot();

            if (params.botToken && params.adminChatId) {
              await sendBotNotification(
                params.botToken,
                params.adminChatId,
                `🚫 <b>تم تخطي المجموعة بسبب القيود</b>\n• المجموعة: <b>${escapeHtml(group.title)}</b>\n• السبب: ${escapeHtml(restrictionReason)}\n• الإجراء: استبعاد دائم لبقية الجلسة.`
              );
            }
            break;
          }

          // خطأ عام آخر — لا نعيد المحاولة لهذه المجموعة في هذه الدورة
          const errMsg = err instanceof Error ? err.message : String(err);
          broadcastState.processedCount += 1;
          broadcastState.failedCount += 1;
          broadcastState.groupStatuses[group.id] = {
            groupId: group.id,
            title: group.title,
            status: "error",
            detail: errMsg,
            assignedTemplateTitle: assignedTitle,
            cycleNumber,
            updatedAt: new Date().toTimeString().slice(0, 8),
          };
          appendLog("error", `تعذر الإرسال إلى "${group.title}": ${errMsg}`);
          syncBroadcastSnapshot();

          if (params.botToken && params.adminChatId) {
            await sendBotNotification(
              params.botToken,
              params.adminChatId,
              `❌ <b>فشل الإرسال</b>\n• المجموعة: <b>${escapeHtml(group.title)}</b>\n• التفاصيل: ${escapeHtml(errMsg)}`
            );
          }
          break;
        }
      }

      if (controller.signal.aborted) break;

      // فاصل زمني عشوائي متغير (Jitter Pacing) بين كل إرسال وآخر
      // يشمل الانتقال من آخر مجموعة في الدورة الحالية إلى أول مجموعة في الدورة التالية
      const min = Math.min(params.minDelaySec, params.maxDelaySec);
      const max = Math.max(params.minDelaySec, params.maxDelaySec);
      const jitterDelaySec = Math.floor(Math.random() * (max - min + 1)) + min;
      const mins = Math.floor(jitterDelaySec / 60);
      const secs = jitterDelaySec % 60;

      const isLastInCycle = i === activeTargets.length - 1;
      const nextContext = isLastInCycle
        ? `قبل انطلاق الدورة رقم #${cycleNumber + 1}`
        : `قبل المجموعة التالية ("${activeTargets[i + 1].title}")`;

      if (isLastInCycle) {
        broadcastState.totalCyclesCompleted += 1;
        appendLog(
          "success",
          `🏁 اكتملت الدورة رقم #${cycleNumber} بنجاح (${broadcastState.succeededCount}/${activeTargets.length}). جاري التدوير التلقائي للدورة #${cycleNumber + 1}...`
        );
        if (params.botToken && params.adminChatId) {
          await sendBotNotification(
            params.botToken,
            params.adminChatId,
            `🏁 <b>اكتملت الدورة رقم #${cycleNumber}</b>\n• تم النشر في <b>${broadcastState.succeededCount}</b> مجموعة\n• إجمالي المنشورات التراكمي: <b>${broadcastState.totalSentAllCycles}</b>\n• سينتقل النظام تلقائياً للدورة #${cycleNumber + 1} بعد فاصل عشوائي (${mins} د و ${secs} ث).`
          );
        }
      }

      appendLog(
        "info",
        `⏳ فاصل عشوائي (Jitter): انتظار ${mins} دقيقة و ${secs} ثانية ${nextContext}...`
      );
      const completedDelay = await sleepWithCountdown(
        jitterDelaySec,
        `فاصل عشوائي (${mins} د ${secs} ث) ${nextContext}`,
        "waiting",
        controller.signal
      );
      if (!completedDelay) break;
    }
  }

  const wasStopped = controller.signal.aborted;
  broadcastState.status = wasStopped ? "stopped" : "completed";
  broadcastState.currentGroupTitle = "";
  broadcastState.countdownSeconds = 0;
  broadcastState.countdownReason = "";
  broadcastState.finishedAt = new Date().toISOString();
  broadcastAbortController = null;

  const finalLabel = wasStopped
    ? "تم إيقاف الحلقة المستمرة يدوياً."
    : "توقفت الحلقة التشغيلية.";
  appendLog(
    "warning",
    `${finalLabel} الدورات المكتملة: ${broadcastState.totalCyclesCompleted} | إجمالي المنشورات: ${broadcastState.totalSentAllCycles} | مستبعدة للقيود: ${broadcastState.skippedCount}`
  );
  syncBroadcastSnapshot();

  if (params.botToken && params.adminChatId) {
    await sendBotNotification(
      params.botToken,
      params.adminChatId,
      `🛑 <b>${finalLabel}</b>\n\n📊 <b>الملخص التراكمي للجلسة:</b>\n• الدورات المكتملة: <b>${broadcastState.totalCyclesCompleted}</b>\n• إجمالي المنشورات الناجحة: <b>${broadcastState.totalSentAllCycles}</b>\n• مجموعات مستبعدة للقيود: <b>${broadcastState.skippedCount}</b>\n• تنبيهات FloodWait: <b>${broadcastState.floodWaitsCount}</b>`
    );
  }
}

// ==============================================================================
// إعداد تطبيق Express ومسارات API
// ==============================================================================
async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // مسارات التنشيط السحابي 24/7 (Render + UptimeRobot) — تدعم GET و HEAD
  const handleKeepAlivePing = (req: express.Request, res: express.Response) => {
    keepAliveStats.pingCount += 1;
    keepAliveStats.lastPingAt = new Date().toISOString();
    emitSSE("keepalive", keepAliveStats);

    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }

    res.status(200).json({
      ok: true,
      status: "alive",
      uptimeSeconds: Math.floor(process.uptime()),
      broadcastStatus: broadcastState.status,
      currentCycle: broadcastState.currentCycle,
      pingCount: keepAliveStats.pingCount,
      lastPingAt: keepAliveStats.lastPingAt,
    });
  };

  app.all("/ping", handleKeepAlivePing);
  app.all("/healthz", handleKeepAlivePing);
  app.all("/api/ping", handleKeepAlivePing);

  app.get("/api/keepalive", (_req, res) => {
    res.json({
      ...keepAliveStats,
      pingPath: "/ping",
    });
  });

  // تدفق الأحداث المباشر SSE
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    sseClients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(broadcastState)}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  // حالة المصادقة الحالية
  app.get("/api/auth/status", async (_req, res) => {
    if (!activeClient || !currentUser) {
      res.json({
        authorized: false,
        stage: pendingAuth?.stage ?? "idle",
        passwordHint: pendingAuth?.passwordHint ?? "",
      });
      return;
    }

    res.json({
      authorized: true,
      user: currentUser,
      sessionString: currentSessionString,
    });
  });

  // استعادة جلسة محفوظة (StringSession)
  app.post("/api/auth/restore", async (req, res) => {
    try {
      const apiId = Number(normalizeNumericInput(String(req.body.apiId ?? "")));
      const apiHash = String(req.body.apiHash ?? "").trim();
      const sessionString = String(req.body.sessionString ?? "").trim();

      if (!apiId || !apiHash || !sessionString) {
        res.status(400).json({ error: "بيانات الجلسة المحفوظة غير مكتملة." });
        return;
      }

      await disconnectActiveClient();
      const client = createTelegramClient(sessionString, apiId, apiHash);
      await client.connect();
      const isAuth = await client.checkAuthorization();
      if (!isAuth) {
        await client.disconnect();
        res.status(401).json({
          error: "انتهت صلاحية الجلسة المحفوظة. يرجى تسجيل الدخول برقم الهاتف أو رمز QR.",
        });
        return;
      }

      activeClient = client;
      const result = await finalizeAuthorizedLogin(client);
      res.json({ authorized: true, user: result.user, sessionString: result.sessionString });
    } catch (err) {
      const parsed = translateTelegramError(err);
      res.status(400).json({ error: parsed.message });
    }
  });

  // الخطوة 1: إرسال رمز التحقق مباشرة مع فحص قناة التوصيل (App / Email / SMS / Firebase)
  app.post("/api/auth/send-code", async (req, res) => {
    try {
      const apiId = Number(normalizeNumericInput(String(req.body.apiId ?? "")));
      const apiHash = String(req.body.apiHash ?? "").trim();
      const phoneNumber = normalizePhoneNumber(String(req.body.phoneNumber ?? ""));

      if (!apiId || Number.isNaN(apiId) || !apiHash || phoneNumber.length < 7) {
        res.status(400).json({
          error: "يرجى إدخال API ID و API Hash ورقم الهاتف بالصيغة الدولية الصحيحة.",
        });
        return;
      }

      await disconnectActiveClient();

      const client = createTelegramClient("", apiId, apiHash);
      activeClient = client;
      await client.connect();

      const codeSettings = new Api.CodeSettings({
        allowFlashcall: false,
        allowMissedCall: false,
        allowFirebase: false,
        currentNumber: true,
      });

      let sendResult: ApiType.auth.TypeSentCode | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          sendResult = await client.invoke(
            new Api.auth.SendCode({
              phoneNumber,
              apiId,
              apiHash,
              settings: codeSettings,
            })
          );
          break;
        } catch (err) {
          const msg = String((err as { errorMessage?: string; message?: string })?.errorMessage ?? err).toUpperCase();
          if (msg.includes("AUTH_RESTART") && attempt < 2) {
            continue;
          }
          throw err;
        }
      }

      if (!sendResult) {
        throw new Error("لم يتم استلام استجابة من خادم تيليجرام.");
      }

      if (sendResult instanceof Api.auth.SentCodeSuccess) {
        const finalAuth = await finalizeAuthorizedLogin(client);
        res.json(finalAuth);
        return;
      }

      const info = describeSentCode(sendResult);
      pendingAuth = {
        mode: "phone",
        apiId,
        apiHash,
        phoneNumber,
        phoneCodeHash: sendResult.phoneCodeHash,
        deliveryInfo: info,
        stage: info.deliveryType === "setup_email" ? "awaiting_email_setup" : "awaiting_code",
      };

      res.json({
        status:
          info.deliveryType === "setup_email" ? "setup_email_required" : "code_required",
        deliveryInfo: info,
      });
    } catch (err) {
      if (!pendingAuth) {
        await disconnectActiveClient();
      }
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  // إعادة إرسال الكود عبر القناة البديلة (SMS أو اتصال) عند تأخر أو عدم وصول الكود
  app.post("/api/auth/resend-code", async (_req, res) => {
    try {
      if (!activeClient || !pendingAuth || !pendingAuth.phoneCodeHash) {
        res.status(400).json({ error: "لا توجد جلسة إرسال كود نشطة. اطلب كوداً جديداً أولاً." });
        return;
      }

      const resendResult = await activeClient.invoke(
        new Api.auth.ResendCode({
          phoneNumber: pendingAuth.phoneNumber,
          phoneCodeHash: pendingAuth.phoneCodeHash,
        })
      );

      if (resendResult instanceof Api.auth.SentCodeSuccess) {
        const finalAuth = await finalizeAuthorizedLogin(activeClient);
        res.json(finalAuth);
        return;
      }

      const info = describeSentCode(resendResult);
      pendingAuth.phoneCodeHash = resendResult.phoneCodeHash;
      pendingAuth.deliveryInfo = info;
      pendingAuth.stage =
        info.deliveryType === "setup_email" ? "awaiting_email_setup" : "awaiting_code";

      res.json({
        status:
          info.deliveryType === "setup_email" ? "setup_email_required" : "code_required",
        deliveryInfo: info,
      });
    } catch (err) {
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  // إلغاء الكود المعلق بأمان عند تغيير الرقم
  app.post("/api/auth/cancel-code", async (_req, res) => {
    await cancelPendingPhoneCodeSafely(activeClient, pendingAuth);
    if (pendingAuth) {
      pendingAuth.phoneCodeHash = "";
      pendingAuth.stage = "idle";
    }
    res.json({ ok: true });
  });

  // في حال طلب تيليجرام ربط بريد إلكتروني للرقم (SentCodeTypeSetUpEmailRequired)
  app.post("/api/auth/setup-email/send", async (req, res) => {
    try {
      const email = String(req.body.email ?? "").trim();
      if (!email || !email.includes("@")) {
        res.status(400).json({ error: "يرجى إدخال بريد إلكتروني صحيح." });
        return;
      }
      if (!activeClient || !pendingAuth || !pendingAuth.phoneCodeHash) {
        res.status(400).json({ error: "لا توجد جلسة تحقق نشطة." });
        return;
      }

      await activeClient.invoke(
        new Api.account.SendVerifyEmailCode({
          purpose: new Api.EmailVerifyPurposeLoginSetup({
            phoneNumber: pendingAuth.phoneNumber,
            phoneCodeHash: pendingAuth.phoneCodeHash,
          }),
          email,
        })
      );

      pendingAuth.stage = "awaiting_email_setup_code";
      res.json({ ok: true, email });
    } catch (err) {
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  app.post("/api/auth/setup-email/verify", async (req, res) => {
    try {
      const code = normalizeNumericInput(String(req.body.code ?? ""));
      if (!code) {
        res.status(400).json({ error: "يرجى إدخال رمز البريد الإلكتروني." });
        return;
      }
      if (!activeClient || !pendingAuth || !pendingAuth.phoneCodeHash) {
        res.status(400).json({ error: "لا توجد جلسة تحقق نشطة." });
        return;
      }

      const verified = await activeClient.invoke(
        new Api.account.VerifyEmail({
          purpose: new Api.EmailVerifyPurposeLoginSetup({
            phoneNumber: pendingAuth.phoneNumber,
            phoneCodeHash: pendingAuth.phoneCodeHash,
          }),
          verification: new Api.EmailVerificationCode({ code }),
        })
      );

      if (verified instanceof Api.account.EmailVerifiedLogin) {
        if (verified.sentCode instanceof Api.auth.SentCodeSuccess) {
          const finalAuth = await finalizeAuthorizedLogin(activeClient);
          res.json(finalAuth);
          return;
        }
        const info = describeSentCode(verified.sentCode);
        pendingAuth.phoneCodeHash = verified.sentCode.phoneCodeHash;
        pendingAuth.deliveryInfo = info;
        pendingAuth.stage = "awaiting_code";
        res.json({ status: "code_required", deliveryInfo: info });
        return;
      }

      res.json({ status: "code_required", deliveryInfo: pendingAuth.deliveryInfo });
    } catch (err) {
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  // الخطوة 2: التحقق من الرمز (يدعم كود الهاتف وأيضاً كود الإيميل EmailVerificationCode)
  app.post("/api/auth/verify-code", async (req, res) => {
    try {
      const code = normalizeNumericInput(String(req.body.phoneCode ?? ""));
      if (!code) {
        res.status(400).json({ error: "يرجى إدخال رمز التحقق." });
        return;
      }
      if (!activeClient || !pendingAuth || !pendingAuth.phoneCodeHash) {
        res.status(400).json({ error: "لا توجد عملية تسجيل دخول نشطة بانتظار الرمز." });
        return;
      }

      const { phoneNumber, phoneCodeHash, deliveryInfo } = pendingAuth;
      const client = activeClient;

      let signInResult: ApiType.auth.TypeAuthorization | null = null;
      const preferEmailVerification = deliveryInfo?.deliveryType === "email";

      try {
        signInResult = await client.invoke(
          new Api.auth.SignIn(
            preferEmailVerification
              ? {
                  phoneNumber,
                  phoneCodeHash,
                  emailVerification: new Api.EmailVerificationCode({ code }),
                }
              : {
                  phoneNumber,
                  phoneCodeHash,
                  phoneCode: code,
                }
          )
        );
      } catch (primaryErr) {
        const primaryMsg = String(
          (primaryErr as { errorMessage?: string; message?: string })?.errorMessage ?? primaryErr
        ).toUpperCase();

        if (primaryMsg.includes("SESSION_PASSWORD_NEEDED")) {
          const hint = await getTwoFaHint(client);
          pendingAuth.stage = "awaiting_password";
          pendingAuth.passwordHint = hint;
          res.json({ status: "password_required", hint });
          return;
        }

        // تجربة الطريقة البديلة تلقائياً إذا طلب تيليجرام emailVerification أو phoneCode بالعكس
        const shouldTryAlternate =
          (preferEmailVerification &&
            (primaryMsg.includes("EMAIL_NOT_ALLOWED") ||
              primaryMsg.includes("PHONE_CODE_EMPTY"))) ||
          (!preferEmailVerification &&
            (primaryMsg.includes("EMAIL") || primaryMsg.includes("PHONE_CODE_EMPTY")));

        if (shouldTryAlternate) {
          try {
            signInResult = await client.invoke(
              new Api.auth.SignIn(
                preferEmailVerification
                  ? { phoneNumber, phoneCodeHash, phoneCode: code }
                  : {
                      phoneNumber,
                      phoneCodeHash,
                      emailVerification: new Api.EmailVerificationCode({ code }),
                    }
              )
            );
          } catch (altErr) {
            const altMsg = String(
              (altErr as { errorMessage?: string; message?: string })?.errorMessage ?? altErr
            ).toUpperCase();
            if (altMsg.includes("SESSION_PASSWORD_NEEDED")) {
              const hint = await getTwoFaHint(client);
              pendingAuth.stage = "awaiting_password";
              pendingAuth.passwordHint = hint;
              res.json({ status: "password_required", hint });
              return;
            }
            throw altErr;
          }
        } else {
          throw primaryErr;
        }
      }

      if (signInResult instanceof Api.auth.AuthorizationSignUpRequired) {
        res.status(400).json({
          error: "هذا الرقم غير مسجل في تيليجرام بعد. يرجى التسجيل عبر تطبيق الهاتف الرسمي أولاً.",
        });
        return;
      }

      const finalAuth = await finalizeAuthorizedLogin(client);
      res.json(finalAuth);
    } catch (err) {
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  // الخطوة 3: التحقق من كلمة مرور 2FA مباشرة عبر SRP
  app.post("/api/auth/verify-password", async (req, res) => {
    try {
      const password = String(req.body.password ?? "");
      if (!password) {
        res.status(400).json({ error: "يرجى إدخال كلمة مرور التحقق بخطوتين." });
        return;
      }
      if (!activeClient || !pendingAuth) {
        res.status(400).json({ error: "لا توجد جلسة بانتظار كلمة المرور." });
        return;
      }

      const srpResult = await activeClient.invoke(new Api.account.GetPassword());
      const passwordCheck = await passwordHelpers.computeCheck(srpResult, password);
      await activeClient.invoke(
        new Api.auth.CheckPassword({
          password: passwordCheck,
        })
      );

      const finalAuth = await finalizeAuthorizedLogin(activeClient);
      res.json(finalAuth);
    } catch (err) {
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  // البديل المضمون 100%: تسجيل الدخول بمسح رمز QR من تطبيق تيليجرام المفتوح
  app.post("/api/auth/qr/start", async (req, res) => {
    try {
      const apiId = Number(normalizeNumericInput(String(req.body.apiId ?? "")));
      const apiHash = String(req.body.apiHash ?? "").trim();

      if (!apiId || Number.isNaN(apiId) || !apiHash) {
        res.status(400).json({ error: "يرجى إدخال API ID و API Hash أولاً." });
        return;
      }

      await disconnectActiveClient();

      const client = createTelegramClient("", apiId, apiHash);
      activeClient = client;
      await client.connect();

      const tokenRes = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        })
      );

      if (tokenRes instanceof Api.auth.LoginTokenSuccess) {
        const finalAuth = await finalizeAuthorizedLogin(client);
        res.json(finalAuth);
        return;
      }

      if (tokenRes instanceof Api.auth.LoginTokenMigrateTo) {
        await client._switchDC(tokenRes.dcId);
        const migrated = await client.invoke(
          new Api.auth.ImportLoginToken({ token: tokenRes.token })
        );
        if (migrated instanceof Api.auth.LoginTokenSuccess) {
          const finalAuth = await finalizeAuthorizedLogin(client);
          res.json(finalAuth);
          return;
        }
        throw new Error("تعذر إتمام نقل الجلسة عبر QR.");
      }

      const tokenUrl = `tg://login?token=${Buffer.from(tokenRes.token).toString("base64url")}`;
      const qrDataUrl = await QRCode.toDataURL(tokenUrl, {
        width: 260,
        margin: 2,
        color: { dark: "#0F172A", light: "#FFFFFF" },
      });

      pendingAuth = {
        mode: "qr",
        apiId,
        apiHash,
        phoneNumber: "",
        phoneCodeHash: "",
        stage: "awaiting_qr",
        qrExpiresAt: tokenRes.expires,
      };

      res.json({
        status: "qr_ready",
        qrDataUrl,
        expiresAt: tokenRes.expires,
      });
    } catch (err) {
      if (!pendingAuth) {
        await disconnectActiveClient();
      }
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  app.post("/api/auth/qr/poll", async (_req, res) => {
    try {
      if (!activeClient || !pendingAuth || pendingAuth.mode !== "qr") {
        res.status(400).json({ error: "لا توجد جلسة QR نشطة." });
        return;
      }

      const client = activeClient;
      const { apiId, apiHash } = pendingAuth;

      try {
        const tokenRes = await client.invoke(
          new Api.auth.ExportLoginToken({
            apiId,
            apiHash,
            exceptIds: [],
          })
        );

        if (tokenRes instanceof Api.auth.LoginTokenSuccess) {
          const finalAuth = await finalizeAuthorizedLogin(client);
          res.json(finalAuth);
          return;
        }

        if (tokenRes instanceof Api.auth.LoginTokenMigrateTo) {
          await client._switchDC(tokenRes.dcId);
          try {
            const migrated = await client.invoke(
              new Api.auth.ImportLoginToken({ token: tokenRes.token })
            );
            if (migrated instanceof Api.auth.LoginTokenSuccess) {
              const finalAuth = await finalizeAuthorizedLogin(client);
              res.json(finalAuth);
              return;
            }
          } catch (migErr) {
            const msg = String(
              (migErr as { errorMessage?: string; message?: string })?.errorMessage ?? migErr
            ).toUpperCase();
            if (msg.includes("SESSION_PASSWORD_NEEDED")) {
              const hint = await getTwoFaHint(client);
              pendingAuth.stage = "awaiting_password";
              pendingAuth.passwordHint = hint;
              res.json({ status: "password_required", hint });
              return;
            }
            throw migErr;
          }
        }

        if (tokenRes instanceof Api.auth.LoginToken) {
          const tokenUrl = `tg://login?token=${Buffer.from(tokenRes.token).toString("base64url")}`;
          const qrDataUrl = await QRCode.toDataURL(tokenUrl, {
            width: 260,
            margin: 2,
            color: { dark: "#0F172A", light: "#FFFFFF" },
          });
          pendingAuth.qrExpiresAt = tokenRes.expires;
          res.json({
            status: "qr_pending",
            qrDataUrl,
            expiresAt: tokenRes.expires,
          });
          return;
        }
      } catch (pollErr) {
        const msg = String(
          (pollErr as { errorMessage?: string; message?: string })?.errorMessage ?? pollErr
        ).toUpperCase();
        if (msg.includes("SESSION_PASSWORD_NEEDED")) {
          const hint = await getTwoFaHint(client);
          pendingAuth.stage = "awaiting_password";
          pendingAuth.passwordHint = hint;
          res.json({ status: "password_required", hint });
          return;
        }
        throw pollErr;
      }

      res.json({ status: "qr_pending" });
    } catch (err) {
      const translated = translateTelegramError(err);
      res.status(400).json({ error: translated.message });
    }
  });

  // تسجيل الخروج وإغلاق الجلسة
  app.post("/api/auth/logout", async (_req, res) => {
    if (broadcastAbortController) {
      broadcastAbortController.abort();
    }
    await disconnectActiveClient();
    res.json({ ok: true });
  });

  // اختبار بوت الإشعارات
  app.post("/api/bot/test", async (req, res) => {
    const botToken = String(req.body.botToken ?? "").trim();
    const adminChatId = String(req.body.adminChatId ?? "").trim();
    const result = await sendBotNotification(
      botToken,
      adminChatId,
      "🤖 <b>تم ربط بوت الإشعارات بنجاح!</b>\nسيصلك هنا تقرير فوري عند كل عملية نشر أو تخطي أو إكمال للحملة."
    );
    if (!result.ok) {
      res.status(400).json({ error: result.error || "فشل إرسال الرسالة التجريبية للبوت." });
      return;
    }
    res.json({ ok: true });
  });

  // جلب المجموعات المصرح بها
  app.get("/api/groups", async (req, res) => {
    if (!activeClient || !currentUser) {
      res.status(401).json({ error: "يرجى تسجيل الدخول بحساب تيليجرام أولاً." });
      return;
    }

    const adminOnly = req.query.adminOnly !== "false";

    try {
      const groups = await scanAuthorizedGroups(activeClient, adminOnly);
      res.json({ groups });
    } catch (err) {
      const parsed = translateTelegramError(err);
      res.status(500).json({ error: parsed.message });
    }
  });

  // معاينة صياغة منشور تجريبي
  app.post("/api/broadcast/preview", (req, res) => {
    const template = String(req.body.template ?? "").trim();
    const groupTitle = String(req.body.groupTitle ?? "مجتمع المطورين العرب").trim();
    const useVariation = Boolean(req.body.useVariation);

    if (!template) {
      res.status(400).json({ error: "القالب فارغ." });
      return;
    }

    const htmlPreview = formatMessageForGroup(template, groupTitle, useVariation);
    res.json({ htmlPreview });
  });

  // حالة البث الحالية
  app.get("/api/broadcast/state", (_req, res) => {
    res.json(broadcastState);
  });

  // بدء حملة البث
  app.post("/api/broadcast/start", async (req, res) => {
    if (!activeClient || !currentUser) {
      res.status(401).json({ error: "يرجى تسجيل الدخول بحساب تيليجرام أولاً." });
      return;
    }
    if (
      broadcastState.status === "running" ||
      broadcastState.status === "waiting" ||
      broadcastState.status === "flood_wait"
    ) {
      res.status(409).json({ error: "توجد حملة نشر قيد التشغيل حالياً." });
      return;
    }

    const groupIds = Array.isArray(req.body.groupIds)
      ? (req.body.groupIds as string[])
      : [];
    const rawTemplates: unknown[] = Array.isArray(req.body.templates)
      ? req.body.templates
      : [];
    const templates: TemplatePayload[] = rawTemplates
      .map((item: unknown, idx: number): TemplatePayload => {
        if (typeof item === "string") {
          return { title: `قالب ${idx + 1}`, content: item.trim() };
        }
        if (item && typeof item === "object") {
          const obj = item as { title?: unknown; content?: unknown };
          const content = String(obj.content ?? "").trim();
          const title = String(obj.title ?? `قالب ${idx + 1}`).trim() || `قالب ${idx + 1}`;
          return { title, content };
        }
        return { title: "", content: "" };
      })
      .filter((t: TemplatePayload) => t.content.length > 0);

    const minDelaySec = Math.max(30, Number(req.body.minDelaySec ?? 300));
    const maxDelaySec = Math.max(minDelaySec, Number(req.body.maxDelaySec ?? 600));
    const useVariation = Boolean(req.body.useVariation);
    const adminOnly = req.body.adminOnly !== false;
    const autoIncludeNewGroups = req.body.autoIncludeNewGroups !== false;
    const botToken = String(req.body.botToken ?? "").trim();
    const adminChatId = String(req.body.adminChatId ?? "").trim();

    if (groupIds.length === 0) {
      res.status(400).json({ error: "يرجى اختيار مجموعة واحدة على الأقل." });
      return;
    }
    if (templates.length === 0) {
      res.status(400).json({ error: "يرجى إضافة قالب تعليمي واحد على الأقل." });
      return;
    }

    // التأكد من وجود المجموعات في الذاكرة
    if (cachedGroups.length === 0) {
      res.status(400).json({ error: "يرجى تحديث قائمة المجموعات أولاً." });
      return;
    }

    void executeBroadcastJob({
      groupIds,
      templates,
      minDelaySec,
      maxDelaySec,
      useVariation,
      adminOnly,
      autoIncludeNewGroups,
      botToken,
      adminChatId,
    });

    res.json({ ok: true });
  });

  // إيقاف الحملة بأمان
  app.post("/api/broadcast/stop", (_req, res) => {
    if (broadcastAbortController) {
      broadcastAbortController.abort();
      res.json({ ok: true });
      return;
    }
    res.json({ ok: false, message: "لا توجد حملة نشطة لإيقافها." });
  });

  // توصيل Vite في بيئة التطوير أو الملفات المبنية في الإنتاج
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

void bootstrap();
