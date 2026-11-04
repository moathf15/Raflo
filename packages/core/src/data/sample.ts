import type { City, Place } from '../types';

/**
 * SAMPLE DATA for the MVP frontend (Phase 5).
 * Place names are real; coordinates are approximate and costs/hours are left
 * null where unknown. The UI labels everything from here as sample data.
 * In Phase 6 this file is replaced by the content the admin team enters.
 */

export const CITIES: City[] = [{ id: 'madinah', name: 'المدينة المنورة', location: { lat: 24.4672, lng: 39.6112 }, timezone: 'Asia/Riyadh' }];

const MOSQUE_ETIQUETTE = 'لباس محتشم، وخفض الصوت، واحترام أوقات الصلاة والمصلين.';

export const SAMPLE_PLACES: Place[] = [
  { id: 'prophets-mosque', cityId: 'madinah', name: 'المسجد النبوي', summary: 'ثاني الحرمين الشريفين، ومقصد كل زائر للمدينة.', category: 'religious', location: { lat: 24.4672, lng: 39.6112 }, visitMinutes: 90, costPerPerson: 0, openingHours: 'مفتوح طوال اليوم', hours: { open: 0, close: 1440 }, source: null, verifiedAt: null, bestTime: 'any', etiquette: MOSQUE_ETIQUETTE, status: 'published', updatedAt: '2026-10-01', openReports: 0 },
  { id: 'quba', cityId: 'madinah', name: 'مسجد قباء', summary: 'أول مسجد بُني في الإسلام.', category: 'religious', location: { lat: 24.4393, lng: 39.6173 }, visitMinutes: 45, costPerPerson: 0, openingHours: 'مفتوح طوال اليوم', hours: { open: 0, close: 1440 }, source: null, verifiedAt: null, bestTime: 'morning', etiquette: MOSQUE_ETIQUETTE, status: 'published', updatedAt: '2026-09-20', openReports: 0 },
  { id: 'qiblatayn', cityId: 'madinah', name: 'مسجد القبلتين', summary: 'المسجد الذي نزل فيه الأمر بتحويل القبلة.', category: 'religious', location: { lat: 24.4842, lng: 39.5788 }, visitMinutes: 30, costPerPerson: 0, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'any', etiquette: MOSQUE_ETIQUETTE, status: 'published', updatedAt: '2026-08-11', openReports: 0 },
  { id: 'uhud', cityId: 'madinah', name: 'جبل أحد', summary: 'موقع غزوة أحد ومقبرة شهدائها.', category: 'history', location: { lat: 24.503, lng: 39.611 }, visitMinutes: 60, costPerPerson: 0, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'morning', etiquette: null, status: 'published', updatedAt: '2026-09-02', openReports: 0 },
  { id: 'seven-mosques', cityId: 'madinah', name: 'المساجد السبعة', summary: 'موقع غزوة الخندق ومساجده التاريخية.', category: 'history', location: { lat: 24.4768, lng: 39.596 }, visitMinutes: 45, costPerPerson: 0, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'morning', etiquette: MOSQUE_ETIQUETTE, status: 'published', updatedAt: '2026-07-15', openReports: 0 },
  { id: 'ghamama', cityId: 'madinah', name: 'مسجد الغمامة', summary: 'مسجد تاريخي قريب من المسجد النبوي.', category: 'religious', location: { lat: 24.4655, lng: 39.6075 }, visitMinutes: 20, costPerPerson: 0, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'any', etiquette: MOSQUE_ETIQUETTE, status: 'review', updatedAt: '2026-01-10', openReports: 0 },
  { id: 'hejaz-railway', cityId: 'madinah', name: 'متحف سكة حديد الحجاز', summary: 'محطة القطار التاريخية وقصة خط الحجاز.', category: 'museum', location: { lat: 24.461, lng: 39.6005 }, visitMinutes: 60, costPerPerson: null, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'afternoon', etiquette: null, status: 'published', updatedAt: '2026-06-30', openReports: 0 },
  { id: 'dates-market', cityId: 'madinah', name: 'سوق التمور', summary: 'أصناف تمور المدينة وأشهرها العجوة.', category: 'market', location: { lat: 24.4705, lng: 39.607 }, visitMinutes: 45, costPerPerson: null, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'afternoon', etiquette: null, status: 'review', updatedAt: '2026-05-04', openReports: 1 },
  { id: 'quba-walk', cityId: 'madinah', name: 'ممشى قباء', summary: 'طريق مشاة يربط بين قباء والمسجد النبوي.', category: 'nature', location: { lat: 24.452, lng: 39.615 }, visitMinutes: 40, costPerPerson: 0, openingHours: 'مفتوح طوال اليوم', hours: { open: 0, close: 1440 }, source: null, verifiedAt: null, bestTime: 'evening', etiquette: null, status: 'published', updatedAt: '2026-10-12', openReports: 0 },
  { id: 'dar-almadinah', cityId: 'madinah', name: 'متحف دار المدينة', summary: 'متحف لتاريخ المدينة المنورة وعمارتها.', category: 'museum', location: { lat: 24.443, lng: 39.629 }, visitMinutes: 90, costPerPerson: null, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'afternoon', etiquette: null, status: 'draft', updatedAt: '2026-10-28', openReports: 0 },
  { id: 'aqiq', cityId: 'madinah', name: 'وادي العقيق', summary: 'وادٍ تاريخي غرب المدينة.', category: 'nature', location: { lat: 24.495, lng: 39.575 }, visitMinutes: 60, costPerPerson: 0, openingHours: null, hours: null, source: null, verifiedAt: null, bestTime: 'afternoon', etiquette: null, status: 'draft', updatedAt: '2026-10-25', openReports: 0 }
];
