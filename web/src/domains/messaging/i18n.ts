import { registerMessages } from '../../lib/i18n/I18nContext.js';

/** Messaging-setup UI strings, namespaced `msg.*`. EN + AR in lockstep. */
const en: Record<string, string> = {
  'msg.title': 'Messaging setup',
  'msg.nav.whatsapp': 'WhatsApp',
  'msg.nav.consent': 'Consent',

  'msg.wa.title': 'WhatsApp connection',
  'msg.wa.subtitle': 'Pair the clinic WhatsApp device to send reminders and follow-ups.',
  'msg.wa.status': 'Status',
  'msg.wa.status.disconnected': 'Disconnected',
  'msg.wa.status.pairing': 'Pairing',
  'msg.wa.status.connected': 'Connected',
  'msg.wa.status.error': 'Error',
  'msg.wa.device': 'Device number',
  'msg.wa.lastError': 'Last error',
  'msg.wa.lastStatus': 'Last checked',
  'msg.wa.notConfigured.title': 'WhatsApp is not configured on this box',
  'msg.wa.notConfigured.body': 'A GOWA WhatsApp bridge must be configured by the operator before pairing. The box keeps working offline until then.',
  'msg.wa.pair': 'Start pairing',
  'msg.wa.reconnect': 'Refresh status',
  'msg.wa.disconnect': 'Disconnect',
  'msg.wa.disconnected.ok': 'WhatsApp disconnected',
  'msg.wa.scan.title': 'Scan to pair',
  'msg.wa.scan.body': 'Open WhatsApp on the clinic phone → Linked devices → Link a device, then scan this code.',
  'msg.wa.scan.expires': 'This code expires in about {n} seconds. Refresh status after scanning.',
  'msg.wa.safeNote': 'No WhatsApp credential or message content is ever shown here or stored in the app.',

  'msg.consent.title': 'Communication consent',
  'msg.consent.subtitle': 'Check a patient’s per-channel consent. Consent is always re-checked at delivery — opt-outs suppress a send even on retry.',
  'msg.consent.patientId': 'Patient id',
  'msg.consent.lookup': 'Look up',
  'msg.consent.col.channel': 'Channel',
  'msg.consent.col.status': 'Consent',
  'msg.consent.col.updated': 'Updated',
  'msg.consent.status.opted_in': 'Opted in',
  'msg.consent.status.opted_out': 'Opted out',
  'msg.consent.status.unknown': 'Unknown (blocked)',
  'msg.consent.empty': 'No consent records for this patient — sends are blocked until they opt in.',

  'msg.err.load': 'Could not load messaging data.',
};

const ar: Record<string, string> = {
  'msg.title': 'إعداد الرسائل',
  'msg.nav.whatsapp': 'واتساب',
  'msg.nav.consent': 'الموافقة',

  'msg.wa.title': 'اتصال واتساب',
  'msg.wa.subtitle': 'اربط جهاز واتساب العيادة لإرسال التذكيرات والمتابعات.',
  'msg.wa.status': 'الحالة',
  'msg.wa.status.disconnected': 'غير متصل',
  'msg.wa.status.pairing': 'جارٍ الربط',
  'msg.wa.status.connected': 'متصل',
  'msg.wa.status.error': 'خطأ',
  'msg.wa.device': 'رقم الجهاز',
  'msg.wa.lastError': 'آخر خطأ',
  'msg.wa.lastStatus': 'آخر فحص',
  'msg.wa.notConfigured.title': 'واتساب غير مُهيّأ على هذا الجهاز',
  'msg.wa.notConfigured.body': 'يجب على المشغّل تهيئة جسر GOWA لواتساب قبل الربط. يستمر الجهاز في العمل دون اتصال حتى ذلك الحين.',
  'msg.wa.pair': 'بدء الربط',
  'msg.wa.reconnect': 'تحديث الحالة',
  'msg.wa.disconnect': 'قطع الاتصال',
  'msg.wa.disconnected.ok': 'تم قطع اتصال واتساب',
  'msg.wa.scan.title': 'امسح للربط',
  'msg.wa.scan.body': 'افتح واتساب على هاتف العيادة ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح هذا الرمز.',
  'msg.wa.scan.expires': 'ينتهي هذا الرمز خلال {n} ثانية تقريباً. حدّث الحالة بعد المسح.',
  'msg.wa.safeNote': 'لا يُعرض أو يُخزَّن أي بيانات اعتماد لواتساب أو محتوى رسائل في التطبيق.',

  'msg.consent.title': 'موافقة التواصل',
  'msg.consent.subtitle': 'تحقق من موافقة المريض لكل قناة. يُعاد التحقق من الموافقة دائماً عند التسليم — يمنع الانسحاب الإرسال حتى عند إعادة المحاولة.',
  'msg.consent.patientId': 'معرّف المريض',
  'msg.consent.lookup': 'بحث',
  'msg.consent.col.channel': 'القناة',
  'msg.consent.col.status': 'الموافقة',
  'msg.consent.col.updated': 'آخر تحديث',
  'msg.consent.status.opted_in': 'موافق',
  'msg.consent.status.opted_out': 'منسحب',
  'msg.consent.status.unknown': 'غير معروف (محظور)',
  'msg.consent.empty': 'لا توجد سجلات موافقة لهذا المريض — الإرسال محظور حتى الموافقة.',

  'msg.err.load': 'تعذّر تحميل بيانات الرسائل.',
};

export function registerMessagingMessages(): void {
  registerMessages('en', en);
  registerMessages('ar', ar);
}
