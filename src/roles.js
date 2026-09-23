import fs from 'node:fs/promises';
import path from 'node:path';

const ROLES_FILE = path.resolve('data/roles.json');
const STAGED_FILE = path.resolve('data/roles-staged.json');

const LIMITS = {
  owner: 1,
  superAdmin: 15,
  admin: 20,
};

// Hierarchy: higher number = more powerful
const ROLE_LEVEL = { admin: 1, superAdmin: 2, owner: 3 };

const roles = {
  owner: [],      // max 1
  superAdmins: [], // max 15
  admins: [],     // max 20
};

let pendingRoles = null;

/* ── Persistence ───────────────────────────────────────── */

export async function loadRoles() {
  try {
    const saved = JSON.parse(await fs.readFile(ROLES_FILE, 'utf8'));
    if (saved.owner) roles.owner = saved.owner;
    if (saved.superAdmins) roles.superAdmins = saved.superAdmins;
    if (saved.admins) roles.admins = saved.admins;
  } catch { /* no saved state yet */ }
  // Also load any staged pending changes
  try {
    const staged = JSON.parse(await fs.readFile(STAGED_FILE, 'utf8'));
    pendingRoles = staged;
  } catch { /* no staged state */ }
  return getRoles();
}

async function saveRoles() {
  await fs.mkdir(path.dirname(ROLES_FILE), { recursive: true });
  await fs.writeFile(ROLES_FILE, JSON.stringify(roles, null, 2));
}

async function saveStaged() {
  await fs.mkdir(path.dirname(STAGED_FILE), { recursive: true });
  if (pendingRoles) {
    await fs.writeFile(STAGED_FILE, JSON.stringify(pendingRoles, null, 2));
  } else {
    try { await fs.unlink(STAGED_FILE); } catch { /* ok */ }
  }
}

/* ── Read-only accessors ───────────────────────────────── */

export function getRoles() {
  return {
    owner: [...roles.owner],
    superAdmins: [...roles.superAdmins],
    admins: [...roles.admins],
  };
}

export function getStagedRoles() {
  if (pendingRoles) return { ...pendingRoles, owner: [...pendingRoles.owner], superAdmins: [...pendingRoles.superAdmins], admins: [...pendingRoles.admins] };
  return null;
}

/**
 * Get a user's role name or null.
 */
export function getUserRole(userId) {
  if (!userId) return null;
  const id = String(userId).trim();
  if (roles.owner.includes(id)) return 'owner';
  if (roles.superAdmins.includes(id)) return 'superAdmin';
  if (roles.admins.includes(id)) return 'admin';
  return null;
}

/**
 * Check if user has at least the given minimum role level.
 * 'owner' > 'superAdmin' > 'admin'
 */
export function hasPermission(userId, minLevel = 'admin') {
  const role = getUserRole(userId);
  if (!role) return false;
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minLevel] || 0);
}

/* ── Validation helper ─────────────────────────────────── */

function validateRoles(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'Invalid roles data' };

  const staged = {
    owner: [],
    superAdmins: [],
    admins: [],
  };

  // Process owner (max 1)
  if (data.owner && Array.isArray(data.owner)) {
    if (data.owner.length > LIMITS.owner) {
      return { ok: false, error: `Owner limit exceeded. Maximum: ${LIMITS.owner}` };
    }
    staged.owner = data.owner.map(String).filter(Boolean);
  }

  // Process superAdmins (max 15)
  if (data.superAdmins && Array.isArray(data.superAdmins)) {
    if (data.superAdmins.length > LIMITS.superAdmin) {
      return { ok: false, error: `Super Admin limit exceeded. Maximum: ${LIMITS.superAdmin}` };
    }
    staged.superAdmins = data.superAdmins.map(String).filter(Boolean);
  }

  // Process admins (max 20)
  if (data.admins && Array.isArray(data.admins)) {
    if (data.admins.length > LIMITS.admin) {
      return { ok: false, error: `Admin limit exceeded. Maximum: ${LIMITS.admin}` };
    }
    staged.admins = data.admins.map(String).filter(Boolean);
  }

  // Check for duplicates across all roles
  const allIds = [...staged.owner, ...staged.superAdmins, ...staged.admins];
  const seen = new Set();
  for (const id of allIds) {
    if (seen.has(id)) {
      return { ok: false, error: `Duplicate User ID: ${id}. A user can only have one role.` };
    }
    seen.add(id);
  }

  return { ok: true, staged };
}

/* ── Mutation operations ───────────────────────────────── */

/**
 * Save roles from client-sent staged data (the main save flow).
 */
export async function saveRolesFromData(data) {
  const result = validateRoles(data);
  if (!result.ok) return result;

  roles.owner = [...result.staged.owner];
  roles.superAdmins = [...result.staged.superAdmins];
  roles.admins = [...result.staged.admins];

  pendingRoles = null;
  await saveRoles();
  await saveStaged();

  return { ok: true, roles: getRoles() };
}

/**
 * Stage changes. Returns a snapshot of what would change.
 */
export function stageRoles(newRoles) {
  const result = validateRoles(newRoles);
  if (!result.ok) return result;
  pendingRoles = result.staged;
  saveStaged().catch(() => {}); // persist in background
  return { ok: true, staged: result.staged };
}

export async function commitPendingRoles() {
  if (!pendingRoles) return { ok: false, error: 'No pending changes to save' };
  return saveRolesFromData(pendingRoles);
}

export async function discardPendingRoles() {
  pendingRoles = null;
  await saveStaged();
  return { ok: true };
}

/* ── Convenience: add/remove single user (stages only) ── */

export function addUserToStage(userId, role) {
  const id = String(userId).trim();
  if (!id) return { ok: false, error: 'User ID is required' };

  // Start from current roles + pending
  const base = pendingRoles || { ...roles, owner: [...roles.owner], superAdmins: [...roles.superAdmins], admins: [...roles.admins] };

  // Check user not already in another role
  const existingRole = findUserRoleInSnapshot(base, id);
  if (existingRole && existingRole !== role) {
    return { ok: false, error: `User ${id} is already assigned as ${existingRole}. Remove them first.` };
  }

  const snapshot = {
    owner: [...base.owner],
    superAdmins: [...base.superAdmins],
    admins: [...base.admins],
  };

  if (role === 'owner') {
    if (snapshot.owner.length >= LIMITS.owner) return { ok: false, error: `Owner limit reached (${snapshot.owner.length}/${LIMITS.owner})` };
    if (!snapshot.owner.includes(id)) snapshot.owner.push(id);
  } else if (role === 'superAdmin') {
    if (snapshot.superAdmins.length >= LIMITS.superAdmin) return { ok: false, error: `Super Admin limit reached (${snapshot.superAdmins.length}/${LIMITS.superAdmin})` };
    if (!snapshot.superAdmins.includes(id)) snapshot.superAdmins.push(id);
  } else if (role === 'admin') {
    if (snapshot.admins.length >= LIMITS.admin) return { ok: false, error: `Admin limit reached (${snapshot.admins.length}/${LIMITS.admin})` };
    if (!snapshot.admins.includes(id)) snapshot.admins.push(id);
  } else {
    return { ok: false, error: `Invalid role: ${role}` };
  }

  pendingRoles = snapshot;
  saveStaged().catch(() => {}); // persist in background
  return { ok: true, staged: snapshot };
}

export function removeUserFromStage(userId) {
  const id = String(userId).trim();
  if (!id) return { ok: false, error: 'User ID is required' };

  const base = pendingRoles || { ...roles, owner: [...roles.owner], superAdmins: [...roles.superAdmins], admins: [...roles.admins] };

  const snapshot = {
    owner: base.owner.filter(x => x !== id),
    superAdmins: base.superAdmins.filter(x => x !== id),
    admins: base.admins.filter(x => x !== id),
  };

  pendingRoles = snapshot;
  saveStaged().catch(() => {}); // persist in background
  return { ok: true, staged: snapshot };
}

function findUserRoleInSnapshot(snapshot, userId) {
  if (snapshot.owner.includes(userId)) return 'owner';
  if (snapshot.superAdmins.includes(userId)) return 'superAdmin';
  if (snapshot.admins.includes(userId)) return 'admin';
  return null;
}
