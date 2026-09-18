import { registerMessages } from '../../lib/i18n/I18nContext.js';

/** Pharma-domain UI strings, namespaced `ph.*`. EN + AR in lockstep. */
const en: Record<string, string> = {
  'ph.title': 'Pharma',
  'ph.nav.dashboard': 'Dashboard',
  'ph.nav.medications': 'Medications',
  'ph.nav.content': 'Content',
  'ph.nav.reports': 'Reports',

  'ph.dash.title': 'Pharma dashboard',
  'ph.dash.subtitle': 'Drug master, approved content and reporting.',
  'ph.dash.medications': 'Medication master',
  'ph.dash.medications.body': 'Browse and search the canonical drug master.',
  'ph.dash.content': 'Approved content',
  'ph.dash.content.body': 'Scientific content and its approval state.',
  'ph.dash.reports': 'Reports',
  'ph.dash.reports.body': 'Governed pharma reports and exports.',
  'ph.dash.open': 'Open',

  'ph.meds.title': 'Medication master',
  'ph.meds.subtitle': 'The canonical drug knowledge base (not clinical decision support).',
  'ph.meds.search': 'Search by generic name',
  'ph.meds.col.generic': 'Generic name',
  'ph.meds.col.atc': 'ATC',
  'ph.meds.col.area': 'Therapeutic area',
  'ph.meds.col.verification': 'Verification',
  'ph.meds.open': 'Open',
  'ph.meds.empty.title': 'No medications found',
  'ph.meds.empty.body': 'Search by generic name or import the drug master.',
  'ph.meds.back': 'Back to medications',
  'ph.meds.detail.atc': 'ATC code',
  'ph.meds.detail.area': 'Therapeutic area',
  'ph.meds.detail.verification': 'Verification status',
  'ph.meds.none': '—',

  'ph.content.title': 'Approved content',
  'ph.content.subtitle': 'Scientific content with its approval lifecycle.',
  'ph.content.col.title': 'Title',
  'ph.content.col.type': 'Type',
  'ph.content.col.jurisdiction': 'Jurisdiction',
  'ph.content.col.status': 'Approval',
  'ph.content.empty.title': 'No content yet',
  'ph.content.empty.body': 'Approved scientific content will appear here.',

  'ph.reports.title': 'Pharma reports',
  'ph.reports.subtitle': 'The catalog of governed pharma reports.',
  'ph.reports.col.title': 'Report',
  'ph.reports.col.description': 'Description',
  'ph.reports.empty.title': 'No reports available',
  'ph.reports.empty.body': 'Report definitions will appear here.',

  'ph.err.load': 'Could not load pharma data.',
};

const ar: Record<string, string> = {
  'ph.title': 'الأدوية',
  'ph.nav.dashboard': 'لوحة المعلومات',
  'ph.nav.medications': 'الأدوية',
  'ph.nav.content': 'المحتوى',
  'ph.nav.reports': 'التقارير',

  'ph.dash.title': 'لوحة معلومات الأدوية',
  'ph.dash.subtitle': 'قاعدة الأدوية والمحتوى المعتمد والتقارير.',
  'ph.dash.medications': 'سجل الأدوية',
  'ph.dash.medications.body': 'تصفّح وابحث في سجل الأدوية المرجعي.',
  'ph.dash.content': 'المحتوى المعتمد',
  'ph.dash.content.body': 'المحتوى العلمي وحالة اعتماده.',
  'ph.dash.reports': 'التقارير',
  'ph.dash.reports.body': 'تقارير وصادرات الأدوية المحكومة.',
  'ph.dash.open': 'فتح',

  'ph.meds.title': 'سجل الأدوية',
  'ph.meds.subtitle': 'قاعدة معرفة الأدوية المرجعية (ليست دعماً للقرار السريري).',
  'ph.meds.search': 'ابحث بالاسم العلمي',
  'ph.meds.col.generic': 'الاسم العلمي',
  'ph.meds.col.atc': 'ATC',
  'ph.meds.col.area': 'المجال العلاجي',
  'ph.meds.col.verification': 'التحقّق',
  'ph.meds.open': 'فتح',
  'ph.meds.empty.title': 'لا توجد أدوية',
  'ph.meds.empty.body': 'ابحث بالاسم العلمي أو استورد سجل الأدوية.',
  'ph.meds.back': 'العودة إلى الأدوية',
  'ph.meds.detail.atc': 'رمز ATC',
  'ph.meds.detail.area': 'المجال العلاجي',
  'ph.meds.detail.verification': 'حالة التحقّق',
  'ph.meds.none': '—',

  'ph.content.title': 'المحتوى المعتمد',
  'ph.content.subtitle': 'المحتوى العلمي ودورة اعتماده.',
  'ph.content.col.title': 'العنوان',
  'ph.content.col.type': 'النوع',
  'ph.content.col.jurisdiction': 'الولاية',
  'ph.content.col.status': 'الاعتماد',
  'ph.content.empty.title': 'لا يوجد محتوى بعد',
  'ph.content.empty.body': 'سيظهر المحتوى العلمي المعتمد هنا.',

  'ph.reports.title': 'تقارير الأدوية',
  'ph.reports.subtitle': 'كتالوج تقارير الأدوية المحكومة.',
  'ph.reports.col.title': 'التقرير',
  'ph.reports.col.description': 'الوصف',
  'ph.reports.empty.title': 'لا توجد تقارير متاحة',
  'ph.reports.empty.body': 'ستظهر تعريفات التقارير هنا.',

  'ph.err.load': 'تعذّر تحميل بيانات الأدوية.',
};

export function registerPharmaMessages(): void {
  registerMessages('en', en);
  registerMessages('ar', ar);
}
