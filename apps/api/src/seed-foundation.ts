import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: '../../.env' });
const prisma = new PrismaClient();
const sites = [
  { code: 'PSK-THR', name: 'دفتر مرکزی تهران', city: 'تهران', rooms: [
    { code: 'PSK-THR-101', name: 'اتاق جلسات مرکزی', capacity: 16, features: ['نمایشگر', 'ویدئوکنفرانس'] },
    { code: 'PSK-THR-102', name: 'اتاق کنفرانس مدیریت', capacity: 12, features: ['نمایشگر', 'تخته هوشمند'] },
    { code: 'PSK-THR-103', name: 'اتاق جلسات کوچک', capacity: 6, features: ['نمایشگر'] }
  ] },
  { code: 'PSK-KSH', name: 'سایت کاشان', city: 'کاشان', rooms: [
    { code: 'PSK-KSH-201', name: 'اتاق جلسات کاشان ۱', capacity: 10, features: ['ویدئوکنفرانس'] },
    { code: 'PSK-KSH-202', name: 'اتاق جلسات کاشان ۲', capacity: 8, features: ['نمایشگر'] }
  ] }
];
try {
  for (const item of sites) {
    const site = await prisma.site.upsert({ where: { code: item.code }, update: { name: item.name, city: item.city, isActive: true }, create: { code: item.code, name: item.name, city: item.city } });
    for (const room of item.rooms) await prisma.room.upsert({ where: { code: room.code }, update: { name: room.name, capacity: room.capacity, features: room.features, siteId: site.id, isActive: true }, create: { ...room, siteId: site.id } });
  }
  console.log('PSK foundation data seeded: 2 sites, 5 rooms. No users or reservations were created.');
} finally { await prisma.$disconnect(); }
