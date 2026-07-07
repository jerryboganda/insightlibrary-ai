<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import {
		Users,
		Shield,
		UserPlus,
		Key,
		Mail,
		Search,
		CheckCircle2,
		X,
		Copy,
		Clock,
		ShieldAlert,
		LogOut,
		BadgeCheck,
		Info,
		Link2,
		Trash2
	} from '@lucide/svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { User } from '@insightlibrary/schemas';

	// Directory rows are the wire User enriched SERVER-SIDE with real better-auth
	// account state (GET /api/users). Nothing is fabricated client-side: status,
	// verification, created and last-active are actual column values, and rows
	// without a login account (seed/local records) say so via hasLogin=false.
	interface DirectoryUser extends User {
		status?: 'active' | 'suspended';
		emailVerified?: boolean | null;
		createdAt?: string | null;
		hasLogin?: boolean;
	}
	interface Invitation {
		id: string;
		email: string;
		role: string;
		status: 'pending' | 'expired';
		createdAt: string;
		expiresAt: string;
		inviteUrl: string;
	}
	interface InviteResult {
		id: string;
		email: string;
		role: string;
		expiresAt: string;
		inviteUrl: string;
		emailSent: boolean;
	}

	const directory = createQuery({
		queryKey: ['users', 'directory'],
		queryFn: () => api.listUserDirectory()
	});
	// Real workspace identity (C10) — replaces the fabricated "14 workspaces".
	const orgSettings = createQuery({
		queryKey: ['org-settings'],
		queryFn: () => api.getOrgSettings()
	});

	const data = $derived(
		$directory.data as unknown as { items: DirectoryUser[]; invitations: Invitation[] } | undefined
	);
	const users = $derived(data?.items ?? []);
	const invitations = $derived(data?.invitations ?? []);
	const workspaceName = $derived($orgSettings.data?.name ?? 'Default workspace');

	// The EXACT role set the backend accepts (PATCH /api/users/[id] validation) —
	// no display-only roles that silently collapse to something else.
	const ROLES = [
		{ value: 'owner', label: 'Owner' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'editor', label: 'Editor' },
		{ value: 'viewer', label: 'Viewer' }
	] as const;
	const INVITE_ROLES = ROLES.filter((r) => r.value !== 'owner');
	const roleLabel = (role: string) => ROLES.find((r) => r.value === role)?.label ?? role;

	let searchQuery = $state('');
	let selectedUser = $state<DirectoryUser | null>(null);
	let editRole = $state<string>('viewer');
	let tempPassword = $state('');
	let isInviteModalOpen = $state(false);
	let isSsoModalOpen = $state(false);
	let inviteEmail = $state('');
	let inviteRole = $state<string>('editor');
	let inviteResult = $state<InviteResult | null>(null);
	let inviteError = $state('');

	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users', 'directory'] });

	function errMsg(e: unknown): string {
		if (e instanceof Error) {
			const body = (e as { body?: string }).body;
			if (body) {
				try {
					const parsed = JSON.parse(body) as { message?: string };
					if (parsed?.message) return parsed.message;
				} catch {
					/* not JSON */
				}
			}
			return e.message;
		}
		return 'Request failed';
	}

	// Short-lived confirmation/error banners shown near the acting control.
	let panelNotice = $state('');
	let panelNoticeKind = $state<'ok' | 'error'>('ok');
	let panelNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	function flashPanelNotice(msg: string, kind: 'ok' | 'error' = 'ok') {
		panelNotice = msg;
		panelNoticeKind = kind;
		clearTimeout(panelNoticeTimer);
		panelNoticeTimer = setTimeout(() => (panelNotice = ''), kind === 'error' ? 4000 : 2200);
	}
	function copyValue(value: string, msg = 'Copied') {
		navigator.clipboard.writeText(value);
		flashPanelNotice(msg);
	}

	// ── Mutations (all real endpoints) ────────────────────────────────────────
	const roleMutation = createMutation({
		mutationFn: (v: { id: string; role: string }) => api.updateUser(v.id, { role: v.role }),
		onSuccess: () => invalidate(),
		onError: (e: unknown) => flashPanelNotice(errMsg(e), 'error')
	});
	const statusMutation = createMutation({
		mutationFn: (v: { id: string; status: string }) => api.updateUser(v.id, { status: v.status }),
		onSuccess: () => invalidate(),
		onError: (e: unknown) => flashPanelNotice(errMsg(e), 'error')
	});
	const inviteMutation = createMutation({
		mutationFn: (v: { email: string; role: string }) => api.inviteUser(v.email, v.role),
		onSuccess: (r: unknown) => {
			inviteResult = r as InviteResult;
			inviteError = '';
			invalidate();
		},
		onError: (e: unknown) => (inviteError = errMsg(e))
	});
	const revokeInviteMutation = createMutation({
		mutationFn: (id: string) => api.revokeInvite(id),
		onSuccess: () => invalidate(),
		onError: (e: unknown) => flashPanelNotice(errMsg(e), 'error')
	});
	const resetPasswordMutation = createMutation({
		mutationFn: (id: string) => api.resetUserPassword(id),
		onSuccess: (r: unknown) => {
			tempPassword = (r as { tempPassword: string }).tempPassword;
			flashPanelNotice('Temporary password issued — existing sessions signed out');
		},
		onError: (e: unknown) => flashPanelNotice(errMsg(e), 'error')
	});
	const forceLogoutMutation = createMutation({
		mutationFn: (id: string) => api.revokeUserSessions(id),
		onSuccess: (r: unknown) => {
			const n = (r as { revoked: number }).revoked;
			flashPanelNotice(`Revoked ${n} session${n === 1 ? '' : 's'}`);
		},
		onError: (e: unknown) => flashPanelNotice(errMsg(e), 'error')
	});

	// Suspend / restore the selected user, keeping the open panel in sync.
	function setUserStatus(status: 'suspended' | 'active') {
		if (!selectedUser) return;
		$statusMutation.mutate({ id: selectedUser.id, status });
		selectedUser = { ...selectedUser, status };
	}

	function saveUserChanges() {
		if (selectedUser && editRole !== selectedUser.role) {
			$roleMutation.mutate({ id: selectedUser.id, role: editRole });
		}
		selectedUser = null;
	}

	function sendInvitation() {
		inviteError = '';
		$inviteMutation.mutate({ email: inviteEmail, role: inviteRole });
	}
	function closeInviteModal() {
		isInviteModalOpen = false;
		inviteResult = null;
		inviteError = '';
		inviteEmail = '';
		inviteRole = 'editor';
	}

	const filteredUsers = $derived(
		users.filter((user) => {
			const q = searchQuery.trim().toLowerCase();
			if (!q) return true;
			return user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q);
		})
	);

	// Header KPIs — every number is a real count from the directory payload.
	const totalUsers = $derived(users.length);
	const verifiedLogins = $derived(users.filter((u) => u.emailVerified === true).length);
	const pendingInvites = $derived(invitations.filter((i) => i.status === 'pending').length);

	function handleEditClick(user: DirectoryUser) {
		selectedUser = user;
		editRole = user.role;
		tempPassword = '';
		panelNotice = '';
	}

	function formatDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}
</script>

<main class="relative w-full overflow-y-auto">
	<div class="relative mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
					<Users class="h-6 w-6 text-indigo-400" />
					Users &amp; Access
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Real accounts, roles and invitations for the <span class="text-zinc-300">{workspaceName}</span>
					workspace.
				</p>
			</div>
			<div class="flex items-center gap-3">
				<button
					onclick={() => (isSsoModalOpen = true)}
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					<Key class="h-4 w-4" /> SSO
					<span class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] tracking-wider text-zinc-400 uppercase">
						Not configured
					</span>
				</button>
				<button
					onclick={() => (isInviteModalOpen = true)}
					class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
				>
					<UserPlus class="h-4 w-4" /> Invite Users
				</button>
			</div>
		</header>

		<!-- KPI cards (real counts) -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
			{#if $directory.isLoading}
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-[116px] rounded-xl" />
				{/each}
			{:else}
				<div in:fly={{ y: 8, duration: 250 }} class="glass-panel rounded-xl border border-zinc-800 p-5">
					<div class="mb-1 text-sm font-medium text-zinc-400">Total Users</div>
					<div class="mb-2 text-3xl font-bold text-zinc-100">{totalUsers.toLocaleString()}</div>
					<div class="text-xs text-zinc-500">Workspace: {workspaceName}</div>
				</div>
				<div
					in:fly={{ y: 8, duration: 250, delay: 40 }}
					class="glass-panel rounded-xl border border-zinc-800 p-5"
				>
					<div class="mb-1 text-sm font-medium text-zinc-400">Verified Logins</div>
					<div class="mb-2 text-3xl font-bold text-emerald-400">{verifiedLogins.toLocaleString()}</div>
					<div class="text-xs text-zinc-500">Sign-in accounts with a verified email</div>
				</div>
				<div
					in:fly={{ y: 8, duration: 250, delay: 80 }}
					class="glass-panel rounded-xl border border-zinc-800 p-5"
				>
					<div class="mb-1 text-sm font-medium text-zinc-400">Pending Invites</div>
					<div class="mb-2 text-3xl font-bold text-amber-400">{pendingInvites}</div>
					<div class="text-xs text-zinc-500">Awaiting signup with the invited email</div>
				</div>
			{/if}
		</div>

		<!-- Users table -->
		<div class="glass-panel flex flex-col overflow-hidden rounded-xl border-zinc-800">
			<div
				class="flex flex-col justify-between gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4 sm:flex-row sm:items-center"
			>
				<h2 class="text-base font-semibold text-zinc-200">Directory</h2>
				<div class="relative">
					<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
					<input
						type="text"
						placeholder="Search by name or email..."
						bind:value={searchQuery}
						class="w-full rounded-md border border-zinc-800 bg-zinc-950 py-1.5 pr-3 pl-9 text-xs text-zinc-300 focus:border-indigo-500/50 focus:outline-none sm:w-64"
					/>
				</div>
			</div>

			<div class="overflow-x-auto">
				{#if $directory.isLoading}
					<div class="space-y-3 p-6">
						{#each Array(5) as _, i (i)}
							<Skeleton class="h-12 rounded-md" />
						{/each}
					</div>
				{:else if $directory.isError}
					<div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
						<ShieldAlert class="h-6 w-6 text-rose-400" />
						<p class="text-sm text-zinc-300">Could not load the user directory.</p>
						<p class="text-xs text-zinc-500">{errMsg($directory.error)}</p>
					</div>
				{:else}
					<table class="w-full text-left text-sm">
						<thead
							class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
						>
							<tr>
								<th class="px-6 py-4">Name</th>
								<th class="px-6 py-4">Role</th>
								<th class="px-6 py-4">Status</th>
								<th class="px-6 py-4">Email Verified</th>
								<th class="px-6 py-4">Created</th>
								<th class="px-6 py-4">Last Active</th>
								<th class="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#if filteredUsers.length === 0}
								<tr>
									<td colspan="7" class="px-6 py-12 text-center text-zinc-500">
										No users found matching your search.
									</td>
								</tr>
							{:else}
								{#each filteredUsers as user, i (user.id)}
									<tr in:fade={{ delay: i * 25 }} class="group transition-colors hover:bg-zinc-900/40">
										<td class="px-6 py-4">
											<div class="font-medium text-zinc-200">{user.name}</div>
											<div class="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
												<Mail class="h-3 w-3" />
												{user.email}
											</div>
										</td>
										<td class="px-6 py-4">
											<span
												class="inline-flex items-center gap-1.5 rounded border border-zinc-700/50 bg-zinc-800/50 px-2.5 py-1 text-xs text-zinc-300"
											>
												<Shield
													class={cn(
														'h-3 w-3',
														user.role === 'owner' || user.role === 'admin'
															? 'text-rose-400'
															: 'text-indigo-400'
													)}
												/>
												{roleLabel(user.role)}
											</span>
										</td>
										<td class="px-6 py-4">
											{#if user.status === 'suspended'}
												<span class="flex items-center gap-1.5 text-xs font-medium text-rose-400">
													<ShieldAlert class="h-3.5 w-3.5" /> Suspended
												</span>
											{:else if user.hasLogin === false}
												<span
													class="flex items-center gap-1.5 text-xs font-medium text-zinc-500"
													title="Seed/local record — no login account exists for this email"
												>
													<Info class="h-3.5 w-3.5" /> No login account
												</span>
											{:else}
												<span class="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
													<CheckCircle2 class="h-3.5 w-3.5" /> Active
												</span>
											{/if}
										</td>
										<td class="px-6 py-4">
											{#if user.hasLogin === false || user.emailVerified === null || user.emailVerified === undefined}
												<span class="text-xs text-zinc-600">—</span>
											{:else if user.emailVerified}
												<span class="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
													<BadgeCheck class="h-3.5 w-3.5" /> Verified
												</span>
											{:else}
												<span class="flex items-center gap-1.5 text-xs font-medium text-amber-400">
													<Clock class="h-3.5 w-3.5" /> Unverified
												</span>
											{/if}
										</td>
										<td class="px-6 py-4 text-xs text-zinc-400">{formatDate(user.createdAt)}</td>
										<td class="px-6 py-4 text-xs text-zinc-400">{formatDate(user.lastActive)}</td>
										<td class="px-6 py-4 text-right">
											<button
												onclick={() => handleEditClick(user)}
												class="rounded px-3 py-1.5 text-xs font-medium text-indigo-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-indigo-500/10 hover:text-indigo-300 focus:opacity-100"
											>
												Edit
											</button>
										</td>
									</tr>
								{/each}
							{/if}
						</tbody>
					</table>
				{/if}
			</div>
		</div>

		<!-- Pending invitations (real invitation rows) -->
		{#if invitations.length > 0}
			<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
				<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
					<h2 class="text-base font-semibold text-zinc-200">Invitations</h2>
					<p class="mt-0.5 text-xs text-zinc-500">
						No email service is configured — copy each link and send it yourself. An invite completes
						when someone signs up with the invited email.
					</p>
				</div>
				<ul class="divide-y divide-zinc-800/50">
					{#each invitations as inv (inv.id)}
						<li class="flex flex-col gap-2 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
							<div class="min-w-0">
								<div class="flex items-center gap-2 text-sm text-zinc-200">
									<Mail class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
									<span class="truncate">{inv.email}</span>
									<span
										class="rounded border border-zinc-700/50 bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-300"
									>
										{roleLabel(inv.role)}
									</span>
									{#if inv.status === 'expired'}
										<span class="text-[10px] font-medium tracking-wider text-rose-400 uppercase">Expired</span>
									{:else}
										<span class="text-[10px] font-medium tracking-wider text-amber-400 uppercase">Pending</span>
									{/if}
								</div>
								<div class="mt-0.5 text-xs text-zinc-500">
									Expires {formatDate(inv.expiresAt)}
								</div>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<button
									onclick={() => copyValue(inv.inviteUrl, 'Invite link copied')}
									class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
								>
									<Link2 class="h-3.5 w-3.5" /> Copy link
								</button>
								<button
									onclick={() => $revokeInviteMutation.mutate(inv.id)}
									disabled={$revokeInviteMutation.isPending}
									class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
								>
									<Trash2 class="h-3.5 w-3.5" /> Revoke
								</button>
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if panelNotice && !selectedUser}
			<p
				transition:fade={{ duration: 120 }}
				class={cn(
					'text-center text-xs font-medium',
					panelNoticeKind === 'error' ? 'text-rose-400' : 'text-emerald-400'
				)}
			>
				{panelNotice}
			</p>
		{/if}
	</div>

	<!-- User Edit Slide Panel -->
	{#if selectedUser}
		<div
			transition:fly={{ x: 400, duration: 300, opacity: 1 }}
			class="absolute top-0 right-0 z-30 flex h-full w-full max-w-sm flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
		>
			<div
				class="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<Users class="h-4 w-4 text-indigo-400" />
					Edit User
				</h2>
				<button
					onclick={() => (selectedUser = null)}
					class="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex-1 space-y-6 overflow-y-auto p-6">
				<div class="space-y-1">
					<div class="text-xl font-bold text-zinc-100">{selectedUser.name}</div>
					<div class="mb-2 flex items-center gap-1.5 text-sm text-zinc-400">
						<Mail class="h-3.5 w-3.5" />
						{selectedUser.email}
					</div>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						{#if selectedUser.hasLogin === false}
							<span
								class="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium tracking-wider text-zinc-400 uppercase"
								title="No login account exists for this email — security actions are unavailable"
							>
								<Info class="h-3 w-3" /> No login account
							</span>
						{:else if selectedUser.emailVerified}
							<span
								class="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium tracking-wider text-emerald-400 uppercase"
							>
								<BadgeCheck class="h-3 w-3" /> Email verified
							</span>
						{:else}
							<span
								class="flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium tracking-wider text-amber-400 uppercase"
							>
								<Clock class="h-3 w-3" /> Email unverified
							</span>
						{/if}
						{#if selectedUser.status === 'suspended'}
							<span
								class="flex items-center gap-1 rounded border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium tracking-wider text-rose-400 uppercase"
							>
								<ShieldAlert class="h-3 w-3" /> Suspended
							</span>
						{/if}
					</div>
				</div>

				<div class="space-y-4 pt-2">
					<div class="grid grid-cols-2 gap-4">
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								Created
							</div>
							<div class="text-sm text-zinc-300">{formatDate(selectedUser.createdAt)}</div>
						</div>
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								Last Active
							</div>
							<div class="text-sm text-zinc-300">{formatDate(selectedUser.lastActive)}</div>
						</div>
					</div>

					<div class="space-y-2">
						<label class="text-xs font-medium tracking-wider text-zinc-400 uppercase" for="edit-role">
							Role
						</label>
						<select
							id="edit-role"
							bind:value={editRole}
							class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-indigo-500 focus:outline-none"
						>
							{#each ROLES as role (role.value)}
								<option value={role.value}>{role.label}</option>
							{/each}
						</select>
						<p class="text-xs text-zinc-500">
							These are the only roles the platform enforces (owner &gt; admin &gt; editor &gt; viewer).
						</p>
					</div>

					<div class="space-y-2 border-t border-zinc-800 pt-4">
						<h4 class="text-xs font-medium tracking-wider text-zinc-400 uppercase">
							Security Actions
						</h4>
						{#if selectedUser.hasLogin === false}
							<p class="text-xs text-zinc-500">
								This record has no login account, so there is no password to reset and no
								sessions to revoke.
							</p>
						{:else}
							<div class="space-y-2 pt-2">
								<button
									onclick={() => selectedUser && $resetPasswordMutation.mutate(selectedUser.id)}
									disabled={$resetPasswordMutation.isPending}
									class="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
								>
									<span class="flex items-center gap-2">
										<Key class="h-4 w-4" />
										{$resetPasswordMutation.isPending ? 'Issuing…' : 'Reset Password'}
									</span>
								</button>
								{#if tempPassword}
									<div class="space-y-1.5 rounded-md border border-indigo-500/20 bg-indigo-500/10 p-3">
										<div class="text-[10px] font-medium tracking-wider text-indigo-300 uppercase">
											One-time temporary password
										</div>
										<div class="flex items-center gap-2">
											<code class="flex-1 truncate rounded bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200">
												{tempPassword}
											</code>
											<button
												onclick={() => copyValue(tempPassword, 'Temporary password copied')}
												class="rounded-md border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
											>
												<Copy class="h-3.5 w-3.5" />
											</button>
										</div>
										<p class="text-[11px] leading-relaxed text-indigo-200/70">
											No email service is configured — share this securely with the user. Their existing
											sessions were signed out.
										</p>
									</div>
								{/if}
								<button
									onclick={() => selectedUser && $forceLogoutMutation.mutate(selectedUser.id)}
									disabled={$forceLogoutMutation.isPending}
									class="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
								>
									<span class="flex items-center gap-2">
										<LogOut class="h-4 w-4" />
										{$forceLogoutMutation.isPending ? 'Revoking…' : 'Force Logout'}
									</span>
								</button>
							</div>
						{/if}
						{#if panelNotice}
							<p
								transition:fade={{ duration: 120 }}
								class={cn(
									'pt-1 text-center text-xs font-medium',
									panelNoticeKind === 'error' ? 'text-rose-400' : 'text-emerald-400'
								)}
							>
								{panelNotice}
							</p>
						{/if}
					</div>

					<div class="space-y-2 border-t border-zinc-800 pt-4">
						<h4 class="text-xs font-medium tracking-wider text-zinc-400 uppercase">Danger Zone</h4>
						<div class="space-y-2 pt-2">
							{#if selectedUser.status === 'suspended'}
								<button
									onclick={() => setUserStatus('active')}
									disabled={$statusMutation.isPending}
									class="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-emerald-400 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"
								>
									<CheckCircle2 class="h-4 w-4" /> Restore Access
								</button>
							{:else}
								<button
									onclick={() => setUserStatus('suspended')}
									disabled={$statusMutation.isPending}
									class="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
								>
									<ShieldAlert class="h-4 w-4" /> Suspend User
								</button>
							{/if}
							<p class="text-xs text-zinc-500">
								Suspension bans the login account and revokes its sessions; restoring lifts the ban.
							</p>
						</div>
					</div>
				</div>
			</div>

			<div class="flex shrink-0 gap-2 border-t border-zinc-800 bg-zinc-900/50 p-4">
				<button
					onclick={() => (selectedUser = null)}
					class="flex-1 bg-transparent px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
				>
					Cancel
				</button>
				<button
					onclick={saveUserChanges}
					disabled={$roleMutation.isPending}
					class="flex-1 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{$roleMutation.isPending ? 'Saving…' : 'Save Changes'}
				</button>
			</div>
		</div>
	{/if}
</main>

<!-- Invite User Modal overlay -->
{#if isInviteModalOpen}
	<div
		transition:fade={{ duration: 150 }}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeInviteModal();
		}}
		role="presentation"
	>
		<div
			transition:scale={{ duration: 180, start: 0.95, opacity: 0 }}
			class="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<UserPlus class="h-4 w-4 text-indigo-400" />
					Invite New User
				</h2>
				<button
					onclick={closeInviteModal}
					class="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			{#if inviteResult}
				<div class="space-y-4 p-6">
					<div class="flex items-center gap-2 text-sm font-medium text-emerald-400">
						<CheckCircle2 class="h-4 w-4" />
						Invitation created for {inviteResult.email}
					</div>
					<div class="space-y-1.5">
						<span class="text-xs font-medium text-zinc-400">Invite link</span>
						<div class="flex items-center gap-2">
							<input
								type="text"
								readonly
								value={inviteResult.inviteUrl}
								class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-400 focus:outline-none"
							/>
							<button
								onclick={() => copyValue(inviteResult?.inviteUrl ?? '', 'Invite link copied')}
								class="rounded-md border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
							>
								<Copy class="h-4 w-4" />
							</button>
						</div>
					</div>
					<div class="flex gap-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
						<Info class="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
						<div class="text-xs leading-relaxed text-amber-200/80">
							No email was sent — this server has no email service configured. Copy the link and send
							it yourself. When someone signs up with <strong>{inviteResult.email}</strong>, they join
							the workspace as <strong>{roleLabel(inviteResult.role)}</strong> automatically. The
							invitation expires {formatDate(inviteResult.expiresAt)}.
						</div>
					</div>
				</div>
				<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/50 px-6 py-4">
					<button
						onclick={closeInviteModal}
						class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
					>
						Done
					</button>
				</div>
			{:else}
				<div class="space-y-5 p-6">
					<div class="space-y-2">
						<label class="text-sm font-medium text-zinc-300" for="invite-email">Email Address</label>
						<div class="relative">
							<Mail class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
							<input
								id="invite-email"
								type="email"
								bind:value={inviteEmail}
								placeholder="colleague@company.com"
								class="w-full rounded-md border border-zinc-800 bg-zinc-900 py-2 pr-3 pl-10 text-sm text-zinc-200 transition-all placeholder:text-zinc-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"
							/>
						</div>
					</div>

					<div class="space-y-2">
						<label class="text-sm font-medium text-zinc-300" for="invite-role">Initial Role</label>
						<select
							id="invite-role"
							bind:value={inviteRole}
							class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors focus:border-indigo-500 focus:outline-none"
						>
							{#each INVITE_ROLES as role (role.value)}
								<option value={role.value}>{role.label}</option>
							{/each}
						</select>
						<p class="pt-1 text-xs text-zinc-500">Roles can be changed later by admins.</p>
					</div>

					<div class="mt-4 flex gap-3 rounded-md border border-indigo-500/20 bg-indigo-500/10 p-3">
						<Info class="mt-0.5 h-5 w-5 shrink-0 text-indigo-400" />
						<div class="text-xs leading-relaxed text-indigo-200/70">
							This server has no email service, so you will get a copyable invite link on the next
							step. The invitation is honored when the person signs up with this email; it expires in
							72 hours.
						</div>
					</div>

					{#if inviteError}
						<p transition:fade={{ duration: 120 }} class="text-xs font-medium text-rose-400">
							{inviteError}
						</p>
					{/if}
				</div>

				<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/50 px-6 py-4">
					<button
						onclick={closeInviteModal}
						class="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
					>
						Cancel
					</button>
					<button
						onclick={sendInvitation}
						disabled={$inviteMutation.isPending || !inviteEmail.trim()}
						class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{$inviteMutation.isPending ? 'Creating…' : 'Create Invitation'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- SSO status modal — honest "not configured" state, no client-side theater -->
{#if isSsoModalOpen}
	<div
		transition:fade={{ duration: 150 }}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={(e) => {
			if (e.target === e.currentTarget) isSsoModalOpen = false;
		}}
		role="presentation"
	>
		<div
			transition:scale={{ duration: 180, start: 0.95, opacity: 0 }}
			class="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<Key class="h-4 w-4 text-indigo-400" />
					Enterprise SSO
				</h2>
				<button
					onclick={() => (isSsoModalOpen = false)}
					class="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="space-y-4 p-6">
				<div class="flex items-center gap-2">
					<span
						class="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium tracking-wider text-zinc-300 uppercase"
					>
						Not configured
					</span>
					<span class="text-xs text-zinc-500">Authentication is email + password.</span>
				</div>
				<p class="text-sm leading-relaxed text-zinc-400">
					Single sign-on (SAML/OIDC) is not available on this deployment.
					There is nothing to set up from this screen — enabling SSO is a server-side change:
				</p>
				<ul class="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-zinc-500">
					<li>
						Add a SAML/OIDC integration (SP/IdP metadata, ACS URL)
						in the API server's auth configuration.
					</li>
					<li>Add persistent identity-provider settings (certificates, ACS/entity IDs) server-side.</li>
					<li>Directory provisioning would require dedicated endpoints — not yet implemented.</li>
				</ul>
				<p class="text-xs text-zinc-500">
					Until then, manage access with invitations, roles, suspension and forced logout — all of
					which are fully functional on this page.
				</p>
			</div>
			<div class="flex items-center justify-end border-t border-zinc-800 bg-zinc-900/50 px-6 py-4">
				<button
					onclick={() => (isSsoModalOpen = false)}
					class="rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
				>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}
