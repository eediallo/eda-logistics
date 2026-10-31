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

function pharmacyInventoryTools(database: SupabaseClient, pharmacyId: string) {
  const listStock = new FunctionTool({
    name: 'list_pharmacy_stock',
    description: 'Lists this pharmacy’s medication names, dosages, stock counts, and IDs. Use it to identify an exact item before restocking.',
    parameters: z.object({}),
    execute: async () => {
      const {data, error} = await database.from('medications')
        .select('id,name,dosage,stock_count,is_active')
        .eq('pharmacy_id', pharmacyId).order('name').limit(100);
      if (error) throw new Error('Could not load this pharmacy’s stock.');
      return data;
    },
  });

  const createStockItem = new FunctionTool({
    name: 'create_pharmacy_stock_item',
    description: 'Creates a new medication inventory item for this pharmacy with its starting stock count. Use only when explicitly asked to create a new item.',
    parameters: z.object({
      name: z.string().trim().min(1).max(200),
      dosage: z.string().trim().min(1).max(100),
      initialStock: z.number().int().min(0).max(1_000_000),
    }),
    execute: async ({name, dosage, initialStock}) => {
      const {data, error} = await database.from('medications').insert({
        pharmacy_id: pharmacyId,
        name,
        dosage,
        stock_count: initialStock,
      }).select('id,name,dosage,stock_count,is_active').single();
      if (error) throw new Error('Could not create the medication stock item.');
      return data;
    },
  });

  const addStockQuantity = new FunctionTool({
    name: 'add_pharmacy_stock_quantity',
    description: 'Adds a quantity to an existing item. The quantity is units to add, not the desired final stock total. Requires an item ID from list_pharmacy_stock.',
    parameters: z.object({
      medicationId: z.string().uuid(),
      quantity: z.number().int().min(1).max(1_000_000),
    }),
    execute: async ({medicationId, quantity}) => {
      const {data, error} = await database.rpc('increase_medication_stock', {
        p_medication_id: medicationId,
        p_quantity: quantity,
      });
      if (error) throw new Error(error.code === 'P0002'
        ? 'Medication was not found for this pharmacy or the stock limit would be exceeded.'
        : 'Could not add to medication stock.');
      return data;
    },
  });

  return [listStock, createStockItem, addStockQuantity];
}

function pharmacyOrderTools(database: SupabaseClient, pharmacyId: string) {
  const listPendingOrders = new FunctionTool({
    name: 'list_my_pending_delivery_orders',
    description: 'Lists this pharmacy’s pending orders with IDs and short order codes so the pharmacy can choose one to mark ready.',
    parameters: z.object({}),
    execute: async () => {
      const {data, error} = await database.from('delivery_orders')
        .select('id,created_at').eq('pharmacy_id', pharmacyId).eq('status', 'pending')
        .order('created_at', {ascending: true}).limit(50);
      if (error) throw new Error('Could not load pending delivery orders.');
      return (data ?? []).map((order) => ({
        id: order.id,
        orderCode: order.id.slice(0, 8),
        createdAt: order.created_at,
      }));
    },
  });

  const markOrderReady = new FunctionTool({
    name: 'mark_pharmacy_delivery_ready',
    description: 'Marks one of this pharmacy’s pending orders ready for driver pickup. Requires the exact ID returned by list_my_pending_delivery_orders.',
    parameters: z.object({deliveryOrderId: z.string().uuid()}),
    execute: async ({deliveryOrderId}) => {
      const {data, error} = await database.from('delivery_orders').update({status: 'ready'})
        .eq('id', deliveryOrderId).eq('pharmacy_id', pharmacyId).eq('status', 'pending')
        .select('id,status').maybeSingle();
      if (error) throw new Error('Could not mark the order ready.');
      if (!data) throw new Error('That order is not pending or does not belong to this pharmacy.');
      return {orderCode: data.id.slice(0, 8), status: data.status};
    },
  });

  return [listPendingOrders, markOrderReady];
}

/** Pharmacy assistant: delivery information and pharmacy-owned stock/order actions. */
export function createDispatcherAgent(database: SupabaseClient, pharmacyId: string): LlmAgent {
  return new LlmAgent({
    name: 'dispatcher_agent',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    description: 'Answers pharmacy delivery questions and manages this pharmacy’s stock and order readiness.',
    instruction: `You help pharmacy staff understand delivery activity and manage their own stock and pending orders.
      Use get_delivery_analytics for questions about totals, delivered item counts, status counts, or which drivers completed the most deliveries.
      Use list_ready_delivery_orders for questions about the current ready queue.
      Use list_pharmacy_stock before referring to a medication by ID. Use create_pharmacy_stock_item only when explicitly asked to create a new medication item. Use add_pharmacy_stock_quantity when explicitly asked to add units to an existing item; this adds units rather than setting a final total. If a medication name or dosage is ambiguous, ask which one.
      Use list_my_pending_delivery_orders before marking one ready. Mark it ready only on a clear request and only if it is pending and belongs to this pharmacy. Do not create delivery orders, assign drivers, or accept deliveries.
      The tools are scoped to the signed-in pharmacy and use its authenticated database permissions. Use their returned data for facts; never guess or claim a change succeeded unless its tool succeeds.
      Each delivery order represents one item in this MVP, so items_delivered is the number of completed orders.
      Explain that driver rankings count completed deliveries. If the data has no completed deliveries, say so instead of naming a top driver.
      Never request or reveal patient information, prescription contents, prescription references, or delivery addresses.`,
    tools: [
      deliveryAnalyticsTool(database),
      readyQueueTool(database),
      ...pharmacyInventoryTools(database, pharmacyId),
      ...pharmacyOrderTools(database, pharmacyId),
    ],
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
          id: order.id,
          order: order.id.slice(0, 8),
          status: order.status,
          created_at: order.created_at,
        })),
      };
    },
  });

  const listAvailableDeliveries = new FunctionTool({
    name: 'list_available_deliveries',
    description: 'Lists ready, unassigned delivery IDs and short order codes visible to drivers. It does not return medication or delivery details.',
    parameters: z.object({}),
    execute: async () => {
      const {data, error} = await database.from('delivery_orders')
        .select('id,created_at').eq('status', 'ready').is('driver_id', null)
        .order('created_at', {ascending: true}).limit(50);
      if (error) throw new Error('Could not load available deliveries.');
      return (data ?? []).map((order) => ({
        id: order.id,
        orderCode: order.id.slice(0, 8),
        createdAt: order.created_at,
      }));
    },
  });

  const acceptDelivery = new FunctionTool({
    name: 'accept_delivery',
    description: 'Atomically accepts one available ready delivery for the signed-in driver. Requires the exact ID returned by list_available_deliveries.',
    parameters: z.object({deliveryOrderId: z.string().uuid()}),
    execute: async ({deliveryOrderId}) => {
      const {data, error} = await database.rpc('accept_delivery_order', {
        p_delivery_order_id: deliveryOrderId,
      });
      if (error) throw new Error(error.code === 'P0002'
        ? 'That delivery is no longer available; refresh the available list.'
        : 'Could not accept the delivery.');
      return {orderCode: data.id.slice(0, 8), status: data.status};
    },
  });

  const updateAssignedDelivery = (
    name: string,
    description: string,
    previousStatus: 'ready' | 'picked_up',
    nextStatus: 'picked_up' | 'delivered',
  ) => new FunctionTool({
    name,
    description,
    parameters: z.object({deliveryOrderId: z.string().uuid()}),
    execute: async ({deliveryOrderId}) => {
      const {data, error} = await database.from('delivery_orders').update({status: nextStatus})
        .eq('id', deliveryOrderId).eq('driver_id', driverId).eq('status', previousStatus)
        .select('id,status').maybeSingle();
      if (error) throw new Error(`Could not mark the delivery ${nextStatus.replace('_', ' ')}.`);
      if (!data) throw new Error('That order is not assigned to you or is not in the required status.');
      return {orderCode: data.id.slice(0, 8), status: data.status};
    },
  });

  const markPickedUp = updateAssignedDelivery(
    'mark_delivery_picked_up',
    'Marks one of the signed-in driver’s ready assigned deliveries as picked up. Requires an exact delivery ID from the driver’s route.',
    'ready',
    'picked_up',
  );
  const markDelivered = updateAssignedDelivery(
    'mark_delivery_delivered',
    'Marks one of the signed-in driver’s picked-up deliveries as delivered. Requires an exact delivery ID from the driver’s route.',
    'picked_up',
    'delivered',
  );

  return new LlmAgent({
    name: 'driver_assistant_agent',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    description: 'Helps a delivery driver manage available pickups and assigned delivery statuses.',
    instruction: `You help the signed-in driver understand and update their delivery workload.
      Use get_my_delivery_route for questions about available deliveries, assigned work, progress, or completed deliveries.
      Only discuss the current driver's assignments and the number of unassigned ready deliveries. Do not claim to know another driver's workload.
      Use list_available_deliveries to identify an order before accepting it. The driver may identify an order by its short code; pass the exact matching ID returned by the tool to the action tool. Ask which order if the request is ambiguous.
      Accept, mark picked up, or mark delivered only when the driver clearly asks for that action. Follow the delivery lifecycle in order, and never claim a change succeeded unless the tool succeeds.
      The tools only return orders and status for this driver or unassigned ready work. They do not return addresses, patient information, medication names, or prescription details. Direct the driver to the delivery card for authorized pickup details.`,
    tools: [getDriverRoute, listAvailableDeliveries, acceptDelivery, markPickedUp, markDelivered],
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
