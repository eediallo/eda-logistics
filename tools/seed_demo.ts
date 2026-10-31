import {createClient} from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const demoPassword = 'DemoDelivery123!';

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to seed local demo data.');
}

const url = new URL(supabaseUrl);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
  throw new Error('Demo accounts can only be seeded into a local Supabase instance.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {autoRefreshToken: false, persistSession: false},
});

const accounts = [
  {email: 'demo.pharmacy@example.com', role: 'pharmacy', displayName: 'Demo Pharmacy'},
  {email: 'demo.driver@example.com', role: 'driver', displayName: 'Demo Driver'},
  {email: 'demo.admin@example.com', role: 'admin', displayName: 'Demo Admin'},
] as const;

async function ensureAccount(email: string, role: string, displayName: string) {
  const {data: page, error: listError} = await supabase.auth.admin.listUsers({page: 1, perPage: 1000});
  if (listError) throw listError;

  const existing = page.users.find((user) => user.email?.toLowerCase() === email);
  if (existing) return existing;

  const {data, error} = await supabase.auth.admin.createUser({
    email,
    password: demoPassword,
    email_confirm: true,
    user_metadata: {requested_role: role, display_name: displayName},
  });
  if (error) throw error;
  return data.user;
}

async function insertMissing(table: string, rows: Record<string, unknown>[], onConflict = 'id') {
  const {error} = await supabase.from(table).upsert(rows, {onConflict, ignoreDuplicates: true});
  if (error) throw error;
}

async function main() {
  const users = new Map<string, string>();
  for (const account of accounts) {
    const user = await ensureAccount(account.email, account.role, account.displayName);
    users.set(account.role, user.id);

    const {error} = await supabase.from('profiles').upsert({
      id: user.id,
      email: account.email,
      role: account.role,
      display_name: account.displayName,
    }, {onConflict: 'id'});
    if (error) throw error;
  }

  const pharmacyId = users.get('pharmacy')!;
  const driverId = users.get('driver')!;
  const meds = [
    {id: '10000000-0000-4000-8000-000000000001', pharmacy_id: pharmacyId, name: 'Demo care pack', dosage: 'Sample item', stock_count: 12, is_active: true},
    {id: '10000000-0000-4000-8000-000000000002', pharmacy_id: pharmacyId, name: 'Demo wellness pack', dosage: 'Sample item', stock_count: 8, is_active: true},
  ];
  await insertMissing('medications', meds);

  const mappings = [
    {id: '20000000-0000-4000-8000-000000000001', pharmacy_id: pharmacyId, medication_id: meds[0].id, external_reference: 'DEMO-RX-1001'},
    {id: '20000000-0000-4000-8000-000000000002', pharmacy_id: pharmacyId, medication_id: meds[1].id, external_reference: 'DEMO-RX-1002'},
  ];
  await insertMissing('prescription_mappings', mappings);

  const orders = [
    {id: '30000000-0000-4000-8000-000000000001', pharmacy_id: pharmacyId, driver_id: null, status: 'pending'},
    {id: '30000000-0000-4000-8000-000000000002', pharmacy_id: pharmacyId, driver_id: null, status: 'ready'},
    {id: '30000000-0000-4000-8000-000000000003', pharmacy_id: pharmacyId, driver_id: driverId, status: 'picked_up'},
    {id: '30000000-0000-4000-8000-000000000004', pharmacy_id: pharmacyId, driver_id: driverId, status: 'delivered'},
  ];
  await insertMissing('delivery_orders', orders);

  const details = orders.map((order, index) => ({
    delivery_order_id: order.id,
    pharmacy_id: pharmacyId,
    medication_name: meds[index % meds.length].name,
    dosage: meds[index % meds.length].dosage,
    delivery_address: `${10 + index} Demo Street, London, EC1A 1AA`,
  }));
  await insertMissing('delivery_details', details, 'delivery_order_id');

  const prescriptions = orders.map((order, index) => ({
    delivery_order_id: order.id,
    pharmacy_id: pharmacyId,
    prescription_mapping_id: mappings[index % mappings.length].id,
  }));
  await insertMissing('delivery_prescriptions', prescriptions, 'delivery_order_id');

  console.log('Local demo accounts are ready (password for all accounts: DemoDelivery123!):');
  for (const account of accounts) console.log(`  ${account.role}: ${account.email}`);
}

await main();
