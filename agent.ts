import {FunctionTool, LlmAgent} from '@google/adk';
import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';

function deliveryAnalyticsTool(database: SupabaseClient) {
  return new FunctionTool({
    name: 'get_delivery_analytics',
    description: 'Returns role-scoped counts for delivery statuses, the number of delivered items, and the five drivers with the most completed deliveries.',
    parameters: z.object({}),
    execute: async () => {
      const {data, error} = await database.rpc('get_delivery_analytics');
      if (error) throw new Error('Could not load delivery analytics.');
      return data;
    },
  });
}

function readyQueueTool(database: SupabaseClient) {
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
  return listReadyOrders;
}

/** Pharmacy assistant: delivery metrics and its ready dispatch queue. */
export function createDispatcherAgent(database: SupabaseClient): LlmAgent {
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
    tools: [deliveryAnalyticsTool(database), readyQueueTool(database)],
  });
}

/** Driver assistant: only this driver's assignments and the public ready queue. */
export function createDriverAgent(database: SupabaseClient, driverId: string): LlmAgent {
  const getDriverRoute = new FunctionTool({
    name: 'get_my_delivery_route',
    description: 'Returns this driver’s available ready-delivery count, assigned delivery status counts, and recent assigned order IDs.',
    parameters: z.object({}),
    execute: async () => {
      const counts = await Promise.all([
        database.from('delivery_orders').select('id', {count: 'exact', head: true})
          .eq('status', 'ready').is('driver_id', null),
        database.from('delivery_orders').select('id', {count: 'exact', head: true})
          .eq('driver_id', driverId).eq('status', 'ready'),
        database.from('delivery_orders').select('id', {count: 'exact', head: true})
          .eq('driver_id', driverId).eq('status', 'picked_up'),
        database.from('delivery_orders').select('id', {count: 'exact', head: true})
          .eq('driver_id', driverId).eq('status', 'delivered'),
      ]);
      const failed = counts.find(({error}) => error);
      if (failed?.error) throw new Error('Could not load your delivery route.');

      const {data: recentOrders, error} = await database
        .from('delivery_orders')
        .select('id, status, created_at')
        .eq('driver_id', driverId)
        .order('updated_at', {ascending: false})
        .limit(10);
      if (error) throw new Error('Could not load your assigned deliveries.');

      return {
        available_ready_count: counts[0].count ?? 0,
        my_ready_count: counts[1].count ?? 0,
        in_progress_count: counts[2].count ?? 0,
        delivered_count: counts[3].count ?? 0,
        recent_assignments: (recentOrders ?? []).map((order) => ({
          order: order.id.slice(0, 8),
          status: order.status,
          created_at: order.created_at,
        })),
      };
    },
  });

  return new LlmAgent({
    name: 'driver_assistant_agent',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    description: 'Helps a delivery driver understand their assigned route and available work.',
    instruction: `You help the signed-in driver understand their delivery workload.
      Use get_my_delivery_route for questions about available deliveries, assigned work, progress, or completed deliveries.
      Only discuss the current driver's assignments and the number of unassigned ready deliveries. Do not claim to know another driver's workload.
      The tool intentionally does not return addresses, patient information, or prescription details. Direct the driver to the delivery card for authorized pickup details.
      You are read-only: do not claim to accept, update, or complete an order.`,
    tools: [getDriverRoute],
  });
}

/** Admin assistant: organization-wide delivery analytics and account counts. */
export function createAdminAgent(database: SupabaseClient): LlmAgent {
  const getAccountCounts = new FunctionTool({
    name: 'get_workspace_account_counts',
    description: 'Returns the total number of accounts and counts by pharmacy, driver, admin, and unassigned role.',
    parameters: z.object({}),
    execute: async () => {
      const counts = await Promise.all([
        database.from('profiles').select('id', {count: 'exact', head: true}),
        database.from('profiles').select('id', {count: 'exact', head: true}).eq('role', 'pharmacy'),
        database.from('profiles').select('id', {count: 'exact', head: true}).eq('role', 'driver'),
        database.from('profiles').select('id', {count: 'exact', head: true}).eq('role', 'admin'),
        database.from('profiles').select('id', {count: 'exact', head: true}).is('role', null),
      ]);
      const failed = counts.find(({error}) => error);
      if (failed?.error) throw new Error('Could not load workspace account counts.');
      return {
        total: counts[0].count ?? 0,
        pharmacies: counts[1].count ?? 0,
        drivers: counts[2].count ?? 0,
        admins: counts[3].count ?? 0,
        unassigned: counts[4].count ?? 0,
      };
    },
  });

  return new LlmAgent({
    name: 'admin_assistant_agent',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    description: 'Answers an administrator’s questions about workspace delivery performance and account roles.',
    instruction: `You help the signed-in administrator understand this workspace.
      Use get_delivery_analytics for organization-wide delivery counts, delivered item totals, status, or driver rankings.
      Use get_workspace_account_counts for account totals by role.
      The tools provide all factual data you may report. Do not guess, expose addresses or prescription references, or make changes to accounts or deliveries.
      Explain that driver rankings count completed deliveries and each delivery order represents one item in this MVP.`,
    tools: [deliveryAnalyticsTool(database), getAccountCounts],
  });
}
