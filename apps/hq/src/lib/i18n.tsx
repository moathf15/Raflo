import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const en = {
  appName: 'Raflo AI HQ',
  nav: { office: 'Office', dashboard: 'Dashboard', tasks: 'Tasks', meetings: 'Meetings', messages: 'Messages', employees: 'Employees', projects: 'Projects', knowledge: 'Knowledge', github: 'GitHub', approvals: 'Approvals', reports: 'Reports', settings: 'Settings', audit: 'Audit log' },
  status: {
    idle: 'Available', thinking: 'Thinking', working: 'Working', reading: 'Reading', writing: 'Writing', in_meeting: 'In a meeting', collaborating: 'Collaborating',
    waiting_approval: 'Waiting for approval', blocked: 'Blocked', completed: 'Completed a task', on_break: 'On break (inactive)'
  } as Record<string, string>,
  taskStatus: { backlog: 'Backlog', assigned: 'Assigned', in_progress: 'In progress', under_review: 'Under review', blocked: 'Blocked', waiting_approval: 'Waiting for approval', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled' } as Record<string, string>,
  priority: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as Record<string, string>,
  rooms: { executive: 'CEO Office', management: 'Management', development: 'Development', qa: 'Quality Assurance', security: 'Security', design: 'Design', marketing: 'Marketing', content: 'Content', business: 'Business', data: 'Data & Analytics', operations: 'Operations Center', majlis: 'Majlis Room', summit: 'Summit Room', huddle: 'Huddle Room', lounge: 'Employee Lounge', projects: 'Project Room' } as Record<string, string>,
  meetingTypes: { brainstorming: 'Brainstorming', product_planning: 'Product planning', technical_review: 'Technical review', security_review: 'Security review', design_review: 'Design review', marketing_strategy: 'Marketing strategy', project_status: 'Project status', emergency: 'Emergency meeting', general: 'General discussion' } as Record<string, string>,
  common: {
    save: 'Save', cancel: 'Cancel', close: 'Close', create: 'Create', delete: 'Delete', edit: 'Edit', loading: 'Loading…', retry: 'Retry', none: 'None', search: 'Search', yes: 'Yes', no: 'No', all: 'All',
    approve: 'Approve', reject: 'Reject', open: 'Open', back: 'Back', send: 'Send', start: 'Start', signOut: 'Sign out', live: 'Live', offline: 'Reconnecting…', unassigned: 'Unassigned', noProject: 'No project'
  },
  office: {
    hint: 'Drag or use arrow keys to move · scroll or +/− to zoom · Tab to an employee and press Enter',
    working: 'Working now', meeting: 'In meetings', blocked: 'Blocked', approvals: 'Approvals waiting', activity: 'Live activity', noActivity: 'Nothing has happened yet. Assign a task or start a meeting.',
    legend: 'Status legend', reset: 'Reset view', startMeeting: 'Start a meeting here', roomBusy: 'In use', objective: 'Give an objective', listView: 'List view', newMeeting: 'New meeting'
  },
  setup: {
    title: 'Before your employees can work',
    provider: 'Connect an AI provider (Settings → AI providers). Without one, nothing runs and no work is simulated.',
    github: 'Connect GitHub and authorise the Raflo repository so engineers can read code.',
    done: 'Ready'
  },
  profile: {
    assign: 'Assign task', talk: 'Start conversation', invite: 'Invite to meeting', review: 'Review work', reports: 'View reports', responsibilities: 'Change responsibilities', permissions: 'Configure permissions',
    overview: 'Overview', work: 'Work', performance: 'Performance', memory: 'Memory', comms: 'Communication', currentTask: 'Current task', skills: 'Skills', responsibilitiesL: 'Responsibilities', projects: 'Projects', pending: 'Pending tasks', completed: 'Completed tasks',
    deliverables: 'Recent deliverables', runs: 'Recent AI runs', roleNotes: 'Role memory (notes sent with every run)', knowledge: 'Knowledge authored', messages: 'Messages', meetings: 'Meetings', manager: 'Reports to', personality: 'Personality', model: 'Model', noWork: 'No work yet.'
  },
  perf: { completed: 'Completed tasks', accepted: 'Accepted deliverables', rejected: 'Rejected / changes requested', rating: 'Owner rating', reviews: 'Review pass rate', failed: 'Failed runs', avgTime: 'Avg. execution time', cost: 'AI cost', completion: 'Completion rate', quality: 'Quality first: these come from reviews and your ratings, not from output volume.' }
};

type Dict = typeof en;

const ar: Dict = {
  appName: 'مقر رفلو الذكي',
  nav: { office: 'المكتب', dashboard: 'لوحة القيادة', tasks: 'المهام', meetings: 'الاجتماعات', messages: 'الرسائل', employees: 'الموظفون', projects: 'المشاريع', knowledge: 'المعرفة', github: 'GitHub', approvals: 'الموافقات', reports: 'التقارير', settings: 'الإعدادات', audit: 'سجل التدقيق' },
  status: {
    idle: 'متاح', thinking: 'يفكّر', working: 'يعمل', reading: 'يقرأ', writing: 'يكتب', in_meeting: 'في اجتماع', collaborating: 'يتعاون',
    waiting_approval: 'بانتظار الموافقة', blocked: 'متوقف', completed: 'أنجز مهمة', on_break: 'في استراحة (غير نشط)'
  },
  taskStatus: { backlog: 'قائمة الانتظار', assigned: 'مُسندة', in_progress: 'قيد التنفيذ', under_review: 'قيد المراجعة', blocked: 'متوقفة', waiting_approval: 'بانتظار الموافقة', completed: 'مكتملة', rejected: 'مرفوضة', cancelled: 'ملغاة' },
  priority: { low: 'منخفضة', normal: 'عادية', high: 'عالية', urgent: 'عاجلة' },
  rooms: { executive: 'مكتب الرئيس التنفيذي', management: 'الإدارة', development: 'التطوير', qa: 'ضمان الجودة', security: 'الأمن', design: 'التصميم', marketing: 'التسويق', content: 'المحتوى', business: 'الأعمال', data: 'البيانات والتحليلات', operations: 'مركز العمليات', majlis: 'قاعة المجلس', summit: 'قاعة القمة', huddle: 'غرفة النقاش', lounge: 'استراحة الموظفين', projects: 'غرفة المشاريع' },
  meetingTypes: { brainstorming: 'عصف ذهني', product_planning: 'تخطيط المنتج', technical_review: 'مراجعة تقنية', security_review: 'مراجعة أمنية', design_review: 'مراجعة التصميم', marketing_strategy: 'استراتيجية التسويق', project_status: 'حالة المشروع', emergency: 'اجتماع طارئ', general: 'نقاش عام' },
  common: {
    save: 'حفظ', cancel: 'إلغاء', close: 'إغلاق', create: 'إنشاء', delete: 'حذف', edit: 'تعديل', loading: 'جارٍ التحميل…', retry: 'إعادة المحاولة', none: 'لا يوجد', search: 'بحث', yes: 'نعم', no: 'لا', all: 'الكل',
    approve: 'موافقة', reject: 'رفض', open: 'فتح', back: 'رجوع', send: 'إرسال', start: 'بدء', signOut: 'تسجيل الخروج', live: 'مباشر', offline: 'جارٍ إعادة الاتصال…', unassigned: 'غير مُسندة', noProject: 'بدون مشروع'
  },
  office: {
    hint: 'اسحب أو استخدم الأسهم للتنقل · مرّر أو +/− للتكبير · انتقل بـ Tab إلى موظف واضغط Enter',
    working: 'يعملون الآن', meeting: 'في اجتماعات', blocked: 'متوقفون', approvals: 'موافقات معلّقة', activity: 'النشاط المباشر', noActivity: 'لم يحدث شيء بعد. أسند مهمة أو ابدأ اجتماعًا.',
    legend: 'دليل الحالات', reset: 'إعادة العرض', startMeeting: 'ابدأ اجتماعًا هنا', roomBusy: 'مشغولة', objective: 'كلّف بهدف', listView: 'عرض القائمة', newMeeting: 'اجتماع جديد'
  },
  setup: {
    title: 'قبل أن يبدأ موظفوك العمل',
    provider: 'اربط مزوّد ذكاء اصطناعي (الإعدادات ← مزوّدو الذكاء الاصطناعي). بدونه لا يعمل شيء ولا يُحاكى أي عمل.',
    github: 'اربط GitHub واسمح بمستودع رفلو ليتمكن المهندسون من قراءة الشيفرة.',
    done: 'جاهز'
  },
  profile: {
    assign: 'إسناد مهمة', talk: 'بدء محادثة', invite: 'دعوة لاجتماع', review: 'مراجعة العمل', reports: 'عرض التقارير', responsibilities: 'تعديل المسؤوليات', permissions: 'ضبط الصلاحيات',
    overview: 'نظرة عامة', work: 'العمل', performance: 'الأداء', memory: 'الذاكرة', comms: 'التواصل', currentTask: 'المهمة الحالية', skills: 'المهارات', responsibilitiesL: 'المسؤوليات', projects: 'المشاريع', pending: 'مهام معلّقة', completed: 'مهام مكتملة',
    deliverables: 'أحدث المخرجات', runs: 'أحدث تشغيلات الذكاء الاصطناعي', roleNotes: 'ذاكرة الدور (تُرسل مع كل تشغيل)', knowledge: 'معرفة من إعداده', messages: 'الرسائل', meetings: 'الاجتماعات', manager: 'يرفع تقاريره إلى', personality: 'الشخصية', model: 'النموذج', noWork: 'لا يوجد عمل بعد.'
  },
  perf: { completed: 'مهام مكتملة', accepted: 'مخرجات مقبولة', rejected: 'مرفوضة / تتطلب تعديلات', rating: 'تقييم المالك', reviews: 'نسبة اجتياز المراجعة', failed: 'تشغيلات فاشلة', avgTime: 'متوسط مدة التنفيذ', cost: 'تكلفة الذكاء الاصطناعي', completion: 'نسبة الإنجاز', quality: 'الجودة أولًا: هذه الأرقام من المراجعات وتقييماتك، لا من حجم المخرجات.' }
};

type Lang = 'en' | 'ar';
const Ctx = createContext<{ lang: Lang; t: Dict; setLang: (l: Lang) => void }>({ lang: 'en', t: en, setLang: () => {} });

function initialLang(): Lang {
  try {
    const v = localStorage.getItem('hq.lang');
    if (v === 'ar' || v === 'en') return v;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.startsWith('ar') ? 'ar' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = lang === 'ar' ? ar.appName : en.appName;
  }, [lang]);
  const value = useMemo(
    () => ({
      lang,
      t: lang === 'ar' ? ar : en,
      setLang: (l: Lang) => {
        setLangState(l);
        try {
          localStorage.setItem('hq.lang', l);
        } catch {
          /* ignore */
        }
      }
    }),
    [lang]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
