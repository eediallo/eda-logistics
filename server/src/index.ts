import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import {z} from 'zod';
import {Runner, InMemorySessionService} from '@google/adk';
import type {FastifyReply, FastifyRequest} from 'fastify';
import {createAdminAgent, createDispatcherAgent, createDriverAgent} from '../../agent.js';
import {authenticate, requireRole} from './auth.js';
import {env} from './env.js';

const app = Fastify({logger: true});
await app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'dist'),
  prefix: '/',
  wildcard: false,
});
const orderInput = z.object({
  prescriptionMappingId: z.string().uuid(),
  deliveryAddress: z.string().trim().min(5).max(500),
});
const medicationInput = z.object({
  name: z.string().trim().min(1).max(200),
  dosage: z.string().trim().min(1).max(100),
  stockCount: z.number().int().min(0).max(1_000_000),
});
const medicationUpdateInput = z.object({
  stockCount: z.number().int().min(0).max(1_000_000).optional(),
  isActive: z.boolean().optional(),
}).refine((value) => value.stockCount !== undefined || value.isActive !== undefined);
const prescriptionMappingInput = z.object({
  medicationId: z.string().uuid(),
  externalReference: z.string().trim().min(1).max(120),
});
const appRoleInput = z.enum(['pharmacy', 'driver', 'admin']);
const locationInput = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const assistantInput = z.object({message: z.string().trim().min(1).max(2000)});

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin === env.WEB_ORIGIN) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});

app.get('/health', async () => ({status: 'ok'}));

app.get('/api/admin/users', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['admin'], reply))) return;
  const {data, error} = await user.db
    .from('profiles')
    .select('id,email,display_name,role,created_at')
    .order('created_at', {ascending: false});
  if (error) {
    request.log.error({err: error}, 'Failed to load account list');
    return reply.code(500).send({error: 'Could not load accounts.'});
  }
  return {users: data};
});

app.patch<{Params: {id: string}}>('/api/admin/users/:id/role', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['admin'], reply))) return;
  const parsed = z.object({role: appRoleInput}).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});
  const {error} = await user.db.rpc('assign_app_role', {
    p_user_id: request.params.id,
    p_role: parsed.data.role,
  });
  if (error) {
    if (error.code === 'P0002') return reply.code(404).send({error: 'Account not found.'});
    request.log.error({err: error}, 'Failed to assign account role');
    return reply.code(500).send({error: 'Could not assign the role.'});
  }
  return {status: 'updated'};
});

app.get('/api/orders', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user) return;
  const {data, error} = await user.db
    .from('delivery_orders')
    .select('id, pharmacy_id, driver_id, status, created_at, updated_at')
    .order('created_at', {ascending: false});
  if (error) {
    request.log.error({err: error}, 'Failed to list delivery orders');
    return reply.code(500).send({error: 'Could not load delivery orders.'});
  }
  if (data.length === 0) return {orders: []};
  const {data: addresses, error: addressError} = await user.db
    .from('delivery_details')
    .select('delivery_order_id, medication_name, dosage, delivery_address')
    .in('delivery_order_id', data.map((order) => order.id));
  if (addressError) {
    request.log.error({err: addressError}, 'Failed to load authorized delivery addresses');
    return reply.code(500).send({error: 'Could not load delivery addresses.'});
  }
  const detailsByOrder = new Map((addresses ?? []).map((row) => [row.delivery_order_id, row]));
  const {data: links, error: linkError} = await user.db
    .from('delivery_prescriptions')
    .select('delivery_order_id, prescription_mapping_id')
    .in('delivery_order_id', data.map((order) => order.id));
  if (linkError) {
    request.log.error({err: linkError}, 'Failed to load authorized prescription links');
    return reply.code(500).send({error: 'Could not load delivery records.'});
  }
  const mappingIds = (links ?? []).map((link) => link.prescription_mapping_id);
  const {data: mappings, error: mappingError} = mappingIds.length
    ? await user.db.from('prescription_mappings').select('id, external_reference').in('id', mappingIds)
    : {data: [], error: null};
  if (mappingError) {
    request.log.error({err: mappingError}, 'Failed to load authorized prescription references');
    return reply.code(500).send({error: 'Could not load delivery records.'});
  }
  const mappingByOrder = new Map((links ?? []).map((link) => [
    link.delivery_order_id,
    (mappings ?? []).find((mapping) => mapping.id === link.prescription_mapping_id)?.external_reference ?? null,
  ]));
  return {orders: data.map((order) => ({
    ...order,
    ...(detailsByOrder.get(order.id) ?? {medication_name: null, dosage: null, delivery_address: null}),
    prescription_reference: mappingByOrder.get(order.id) ?? null,
  }))};
});

app.get('/api/inventory', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const {data, error} = await user.db
    .from('medications')
    .select('id, name, dosage, stock_count, is_active, created_at')
    .order('name');
  if (error) {
    request.log.error({err: error}, 'Failed to load pharmacy inventory');
    return reply.code(500).send({error: 'Could not load medication inventory.'});
  }
  return {medications: data};
});

app.post('/api/inventory', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const parsed = medicationInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});
  const {data, error} = await user.db.from('medications').insert({
    pharmacy_id: user.id,
    name: parsed.data.name,
    dosage: parsed.data.dosage,
    stock_count: parsed.data.stockCount,
  }).select().single();
  if (error) {
    request.log.error({err: error}, 'Failed to add pharmacy medication');
    return reply.code(500).send({error: 'Could not add the medication.'});
  }
  return reply.code(201).send({medication: data});
});

app.patch<{Params: {id: string}}>('/api/inventory/:id', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const parsed = medicationUpdateInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});
  const updates = {
    ...(parsed.data.stockCount === undefined ? {} : {stock_count: parsed.data.stockCount}),
    ...(parsed.data.isActive === undefined ? {} : {is_active: parsed.data.isActive}),
  };
  const {data, error} = await user.db.from('medications').update(updates)
    .eq('id', request.params.id).select().maybeSingle();
  if (error) {
    request.log.error({err: error}, 'Failed to update medication inventory');
    return reply.code(500).send({error: 'Could not update medication inventory.'});
  }
  if (!data) return reply.code(404).send({error: 'Medication not found.'});
  return {medication: data};
});

app.get('/api/prescriptions', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const {data, error} = await user.db
    .from('prescription_mappings')
    .select('id, medication_id, external_reference, created_at')
    .order('created_at', {ascending: false});
  if (error) {
    request.log.error({err: error}, 'Failed to load prescription mappings');
    return reply.code(500).send({error: 'Could not load prescription mappings.'});
  }
  if (data.length === 0) return {prescriptions: []};
  const {data: medications, error: medicationError} = await user.db
    .from('medications')
    .select('id, name, dosage, stock_count, is_active')
    .in('id', data.map((mapping) => mapping.medication_id));
  if (medicationError) {
    request.log.error({err: medicationError}, 'Failed to load mapped medications');
    return reply.code(500).send({error: 'Could not load prescription details.'});
  }
  const medicationById = new Map((medications ?? []).map((medication) => [medication.id, medication]));
  return {prescriptions: data.map((mapping) => ({...mapping, medication: medicationById.get(mapping.medication_id)}))};
});

app.post('/api/prescriptions', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const parsed = prescriptionMappingInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});
  const {data, error} = await user.db.from('prescription_mappings').insert({
    pharmacy_id: user.id,
    medication_id: parsed.data.medicationId,
    external_reference: parsed.data.externalReference,
  }).select().single();
  if (error) {
    request.log.error({err: error}, 'Failed to add prescription mapping');
    return reply.code(500).send({error: 'Could not add the prescription reference.'});
  }
  return reply.code(201).send({prescription: data});
});

app.post('/api/orders', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const parsed = orderInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});

  const {data, error} = await user.db.rpc('create_delivery_order', {
    p_prescription_mapping_id: parsed.data.prescriptionMappingId,
    p_delivery_address: parsed.data.deliveryAddress,
  });
  if (error) {
    if (error.code === 'P0001' || error.code === 'P0002') {
      return reply.code(409).send({error: 'That prescription mapping is unavailable or its medication is out of stock.'});
    }
    request.log.error({err: error}, 'Failed to create delivery order');
    return reply.code(500).send({error: 'Could not create the delivery order.'});
  }
  return reply.code(201).send({order: data});
});

app.post<{Params: {id: string}}>('/api/orders/:id/ready', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy'], reply))) return;
  const {data, error} = await user.db
    .from('delivery_orders')
    .update({status: 'ready'})
    .eq('id', request.params.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (error) {
    request.log.error({err: error}, 'Failed to mark delivery order ready');
    return reply.code(500).send({error: 'Could not update the delivery order.'});
  }
  if (!data) return reply.code(404).send({error: 'Order not found or no longer pending.'});
  return {order: data};
});

app.post<{Params: {id: string}}>('/api/orders/:id/accept', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['driver'], reply))) return;
  const {data, error} = await user.db.rpc('accept_delivery_order', {
    p_delivery_order_id: request.params.id,
  });
  if (error) {
    if (error.code === 'P0002') return reply.code(409).send({error: 'This order is no longer available.'});
    request.log.error({err: error}, 'Failed to accept delivery order');
    return reply.code(500).send({error: 'Could not accept the delivery order.'});
  }
  return {order: data};
});

async function advanceOrder(
  request: FastifyRequest<{Params: {id: string}}>,
  reply: FastifyReply,
  allowedRole: 'driver',
  oldStatus: 'ready' | 'picked_up',
  newStatus: 'picked_up' | 'delivered',
) {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, [allowedRole], reply))) return;
  const {data, error} = await user.db
    .from('delivery_orders')
    .update({status: newStatus})
    .eq('id', request.params.id)
    .eq('status', oldStatus)
    .select()
    .maybeSingle();
  if (error) {
    request.log.error({err: error}, 'Failed to advance delivery order');
    return reply.code(500).send({error: 'Could not update the delivery order.'});
  }
  if (!data) return reply.code(404).send({error: 'Order not found or not in the expected status.'});
  return {order: data};
}

app.post<{Params: {id: string}}>('/api/orders/:id/pickup', async (request, reply) =>
  advanceOrder(request, reply, 'driver', 'ready', 'picked_up'));

app.post<{Params: {id: string}}>('/api/orders/:id/complete', async (request, reply) =>
  advanceOrder(request, reply, 'driver', 'picked_up', 'delivered'));

app.post<{Params: {id: string}}>('/api/orders/:id/location', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['driver'], reply))) return;
  const parsed = locationInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});
  const {data: order, error: orderError} = await user.db
    .from('delivery_orders')
    .select('id,status')
    .eq('id', request.params.id)
    .maybeSingle();
  if (orderError || !order) return reply.code(404).send({error: 'Assigned order not found.'});

  const {error} = await user.db.from('driver_progress').insert({
    delivery_order_id: request.params.id,
    driver_id: user.id,
    current_lat: parsed.data.latitude,
    current_lng: parsed.data.longitude,
    status: order.status,
  });
  if (error) {
    request.log.error({err: error}, 'Failed to record driver location');
    return reply.code(500).send({error: 'Could not record the location update.'});
  }
  return reply.code(201).send({status: 'recorded'});
});

app.get('/api/analytics', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy', 'admin'], reply))) return;
  const statuses = ['pending', 'ready', 'picked_up', 'delivered'] as const;
  const counts = await Promise.all(statuses.map(async (status) => {
    const {count, error} = await user.db
      .from('delivery_orders')
      .select('id', {count: 'exact', head: true})
      .eq('status', status);
    if (error) throw error;
    return [status, count ?? 0] as const;
  }));
  return {deliveries: Object.fromEntries(counts)};
});

app.post('/api/assistant/dispatch', async (request, reply) => {
  const user = await authenticate(request, reply);
  if (!user || !(await requireRole(user, ['pharmacy', 'driver', 'admin'], reply))) return;
  const parsed = assistantInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error: parsed.error.flatten()});

  const agent = user.role === 'driver'
    ? createDriverAgent(user.db, user.id)
    : user.role === 'admin'
      ? createAdminAgent(user.db)
      : createDispatcherAgent(user.db);
  const runner = new Runner({
    appName: 'pharmacy-delivery',
    agent,
    sessionService: new InMemorySessionService(),
  });
  const events = [];
  for await (const event of runner.runEphemeral({
    userId: user.id,
    newMessage: {role: 'user', parts: [{text: parsed.data.message}]},
  })) {
    if (event.content?.parts) events.push(...event.content.parts.flatMap((part) =>
      'text' in part && part.text ? [part.text] : []));
  }
  return {answer: events.at(-1) ?? 'I could not produce a response.'};
});

app.setNotFoundHandler((request, reply) => {
  if (request.method === 'GET' && !request.url.startsWith('/api/')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({error: 'Not found.'});
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({err: error}, 'Unhandled request error');
  const errorStatusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
  const statusCode = typeof errorStatusCode === 'number' && errorStatusCode >= 400 && errorStatusCode < 500
    ? errorStatusCode
    : 500;
  const message = statusCode < 500 && error instanceof Error
    ? error.message
    : 'An unexpected server error occurred.';
  return reply.code(statusCode).send({error: message});
});

await app.listen({host: '0.0.0.0', port: env.PORT});
