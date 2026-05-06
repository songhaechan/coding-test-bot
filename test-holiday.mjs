import Holidays from 'date-holidays';
import { isHoliday as isHolidayKR } from '@hyunbinseo/holidays-kr';

const hd = new Holidays('KR');
const d = new Date('2026-05-01T00:00:00Z'); // Labor Day
console.log('isHolidayKR:', isHolidayKR(d));
console.log('date-holidays:', hd.isHoliday(d));

const today = new Date();
console.log('Today:', today);
console.log('isHolidayKR today:', isHolidayKR(today));
console.log('date-holidays today:', hd.isHoliday(today));
