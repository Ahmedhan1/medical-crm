import { registerMessages } from '../../lib/i18n/I18nContext.js';

/** CRM-domain UI strings, namespaced `crm.*`. EN + AR in lockstep. */
const en: Record<string, string> = {
  'crm.title': 'CRM',
  'crm.nav.hcps': 'Professionals',
  'crm.nav.hcos': 'Organizations',
  'crm.nav.visits': 'Visits',

  'crm.hcps.title': 'Healthcare professionals',
  'crm.hcps.subtitle': 'The HCP relationship directory. No patient data.',
  'crm.hcps.search': 'Search by name',
  'crm.hcps.col.name': 'Name',
  'crm.hcps.col.category': 'Category',
  'crm.hcps.col.contact': 'Contact',
  'crm.hcps.col.status': 'Status',
  'crm.hcps.open': 'Open',
  'crm.hcps.empty.title': 'No professionals found',
  'crm.hcps.empty.body': 'Search by name or add HCPs from the pharma workflow.',

  'crm.hcp.back': 'Back to professionals',
  'crm.hcp.section.profile': 'Profile',
  'crm.hcp.title': 'Title',
  'crm.hcp.category': 'Category',
  'crm.hcp.email': 'Email',
  'crm.hcp.phone': 'Phone',
  'crm.hcp.status': 'Status',
  'crm.hcp.none': '—',

  'crm.hcos.title': 'Healthcare organizations',
  'crm.hcos.subtitle': 'Hospitals, clinics, pharmacies and their sites.',
  'crm.hcos.search': 'Search by name',
  'crm.hcos.col.name': 'Name',
  'crm.hcos.col.type': 'Type',
  'crm.hcos.col.location': 'Location',
  'crm.hcos.col.status': 'Status',
  'crm.hcos.empty.title': 'No organizations found',
  'crm.hcos.empty.body': 'Search by name or add organizations from the pharma workflow.',

  'crm.visits.title': 'Field visits',
  'crm.visits.subtitle': 'HCP/HCO engagement calls and their outcomes.',
  'crm.visits.col.when': 'Planned',
  'crm.visits.col.subject': 'Subject',
  'crm.visits.col.modality': 'Modality',
  'crm.visits.col.type': 'Type',
  'crm.visits.col.status': 'Status',
  'crm.visits.filter.all': 'All statuses',
  'crm.visits.empty.title': 'No visits',
  'crm.visits.empty.body': 'Field visits will appear here as reps plan and log them.',

  'crm.status.active': 'Active',
  'crm.status.inactive': 'Inactive',
  'crm.status.retired': 'Retired',
  'crm.status.merged': 'Merged',
  'crm.vstatus.planned': 'Planned',
  'crm.vstatus.confirmed': 'Confirmed',
  'crm.vstatus.completed': 'Completed',
  'crm.vstatus.cancelled': 'Cancelled',
  'crm.vstatus.no_access': 'No access',

  'crm.err.load': 'Could not load CRM data.',
};

const ar: Record<string, string> = {
  'crm.title': 'إدارة العلاقات',
  'crm.nav.hcps': 'المهنيون',
  'crm.nav.hcos': 'المنظمات',
  'crm.nav.visits': 'الزيارات',

  'crm.hcps.title': 'المهنيون الصحيون',
  'crm.hcps.subtitle': 'دليل علاقات الأطباء. لا توجد بيانات مرضى.',
  'crm.hcps.search': 'ابحث بالاسم',
  'crm.hcps.col.name': 'الاسم',
  'crm.hcps.col.category': 'الفئة',
  'crm.hcps.col.contact': 'التواصل',
  'crm.hcps.col.status': 'الحالة',
  'crm.hcps.open': 'فتح',
  'crm.hcps.empty.title': 'لا يوجد مهنيون',
  'crm.hcps.empty.body': 'ابحث بالاسم أو أضف الأطباء من سير عمل الأدوية.',

  'crm.hcp.back': 'العودة إلى المهنيين',
  'crm.hcp.section.profile': 'الملف',
  'crm.hcp.title': 'اللقب',
  'crm.hcp.category': 'الفئة',
  'crm.hcp.email': 'البريد',
  'crm.hcp.phone': 'الهاتف',
  'crm.hcp.status': 'الحالة',
  'crm.hcp.none': '—',

  'crm.hcos.title': 'المنظمات الصحية',
  'crm.hcos.subtitle': 'المستشفيات والعيادات والصيدليات ومواقعها.',
  'crm.hcos.search': 'ابحث بالاسم',
  'crm.hcos.col.name': 'الاسم',
  'crm.hcos.col.type': 'النوع',
  'crm.hcos.col.location': 'الموقع',
  'crm.hcos.col.status': 'الحالة',
  'crm.hcos.empty.title': 'لا توجد منظمات',
  'crm.hcos.empty.body': 'ابحث بالاسم أو أضف المنظمات من سير عمل الأدوية.',

  'crm.visits.title': 'الزيارات الميدانية',
  'crm.visits.subtitle': 'مكالمات التواصل مع الأطباء/المنظمات ونتائجها.',
  'crm.visits.col.when': 'مخطط',
  'crm.visits.col.subject': 'الموضوع',
  'crm.visits.col.modality': 'الأسلوب',
  'crm.visits.col.type': 'النوع',
  'crm.visits.col.status': 'الحالة',
  'crm.visits.filter.all': 'كل الحالات',
  'crm.visits.empty.title': 'لا توجد زيارات',
  'crm.visits.empty.body': 'ستظهر الزيارات الميدانية هنا عند تخطيطها وتسجيلها.',

  'crm.status.active': 'نشط',
  'crm.status.inactive': 'غير نشط',
  'crm.status.retired': 'متقاعد',
  'crm.status.merged': 'مدمج',
  'crm.vstatus.planned': 'مخطط',
  'crm.vstatus.confirmed': 'مؤكد',
  'crm.vstatus.completed': 'مكتمل',
  'crm.vstatus.cancelled': 'ملغى',
  'crm.vstatus.no_access': 'تعذّر الوصول',

  'crm.err.load': 'تعذّر تحميل بيانات إدارة العلاقات.',
};

export function registerCrmMessages(): void {
  registerMessages('en', en);
  registerMessages('ar', ar);
}
