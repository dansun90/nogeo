import { PrismaClient } from '../generated/client/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// 1. Setup the Connection Pool (Reuse existing logic)
const connectionString = process.env.DIRECT_URL; 

// 2. Create the Pool and Adapter
const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);

// 3. Export the SINGLE instance of Prisma to be used everywhere
export const prisma = new PrismaClient({ adapter });