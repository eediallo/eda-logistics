import {hostname} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Kafka, type EachMessagePayload} from 'kafkajs';
import {createClient} from '@supabase/supabase-js';
import {env} from './env.js';

type OutboxEvent = {
  id: number;
  event_type: 'medication.ready' | 'driver.pickup' | 'delivery.completed';
  delivery_order_id: string;
  payload: {pharmacy_id: string; driver_id: string | null};
  created_at: string;
};

const workerId = `${hostname()}-${process.pid}`;
const database = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {autoRefreshToken: false, persistSession: false},
});
const kafka = new Kafka({
  clientId: 'pharmacy-delivery-worker',
  brokers: env.KAFKA_BROKERS.split(',').map((broker) => broker.trim()).filter(Boolean),
});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
const consumer = kafka.consumer({groupId: 'pharmacy-delivery-notifications'});
let stopping = false;

async function publishOutboxBatch(): Promise<void> {
  const {data, error} = await database.rpc('claim_outbox_events', {
    p_worker_id: workerId,
    p_limit: 25,
  });
  if (error) throw error;

  for (const event of (data ?? []) as OutboxEvent[]) {
    try {
      await producer.send({
        topic: 'delivery.milestones',
        messages: [{
          key: event.delivery_order_id,
          value: JSON.stringify({
            id: event.id,
            type: event.event_type,
            orderId: event.delivery_order_id,
            payload: event.payload,
            occurredAt: event.created_at,
          }),
        }],
      });
      const {error: markError} = await database
        .from('event_outbox')
        .update({published_at: new Date().toISOString(), locked_at: null, locked_by: null, last_error: null})
        .eq('id', event.id)
        .eq('locked_by', workerId)
        .is('published_at', null);
      if (markError) throw markError;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown publish error';
      await database
        .from('event_outbox')
        .update({locked_at: null, locked_by: null, last_error: message})
        .eq('id', event.id)
        .eq('locked_by', workerId)
        .is('published_at', null);
      console.error(`Failed to publish outbox event ${event.id}: ${message}`);
    }
  }
}

async function deliverNotification(payload: EachMessagePayload): Promise<void> {
  const value = payload.message.value?.toString();
  if (!value) return;
  const event = JSON.parse(value) as {
    id: number;
    type: OutboxEvent['event_type'];
    orderId: string;
    payload: OutboxEvent['payload'];
  };

  let recipients: string[] = [];
  let title = '';
  let body = '';
  if (event.type === 'medication.ready') {
    const {data, error} = await database.from('profiles').select('id').eq('role', 'driver');
    if (error) throw error;
    recipients = (data ?? []).map((profile) => profile.id);
    title = 'Delivery available';
    body = 'A pharmacy has a delivery ready for pickup.';
  } else {
    recipients = event.payload.pharmacy_id ? [event.payload.pharmacy_id] : [];
    title = event.type === 'driver.pickup' ? 'Delivery picked up' : 'Delivery completed';
    body = event.type === 'driver.pickup'
      ? 'A driver picked up one of your deliveries.'
      : 'A driver completed one of your deliveries.';
  }

  if (recipients.length === 0) return;
  const rows = recipients.map((userId) => ({
    event_outbox_id: event.id,
    user_id: userId,
    title,
    body,
  }));
  const {error} = await database
    .from('notifications')
    .upsert(rows, {onConflict: 'event_outbox_id,user_id', ignoreDuplicates: true});
  if (error) throw error;
  console.info(`Recorded ${recipients.length} notification(s) for event ${event.id}`);
}

async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topic: 'delivery.milestones', fromBeginning: false});
  await consumer.run({eachMessage: deliverNotification});

  while (!stopping) {
    try {
      await publishOutboxBatch();
    } catch (error) {
      console.error('Outbox polling failed:', error);
    }
    await delay(1000);
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([producer.disconnect(), consumer.disconnect()]);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
run().catch((error) => {
  console.error('Notification worker failed to start:', error);
  process.exitCode = 1;
});
