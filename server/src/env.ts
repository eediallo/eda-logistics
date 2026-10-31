import {z} from 'zod';

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export const env = envSchema.parse(process.env);
