import {FunctionTool, LlmAgent} from '@google/adk';
import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';

/** Build a read-only dispatch assistant scoped to the authenticated caller's RLS context. */
export function createDispatcherAgent(database: SupabaseClient): LlmAgent {
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
    description: 'Summarizes the authenticated pharmacy dispatch queue.',
    instruction: `You help pharmacy staff understand their delivery queue.
      Use list_ready_delivery_orders when the question needs current queue data.
      The tool only returns orders that the signed-in user is allowed to see.
      You are read-only: never claim that you assigned a driver or changed an order.
      Do not request or reveal patient information or delivery addresses.`,
    tools: [listReadyOrders],
  });
}
