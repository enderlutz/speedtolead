import { useEffect, useMemo, useState, useCallback } from "react";
import { api, getCurrentUser, startImpersonation, type AdminUser, type PermissionCatalog } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Users, Trash2, Plus, ChevronDown, ChevronRight, ShieldCheck, Loader2, LogIn } from "lucide-react";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  va: "Office (VA)",
  worker: "Worker",
};

// A reusable views+actions toggle grid bound to a draft map.
function PermGrid({
  catalog, draft, onToggle, disabled,
}: {
  catalog: PermissionCatalog;
  draft: Record<string, boolean>;
  onToggle: (key: string, value: boolean) => void;
  disabled?: boolean;
}) {
  const group = (title: string, items: { key: string; label: string }[]) => (
    <div>
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{title}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {items.map((it) => (
          <label key={it.key} className={`flex items-center gap-2 text-xs ${disabled ? "opacity-60" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              checked={!!draft[it.key]}
              disabled={disabled}
              onChange={(e) => onToggle(it.key, e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {it.label}
          </label>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      {group("Pages", catalog.views)}
      {group("Actions", catalog.actions)}
    </div>
  );
}

function UserRow({
  u, catalog, currentUsername, onChanged,
}: {
  u: AdminUser;
  catalog: PermissionCatalog;
  currentUsername: string;
  onChanged: () => void;
}) {
  const isAdminAccount = u.role === "admin";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, boolean>>(u.effective);
  const [role, setRole] = useState(u.role);
  const [seeAll, setSeeAll] = useState(u.see_all_jobs);
  const [saving, setSaving] = useState(false);

  // Re-seed the draft from role defaults when the role changes, so the grid
  // reflects the new role's baseline (admin can then tweak from there).
  const roleDefaults = catalog.role_defaults[role] || {};
  const reseedForRole = (newRole: string) => {
    setRole(newRole);
    setDraft({ ...(catalog.role_defaults[newRole] || {}), ...u.overrides });
  };

  const save = async () => {
    setSaving(true);
    try {
      // Only persist toggles that differ from the (new) role default.
      const overrides: Record<string, boolean> = {};
      for (const k of Object.keys(draft)) {
        if (!!draft[k] !== !!roleDefaults[k]) overrides[k] = !!draft[k];
      }
      await api.updateUser(u.id, { role, see_all_jobs: seeAll, permissions: overrides });
      toast.success(`Saved ${u.display_name || u.username}`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete account "${u.username}"? This can't be undone.`)) return;
    try {
      await api.deleteUser(u.id);
      toast.success("Account deleted");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const switchTo = async () => {
    if (!confirm(`Switch to ${u.display_name || u.username}'s account? You'll act as them until you return to your own account.`)) return;
    try {
      const r = await api.impersonateUser(u.id);
      startImpersonation(r.token);
      window.location.assign("/");   // reload as the target user, land on their home
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't switch accounts");
    }
  };

  return (
    <div className="border rounded-md">
      <div className="flex items-center gap-2 p-2">
        <button onClick={() => setOpen((o) => !o)} className="text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">
            {u.display_name || u.username}
            {u.username === currentUsername && <span className="ml-1.5 text-[10px] text-muted-foreground">(you)</span>}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">@{u.username}</div>
        </div>
        <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded">{ROLE_LABEL[u.role] || u.role}</span>
        {u.username !== currentUsername && (
          <button onClick={switchTo} className="text-primary hover:text-primary/80 inline-flex items-center gap-1 text-[11px]" title={`Switch to ${u.username}'s account`}>
            <LogIn className="h-3.5 w-3.5" /> Switch
          </button>
        )}
        {u.username !== currentUsername && (
          <button onClick={remove} className="text-red-600 hover:text-red-700" title="Delete account">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="border-t p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs flex items-center gap-1.5">
              <span className="text-muted-foreground">Type</span>
              <select
                value={role}
                onChange={(e) => reseedForRole(e.target.value)}
                className="text-xs rounded border bg-background px-1.5 py-1"
              >
                {catalog.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
              </select>
            </label>
            <label className="text-xs flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={seeAll} onChange={(e) => setSeeAll(e.target.checked)} className="h-3.5 w-3.5" />
              See all jobs (manager)
            </label>
          </div>

          {isAdminAccount ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" /> Admins always have full access — page/action toggles don't apply.
            </p>
          ) : (
            <PermGrid catalog={catalog} draft={draft} onToggle={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} />
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateUserForm({ catalog, onCreated }: { catalog: PermissionCatalog; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("worker");
  const [seeAll, setSeeAll] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setUsername(""); setDisplayName(""); setPassword(""); setRole("worker"); setSeeAll(false);
  };

  const create = async () => {
    if (!username.trim() || !password) { toast.error("Username and password are required"); return; }
    setSaving(true);
    try {
      await api.createUser({
        username: username.trim(),
        password,
        display_name: displayName.trim(),
        role,
        see_all_jobs: seeAll,
      });
      toast.success("Account created");
      reset();
      setOpen(false);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create account");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5 mr-1" /> Create account
      </Button>
    );
  }

  return (
    <div className="border rounded-md p-3 space-y-2 bg-muted/30">
      <p className="text-sm font-medium">New account</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" className="text-sm rounded border bg-background px-2 py-1" />
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" className="text-sm rounded border bg-background px-2 py-1" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="text" className="text-sm rounded border bg-background px-2 py-1" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="text-sm rounded border bg-background px-2 py-1">
          {catalog.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
        </select>
      </div>
      <label className="text-xs flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" checked={seeAll} onChange={(e) => setSeeAll(e.target.checked)} className="h-3.5 w-3.5" />
        See all jobs (manager)
      </label>
      <p className="text-[11px] text-muted-foreground">Permissions start from the selected type's defaults; fine-tune them after creating.</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => { setOpen(false); reset(); }} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={create} disabled={saving}>{saving ? "Creating…" : "Create"}</Button>
      </div>
    </div>
  );
}

function RoleDefaultsEditor({ catalog, onSaved }: { catalog: PermissionCatalog; onSaved: () => void }) {
  // Editable defaults for the non-admin roles (admin is always full access).
  const editableRoles = catalog.roles.filter((r) => r !== "admin");
  const [active, setActive] = useState(editableRoles[0] || "va");
  const [draft, setDraft] = useState<Record<string, boolean>>({ ...(catalog.role_defaults[active] || {}) });
  const [saving, setSaving] = useState(false);

  const pickRole = (r: string) => { setActive(r); setDraft({ ...(catalog.role_defaults[r] || {}) }); };

  const save = async () => {
    setSaving(true);
    try {
      await api.setRoleDefaults(active, draft);
      toast.success(`Saved ${ROLE_LABEL[active] || active} defaults`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save defaults");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="inline-flex border rounded-md">
        {editableRoles.map((r) => (
          <button
            key={r}
            onClick={() => pickRole(r)}
            className={`px-2.5 py-1 text-xs ${active === r ? "bg-muted font-medium" : "hover:bg-muted"}`}
          >
            {ROLE_LABEL[r] || r}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Defaults apply to every {ROLE_LABEL[active] || active} account that doesn't have a per-account override for that toggle.
      </p>
      <PermGrid catalog={catalog} draft={draft} onToggle={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} />
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save defaults"}</Button>
      </div>
    </div>
  );
}

export default function PermissionsManager() {
  const me = getCurrentUser();
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  const loadUsers = useCallback(() => {
    api.listUsers().then((r) => setUsers(r.users)).catch(() => toast.error("Failed to load users"));
  }, []);

  const loadCatalog = useCallback(() => {
    return api.getPermissionCatalog().then(setCatalog).catch(() => toast.error("Failed to load permission catalog"));
  }, []);

  useEffect(() => {
    Promise.all([loadCatalog(), api.listUsers().then((r) => setUsers(r.users))])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [loadCatalog]);

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => (a.role === "admin" ? -1 : 1) - (b.role === "admin" ? -1 : 1) || a.username.localeCompare(b.username)),
    [users],
  );

  if (loading) {
    return <div className="py-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  }
  if (!catalog) {
    return <p className="text-sm text-muted-foreground">Couldn't load the permission catalog.</p>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> Accounts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <CreateUserForm catalog={catalog} onCreated={loadUsers} />
          <div className="space-y-2">
            {sortedUsers.map((u) => (
              <UserRow key={u.id} u={u} catalog={catalog} currentUsername={me?.sub || ""} onChanged={loadUsers} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Role defaults
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RoleDefaultsEditor catalog={catalog} onSaved={() => loadCatalog().then(loadUsers)} />
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Permission changes take effect when the affected user next logs in. Admins always retain full access.
      </p>
    </div>
  );
}
