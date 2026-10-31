import {z} from 'zod';

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_SECURITY_PROTOCOL: z.enum(['plaintext', 'sasl_ssl']).default('plaintext'),
  KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
  KAFKA_USERNAME: z.string().optional(),
  KAFKA_PASSWORD: z.string().optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
}).superRefine((value, context) => {
  if (value.KAFKA_SECURITY_PROTOCOL === 'sasl_ssl'
      && (!value.KAFKA_SASL_MECHANISM || !value.KAFKA_USERNAME || !value.KAFKA_PASSWORD)) {
    context.addIssue({
      code: 'custom',
      message: 'KAFKA_SASL_MECHANISM, KAFKA_USERNAME, and KAFKA_PASSWORD are required when KAFKA_SECURITY_PROTOCOL=sasl_ssl.',
    });
  }
});

export const env = envSchema.parse(process.env);
