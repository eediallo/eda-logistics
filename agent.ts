import {FunctionTool, LlmAgent} from '@google/adk';
import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';

/** Build a read-only dispatch assistant scoped to the authenticated caller's RLS context. */
export function createDispatcherAgent(database: SupabaseClient): LlmAgent {
  const getDeliveryAnalytics = new FunctionTool({
    name: 'get_delivery_analytics',
    description: 'Returns role-scoped counts for delivery statuses, the number of delivered items, and the five drivers with the most completed deliveries.',
    parameters: z.object({}),
    execute: async () => {
      const {data, error} = await database.rpc('get_delivery_analytics');
      if (error) throw new Error('Could not load delivery analytics.');
      return data;
    },
  });

  const listReadyOrders = new FunctionTool({
    name: 'list_ready_delivery_orders',
    description: 'Lists ready medication deliveries visible to the signed-in pharmacy.',
    parameters: z.object({}),
    execute: async () => {
      const {data, error} = await database
        .from('delivery_orders')
        .select('id, driver_id, created_at')
        .eq('status', 'ready')
        .order('created_at', {ascending: true})
        .limit(50);
      if (error) throw new Error('Could not load the dispatch queue.');
      if (!data?.length) return [];
      const {data: details, error: detailsError} = await database
        .from('delivery_details')
        .select('delivery_order_id, medication_name, dosage')
        .in('delivery_order_id', data.map((order) => order.id));
      if (detailsError) throw new Error('Could not load dispatch details.');
      const detailByOrder = new Map((details ?? []).map((detail) => [detail.delivery_order_id, detail]));
      return data.map((order) => ({
        id: order.id,
        medication: detailByOrder.get(order.id)?.medication_name,
        dosage: detailByOrder.get(order.id)?.dosage,
        assigned: Boolean(order.driver_id),
        createdAt: order.created_at,
      }));
    },
  });

  return new LlmAgent({
    name: 'dispatcher_agent',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    description: 'Answers questions about delivery status, volume, and driver performance for the authenticated workspace.',
    instruction: `You help pharmacy staff understand delivery activity and performance.
      Use get_delivery_analytics for questions about totals, delivered item counts, status counts, or which drivers completed the most deliveries.
      Use list_ready_delivery_orders for questions about the current ready queue.
      The tools only return information the signed-in user is allowed to see. Use the returned data for factual answers; do not guess missing metrics.
      Each delivery order represents one item in this MVP, so items_delivered is the number of completed orders.
      Explain that driver rankings count completed deliveries. If the data has no completed deliveries, say so instead of naming a top driver.
      You are read-only: never claim that you assigned a driver or changed an order.
      Do not request or reveal patient information, prescription references, or delivery addresses.`,
    tools: [getDeliveryAnalytics, listReadyOrders],
  });
}
