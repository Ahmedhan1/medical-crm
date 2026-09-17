import { registerMessages } from '../../lib/i18n/I18nContext.js';

/**
 * Clinical-domain UI strings, namespaced `clinical.*`. Registered via the
 * platform i18n extension point so the shared dictionary is never edited.
 * EN + AR are kept in lockstep; RTL is handled structurally by the platform.
 */
const en: Record<string, string> = {
  'clinical.title': 'Clinical',
  'clinical.nav.patients': 'Patients',
  'clinical.nav.queue': 'Queue',

  // Patients list / search
  'clinical.patients.title': 'Patients',
  'clinical.patients.subtitle': 'Find or register a patient',
  'clinical.patients.search.placeholder': 'Search by name, MRN or phone (min 2 characters)',
  'clinical.patients.search.hint': 'Enter at least 2 characters to search.',
  'clinical.patients.register': 'Register patient',
  'clinical.patients.col.mrn': 'MRN',
  'clinical.patients.col.name': 'Name',
  'clinical.patients.col.sex': 'Sex',
  'clinical.patients.col.dob': 'Date of birth',
  'clinical.patients.col.phone': 'Phone',
  'clinical.patients.col.status': 'Status',
  'clinical.patients.empty.title': 'No matching patients',
  'clinical.patients.empty.body': 'Try a different name, MRN or phone number.',
  'clinical.patients.view': 'Open',

  // Register form
  'clinical.register.title': 'Register patient',
  'clinical.register.fullName': 'Full name',
  'clinical.register.sex': 'Sex',
  'clinical.register.birthDate': 'Date of birth',
  'clinical.register.phone': 'Phone',
  'clinical.register.nationalId': 'National ID',
  'clinical.register.submit': 'Register',
  'clinical.register.success': 'Patient registered',
  'clinical.register.duplicate':
    'A matching patient already exists. Review before registering a duplicate.',
  'clinical.register.err.fullName': 'Enter a full name (at least 2 characters).',
  'clinical.register.err.birthDate': 'Use the format YYYY-MM-DD.',

  // Sex values
  'clinical.sex.male': 'Male',
  'clinical.sex.female': 'Female',
  'clinical.sex.other': 'Other',
  'clinical.sex.unknown': 'Unknown',

  // Patient status
  'clinical.status.active': 'Active',
  'clinical.status.inactive': 'Inactive',
  'clinical.status.deceased': 'Deceased',
  'clinical.status.merged': 'Merged',
  'clinical.patient.mergedNotice': 'This record was merged. Open the surviving record.',

  // Patient 360
  'clinical.p360.title': 'Patient 360',
  'clinical.p360.back': 'Back to patients',
  'clinical.p360.section.allergies': 'Allergies',
  'clinical.p360.section.vitals': 'Recent vitals',
  'clinical.p360.section.prescriptions': 'Active prescriptions',
  'clinical.p360.section.appointments': 'Upcoming appointments',
  'clinical.p360.section.visits': 'Recent visits',
  'clinical.p360.section.referrals': 'Referrals',
  'clinical.p360.section.followups': 'Open follow-ups',
  'clinical.p360.section.procedures': 'Procedures',
  'clinical.p360.section.careplans': 'Care plans',
  'clinical.p360.section.episodes': 'Treatment episodes',
  'clinical.p360.section.none': 'None recorded',
  'clinical.p360.noSections':
    'No clinical sections are available to your role for this patient.',
  'clinical.p360.count': '{n} item(s)',

  // Queue
  'clinical.queue.title': 'Clinical queue',
  'clinical.queue.subtitle': 'Patients currently checked in, oldest first',
  'clinical.queue.col.mrn': 'MRN',
  'clinical.queue.col.patient': 'Patient',
  'clinical.queue.col.status': 'Status',
  'clinical.queue.col.since': 'Waiting since',
  'clinical.queue.empty.title': 'The queue is empty',
  'clinical.queue.empty.body': 'No patients are currently checked in.',
  'clinical.queue.checkIn': 'Check in',
  'clinical.queue.checkIn.success': 'Patient checked in',
  'clinical.queue.checkIn.pick': 'Search a patient to check in from the Patients page.',

  // Generic
  'clinical.err.load': 'Could not load clinical data.',
  'clinical.forbidden': 'You do not have permission to view this section.',
};

const ar: Record<string, string> = {
  'clinical.title': 'العيادة',
  'clinical.nav.patients': 'المرضى',
  'clinical.nav.queue': 'قائمة الانتظار',

  'clinical.patients.title': 'المرضى',
  'clinical.patients.subtitle': 'ابحث عن مريض أو سجّل مريضاً جديداً',
  'clinical.patients.search.placeholder': 'ابحث بالاسم أو رقم الملف أو الهاتف (حرفان على الأقل)',
  'clinical.patients.search.hint': 'أدخل حرفين على الأقل للبحث.',
  'clinical.patients.register': 'تسجيل مريض',
  'clinical.patients.col.mrn': 'رقم الملف',
  'clinical.patients.col.name': 'الاسم',
  'clinical.patients.col.sex': 'النوع',
  'clinical.patients.col.dob': 'تاريخ الميلاد',
  'clinical.patients.col.phone': 'الهاتف',
  'clinical.patients.col.status': 'الحالة',
  'clinical.patients.empty.title': 'لا يوجد مرضى مطابقون',
  'clinical.patients.empty.body': 'جرّب اسماً أو رقم ملف أو رقم هاتف مختلفاً.',
  'clinical.patients.view': 'فتح',

  'clinical.register.title': 'تسجيل مريض',
  'clinical.register.fullName': 'الاسم الكامل',
  'clinical.register.sex': 'النوع',
  'clinical.register.birthDate': 'تاريخ الميلاد',
  'clinical.register.phone': 'الهاتف',
  'clinical.register.nationalId': 'الرقم القومي',
  'clinical.register.submit': 'تسجيل',
  'clinical.register.success': 'تم تسجيل المريض',
  'clinical.register.duplicate': 'يوجد مريض مطابق بالفعل. راجع قبل تسجيل نسخة مكررة.',
  'clinical.register.err.fullName': 'أدخل اسماً كاملاً (حرفان على الأقل).',
  'clinical.register.err.birthDate': 'استخدم الصيغة سنة-شهر-يوم.',

  'clinical.sex.male': 'ذكر',
  'clinical.sex.female': 'أنثى',
  'clinical.sex.other': 'آخر',
  'clinical.sex.unknown': 'غير معروف',

  'clinical.status.active': 'نشط',
  'clinical.status.inactive': 'غير نشط',
  'clinical.status.deceased': 'متوفى',
  'clinical.status.merged': 'مدمج',
  'clinical.patient.mergedNotice': 'تم دمج هذا السجل. افتح السجل الأصلي.',

  'clinical.p360.title': 'الملف الشامل للمريض',
  'clinical.p360.back': 'العودة إلى المرضى',
  'clinical.p360.section.allergies': 'الحساسية',
  'clinical.p360.section.vitals': 'العلامات الحيوية الأخيرة',
  'clinical.p360.section.prescriptions': 'الوصفات النشطة',
  'clinical.p360.section.appointments': 'المواعيد القادمة',
  'clinical.p360.section.visits': 'الزيارات الأخيرة',
  'clinical.p360.section.referrals': 'الإحالات',
  'clinical.p360.section.followups': 'المتابعات المفتوحة',
  'clinical.p360.section.procedures': 'الإجراءات',
  'clinical.p360.section.careplans': 'الخطط العلاجية',
  'clinical.p360.section.episodes': 'حلقات العلاج',
  'clinical.p360.section.none': 'لا يوجد',
  'clinical.p360.noSections': 'لا توجد أقسام إكلينيكية متاحة لدورك لهذا المريض.',
  'clinical.p360.count': '{n} عنصر',

  'clinical.queue.title': 'قائمة انتظار العيادة',
  'clinical.queue.subtitle': 'المرضى المسجّلون حالياً، الأقدم أولاً',
  'clinical.queue.col.mrn': 'رقم الملف',
  'clinical.queue.col.patient': 'المريض',
  'clinical.queue.col.status': 'الحالة',
  'clinical.queue.col.since': 'في الانتظار منذ',
  'clinical.queue.empty.title': 'قائمة الانتظار فارغة',
  'clinical.queue.empty.body': 'لا يوجد مرضى مسجّلون حالياً.',
  'clinical.queue.checkIn': 'تسجيل الوصول',
  'clinical.queue.checkIn.success': 'تم تسجيل وصول المريض',
  'clinical.queue.checkIn.pick': 'ابحث عن مريض لتسجيل وصوله من صفحة المرضى.',

  'clinical.err.load': 'تعذّر تحميل البيانات الإكلينيكية.',
  'clinical.forbidden': 'ليس لديك إذن لعرض هذا القسم.',
};

export function registerClinicalMessages(): void {
  registerMessages('en', en);
  registerMessages('ar', ar);
}
