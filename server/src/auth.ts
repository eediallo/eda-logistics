import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import type {FastifyReply, FastifyRequest} from 'fastify';
import {env} from './env.js';

export type AppRole = 'pharmacy' | 'driver' | 'admin';

export interface AuthenticatedUser {
  id: string;
  email: string | undefined;
  role: AppRole;
  db: SupabaseClient;
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedUser | undefined> {
  const authorization = request.headers.authorization;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    await reply.code(401).send({error: 'A bearer access token is required.'});
    return;
  }

  const db = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
    global: {headers: {Authorization: `Bearer ${token}`}},
  });
  const {data: {user}, error: authError} = await db.auth.getUser(token);
  if (authError || !user) {
    await reply.code(401).send({error: 'The access token is invalid or expired.'});
    return;
  }

  const {data: profile, error: profileError} = await db
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    request.log.error({err: profileError}, 'Could not load the authenticated profile');
    await reply.code(500).send({error: 'Could not load your profile.'});
    return;
  }
  if (!profile?.role) {
    await reply.code(403).send({error: 'Your account has not been assigned an application role.'});
    return;
  }

  return {id: user.id, email: user.email, role: profile.role as AppRole, db};
}

export async function requireRole(
  user: AuthenticatedUser,
  roles: AppRole[],
  reply: FastifyReply,
): Promise<boolean> {
  if (roles.includes(user.role)) return true;
  await reply.code(403).send({error: 'Your account role cannot perform this action.'});
  return false;
}
