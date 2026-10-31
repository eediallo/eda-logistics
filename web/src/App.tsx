import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {createClient, type Session} from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
const apiBase = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');

type Role = 'pharmacy' | 'driver' | 'admin';
type Profile = {id: string; email: string | null; role: Role | null; display_name: string | null};
type AdminUser = Profile & {created_at: string};
type DeliveryOrder = {
  id: string;
  pharmacy_id: string;
  driver_id: string | null;
  medication_name: string | null;
  dosage: string | null;
  delivery_address: string | null;
  prescription_reference: string | null;
  status: 'pending' | 'ready' | 'picked_up' | 'delivered' | 'cancelled';
  created_at: string;
};
type Medication = {id: string; name: string; dosage: string; stock_count: number; is_active: boolean};
type PrescriptionMapping = {
  id: string;
  external_reference: string;
  medication: Medication;
};
type Notification = {id: string; title: string; body: string; created_at: string; read_at: string | null};

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionMapping[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [signupRole, setSignupRole] = useState<'pharmacy' | 'driver'>('pharmacy');
  const [error, setError] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => setSession(data.session));
    const {data: {subscription}} = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setProfile(null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    if (!session) throw new Error('Your session has expired. Please sign in again.');
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        ...(options.body == null ? {} : {'Content-Type': 'application/json'}),
        Authorization: `Bearer ${session.access_token}`,
        ...options.headers,
      },
    });
    const result = await response.json();
    if (!response.ok) {
      const message = typeof result.error === 'string' ? result.error : 'Request could not be completed.';
      throw new Error(message);
    }
    return result as T;
  }, [session]);

  const refresh = useCallback(async () => {
    const [{orders: nextOrders}, {data: nextNotifications, error: notificationError}] = await Promise.all([
      request<{orders: DeliveryOrder[]}>('/api/orders'),
      supabase.from('notifications').select('id,title,body,created_at,read_at')
        .order('created_at', {ascending: false}).limit(8),
    ]);
    if (notificationError) throw notificationError;
    setOrders(nextOrders);
    setNotifications(nextNotifications ?? []);
    if (profile?.role === 'pharmacy') {
      const [inventory, prescriptionList] = await Promise.all([
        request<{medications: Medication[]}>('/api/inventory'),
        request<{prescriptions: PrescriptionMapping[]}>('/api/prescriptions'),
      ]);
      setMedications(inventory.medications);
      setPrescriptions(prescriptionList.prescriptions);
    } else {
      setMedications([]);
      setPrescriptions([]);
    }
  }, [request, profile?.role]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    supabase.from('profiles').select('id,email,role,display_name').eq('id', session.user.id).single()
      .then(({data, error: profileError}) => {
        if (!active) return;
        if (profileError) setError(profileError.message);
        else setProfile(data as Profile);
      });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (!session || !profile?.role) return;
    let active = true;
    const load = async () => {
      try {
        await refresh();
        if (active) setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load the dashboard.');
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [session, profile?.role, refreshKey, refresh]);

  async function runAction(action: () => Promise<unknown>): Promise<unknown> {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      setRefreshKey((value) => value + 1);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setAuthMessage('');
    try {
      if (authMode === 'signin') {
        const {error: authError} = await supabase.auth.signInWithPassword({email, password});
        if (authError) throw authError;
      } else {
        const {data, error: authError} = await supabase.auth.signUp({
          email,
          password,
          options: {data: {requested_role: signupRole}},
        });
        if (authError) throw authError;
        if (data.session) {
          setAuthMessage('Your account is ready.');
        } else {
          setAuthMessage('Account created. Check your email to confirm it, then sign in.');
          setAuthMode('signin');
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not authenticate.');
    } finally {
      setBusy(false);
    }
  }

  async function chooseRole(role: 'pharmacy' | 'driver') {
    setBusy(true);
    setError('');
    const {error: roleError} = await supabase.rpc('set_my_app_role', {p_role: role});
    if (roleError) setError(roleError.message);
    else if (profile) setProfile({...profile, role});
    setBusy(false);
  }

  async function markNotificationRead(notification: Notification) {
    const {error: updateError} = await supabase.from('notifications')
      .update({read_at: new Date().toISOString()}).eq('id', notification.id);
    if (updateError) setError(updateError.message);
    else setRefreshKey((value) => value + 1);
  }

  function recordLocation(orderId: string) {
    if (!navigator.geolocation) {
      setError('Location sharing is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({coords}) => void runAction(() => request(`/api/orders/${orderId}/location`, {
        method: 'POST',
        body: JSON.stringify({latitude: coords.latitude, longitude: coords.longitude}),
      })),
      (cause) => setError(cause.message || 'Could not read your location.'),
      {enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000},
    );
  }

  if (!session) {
    return <SignIn email={email} password={password} setEmail={setEmail} setPassword={setPassword}
      mode={authMode} setMode={(mode) => {setAuthMode(mode); setError(''); setAuthMessage('');}}
      signupRole={signupRole} setSignupRole={setSignupRole} onSubmit={submitAuth} busy={busy}
      error={error} message={authMessage} />;
  }
  if (!profile) return <main className="loading-screen">Loading your workspace…</main>;
  if (!profile.role) {
    return <main className="loading-screen"><section className="pending-card">
      <span className="brand-mark">G</span><p className="eyebrow">GOODROUTE WORKSPACE</p>
      <h1>Choose your workspace</h1>
      <p>Select whether you’re joining as a pharmacy or a delivery driver. An admin can adjust this later.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="role-choice-buttons">
        <button className="button button-primary" disabled={busy} onClick={() => void chooseRole('pharmacy')}>I’m a pharmacy</button>
        <button className="button button-secondary" disabled={busy} onClick={() => void chooseRole('driver')}>I’m a driver</button>
      </div>
      <button className="button button-secondary" onClick={() => void supabase.auth.signOut()}>Sign out</button>
    </section></main>;
  }

  if (profile.role === 'admin') {
    return <AdminDashboard
      profile={profile}
      onSignOut={() => void supabase.auth.signOut()}
      onLoadUsers={async () => (await request<{users: AdminUser[]}>('/api/admin/users')).users}
      onAssignRole={async (userId, role) => {await request(`/api/admin/users/${userId}/role`, {method: 'PATCH', body: JSON.stringify({role})});}}
      onAskAssistant={(message) => request('/api/assistant/dispatch', {method: 'POST', body: JSON.stringify({message})})}
    />;
  }

  const greeting = profile.display_name?.trim() || profile.email?.split('@')[0] || 'there';
  const title = profile.role === 'pharmacy' ? 'Pharmacy desk' : profile.role === 'driver' ? 'Driver route' : 'Operations';
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#home"><span className="brand-mark">G</span><span>goodroute<span className="brand-dot">.</span></span></a>
      <div className="sidebar-label">WORKSPACE</div>
      <div className="nav-item nav-item-active"><span className="nav-icon">▦</span>{title}</div>
      <div className="sidebar-bottom">
        <div className="status-card"><span className="status-orb"/><span><b>All systems ready</b><small>Updated just now</small></span></div>
        <div className="user-card"><div className="avatar">{greeting.slice(0, 1).toUpperCase()}</div><div className="user-info"><b>{greeting}</b><small>{profile.role}</small></div>
          <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void supabase.auth.signOut()}>↗</button></div>
      </div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="crumb">Workspace <span>/</span> {title}</span><h1>{title}</h1></div>
        <div className="topbar-actions"><span className="live-pill"><span/> Live updates</span><span className="date-label">{new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'}).format(new Date())}</span></div>
      </header>
      {error && <div className="alert" role="alert"><span>!</span>{error}<button onClick={() => setError('')}>×</button></div>}
      <section className="welcome-row"><div><p className="eyebrow">{profile.role === 'pharmacy' ? 'PHARMACY OPERATIONS' : profile.role === 'driver' ? 'ON THE ROAD' : 'DELIVERY OVERVIEW'}</p>
        <h2>{profile.role === 'driver' ? 'Your route, at a glance.' : 'Good morning,'} <em>{profile.role === 'driver' ? '' : `${greeting}.`}</em></h2>
        <p className="subheading">{profile.role === 'driver' ? 'Pick up a delivery and keep each stop up to date.' : 'Keep every medication delivery moving smoothly.'}</p></div>
        <div className="hero-illustration"><span className="sun-disc"/><span className="hill hill-back"/><span className="hill hill-front"/><span className="parcel">✚</span></div>
      </section>
      <Stats role={profile.role} orders={orders}/>
      <div className="content-grid">
        <section className="panel orders-panel">
          <div className="panel-header"><div><p className="eyebrow">{profile.role === 'driver' ? 'PICKUPS & DELIVERIES' : 'YOUR QUEUE'}</p><h3>{profile.role === 'driver' ? 'Available and assigned' : 'Delivery orders'}</h3></div>
            <span className="count-badge">{orders.length} total</span></div>
          {profile.role === 'pharmacy' && <OrderForm busy={busy} prescriptions={prescriptions} onCreate={(input) => runAction(() => request('/api/orders', {method: 'POST', body: JSON.stringify(input)}))}/>}
          {orders.length === 0 ? <div className="empty-state"><span className="empty-icon">⌁</span><b>Nothing on the board yet</b><p>New delivery activity will show up here.</p></div> :
            <div className="order-list">{orders.map((order) => <OrderCard key={order.id} role={profile.role!} order={order} busy={busy} onLocation={() => recordLocation(order.id)} onAction={(path) => runAction(() => request(path, {method: 'POST'}))}/>)}</div>}
        </section>
        <aside className="right-column">
          {profile.role === 'pharmacy' && <InventoryPanel busy={busy} medications={medications} onUpdateMedication={(id, stockCount) => runAction(() => request(`/api/inventory/${id}`, {method: 'PATCH', body: JSON.stringify({stockCount})}))} onAddMedication={(input) => runAction(() => request('/api/inventory', {method: 'POST', body: JSON.stringify(input)}))} onAddPrescription={(input) => runAction(() => request('/api/prescriptions', {method: 'POST', body: JSON.stringify(input)}))}/>}
          <AssistantPanel role={profile.role} onAsk={(message) => request('/api/assistant/dispatch', {method: 'POST', body: JSON.stringify({message})})}/>
          <section className="panel notification-panel"><div className="panel-header"><div><p className="eyebrow">UPDATES</p><h3>Notifications</h3></div><span className="notification-count">{notifications.filter((item) => !item.read_at).length}</span></div>
            {notifications.length === 0 ? <p className="muted small-copy">Milestone updates will appear here.</p> : <div className="notification-list">{notifications.map((item) => <button className={`notification-item ${item.read_at ? '' : 'notification-unread'}`} key={item.id} onClick={() => !item.read_at && void markNotificationRead(item)}>
              <span className="notification-dot"/><span className="notification-text"><b>{item.title}</b><small>{item.body}</small><time>{new Date(item.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</time></span></button>)}</div>}
          </section>
          <div className="tip-card"><span className="tip-spark">✳</span><div><b>A little heads-up</b><p>Order addresses are visible only to the pharmacy and the assigned driver.</p></div></div>
        </aside>
      </div>
      <footer>GOODROUTE <span>·</span> Care, delivered with care.</footer>
    </main>
  </div>;
}

function SignIn(props: {
  email: string;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  mode: 'signin' | 'signup';
  setMode: (mode: 'signin' | 'signup') => void;
  signupRole: 'pharmacy' | 'driver';
  setSignupRole: (role: 'pharmacy' | 'driver') => void;
  onSubmit: (event: FormEvent) => void;
  busy: boolean;
  error: string;
  message: string;
}) {
  const signup = props.mode === 'signup';
  return <main className="signin-layout"><section className="signin-story"><a className="brand" href="#home"><span className="brand-mark">G</span><span>goodroute<span className="brand-dot">.</span></span></a>
    <div className="story-copy"><p className="eyebrow">PHARMACY DELIVERY, SIMPLIFIED</p><h1>Every delivery,<br/><em>thoughtfully handled.</em></h1><p>One calm workspace for pharmacy teams and drivers keeping care on the move.</p></div>
    <div className="story-art"><span className="story-sun"/><span className="story-arc"/><span className="story-box">✚</span><span className="story-line"/></div>
    <small className="story-footer">A clearer route from pharmacy to doorstep.</small>
  </section><section className="signin-form-side"><form className="signin-form" onSubmit={props.onSubmit}><p className="eyebrow">{signup ? 'GET STARTED' : 'WELCOME BACK'}</p><h2>{signup ? 'Create your workspace account' : 'Sign in to your workspace'}</h2><p className="muted">{signup ? 'Choose the role you’ll use in Goodroute.' : 'Sign in with your pharmacy or driver account.'}</p>
    {props.error && <div className="alert" role="alert">{props.error}</div>}
    {props.message && <div className="success-message" role="status">{props.message}</div>}
    <label>Email address<input type="email" value={props.email} onChange={(event) => props.setEmail(event.target.value)} autoComplete="username" required placeholder="you@pharmacy.com"/></label>
    <label>Password<input type="password" value={props.password} onChange={(event) => props.setPassword(event.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8} placeholder={signup ? 'At least 8 characters' : 'Enter your password'}/></label>
    {signup && <label>Account role<select value={props.signupRole} onChange={(event) => props.setSignupRole(event.target.value as 'pharmacy' | 'driver')}>
      <option value="pharmacy">Pharmacy</option><option value="driver">Delivery driver</option>
    </select></label>}
    <button className="button button-primary full-width" type="submit" disabled={props.busy}>{props.busy ? (signup ? 'Creating account…' : 'Signing in…') : (signup ? 'Create account' : 'Sign in')} <span>→</span></button>
    <p className="form-note">{signup ? 'Admins can change your role later.' : 'New to Goodroute?'} <button type="button" className="text-button auth-mode-toggle" onClick={() => props.setMode(signup ? 'signin' : 'signup')}>{signup ? 'Back to sign in' : 'Create an account'}</button></p>
  </form></section></main>;
}

function AdminDashboard({profile, onLoadUsers, onAssignRole, onSignOut, onAskAssistant}: {
  profile: Profile;
  onLoadUsers: () => Promise<AdminUser[]>;
  onAssignRole: (userId: string, role: Role) => Promise<void>;
  onSignOut: () => void;
  onAskAssistant: (message: string) => Promise<unknown>;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Role | ''>>({});
  const [error, setError] = useState('');
  const [busyUser, setBusyUser] = useState('');

  const load = useCallback(async () => {
    try {
      setUsers(await onLoadUsers());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load accounts.');
    }
  }, [onLoadUsers]);

  useEffect(() => { void load(); }, [load]);

  async function saveRole(user: AdminUser) {
    const role = roleDrafts[user.id];
    if (!role || role === user.role || user.id === profile.id) return;
    setBusyUser(user.id);
    setError('');
    try {
      await onAssignRole(user.id, role);
      setUsers((current) => current.map((entry) => entry.id === user.id ? {...entry, role} : entry));
      setRoleDrafts((current) => ({...current, [user.id]: ''}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not assign that role.');
    } finally {
      setBusyUser('');
    }
  }

  const name = profile.display_name?.trim() || profile.email?.split('@')[0] || 'Admin';
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#home"><span className="brand-mark">G</span><span>goodroute<span className="brand-dot">.</span></span></a>
      <div className="sidebar-label">ADMINISTRATION</div>
      <div className="nav-item nav-item-active"><span className="nav-icon">♙</span>Account roles</div>
      <div className="sidebar-bottom"><div className="user-card"><div className="avatar">{name.slice(0, 1).toUpperCase()}</div><div className="user-info"><b>{name}</b><small>admin</small></div><button className="icon-button" aria-label="Sign out" onClick={onSignOut}>↗</button></div></div>
    </aside>
    <main className="main-content admin-content">
      <header className="topbar"><div><span className="crumb">Workspace <span>/</span> Administration</span><h1>Account roles</h1></div><button className="button button-secondary" onClick={() => void load()}>Refresh</button></header>
      <section className="welcome-row"><div><p className="eyebrow">USER MANAGEMENT</p><h2>Manage workspace access.</h2><p className="subheading">Set each account as a pharmacy, driver, or admin.</p></div><div className="hero-illustration"><span className="sun-disc"/><span className="hill hill-back"/><span className="hill hill-front"/><span className="parcel">✚</span></div></section>
      {error && <div className="alert" role="alert"><span>!</span>{error}</div>}
      <section className="panel admin-users-panel"><div className="panel-header"><div><p className="eyebrow">AUTHENTICATED ACCOUNTS</p><h3>{users.length} accounts</h3></div></div>
        {users.length === 0 ? <div className="empty-state"><b>No accounts found</b><p>New signups will appear here.</p></div> : <div className="admin-user-list">
          <div className="admin-user-row admin-user-heading"><span>ACCOUNT</span><span>CREATED</span><span>ROLE</span><span/></div>
          {users.map((user) => <div className="admin-user-row" key={user.id}>
            <span className="admin-account"><b>{user.display_name || user.email || 'Unnamed account'}</b><small>{user.email}</small></span>
            <time>{new Date(user.created_at).toLocaleDateString()}</time>
            <select aria-label={`Role for ${user.email ?? user.id}`} value={roleDrafts[user.id] ?? user.role ?? ''} disabled={user.id === profile.id || busyUser === user.id} onChange={(event) => setRoleDrafts({...roleDrafts, [user.id]: event.target.value as Role | ''})}>
              <option value="">Choose role</option><option value="pharmacy">Pharmacy</option><option value="driver">Driver</option><option value="admin">Admin</option>
            </select>
            {user.id === profile.id ? <span className="admin-self-label">You</span> : <button className="button button-small button-secondary" disabled={!roleDrafts[user.id] || roleDrafts[user.id] === user.role || busyUser === user.id} onClick={() => void saveRole(user)}>{busyUser === user.id ? 'Saving…' : 'Save role'}</button>}
          </div>)}
        </div>}
      </section>
      <AssistantPanel role="admin" onAsk={onAskAssistant}/>
      <p className="admin-note">New accounts may select Pharmacy or Driver during signup. Only an existing admin can grant or change admin access.</p>
      <footer>GOODROUTE <span>·</span> Care, delivered with care.</footer>
    </main>
  </div>;
}

function Stats({role, orders}: {role: Role; orders: DeliveryOrder[]}) {
  const cards = role === 'driver' ? [
    {label: 'Ready to pick up', value: orders.filter((order) => order.status === 'ready').length, icon: '↗', tone: 'mint'},
    {label: 'In progress', value: orders.filter((order) => order.status === 'picked_up').length, icon: '⌖', tone: 'peach'},
    {label: 'Completed', value: orders.filter((order) => order.status === 'delivered').length, icon: '✓', tone: 'blue'},
  ] : [
    {label: 'Awaiting prep', value: orders.filter((order) => order.status === 'pending').length, icon: '◷', tone: 'peach'},
    {label: 'Ready / in transit', value: orders.filter((order) => ['ready', 'picked_up'].includes(order.status)).length, icon: '↗', tone: 'mint'},
    {label: 'Delivered', value: orders.filter((order) => order.status === 'delivered').length, icon: '✓', tone: 'blue'},
  ];
  return <section className="stats-grid">{cards.map((card) => <article className="stat-card" key={card.label}><span className={`stat-icon ${card.tone}`}>{card.icon}</span><div><span className="stat-label">{card.label}</span><strong>{card.value}</strong></div><span className="stat-arrow">↗</span></article>)}</section>;
}

function OrderForm({busy, prescriptions, onCreate}: {busy: boolean; prescriptions: PrescriptionMapping[]; onCreate: (input: {prescriptionMappingId: string; deliveryAddress: string}) => void}) {
  const [open, setOpen] = useState(false);
  const [prescriptionMappingId, setPrescriptionMappingId] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    onCreate({prescriptionMappingId, deliveryAddress});
    setPrescriptionMappingId(''); setDeliveryAddress(''); setOpen(false);
  }
  return <div className="create-order-wrap"><button className="button button-primary" onClick={() => setOpen(!open)}>{open ? 'Cancel' : '+ New delivery'}</button>
    {open && <form className="order-form" onSubmit={submit}><label>Prescription mapping<select value={prescriptionMappingId} onChange={(event) => setPrescriptionMappingId(event.target.value)} required>
      <option value="">Select a medication and reference</option>{prescriptions.filter((item) => item.medication.is_active && item.medication.stock_count > 0).map((item) => <option key={item.id} value={item.id}>{item.medication.name} · {item.medication.dosage} · {item.external_reference}</option>)}
    </select></label>
      <label>Delivery address<input value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} required maxLength={500} placeholder="Street, city"/></label>
      <button className="button button-secondary" disabled={busy || !prescriptions.some((item) => item.medication.stock_count > 0 && item.medication.is_active)}>Create pending order</button></form>}
  </div>;
}

function InventoryPanel({busy, medications, onUpdateMedication, onAddMedication, onAddPrescription}: {busy: boolean; medications: Medication[]; onUpdateMedication: (id: string, stockCount: number) => void; onAddMedication: (input: {name: string; dosage: string; stockCount: number}) => Promise<unknown>; onAddPrescription: (input: {medicationId: string; externalReference: string}) => Promise<unknown>}) {
  const [addingMedication, setAddingMedication] = useState(false);
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [stockCount, setStockCount] = useState(0);
  const [medicationId, setMedicationId] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [addingReference, setAddingReference] = useState(false);
  const [stockDrafts, setStockDrafts] = useState<Record<string, number>>({});
  async function addMedication(event: FormEvent) {
    event.preventDefault();
    const result = await onAddMedication({name, dosage, stockCount});
    if (result === undefined) return;
    setName(''); setDosage(''); setStockCount(0); setAddingMedication(false);
  }
  async function addReference(event: FormEvent) {
    event.preventDefault();
    const result = await onAddPrescription({medicationId, externalReference});
    if (result === undefined) return;
    setMedicationId(''); setExternalReference(''); setAddingReference(false);
  }
  return <section className="panel inventory-panel"><div className="panel-header"><div><p className="eyebrow">PHARMACY STOCK</p><h3>Inventory & Rx links</h3></div><span className="count-badge">{medications.length} items</span></div>
    {medications.length === 0 ? <p className="muted small-copy">Start here: add a medication and its available stock. Then link a prescription reference to create a delivery.</p> : <div className="inventory-list">{medications.map((item) => <div className="inventory-row" key={item.id}><span className="medicine-icon">✚</span><span className="inventory-description"><b>{item.name}</b><small>{item.dosage} · {item.stock_count} in stock{item.is_active ? '' : ' · inactive'}</small></span><input className="stock-input" aria-label={`Stock count for ${item.name}`} type="number" min="0" value={stockDrafts[item.id] ?? item.stock_count} onChange={(event) => setStockDrafts({...stockDrafts, [item.id]: Number(event.target.value)})}/><button className="text-button stock-save" disabled={busy || (stockDrafts[item.id] ?? item.stock_count) === item.stock_count} onClick={() => onUpdateMedication(item.id, stockDrafts[item.id] ?? item.stock_count)}>Save</button></div>)}</div>}
    {addingMedication ? <form className="mini-form" onSubmit={addMedication}><input aria-label="Medication name" placeholder="Medication name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200}/><div className="form-row"><input aria-label="Dosage" placeholder="Dosage" value={dosage} onChange={(event) => setDosage(event.target.value)} required maxLength={100}/><input aria-label="Stock count" type="number" min="0" value={stockCount} onChange={(event) => setStockCount(Number(event.target.value))} required/></div><button className="button button-secondary" disabled={busy}>Save medication</button><button type="button" className="text-button" onClick={() => setAddingMedication(false)}>Cancel</button></form> : <button type="button" className="button button-secondary inventory-action" onClick={() => setAddingMedication(true)}>+ Add medication stock</button>}
    {medications.length > 0 && (addingReference ? <form className="mini-form" onSubmit={addReference}><select aria-label="Medication for reference" value={medicationId} onChange={(event) => setMedicationId(event.target.value)} required><option value="">Choose stock item</option>{medications.filter((item) => item.is_active).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.dosage}</option>)}</select><input aria-label="Prescription reference" placeholder="Opaque Rx reference" value={externalReference} onChange={(event) => setExternalReference(event.target.value)} required maxLength={120}/><button className="button button-secondary" disabled={busy}>Save reference mapping</button><button type="button" className="text-button" onClick={() => setAddingReference(false)}>Cancel</button></form> : <button type="button" className="button button-secondary inventory-action" onClick={() => setAddingReference(true)}>+ Map prescription reference</button>)}
    <p className="inventory-footnote">Stores an external reference only; prescription content and clinical verification stay in your pharmacy system.</p>
  </section>;
}

function OrderCard({role, order, busy, onAction, onLocation}: {role: Role; order: DeliveryOrder; busy: boolean; onAction: (path: string) => void; onLocation: () => void}) {
  const driver = role === 'driver';
  const action = driver && !order.driver_id ? ['Accept pickup', `/api/orders/${order.id}/accept`]
    : driver && order.status === 'ready' ? ['Mark picked up', `/api/orders/${order.id}/pickup`]
    : driver && order.status === 'picked_up' ? ['Complete delivery', `/api/orders/${order.id}/complete`]
    : role === 'pharmacy' && order.status === 'pending' ? ['Mark ready', `/api/orders/${order.id}/ready`] : null;
  const title = order.medication_name ?? (driver && !order.driver_id ? 'Available delivery' : 'Delivery order');
  return <article className="order-card"><div className="order-main"><span className="medicine-icon">✚</span><div className="order-copy"><div className="order-title-row"><b>{title}</b><span className={`status-pill status-${order.status}`}>{order.status.replace('_', ' ')}</span></div>
    {order.dosage && <span>{order.dosage}</span>}<small>{driver ? (order.delivery_address ?? 'Accept this pickup to view delivery details') : `Order ${order.id.slice(0, 8)}`}</small></div></div>
    <div className="order-actions">{driver && order.status === 'picked_up' && <button className="button button-small button-secondary" disabled={busy} onClick={onLocation}>Update location</button>}
      {action && <button className="button button-small button-secondary" disabled={busy} onClick={() => onAction(action[1])}>{action[0]} <span>→</span></button>}</div>
  </article>;
}

function AssistantPanel({role, onAsk}: {role: Role; onAsk: (message: string) => Promise<unknown>}) {
  const starterPrompts: Record<Role, string> = {
    pharmacy: 'How many items have been delivered, and who has completed the most deliveries?',
    driver: 'How many deliveries are available, and what is the status of my assigned deliveries?',
    admin: 'How many deliveries have been completed, who are the top drivers, and how many accounts does each role have?',
  };
  const [message, setMessage] = useState(starterPrompts[role]);
  const [answer, setAnswer] = useState('');
  const [assistantError, setAssistantError] = useState('');
  const [asking, setAsking] = useState(false);
  async function ask() {
    setAsking(true);
    setAssistantError('');
    try {
      const result = await onAsk(message) as {answer: string};
      setAnswer(result.answer);
    } catch (cause) {
      setAssistantError(cause instanceof Error ? cause.message : 'Could not get an assistant response.');
    } finally {
      setAsking(false);
    }
  }
  const label = role === 'admin' ? 'ADMIN ASSISTANT' : role === 'driver' ? 'DRIVER ASSISTANT' : 'PHARMACY ASSISTANT';
  const description = role === 'admin'
    ? 'Ask about workspace delivery performance, top drivers, and account roles.'
    : role === 'driver'
      ? 'Ask about available pickups, your assigned deliveries, and your progress.'
      : 'Ask about delivery counts, completed items, top drivers, or the ready queue.';
  return <section className="assistant-card"><div className="assistant-heading"><span className="assistant-icon">✳</span><div><p className="eyebrow">ADK {label}</p><h3>Ask about deliveries</h3></div></div>
    <p className="assistant-desc">{description}</p>
    <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} aria-label="Ask about deliveries"/>
    <button className="button button-dark full-width" disabled={asking || !message.trim()} onClick={() => void ask()}>{asking ? 'Checking deliveries…' : 'Ask assistant'} <span>↗</span></button>
    {assistantError && <p className="assistant-answer" role="alert">{assistantError}</p>}
    {answer && <p className="assistant-answer">{answer}</p>}
  </section>;
}
