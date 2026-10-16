/**
 * Seeds a complete, realistic school: The Junior Cambridge School, Nari
 * (District Khushab), in the 2026-27 session.
 *
 *   npx tsx scripts/seed-school.ts
 *
 * Classes 1–10 with sections A and B, about 130 students with their guardians
 * (siblings share a guardian), 22 staff, subjects per class, subject teachers,
 * a weekly timetable, attendance since 1 September, leave, fee structures in
 * PKR with sibling/staff/merit concessions, three months of invoices and
 * payments (with a realistic tail of defaulters), the first-term examination
 * with marks and published results, payroll for August and September, the
 * chart of accounts with expense vouchers, inventory with purchase orders, and
 * admission applications for next session.
 *
 * Everything except a final date back-fill goes through the real HTTP API
 * (an in-process copy of the app with rate limiting off), so the seed is also
 * an end-to-end exercise of every module's validation, permissions and rules.
 *
 * Requires: migrations applied, `seed-permissions.ts` and `seed-super-admin.ts`
 * run, and no students yet. Deterministic: the same run produces the same school.
 */

import type { AddressInfo } from 'node:net';
import { buildContainer } from '../src/container';
import { createApp } from '../src/app';
import { closePool, withClient } from '../src/core/db/pool';

/* ------------------------------------------------------------------ helpers */

let seed = 20261016;
/** Deterministic PRNG (mulberry32), so a re-seed gives the same school. */
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));
const dow = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 = Sunday

const TODAY = iso(new Date());
const USERNAME = process.env.SUPER_ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.SUPER_ADMIN_PASSWORD;

let base = '';
let token = '';
let calls = 0;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  calls++;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 600)}`);
  }
  return json.data as T;
}

/** The id of whatever a create endpoint returned, however it is wrapped. */
function idOf(data: any): string {
  if (data?.id != null) return String(data.id);
  for (const v of Object.values(data ?? {})) if (v && typeof v === 'object' && (v as any).id != null) return String((v as any).id);
  throw new Error(`No id in ${JSON.stringify(data).slice(0, 200)}`);
}

const sql = <T = any>(text: string, params: unknown[] = []) =>
  withClient(async (c) => (await c.query(text, params)).rows as T[]);

function step(label: string) {
  console.log(`- ${label}`);
}

/* --------------------------------------------------------------- reference */

const YEAR = { name: '2026-27', start: '2026-04-01', end: '2027-03-31' };
const CLASS_COUNT = 10;
const SECTIONS = ['A', 'B'];

const BOYS = ['Muhammad Ahmed', 'Ali Hassan', 'Hamza', 'Abdullah', 'Usman', 'Bilal', 'Hassan Raza', 'Zain ul Abideen', 'Muhammad Umar',
  'Saad', 'Talha', 'Ahsan', 'Haris', 'Fahad', 'Muhammad Huzaifa', 'Shayan', 'Ayan', 'Rayyan', 'Muhammad Ibrahim', 'Arslan',
  'Daniyal', 'Abdul Hadi', 'Moiz', 'Muhammad Yousuf', 'Hamid', 'Waleed', 'Muhammad Taha', 'Faizan', 'Sami Ullah', 'Muhammad Ali'];
const GIRLS = ['Ayesha', 'Fatima', 'Zainab', 'Maryam', 'Hira', 'Iqra', 'Eman', 'Areeba', 'Laiba', 'Khadija', 'Hafsa', 'Aleena',
  'Mahnoor', 'Anaya', 'Noor ul Ain', 'Javeria', 'Rida', 'Amna', 'Sidra', 'Mehak', 'Alishba', 'Kinza', 'Dua', 'Hania', 'Ume Habiba',
  'Minahil', 'Tooba', 'Aqsa', 'Sana', 'Hoorain'];
const FATHERS = ['Muhammad Akram', 'Ghulam Mustafa', 'Muhammad Ashraf', 'Malik Nadeem', 'Rana Shahid', 'Muhammad Riaz', 'Abdul Ghafoor',
  'Zafar Iqbal', 'Muhammad Nawaz', 'Khalid Mehmood', 'Sajjad Hussain', 'Muhammad Arshad', 'Tahir Mehmood', 'Javed Iqbal', 'Ghulam Abbas',
  'Mumtaz Ahmed', 'Allah Bakhsh', 'Muhammad Siddique', 'Naeem Akhtar', 'Shahbaz Ahmed', 'Abdul Majeed', 'Liaqat Ali', 'Muhammad Yaseen',
  'Ijaz Ahmed', 'Sarfraz Khan', 'Imtiaz Hussain', 'Qamar Abbas', 'Muhammad Afzal', 'Fayyaz Ahmed', 'Asghar Ali'];
const FAMILY = ['Awan', 'Tiwana', 'Malik', 'Baloch', 'Niazi', 'Khan', 'Rana', 'Qureshi', 'Chaudhry', 'Hashmi', 'Shah', 'Bhatti', 'Janjua', 'Gondal'];
const OCCUPATIONS = ['Farmer', 'Shopkeeper', 'Government Employee', 'Teacher', 'Army (Retd.)', 'Business', 'Driver', 'Overseas (Saudi Arabia)',
  'Overseas (UAE)', 'Electrician', 'Doctor', 'Bank Officer', 'Police', 'Contractor', 'WAPDA Employee'];
const AREAS = ['Mohallah Awan Abad, Nari', 'Mohallah Islampura, Nari', 'Main Bazaar, Nari', 'Ward No. 4, Nari', 'Chak 12, Nari Road',
  'Mohallah Madina Town, Jauharabad', 'Block 3, Jauharabad', 'Quaidabad Road, Khushab', 'Mohallah Shah Jeewna, Nari', 'Dhok Malik, Nari'];
const BLOOD = ['A+', 'B+', 'B+', 'O+', 'O+', 'AB+', 'A-', 'O-'];

const phoneNo = () => `03${pick(['00', '01', '03', '05', '06', '08', '11', '21', '33', '45', '46', '55'])}${between(1000000, 9999999)}`;
const cnic = (g: 'm' | 'f') => {
  const last = between(0, 4) * 2 + (g === 'm' ? 1 : 2);
  return `38103-${between(1000000, 9999999)}-${last % 10}`;
};

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  if (!PASSWORD) throw new Error('Set SUPER_ADMIN_PASSWORD to the admin password');
  const existing = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM students`);
  if (existing[0]!.n > 0) throw new Error('Students already exist; this seed is for an empty school.');

  const app = createApp(buildContainer({ forTests: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const login = await api<{ accessToken: string }>('POST', '/auth/login', { username: USERNAME, password: PASSWORD });
    token = login.accessToken;
    await seedSchool();
  } finally {
    server.close();
  }
}

async function seedSchool(): Promise<void> {
  /* ---------------------------------------------------------- settings */
  step('School profile and settings');
  await api('PATCH', '/settings', {
    settings: {
      'school.name': 'The Junior Cambridge School',
      'school.address': 'Main Road, Nari, Tehsil & District Khushab, Punjab',
      'school.phone': '0454-720145',
      'school.email': 'info@jcsnari.edu.pk',
      'school.logo_path': '/school-logo.jpg',
      'school.currency': 'PKR',
      'school.receipt_prefix': 'JCS',
      'school.receipt_footer': 'Fee once paid is non-refundable. Please keep this receipt for your record.',
      'attendance.weekend_days': 'sunday',
      'notifications.fee_reminder_interval_days': '7',
    },
  });

  /* ---------------------------------------------------------- academic */
  step('Academic year, terms, classes, sections, rooms');
  const yearId = idOf(await api('POST', '/academic/years', { name: YEAR.name, startDate: YEAR.start, endDate: YEAR.end }));
  await api('POST', `/academic/years/${yearId}/set-current`);
  const term1 = idOf(await api('POST', '/academic/terms', { academicYearId: yearId, name: 'First Term', startDate: '2026-04-01', endDate: '2026-09-30' }));
  const term2 = idOf(await api('POST', '/academic/terms', { academicYearId: yearId, name: 'Second Term', startDate: '2026-10-01', endDate: '2027-03-31' }));

  const classIds: string[] = [];
  for (let n = 1; n <= CLASS_COUNT; n++) {
    classIds.push(idOf(await api('POST', '/academic/classes', { name: `Class ${n}`, levelOrder: n })));
  }

  const rooms: string[] = [];
  for (let n = 1; n <= CLASS_COUNT; n++) {
    for (const s of SECTIONS) rooms.push(idOf(await api('POST', '/academic/rooms', { name: `Room ${n}${s}`, roomType: 'classroom', capacity: 35 })));
  }
  const computerLab = idOf(await api('POST', '/academic/rooms', { name: 'Computer Lab', roomType: 'lab', capacity: 30 }));
  const scienceLab = idOf(await api('POST', '/academic/rooms', { name: 'Science Lab', roomType: 'lab', capacity: 30 }));
  const hall = idOf(await api('POST', '/academic/rooms', { name: 'Examination Hall', roomType: 'hall', capacity: 150 }));

  /* ------------------------------------------------------------- staff */
  step('Departments, designations, staff');
  const dept: Record<string, string> = {};
  for (const d of ['Administration', 'Primary Wing', 'Middle Wing', 'Secondary Wing', 'Accounts', 'Support Staff']) {
    dept[d] = idOf(await api('POST', '/departments', { name: d }));
  }
  const desig: Record<string, string> = {};
  for (const [d, dp] of [
    ['Principal', 'Administration'], ['Vice Principal', 'Administration'], ['Senior Teacher', null], ['Teacher', null],
    ['Accountant', 'Accounts'], ['Office Clerk', 'Administration'], ['Lab Assistant', 'Secondary Wing'],
    ['Naib Qasid', 'Support Staff'], ['Security Guard', 'Support Staff'], ['Sweeper', 'Support Staff'],
  ] as const) {
    desig[d] = idOf(await api('POST', '/designations', { name: d, departmentId: dp ? dept[dp] : null }));
  }

  // levels: P = Classes 1–5, M = 6–8, S = 9–10. `ct` marks a class teacher for that wing.
  // CLASS = a primary class teacher, who teaches her own section's general subjects.
  type StaffSeed = { name: string; g: 'male' | 'female'; dept: string; desig: string; basic: number; join: string; age: number; teaches?: string[]; levels?: string; ct?: 'P' | 'M' | 'S' };
  const T = (name: string, g: 'male' | 'female', dept: string, basic: number, join: string, age: number, teaches: string[], levels: string, ct?: 'P' | 'M' | 'S', desig = 'Teacher'): StaffSeed =>
    ({ name, g, dept, desig, basic, join, age, teaches, levels, ...(ct ? { ct } : {}) });
  const STAFF: StaffSeed[] = [
    { name: 'Shazia Parveen', g: 'female', dept: 'Administration', desig: 'Principal', basic: 120000, join: '2015-04-01', age: 49 },
    T('Muhammad Aslam Awan', 'male', 'Administration', 85000, '2016-08-15', 46, ['MATH'], 'S', undefined, 'Vice Principal'),
    // Secondary and middle wing subject specialists.
    T('Ayesha Siddiqa', 'female', 'Secondary Wing', 62000, '2017-04-01', 38, ['ENG'], 'SM', 'S', 'Senior Teacher'),
    T('Ghulam Abbas Tiwana', 'male', 'Secondary Wing', 60000, '2018-04-01', 41, ['MATH'], 'SM', 'S', 'Senior Teacher'),
    T('Imran Haider', 'male', 'Secondary Wing', 52000, '2019-04-01', 35, ['PHY', 'GSCI'], 'SM', 'S'),
    T('Saima Kausar', 'female', 'Secondary Wing', 50000, '2020-04-01', 33, ['CHEM', 'GSCI'], 'SM', 'S'),
    T('Farzana Yasmeen', 'female', 'Secondary Wing', 48000, '2021-04-01', 31, ['BIO', 'GSCI'], 'SM'),
    T('Nazia Bibi', 'female', 'Middle Wing', 55000, '2016-04-01', 42, ['URD'], 'MS', 'M', 'Senior Teacher'),
    T('Shamim Akhtar', 'female', 'Middle Wing', 42000, '2022-04-01', 34, ['URD'], 'MS', 'M'),
    T('Faiza Rani', 'female', 'Middle Wing', 43000, '2021-08-01', 30, ['ENG'], 'MS', 'M'),
    T('Asif Mehmood Malik', 'male', 'Middle Wing', 46000, '2019-08-01', 36, ['MATH'], 'MS', 'M'),
    T('Sadia Batool', 'female', 'Middle Wing', 44000, '2021-08-01', 29, ['SST', 'PST'], 'MS', 'M'),
    T('Hafiz Abdul Rehman', 'male', 'Middle Wing', 45000, '2018-08-01', 39, ['ISL', 'TQ'], 'MS', 'M'),
    T('Hafiz Zeeshan Haider', 'male', 'Middle Wing', 40000, '2023-04-01', 27, ['ISL', 'TQ'], 'MS'),
    T('Waqar Ahmed', 'male', 'Middle Wing', 50000, '2020-08-01', 30, ['COMP'], 'PMS'),
    T('Bushra Iqbal', 'female', 'Middle Wing', 42000, '2023-08-01', 26, ['COMP'], 'PMS'),
    // Primary wing: a class teacher per section, plus Islamiyat / Nazra Quran.
    T('Kiran Shahzadi', 'female', 'Primary Wing', 38000, '2021-04-01', 28, ['CLASS'], 'P', 'P'),
    T('Uzma Tariq', 'female', 'Primary Wing', 38000, '2022-04-01', 27, ['CLASS'], 'P', 'P'),
    T('Hina Javed', 'female', 'Primary Wing', 36000, '2022-08-01', 26, ['CLASS'], 'P', 'P'),
    T('Rabia Noreen', 'female', 'Primary Wing', 37000, '2021-08-01', 30, ['CLASS'], 'P', 'P'),
    T('Mehwish Akram', 'female', 'Primary Wing', 35000, '2023-04-01', 25, ['CLASS'], 'P', 'P'),
    T('Sumaira Naz', 'female', 'Primary Wing', 36000, '2020-04-01', 32, ['CLASS'], 'P', 'P'),
    T('Iram Shehzadi', 'female', 'Primary Wing', 34000, '2024-04-01', 24, ['CLASS'], 'P', 'P'),
    T('Nida Fatima', 'female', 'Primary Wing', 35000, '2023-08-01', 25, ['CLASS'], 'P', 'P'),
    T('Asma Kanwal', 'female', 'Primary Wing', 37000, '2019-04-01', 33, ['CLASS'], 'P', 'P'),
    T('Shabana Kausar', 'female', 'Primary Wing', 39000, '2017-08-01', 37, ['CLASS'], 'P', 'P'),
    T('Qari Muhammad Ilyas', 'male', 'Primary Wing', 34000, '2018-04-01', 44, ['ISL', 'NQ'], 'P'),
    T('Hafiza Rehana Kausar', 'female', 'Primary Wing', 32000, '2022-04-01', 29, ['ISL', 'NQ'], 'P'),
    T('Hafiza Sadia Noreen', 'female', 'Primary Wing', 32000, '2024-04-01', 24, ['ISL', 'NQ'], 'P'),
    { name: 'Tariq Mehmood', g: 'male', dept: 'Accounts', desig: 'Accountant', basic: 55000, join: '2017-04-01', age: 44 },
    { name: 'Naveed Anjum', g: 'male', dept: 'Administration', desig: 'Office Clerk', basic: 32000, join: '2019-04-01', age: 34 },
    { name: 'Shahid Iqbal', g: 'male', dept: 'Secondary Wing', desig: 'Lab Assistant', basic: 30000, join: '2020-04-01', age: 31 },
    { name: 'Allah Ditta', g: 'male', dept: 'Support Staff', desig: 'Naib Qasid', basic: 26000, join: '2014-04-01', age: 52 },
    { name: 'Muhammad Ramzan', g: 'male', dept: 'Support Staff', desig: 'Security Guard', basic: 27000, join: '2018-01-01', age: 47 },
    { name: 'Rukhsana Bibi', g: 'female', dept: 'Support Staff', desig: 'Sweeper', basic: 25000, join: '2016-06-01', age: 45 },
  ];
  const staffIds: string[] = [];
  for (const s of STAFF) {
    const local = s.name.toLowerCase().replace(/[^a-z]+/g, '.');
    staffIds.push(idOf(await api('POST', '/staff', {
      fullName: s.name, gender: s.g, dob: `${2026 - s.age}-${pad(between(1, 12))}-${pad(between(1, 28))}`,
      phone: phoneNo(), joinDate: s.join, nationalId: cnic(s.g === 'male' ? 'm' : 'f'),
      email: `${local}@jcsnari.edu.pk`, address: pick(AREAS) + ', District Khushab',
      departmentId: dept[s.dept], designationId: desig[s.desig],
    })));
  }
  const staffByName = new Map(STAFF.map((s, i) => [s.name, staffIds[i]!]));

  /* ---------------------------------------------------------- subjects */
  step('Subjects and class subject lists');
  const SUBJECTS: [string, string, 'core' | 'elective' | 'co_curricular'][] = [
    ['ENG', 'English', 'core'], ['URD', 'Urdu', 'core'], ['MATH', 'Mathematics', 'core'], ['GSCI', 'General Science', 'core'],
    ['ISL', 'Islamiyat', 'core'], ['SST', 'Social Studies', 'core'], ['PST', 'Pakistan Studies', 'core'], ['COMP', 'Computer Science', 'core'],
    ['PHY', 'Physics', 'core'], ['CHEM', 'Chemistry', 'core'], ['BIO', 'Biology', 'elective'], ['TQ', 'Tarjama-tul-Quran', 'core'],
    ['NQ', 'Nazra Quran', 'co_curricular'], ['ART', 'Art & Drawing', 'co_curricular'],
  ];
  const subj: Record<string, string> = {};
  for (const [code, name, type] of SUBJECTS) subj[code] = idOf(await api('POST', '/academic/subjects', { code, name, type }));

  const subjectsFor = (n: number): string[] => {
    if (n <= 2) return ['ENG', 'URD', 'MATH', 'GSCI', 'ISL', 'NQ', 'ART'];
    if (n <= 5) return ['ENG', 'URD', 'MATH', 'GSCI', 'ISL', 'SST', 'COMP', 'NQ'];
    if (n <= 8) return ['ENG', 'URD', 'MATH', 'GSCI', 'ISL', 'SST', 'COMP', 'TQ'];
    if (n === 9) return ['ENG', 'URD', 'MATH', 'PHY', 'CHEM', 'BIO', 'COMP', 'ISL', 'TQ'];
    return ['ENG', 'URD', 'MATH', 'PHY', 'CHEM', 'BIO', 'COMP', 'PST', 'TQ'];
  };
  for (let n = 1; n <= CLASS_COUNT; n++) {
    await api('PUT', `/academic/classes/${classIds[n - 1]}/subjects`, {
      subjects: subjectsFor(n).map((c) => ({ subjectId: subj[c], isMandatory: c !== 'BIO' && c !== 'ART' })),
    });
  }

  /* -------------------------------------------- sections + class teachers */
  const levelOf = (n: number) => (n <= 5 ? 'P' : n <= 8 ? 'M' : 'S');
  const ctPool: Record<string, string[]> = { P: [], M: [], S: [] };
  for (const s of STAFF) if (s.ct) ctPool[s.ct]!.push(staffByName.get(s.name)!);
  const sectionIds: { id: string; classNo: number; name: string; room: string; classTeacher: string | null }[] = [];
  let roomIdx = 0;
  for (let n = 1; n <= CLASS_COUNT; n++) {
    for (const s of SECTIONS) {
      const classTeacher = ctPool[levelOf(n)]!.shift() ?? null;
      const id = idOf(await api('POST', '/academic/sections', { classId: classIds[n - 1], name: s, capacity: 35, classTeacherId: classTeacher }));
      sectionIds.push({ id, classNo: n, name: s, room: rooms[roomIdx++]!, classTeacher });
    }
  }

  /* --------------------------------------------------- subject teachers */
  step('Subject teachers');
  // Weekly periods per subject: 7 periods x 6 days = 42 per section.
  const weeklyFor = (n: number): Record<string, number> =>
    n <= 2 ? { ENG: 7, URD: 7, MATH: 7, GSCI: 5, ISL: 5, NQ: 5, ART: 6 }
      : n <= 5 ? { ENG: 6, URD: 6, MATH: 7, GSCI: 5, ISL: 4, SST: 4, COMP: 4, NQ: 6 }
        : n <= 8 ? { ENG: 6, URD: 6, MATH: 7, GSCI: 6, ISL: 4, SST: 4, COMP: 5, TQ: 4 }
          : n === 9 ? { ENG: 5, URD: 5, MATH: 6, PHY: 5, CHEM: 5, BIO: 5, COMP: 5, ISL: 3, TQ: 3 }
            : { ENG: 5, URD: 5, MATH: 6, PHY: 5, CHEM: 5, BIO: 5, COMP: 5, PST: 3, TQ: 3 };
  const CAP = 38;
  const CLASS_SUBJECTS = ['ENG', 'URD', 'MATH', 'GSCI', 'SST', 'ART'];
  const teacherOf = new Map<string, string>(); // `${sectionId}:${code}` -> staffId
  const load = new Map<string, number>();
  for (const sec of [...sectionIds].sort((a, b) => b.classNo - a.classNo)) {
    const lvl = levelOf(sec.classNo);
    for (const [code, w] of Object.entries(weeklyFor(sec.classNo))) {
      let t: string;
      if (lvl === 'P' && CLASS_SUBJECTS.includes(code)) t = sec.classTeacher!;
      else {
        const cands = STAFF.filter((s) => s.teaches?.includes(code) && s.levels?.includes(lvl)).map((s) => staffByName.get(s.name)!)
          .sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0));
        t = cands.find((c) => (load.get(c) ?? 0) + w <= CAP) ?? cands[0]!;
      }
      load.set(t, (load.get(t) ?? 0) + w);
      teacherOf.set(`${sec.id}:${code}`, t);
      await api('POST', '/academic/subject-teachers', { academicYearId: yearId, sectionId: sec.id, subjectId: subj[code], staffId: t });
    }
  }

  /* ---------------------------------------------------------- timetable */
  step('Periods and weekly timetable');
  const PERIODS = [['1st Period', '08:00', '08:40'], ['2nd Period', '08:40', '09:20'], ['3rd Period', '09:20', '10:00'], ['4th Period', '10:00', '10:40'],
    ['5th Period', '11:10', '11:50'], ['6th Period', '11:50', '12:30'], ['7th Period', '12:30', '13:10']] as const;
  const periodIds: string[] = [];
  for (const [i, [name, startTime, endTime]] of PERIODS.entries()) {
    periodIds.push(idOf(await api('POST', '/periods', { name, startTime, endTime, sortOrder: i + 1 })));
  }
  // Most-constrained first: the teachers with the heaviest load are placed
  // before anyone else, and a primary class teacher (who only teaches her own
  // section) last, into whatever her section has left. A swap pass then repairs
  // the few periods the greedy pass could not seat.
  const DAYS = [1, 2, 3, 4, 5, 6];
  const P = periodIds.length;
  type Cell = { code: string; t: string; room: string };
  const grid = new Map(sectionIds.map((s) => [s.id, new Map<string, Cell>()])); // `${day}:${p}`
  const teacherBusy = new Set<string>(); // `${t}:${day}:${p}`
  const roomBusy = new Set<string>();
  const roomFor = (sec: (typeof sectionIds)[number], code: string, day: number, p: number) => {
    const lab = code === 'COMP' ? computerLab : ['PHY', 'CHEM', 'BIO'].includes(code) ? scienceLab : null;
    return lab && !roomBusy.has(`${lab}:${day}:${p}`) ? lab : sec.room;
  };
  const put = (sec: (typeof sectionIds)[number], code: string, day: number, p: number) => {
    const t = teacherOf.get(`${sec.id}:${code}`)!;
    const room = roomFor(sec, code, day, p);
    grid.get(sec.id)!.set(`${day}:${p}`, { code, t, room });
    teacherBusy.add(`${t}:${day}:${p}`);
    roomBusy.add(`${room}:${day}:${p}`);
  };
  const take = (sec: (typeof sectionIds)[number], day: number, p: number) => {
    const c = grid.get(sec.id)!.get(`${day}:${p}`)!;
    grid.get(sec.id)!.delete(`${day}:${p}`);
    teacherBusy.delete(`${c.t}:${day}:${p}`);
    roomBusy.delete(`${c.room}:${day}:${p}`);
    return c.code;
  };
  const perDay = (sec: (typeof sectionIds)[number], code: string, day: number) =>
    [...grid.get(sec.id)!.entries()].filter(([k, c]) => k.startsWith(`${day}:`) && c.code === code).length;

  const jobs = sectionIds.flatMap((sec) => Object.entries(weeklyFor(sec.classNo)).map(([code, w]) => ({ sec, code, w, t: teacherOf.get(`${sec.id}:${code}`)! })));
  const isClassTeacherJob = (j: (typeof jobs)[number]) => levelOf(j.sec.classNo) === 'P' && CLASS_SUBJECTS.includes(j.code);
  jobs.sort((a, b) => Number(isClassTeacherJob(a)) - Number(isClassTeacherJob(b)) || (load.get(b.t) ?? 0) - (load.get(a.t) ?? 0) || b.w - a.w);
  const unplaced: { sec: (typeof sectionIds)[number]; code: string }[] = [];
  for (const j of jobs) {
    for (let n = 0; n < j.w; n++) {
      // Spread over the week: fewest of this subject that day, then a random free period.
      const options: [number, number][] = [];
      for (const day of DAYS) for (let p = 0; p < P; p++) {
        if (!grid.get(j.sec.id)!.has(`${day}:${p}`) && !teacherBusy.has(`${j.t}:${day}:${p}`)) options.push([day, p]);
      }
      if (!options.length) { unplaced.push({ sec: j.sec, code: j.code }); continue; }
      options.sort((a, b) => perDay(j.sec, j.code, a[0]) - perDay(j.sec, j.code, b[0]) || rand() - 0.5);
      put(j.sec, j.code, options[0]![0], options[0]![1]);
    }
  }
  // Repair: seat X at a slot its teacher is free by moving the occupant Y to an
  // empty slot of this section where Y's teacher is free.
  let repaired = 0;
  for (const u of unplaced) {
    const tX = teacherOf.get(`${u.sec.id}:${u.code}`)!;
    const empties: [number, number][] = [];
    for (const day of DAYS) for (let p = 0; p < P; p++) if (!grid.get(u.sec.id)!.has(`${day}:${p}`)) empties.push([day, p]);
    let done = false;
    for (const day of DAYS) {
      for (let p = 0; p < P && !done; p++) {
        const occ = grid.get(u.sec.id)!.get(`${day}:${p}`);
        if (!occ || teacherBusy.has(`${tX}:${day}:${p}`)) continue;
        const e = empties.find(([d2, p2]) => !teacherBusy.has(`${occ.t}:${d2}:${p2}`));
        if (!e) continue;
        const y = take(u.sec, day, p);
        put(u.sec, y, e[0], e[1]);
        put(u.sec, u.code, day, p);
        done = true;
        repaired++;
      }
      if (done) break;
    }
  }
  const slots = new Map(sectionIds.map((s) => [s.id, new Map([...grid.get(s.id)!.entries()].map(([k, c]) => {
    const [day, p] = k.split(':').map(Number) as [number, number];
    return [k, { dayOfWeek: day, periodId: periodIds[p], subjectId: subj[c.code], staffId: c.t, roomId: c.room }];
  }))]));
  console.log(`  scheduler: ${unplaced.length} periods needed repair, ${repaired} repaired`);
  let ttEntries = 0;
  let holes = 0;
  for (const sec of sectionIds) {
    const entries = [...slots.get(sec.id)!.values()];
    holes += 42 - entries.length;
    ttEntries += entries.length;
    await api('POST', `/timetable/sections/${sec.id}/bulk-save`, { academicYearId: yearId, entries });
  }
  console.log(`  ${ttEntries} timetable entries (${holes} free periods)`);

  /* --------------------------------------------------------- accounting */
  step('Chart of accounts and bank accounts');
  const head: Record<string, string> = {};
  const HEADS: [string, string, string, string?][] = [
    ['1000', 'Assets', 'asset'], ['1100', 'Cash in Hand', 'asset', '1000'], ['1200', 'HBL Current Account', 'asset', '1000'],
    ['1210', 'Meezan Bank Account', 'asset', '1000'], ['1300', 'Inventory Stock', 'asset', '1000'],
    ['2000', 'Liabilities', 'liability'], ['2100', 'Accounts Payable', 'liability', '2000'], ['2200', 'Security Deposits', 'liability', '2000'],
    ['3000', 'Owner Equity', 'equity'], ['3100', 'Capital Account', 'equity', '3000'],
    ['4000', 'Income', 'income'], ['4100', 'Tuition Fee Income', 'income', '4000'], ['4200', 'Lab Fee Income', 'income', '4000'],
    ['4300', 'Admission Fee Income', 'income', '4000'], ['4400', 'Examination Fee Income', 'income', '4000'], ['4500', 'Annual Charges Income', 'income', '4000'],
    ['5000', 'Expenses', 'expense'], ['5100', 'Salaries & Wages', 'expense', '5000'], ['5200', 'Electricity (FESCO)', 'expense', '5000'],
    ['5210', 'Sui Gas', 'expense', '5000'], ['5220', 'Internet & Telephone', 'expense', '5000'], ['5300', 'Generator Fuel', 'expense', '5000'],
    ['5400', 'Stationery & Printing', 'expense', '5000'], ['5500', 'Repairs & Maintenance', 'expense', '5000'], ['5600', 'Building Rent', 'expense', '5000'],
  ];
  for (const [code, name, type, parent] of HEADS) {
    head[code] = idOf(await api('POST', '/account-heads', { code, name, type, parentId: parent ? head[parent] : null }));
  }
  const hbl = idOf(await api('POST', '/bank-accounts', { bankName: 'Habib Bank Limited, Nari Branch', accountTitle: 'The Junior Cambridge School', accountNo: '0412-79004417-03', openingBalance: '850000.00', accountHeadId: head['1200'] }));
  idOf(await api('POST', '/bank-accounts', { bankName: 'Meezan Bank, Jauharabad', accountTitle: 'The Junior Cambridge School', accountNo: '0219-0104338712', openingBalance: '320000.00', accountHeadId: head['1210'] }));

  /* -------------------------------------------------------------- fees */
  step('Fee categories, structures, concessions');
  const cat: Record<string, string> = {};
  for (const [name, frequency, income] of [
    ['Tuition Fee', 'monthly', '4100'], ['Computer Lab Fee', 'monthly', '4200'], ['Science Lab Fee', 'monthly', '4200'],
    ['Admission Fee', 'one_time', '4300'], ['Examination Fee', 'termly', '4400'], ['Annual Charges', 'yearly', '4500'],
  ] as const) {
    cat[name] = idOf(await api('POST', '/fee-categories', { name, frequency, incomeHeadId: head[income] }));
  }
  const tuition = (n: number) => (n <= 2 ? 2500 : n <= 5 ? 3000 : n <= 8 ? 3800 : 4500);
  for (let n = 1; n <= CLASS_COUNT; n++) {
    const classId = classIds[n - 1];
    await api('POST', '/fee-structures', { academicYearId: yearId, classId, feeCategoryId: cat['Tuition Fee'], amount: tuition(n), dueDay: 10 });
    if (n >= 3) await api('POST', '/fee-structures', { academicYearId: yearId, classId, feeCategoryId: cat['Computer Lab Fee'], amount: n >= 6 ? 500 : 300, dueDay: 10 });
    if (n >= 9) await api('POST', '/fee-structures', { academicYearId: yearId, classId, feeCategoryId: cat['Science Lab Fee'], amount: 400, dueDay: 10 });
  }
  const siblingDisc = idOf(await api('POST', '/discounts', { name: 'Sibling Concession (10%)', type: 'percent', value: 10 }));
  const staffDisc = idOf(await api('POST', '/discounts', { name: 'Staff Child Concession (50%)', type: 'percent', value: 50 }));
  const meritDisc = idOf(await api('POST', '/discounts', { name: 'Merit Scholarship', type: 'fixed', value: 1500 }));
  idOf(await api('POST', '/discounts', { name: 'Hafiz-e-Quran Concession (25%)', type: 'percent', value: 25 }));

  /* ---------------------------------------------- students and guardians */
  step('Guardians, students, enrollments');
  type Fam = { guardianId: string; surname: string; father: string; phone: string; kids: { enrollmentId: string; studentId: string; classNo: number; sectionId: string; first: string; ability: number }[] };
  const families: Fam[] = [];
  const allKids: (Fam['kids'][number] & { fam: Fam })[] = [];
  // Seats to fill: 6 or 7 students per section.
  const seats: { sec: (typeof sectionIds)[number] }[] = [];
  for (const sec of sectionIds) for (let i = 0; i < (sec.name === 'A' ? 7 : 6); i++) seats.push({ sec });
  // Shuffle so siblings land in different classes.
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [seats[i], seats[j]] = [seats[j]!, seats[i]!];
  }
  let seatIdx = 0;
  const usedNames = new Set<string>();
  // Two staff members send their children here.
  const staffParents = [{ staffName: 'Ghulam Abbas Tiwana', kids: 2 }, { staffName: 'Nazia Bibi', kids: 1 }];

  while (seatIdx < seats.length) {
    const fIdx = families.length;
    const staffParent = staffParents[fIdx];
    const surname = staffParent ? staffParent.staffName.split(' ').at(-1)! : pick(FAMILY);
    const father = staffParent?.staffName === 'Ghulam Abbas Tiwana' ? 'Ghulam Abbas Tiwana'
      : staffParent ? `Muhammad Zubair ${surname === 'Bibi' ? 'Awan' : surname}` : `${pick(FATHERS)} ${surname}`;
    const familySurname = surname === 'Bibi' ? 'Awan' : surname;
    const gPhone = phoneNo();
    const address = `House ${between(1, 240)}, ${pick(AREAS)}, District Khushab`;
    const guardianId = idOf(await api('POST', '/guardians', {
      fullName: father, phone: gPhone, nationalId: cnic('m'), email: rand() < 0.3 ? `${father.split(' ')[0]!.toLowerCase()}${between(10, 99)}@gmail.com` : null,
      occupation: staffParent ? 'Teacher' : pick(OCCUPATIONS), address,
    }));
    const fam: Fam = { guardianId, surname: familySurname, father, phone: gPhone, kids: [] };
    families.push(fam);

    const kidsCount = staffParent ? staffParent.kids : Math.min(seats.length - seatIdx, rand() < 0.62 ? 1 : rand() < 0.75 ? 2 : 3);
    for (let k = 0; k < kidsCount && seatIdx < seats.length; k++) {
      const { sec } = seats[seatIdx++]!;
      const gender = rand() < 0.48 ? 'female' : 'male';
      let first = '';
      do first = gender === 'male' ? pick(BOYS) : pick(GIRLS);
      while (usedNames.has(`${first} ${familySurname}`));
      usedNames.add(`${first} ${familySurname}`);
      const age = sec.classNo + 5;
      const dob = `${2026 - age - (rand() < 0.3 ? 1 : 0)}-${pad(between(1, 12))}-${pad(between(1, 28))}`;
      const joinedYear = Math.max(2016, 2026 - between(0, sec.classNo));
      const studentId = idOf(await api('POST', '/students', {
        firstName: first, lastName: familySurname, gender, dob,
        admissionDate: joinedYear === 2026 ? '2026-04-01' : `${joinedYear}-04-${pad(between(1, 15))}`,
        nationalId: null, phone: null, address, bloodGroup: pick(BLOOD), religion: 'Islam',
        previousSchool: joinedYear === 2026 && sec.classNo > 1 ? pick(['Govt. Primary School Nari', 'Allied School Jauharabad', 'The Educators, Khushab', 'Govt. High School Nari']) : null,
      }));
      await api('POST', '/student-guardians', { studentId, guardianId, relation: 'father', isPrimary: true, isFeePayer: true });
      const enr = await api('POST', '/enrollments', { studentId, academicYearId: yearId, classId: classIds[sec.classNo - 1], sectionId: sec.id, enrolledOn: '2026-04-01' });
      const kid = { enrollmentId: idOf(enr), studentId, classNo: sec.classNo, sectionId: sec.id, first, ability: 0.45 + rand() * 0.5 };
      fam.kids.push(kid);
      allKids.push({ ...kid, fam });
    }
  }
  console.log(`  ${families.length} families, ${allKids.length} students`);

  // Mothers as second contacts for some families.
  for (const fam of families.slice(0, 18)) {
    const motherId = idOf(await api('POST', '/guardians', {
      fullName: `${pick(['Shamim', 'Nasreen', 'Rubina', 'Kausar', 'Tahira', 'Samina', 'Naseem', 'Shagufta', 'Robina', 'Fozia'])} ${pick(['Bibi', 'Akhtar', 'Begum', 'Parveen'])}`,
      phone: phoneNo(), nationalId: cnic('f'), email: null, occupation: rand() < 0.2 ? 'Teacher' : 'Housewife', address: null,
    }));
    for (const k of fam.kids) await api('POST', '/student-guardians', { studentId: k.studentId, guardianId: motherId, relation: 'mother', isPrimary: false, isFeePayer: false });
  }

  // Concessions, effective from the start of the session.
  let concessions = 0;
  for (const [i, fam] of families.entries()) {
    if (i < staffParents.length) {
      for (const k of fam.kids) { await api('POST', '/student-discounts', { enrollmentId: k.enrollmentId, discountId: staffDisc, feeCategoryId: cat['Tuition Fee'], validFrom: '2026-04-01', validTo: '2027-03-31' }); concessions++; }
      continue;
    }
    // Every child after the first gets the sibling concession on tuition.
    for (const k of fam.kids.slice(1)) {
      await api('POST', '/student-discounts', { enrollmentId: k.enrollmentId, discountId: siblingDisc, feeCategoryId: cat['Tuition Fee'], validFrom: '2026-04-01', validTo: '2027-03-31' });
      concessions++;
    }
  }
  // Merit scholarships: the strongest two in each of classes 9 and 10.
  for (const n of [9, 10]) {
    const top = allKids.filter((k) => k.classNo === n).sort((a, b) => b.ability - a.ability).slice(0, 2);
    for (const k of top) { await api('POST', '/student-discounts', { enrollmentId: k.enrollmentId, discountId: meritDisc, feeCategoryId: cat['Tuition Fee'], validFrom: '2026-04-01', validTo: '2027-03-31' }); concessions++; }
  }
  console.log(`  ${concessions} concessions`);

  /* ------------------------------------------------- invoices + payments */
  step('Invoices (Aug–Oct) and payments');
  const MONTHS = [
    { period: '2026-08', issue: '2026-08-01', due: '2026-08-10', payRate: 0.97 },
    { period: '2026-09', issue: '2026-09-01', due: '2026-09-10', payRate: 0.92 },
    { period: '2026-10', issue: '2026-10-01', due: '2026-10-10', payRate: 0.68 },
  ];
  const paymentDates: { id: string; at: string }[] = [];
  // A few families are habitual late payers.
  const lateFamilies = new Set(families.filter(() => rand() < 0.08).map((f) => f.guardianId));
  for (const m of MONTHS) {
    for (const classId of classIds) {
      await api('POST', '/invoices/bulk-generate', { academicYearId: yearId, classId, billingPeriod: m.period, issueDate: m.issue, dueDate: m.due });
    }
    for (const fam of families) {
      if (lateFamilies.has(fam.guardianId) && m.period !== '2026-08') continue;
      if (rand() > m.payRate) continue;
      const inv = await sql<{ id: string; total: string; paid: string }>(
        `SELECT i.id::text, i.total::text AS total, i.paid_total::text AS paid FROM fee_invoices i
          WHERE i.billing_period = $1 AND i.enrollment_id = ANY($2::bigint[]) AND i.status IN ('unpaid','partial')`,
        [m.period, fam.kids.map((k) => k.enrollmentId)],
      );
      if (!inv.length) continue;
      const partial = m.period === '2026-10' && rand() < 0.15;
      const allocations = inv.map((r) => {
        const due = Number(r.total) - Number(r.paid);
        return { invoiceId: r.id, amount: (partial ? Math.round(due / 2) : due).toFixed(2) };
      });
      const amount = allocations.reduce((s, a) => s + Number(a.amount), 0).toFixed(2);
      const method = rand() < 0.72 ? 'cash' : rand() < 0.6 ? 'bank' : 'online';
      const p = await api('POST', '/payments', {
        guardianId: fam.guardianId, amount, method, allocations,
        ...(method === 'bank' ? { bankAccountId: hbl, referenceNo: `HBL-DEP-${between(100000, 999999)}` } : {}),
        ...(method === 'online' ? { referenceNo: `${pick(['JazzCash', 'Easypaisa'])}-${between(10000000, 99999999)}` } : {}),
      });
      // Most families pay in the first ten days of the month.
      const day = m.period === '2026-10' ? between(2, 15) : rand() < 0.85 ? between(2, 10) : between(11, 25);
      paymentDates.push({ id: idOf(p), at: `${m.period}-${pad(day)}T${pad(between(8, 13))}:${pad(between(0, 59))}:00+05:00` });
    }
  }
  console.log(`  ${paymentDates.length} payments`);

  // One mistaken payment, reversed the same day.
  if (paymentDates.length) {
    const last = paymentDates.at(-1)!;
    await api('POST', `/payments/${last.id}/reverse`, { reason: 'Entered against the wrong family; re-entered on the correct account.' });
  }

  /* --------------------------------------------------------- attendance */
  step('Student and staff attendance since 1 September');
  const schoolDays: string[] = [];
  const holidays = new Set(['2026-09-06']); // Defence Day
  for (let d = '2026-09-01'; d <= TODAY; d = addDays(d, 1)) if (dow(d) !== 0 && !holidays.has(d)) schoolDays.push(d);
  const kidsBySection = new Map<string, typeof allKids>();
  for (const k of allKids) kidsBySection.set(k.sectionId, [...(kidsBySection.get(k.sectionId) ?? []), k]);
  const sickDays = new Map<string, Set<string>>(); // enrollment -> dates on approved leave
  let marks = 0;
  for (const date of schoolDays) {
    for (const sec of sectionIds) {
      const entries = (kidsBySection.get(sec.id) ?? []).map((k) => {
        const r = rand();
        const onLeave = sickDays.get(k.enrollmentId)?.has(date);
        const status = onLeave ? 'leave' : r < 0.035 + (1 - k.ability) * 0.06 ? 'absent' : r < 0.075 ? 'late' : 'present';
        return { enrollmentId: k.enrollmentId, status };
      });
      await api('POST', '/attendance/students/submit', {
        sectionId: sec.id, academicYearId: yearId, date, entries,
        ...(date < TODAY ? { reason: 'Entered from the class attendance register' } : {}),
      });
      marks += entries.length;
    }
    const staffEntries = staffIds.map((staffId) => {
      const r = rand();
      const status = r < 0.03 ? 'absent' : r < 0.07 ? 'late' : 'present';
      return status === 'absent' ? { staffId, status } : { staffId, status, checkIn: status === 'late' ? `08:${pad(between(10, 35))}` : `07:${pad(between(35, 55))}`, checkOut: `14:${pad(between(0, 30))}` };
    });
    await api('POST', '/attendance/staff/submit', { date, entries: staffEntries, ...(date < TODAY ? { reason: 'Entered from the staff attendance register' } : {}) });
  }
  console.log(`  ${schoolDays.length} school days, ${marks} student marks`);

  /* -------------------------------------------------------------- leave */
  step('Leave types, balances and requests');
  const sick = idOf(await api('POST', '/leave-types', { name: 'Sick Leave', appliesTo: 'both', daysPerYear: 12 }));
  const casual = idOf(await api('POST', '/leave-types', { name: 'Casual Leave', appliesTo: 'staff', daysPerYear: 10 }));
  const earned = idOf(await api('POST', '/leave-types', { name: 'Earned Leave', appliesTo: 'staff', daysPerYear: 20 }));
  const family = idOf(await api('POST', '/leave-types', { name: 'Family Function / Urgent Work', appliesTo: 'student', daysPerYear: 6 }));
  for (const s of staffIds) {
    await api('POST', '/staff-leave-balances', { staffId: s, leaveTypeId: sick, academicYearId: yearId, allotted: 12 });
    await api('POST', '/staff-leave-balances', { staffId: s, leaveTypeId: casual, academicYearId: yearId, allotted: 10 });
    await api('POST', '/staff-leave-balances', { staffId: s, leaveTypeId: earned, academicYearId: yearId, allotted: 20 });
  }
  const leaveReqs = [
    { k: 3, type: sick, from: '2026-10-19', to: '2026-10-20', reason: 'Fever and flu; doctor advised two days rest.', decide: 'approved' },
    { k: 11, type: family, from: '2026-10-22', to: '2026-10-23', reason: "Elder brother's wedding (Mehndi and Barat).", decide: 'approved' },
    { k: 27, type: sick, from: '2026-10-19', to: '2026-10-21', reason: 'Dengue test advised, recovering at home.', decide: 'approved' },
    { k: 40, type: family, from: '2026-10-26', to: '2026-10-26', reason: 'Visiting grandparents in Sargodha.', decide: 'rejected' },
    { k: 58, type: sick, from: '2026-10-20', to: '2026-10-20', reason: 'Dental appointment at DHQ Hospital Khushab.', decide: null },
    { k: 76, type: family, from: '2026-10-28', to: '2026-10-29', reason: 'Family travelling to Lahore for a funeral.', decide: null },
  ];
  for (const r of leaveReqs) {
    const kid = allKids[r.k % allKids.length]!;
    const req = await api('POST', '/leave/student-requests', { enrollmentId: kid.enrollmentId, leaveTypeId: r.type, fromDate: r.from, toDate: r.to, reason: r.reason });
    if (r.decide) await api('POST', `/leave/student-requests/${idOf(req)}/decide`, { decision: r.decide });
  }

  /* -------------------------------------------------------------- exams */
  step('Grading scale, exams, marks, results');
  const scale = idOf(await api('POST', '/grading-scales', { name: 'BISE Sargodha Scheme', isDefault: true }));
  for (const [min, max, grade, gpa, remark] of [
    [80, 100, 'A+', 4.0, 'Exceptional'], [70, 79.99, 'A', 3.7, 'Excellent'], [60, 69.99, 'B', 3.0, 'Very Good'],
    [50, 59.99, 'C', 2.5, 'Good'], [40, 49.99, 'D', 2.0, 'Fair'], [33, 39.99, 'E', 1.0, 'Satisfactory'], [0, 32.99, 'F', 0, 'Fail'],
  ] as const) {
    await api('POST', '/grading-scale-ranges', { gradingScaleId: scale, minPercent: min, maxPercent: max, grade, gpaPoints: gpa, remark });
  }
  const monthly = idOf(await api('POST', '/exam-types', { name: 'Monthly Test', weightage: 10 }));
  const termType = idOf(await api('POST', '/exam-types', { name: 'Term Examination', weightage: 40 }));
  const annual = idOf(await api('POST', '/exam-types', { name: 'Annual Examination', weightage: 50 }));

  const kidsByClass = new Map<number, typeof allKids>();
  for (const k of allKids) kidsByClass.set(k.classNo, [...(kidsByClass.get(k.classNo) ?? []), k]);

  const SITTINGS = [['08:30', '10:30'], ['11:00', '12:30'], ['13:00', '14:00']] as const;
  async function runExam(opts: { name: string; typeId: string; termId: string; start: string; end: string; total: number; marks: boolean; publish: boolean; lock: boolean }) {
    const examId = idOf(await api('POST', '/exams', { academicYearId: yearId, termId: opts.termId, examTypeId: opts.typeId, name: opts.name, startDate: opts.start, endDate: opts.end }));
    const examDays: string[] = [];
    for (let d = opts.start; d <= opts.end; d = addDays(d, 1)) if (dow(d) !== 0) examDays.push(d);
    let schedules = 0;
    for (let n = 1; n <= CLASS_COUNT; n++) {
      const codes = subjectsFor(n).filter((c) => !['NQ', 'ART'].includes(c));
      for (const [i, code] of codes.entries()) {
        const total = code === 'TQ' ? Math.min(opts.total, 50) : opts.total;
        const sch = await api('POST', '/exam-schedules', {
          examId, classId: classIds[n - 1], subjectId: subj[code], examDate: examDays[i % examDays.length], startTime: SITTINGS[Math.floor(i / examDays.length)]![0],
          endTime: SITTINGS[Math.floor(i / examDays.length)]![1], roomId: n === 10 ? hall : rooms[(n - 1) * 2], totalMarks: total, passingMarks: Math.round(total * 0.33),
        });
        schedules++;
        if (!opts.marks) continue;
        const entries = (kidsByClass.get(n) ?? []).map((k) => {
          if (rand() < 0.02) return { enrollmentId: k.enrollmentId, isAbsent: true };
          const pct = Math.max(0.12, Math.min(1, k.ability + (rand() - 0.5) * 0.25));
          return { enrollmentId: k.enrollmentId, marksObtained: Math.round(pct * total) };
        });
        await api('POST', '/marks/submit', { examScheduleId: idOf(sch), entries });
      }
    }
    if (opts.publish) await api('POST', `/exams/${examId}/publish`);
    if (opts.lock) await api('POST', `/exams/${examId}/lock`);
    console.log(`  ${opts.name}: ${schedules} papers`);
    return examId;
  }
  await runExam({ name: 'First Term Examination 2026', typeId: termType, termId: term1, start: '2026-09-14', end: '2026-09-24', total: 100, marks: true, publish: true, lock: true });
  await runExam({ name: 'October Monthly Test', typeId: monthly, termId: term2, start: '2026-10-12', end: '2026-10-15', total: 25, marks: true, publish: true, lock: false });
  await runExam({ name: 'Annual Examination 2027', typeId: annual, termId: term2, start: '2027-03-01', end: '2027-03-13', total: 100, marks: false, publish: false, lock: false });

  /* ------------------------------------------------------------ payroll */
  step('Payroll: components, salaries, August and September runs');
  const comp: Record<string, string> = {};
  for (const [name, type, calcType] of [
    ['House Rent Allowance', 'earning', 'percent'], ['Medical Allowance', 'earning', 'fixed'], ['Conveyance Allowance', 'earning', 'fixed'],
    ['Overtime / Extra Classes', 'earning', 'fixed'], ['Provident Fund', 'deduction', 'percent'], ['Income Tax', 'deduction', 'fixed'],
    ['Absence Deduction', 'deduction', 'fixed'], ['Salary Advance Recovery', 'deduction', 'fixed'],
  ] as const) {
    comp[name] = idOf(await api('POST', '/salary-components', { name, type, calcType }));
  }
  const teaching = idOf(await api('POST', '/salary-structures', { name: 'Teaching Staff', description: 'Basic pay plus medical and conveyance allowances.' }));
  const nonTeaching = idOf(await api('POST', '/salary-structures', { name: 'Non-Teaching Staff', description: 'Administrative, accounts and support staff.' }));
  for (const [i, s] of STAFF.entries()) {
    await api('POST', '/staff-salaries', { staffId: staffIds[i], salaryStructureId: s.teaches ? teaching : nonTeaching, basicSalary: s.basic, effectiveFrom: '2026-04-01' });
  }
  for (const payMonth of [8, 9]) {
    const runId = idOf(await api('POST', '/payroll-runs', { payMonth, payYear: 2026 }));
    await api('POST', `/payroll-runs/${runId}/generate-payslips`);
    const slips = await sql<{ id: string; staff_id: string; gross: string }>(`SELECT id::text, staff_id::text, gross::text FROM payslips WHERE payroll_run_id = $1`, [runId]);
    for (const p of slips) {
      const s = STAFF[staffIds.indexOf(p.staff_id)]!;
      await api('POST', `/payslips/${p.id}/adjustments`, { salaryComponentId: comp['Medical Allowance'], type: 'earning', amount: s.basic >= 50000 ? 3000 : 2000, reason: 'Monthly medical allowance' });
      await api('POST', `/payslips/${p.id}/adjustments`, { salaryComponentId: comp['Conveyance Allowance'], type: 'earning', amount: 2500, reason: 'Monthly conveyance allowance' });
      if (s.basic >= 60000) {
        await api('POST', `/payslips/${p.id}/adjustments`, { salaryComponentId: comp['Income Tax'], type: 'deduction', amount: Math.round((s.basic - 50000) * 0.05), reason: 'Withholding tax as per FBR slab' });
      }
      if (rand() < 0.15) {
        await api('POST', `/payslips/${p.id}/adjustments`, { salaryComponentId: comp['Absence Deduction'], type: 'deduction', amount: Math.round(s.basic / 30), reason: 'One day unauthorised absence' });
      }
    }
    await api('POST', `/payroll-runs/${runId}/approve`);
    await api('POST', `/payroll-runs/${runId}/mark-paid`);
  }
  // October is in progress: a draft run, payslips generated, awaiting approval.
  const octRun = idOf(await api('POST', '/payroll-runs', { payMonth: 10, payYear: 2026 }));
  await api('POST', `/payroll-runs/${octRun}/generate-payslips`);

  /* ---------------------------------------------------------- inventory */
  step('Inventory: categories, suppliers, items, purchase orders, issues');
  const icat: Record<string, string> = {};
  for (const n of ['Stationery', 'Science Lab', 'Computer Lab', 'Sports', 'Cleaning & Sanitation', 'Examination Material']) icat[n] = idOf(await api('POST', '/item-categories', { name: n }));
  const sup: Record<string, string> = {};
  for (const [name, phone, address] of [
    ['Al-Rehman Stationers', '03006081234', 'Main Bazaar, Jauharabad'],
    ['Sargodha Scientific Store', '0483721455', 'Kutchery Bazaar, Sargodha'],
    ['Digital Point Computers', '03214567890', 'Hall Road, Lahore'],
    ['Pak Sports Goods', '03337654321', 'Sialkot Road, Sialkot'],
    ['Khushab Cleaning Supplies', '03456789012', 'Railway Road, Khushab'],
  ] as const) {
    sup[name] = idOf(await api('POST', '/suppliers', { name, phone, address }));
  }
  type ItemSeed = [string, string, string, string, number, number]; // sku, name, cat, unit, reorder, unitCost
  const ITEMS: ItemSeed[] = [
    ['STN-001', 'Register (200 pages)', 'Stationery', 'pcs', 50, 180], ['STN-002', 'Whiteboard Marker (Dollar)', 'Stationery', 'box', 10, 650],
    ['STN-003', 'A4 Paper Rim (Double A)', 'Stationery', 'rim', 20, 1450], ['STN-004', 'Chalk Box (White)', 'Stationery', 'box', 15, 120],
    ['STN-005', 'Ball Pen (Piano)', 'Stationery', 'box', 10, 300], ['EXM-001', 'Answer Sheet (4 pages)', 'Examination Material', 'pcs', 500, 6],
    ['EXM-002', 'Roll Number Slip Pad', 'Examination Material', 'pcs', 20, 90], ['LAB-001', 'Test Tube (Borosilicate)', 'Science Lab', 'pcs', 40, 45],
    ['LAB-002', 'Beaker 250 ml', 'Science Lab', 'pcs', 20, 220], ['LAB-003', 'Litmus Paper (Pack)', 'Science Lab', 'pack', 10, 150],
    ['LAB-004', 'Microscope Slides (Box of 50)', 'Science Lab', 'box', 5, 550], ['CMP-001', 'USB Keyboard (A4Tech)', 'Computer Lab', 'pcs', 5, 1600],
    ['CMP-002', 'USB Mouse (Dell)', 'Computer Lab', 'pcs', 5, 950], ['CMP-003', 'Toner Cartridge (HP 85A)', 'Computer Lab', 'pcs', 2, 4800],
    ['SPT-001', 'Cricket Ball (Tape)', 'Sports', 'pcs', 12, 90], ['SPT-002', 'Football (Size 5)', 'Sports', 'pcs', 4, 2200],
    ['SPT-003', 'Badminton Shuttles (Tube)', 'Sports', 'tube', 4, 850], ['CLN-001', 'Phenyl (5 litre)', 'Cleaning & Sanitation', 'can', 6, 950],
    ['CLN-002', 'Hand Wash (500 ml)', 'Cleaning & Sanitation', 'pcs', 12, 260], ['CLN-003', 'Floor Wiper', 'Cleaning & Sanitation', 'pcs', 4, 450],
  ];
  const item: Record<string, { id: string; cost: number }> = {};
  for (const [sku, name, c, unit, reorder, cost] of ITEMS) item[sku] = { id: idOf(await api('POST', '/items', { sku, name, categoryId: icat[c], unit, reorderLevel: reorder })), cost };
  const po = async (supplier: string, orderDate: string, lines: [string, number][], receive: 'full' | 'partial' | 'none' | 'draft') => {
    const id = idOf(await api('POST', '/purchase-orders', { supplierId: sup[supplier], orderDate, items: lines.map(([sku, q]) => ({ itemId: item[sku]!.id, quantity: q, unitCost: item[sku]!.cost })) }));
    if (receive === 'draft') return id;
    await api('POST', `/purchase-orders/${id}/mark-ordered`);
    if (receive === 'none') return id;
    await api('POST', `/purchase-orders/${id}/receive`, { items: lines.map(([sku, q]) => ({ itemId: item[sku]!.id, quantity: receive === 'full' ? q : Math.ceil(q / 2) })) });
    return id;
  };
  await po('Al-Rehman Stationers', '2026-08-20', [['STN-001', 300], ['STN-002', 25], ['STN-003', 40], ['STN-004', 30], ['STN-005', 20]], 'full');
  await po('Al-Rehman Stationers', '2026-09-05', [['EXM-001', 3000], ['EXM-002', 40]], 'full');
  await po('Sargodha Scientific Store', '2026-09-02', [['LAB-001', 120], ['LAB-002', 40], ['LAB-003', 20], ['LAB-004', 8]], 'full');
  await po('Digital Point Computers', '2026-09-18', [['CMP-001', 10], ['CMP-002', 10], ['CMP-003', 4]], 'partial');
  await po('Pak Sports Goods', '2026-10-05', [['SPT-001', 48], ['SPT-002', 6], ['SPT-003', 10]], 'none');
  await po('Khushab Cleaning Supplies', '2026-10-14', [['CLN-001', 12], ['CLN-002', 36], ['CLN-003', 8]], 'draft');
  // Stock issued to the wing that uses it.
  for (const [sku, q, wing] of [['STN-001', 140, 'Administration'], ['STN-002', 12, 'Middle Wing'], ['STN-004', 18, 'Primary Wing'],
    ['EXM-001', 2600, 'Administration'], ['EXM-002', 22, 'Administration'], ['LAB-001', 30, 'Secondary Wing'],
    ['LAB-003', 8, 'Secondary Wing'], ['STN-003', 26, 'Administration'], ['CLN-001', 0, 'Support Staff']] as const) {
    if (q > 0) await api('POST', '/stock/issue', { itemId: item[sku]!.id, quantity: q, referenceType: 'department', referenceId: dept[wing] });
  }
  await api('POST', '/stock/adjust', { itemId: item['LAB-002']!.id, quantityDelta: -3, reason: 'Three beakers broken during Class 9 practical (lab register entry 14/10).' });

  /* ----------------------------------------------------- expense vouchers */
  step('Expense and transfer vouchers');
  const voucher = async (type: 'payment' | 'receipt' | 'journal', date: string, narration: string, dr: string, cr: string, amt: number) => {
    const id = idOf(await api('POST', '/vouchers', { type, voucherDate: date, narration, entries: [{ accountHeadId: head[dr], debit: amt }, { accountHeadId: head[cr], credit: amt }] }));
    await api('POST', `/vouchers/${id}/post`);
  };
  await voucher('journal', '2026-04-01', 'Opening balance: owner capital introduced', '1200', '3100', 850000);
  await voucher('journal', '2026-04-01', 'Opening balance: Meezan Bank account', '1210', '3100', 320000);
  await voucher('journal', '2026-04-01', 'Opening balance: cash in hand', '1100', '3100', 45000);
  for (const [m, elec, gas, fuel] of [['08', 48650, 3200, 18500], ['09', 52310, 3450, 21000], ['10', 39870, 3800, 9500]] as const) {
    const d = `2026-${m}`;
    await voucher('payment', `${d}-14`, `FESCO electricity bill for ${m === '08' ? 'July' : m === '09' ? 'August' : 'September'} 2026`, '5200', '1200', elec);
    await voucher('payment', `${d}-15`, `SNGPL gas bill`, '5210', '1100', gas);
    await voucher('payment', `${d}-05`, `PTCL broadband and telephone`, '5220', '1200', 4999);
    await voucher('payment', `${d}-08`, `Diesel for generator during load-shedding`, '5300', '1100', fuel);
    await voucher('journal', `${d}-12`, `Cash fee collection deposited in HBL`, '1200', '1100', m === '10' ? 180000 : 320000);
  }
  await voucher('payment', '2026-09-20', 'Repair of classroom ceiling fans and wiring (Room 6A, 7B)', '5500', '1100', 14500);
  await voucher('payment', '2026-08-25', 'Printing of diaries and fee cards', '5400', '1100', 22800);
  // A draft voucher awaiting the Principal's approval.
  await api('POST', '/vouchers', { type: 'payment', voucherDate: TODAY, narration: 'Whitewash of boundary wall (quotation approved)', entries: [{ accountHeadId: head['5500'], debit: 38000 }, { accountHeadId: head['1200'], credit: 38000 }] });

  /* --------------------------------------------------------- admissions */
  step('Admission applications for next session');
  const apps: [string, string, 'male' | 'female', string, number, string[]][] = [
    ['Muhammad Hassan Awan', '2020-03-14', 'male', 'Muhammad Rafiq Awan', 1, ['applied', 'test', 'accepted']],
    ['Zoya Fatima', '2020-07-02', 'female', 'Sajid Mehmood', 1, ['applied', 'accepted']],
    ['Abdul Rehman Tiwana', '2019-11-21', 'male', 'Shaukat Hayat Tiwana', 2, ['applied', 'test']],
    ['Hareem Baloch', '2016-05-09', 'female', 'Nadeem Abbas Baloch', 5, ['applied']],
    ['Usman Ghani', '2014-01-30', 'male', 'Abdul Ghani', 7, ['applied', 'rejected']],
    ['Laiba Niazi', '2012-09-17', 'female', 'Muhammad Iqbal Niazi', 9, ['applied', 'test']],
    ['Ali Raza Janjua', '2020-02-11', 'male', 'Raza Ali Janjua', 1, []],
    ['Muhammad Saad', '2018-08-08', 'male', 'Muhammad Kashif', 3, ['applied']],
  ];
  for (const [name, dob, gender, gName, cls, path] of apps) {
    const a = idOf(await api('POST', '/applications', { applicantName: name, dob, gender, guardianName: gName, guardianPhone: phoneNo(), appliedClassId: classIds[cls - 1], remarks: null }));
    for (const s of path) await api('PATCH', `/applications/${a}/status`, { status: s, remarks: s === 'rejected' ? 'Did not meet the entry test criteria for Class 7.' : s === 'test' ? 'Entry test on Saturday at 9:00 am.' : undefined });
  }

  /* ----------------------------------------------------------- back-fill */
  step('Back-dating payments and vouchers to when they happened');
  await withClient(async (c) => {
    await c.query('BEGIN');
    // Only the audit triggers are suspended; change capture still records
    // these updates so they replicate to the cloud copy.
    await c.query('ALTER TABLE payments DISABLE TRIGGER trg_audit_payments');
    await c.query(`UPDATE payments p SET paid_at = x.at::timestamptz, created_at = x.at::timestamptz
                     FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, at text) WHERE p.id = x.id AND p.status = 'valid'`, [JSON.stringify(paymentDates)]);
    await c.query('ALTER TABLE payments ENABLE TRIGGER trg_audit_payments');
    await c.query('ALTER TABLE vouchers DISABLE TRIGGER trg_guard_voucher');
    await c.query(`UPDATE vouchers v SET voucher_date = (p.paid_at AT TIME ZONE 'Asia/Karachi')::date
                     FROM payments p WHERE v.source_type = 'payment' AND v.source_id = p.id AND p.status = 'valid'`);
    // Fire the deferred balance check now, so the trigger can be re-enabled.
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('ALTER TABLE vouchers ENABLE TRIGGER trg_guard_voucher');
    await c.query('COMMIT');
  });

  /* -------------------------------------------------------------- report */
  const counts = await sql<{ t: string; n: number }>(`
    SELECT t, n FROM (VALUES
      ('classes', (SELECT count(*) FROM classes)), ('sections', (SELECT count(*) FROM sections)),
      ('students', (SELECT count(*) FROM students)), ('guardians', (SELECT count(*) FROM guardians)),
      ('staff', (SELECT count(*) FROM staff)), ('timetable_entries', (SELECT count(*) FROM timetable_entries)),
      ('student_attendance', (SELECT count(*) FROM student_attendance)), ('fee_invoices', (SELECT count(*) FROM fee_invoices)),
      ('payments', (SELECT count(*) FROM payments)), ('marks', (SELECT count(*) FROM marks)),
      ('payslips', (SELECT count(*) FROM payslips)), ('vouchers', (SELECT count(*) FROM vouchers)),
      ('stock_movements', (SELECT count(*) FROM stock_movements)), ('admission_applications', (SELECT count(*) FROM admission_applications))
    ) AS v(t, n)`);
  console.log(`\nDone in ${calls} API calls:`);
  for (const r of counts) console.log(`  ${r.t.padEnd(24)} ${r.n}`);
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nSEED FAILED:', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exit(1);
  });
