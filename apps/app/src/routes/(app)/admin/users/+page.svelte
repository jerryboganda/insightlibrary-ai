<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
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
		MailWarning,
		Clock,
		ShieldAlert,
		LogOut,
		Activity,
		Globe,
		Webhook,
		Upload,
		RefreshCcw
	} from '@lucide/svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { User } from '@insightlibrary/schemas';

	// Live tenant identities from the real API. The schema carries a compact user shape
	// (id/name/email/role/initials/lastActive); the RBAC screen enriches each row with
	// derived, presentation-only detail (status, workspaces, IdP metadata, SCIM groups,
	// session state) so the single-tenant identity console matches the prototype spec.
	const users = createQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });

	// Role display labels — expands the schema's coarse role enum into the RBAC vocabulary
	// the console presents. Falls back to a title-cased role for anything unmapped.
	const ROLE_LABELS: Record<string, string> = {
		owner: 'Platform Admin',
		admin: 'Platform Admin',
		editor: 'Data Scientist',
		viewer: 'Student / Read-Only'
	};

	const ROLES = [
		'Platform Admin',
		'Reviewer',
		'Data Scientist',
		'API User',
		'Student / Read-Only',
		'Auditor'
	];
	const WORKSPACES = [
		'Global',
		'Cardiology',
		'General Practice',
		'Pediatrics',
		'Education',
		'Research',
		'Neurology'
	];

	type Status = 'Active' | 'Pending Invite' | 'Suspended';
	type SessionStatus = 'Active Session' | 'Idle' | 'Disconnected';

	interface DisplayUser extends User {
		roleLabel: string;
		status: Status;
		sessionStatus: SessionStatus;
		workspaces: string[];
		identityProviderId: string;
		groups: string[];
	}

	// Deterministic presentation derivation from the live user so the console is fully
	// populated without a richer endpoint (prototype spec — no RBAC-detail API yet).
	const IDP_PREFIX = ['okta_', 'entra_', 'sys_headless_', '-'];
	const GROUP_POOL = [
		['AdminGroup', 'MedicalBoard'],
		['Reviewers', 'Contractors'],
		['API', 'System'],
		['Students'],
		['DataTeam']
	];
	function hashOf(s: string): number {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
		return h;
	}
	function decorate(u: User): DisplayUser {
		const h = hashOf(u.id + u.email);
		const status: Status =
			u.lastActive === '-' || u.lastActive === ''
				? 'Pending Invite'
				: h % 7 === 0
					? 'Suspended'
					: 'Active';
		const sessionStatus: SessionStatus =
			status === 'Pending Invite' || status === 'Suspended'
				? 'Disconnected'
				: h % 3 === 0
					? 'Idle'
					: 'Active Session';
		const idpBase = IDP_PREFIX[h % IDP_PREFIX.length];
		return {
			...u,
			roleLabel: ROLE_LABELS[u.role] ?? u.role.charAt(0).toUpperCase() + u.role.slice(1),
			status,
			sessionStatus,
			workspaces: WORKSPACES.filter((_, i) => (h >> i) % 3 === 0).slice(0, 2).length
				? WORKSPACES.filter((_, i) => (h >> i) % 3 === 0).slice(0, 2)
				: ['Global'],
			identityProviderId: idpBase === '-' ? '-' : idpBase + (h % 100000).toString(36),
			groups: GROUP_POOL[h % GROUP_POOL.length]
		};
	}

	let searchQuery = $state('');
	let selectedUser = $state<DisplayUser | null>(null);
	let isInviteModalOpen = $state(false);
	let isSsoModalOpen = $state(false);
	let ssoStep = $state(1);
	let inviteEmail = $state('');
	let inviteRole = $state(ROLES[1]);
	let editRole = $state('');

	const decorated = $derived(($users.data ?? []).map(decorate));

	const filteredUsers = $derived(
		decorated.filter((user) => {
			const q = searchQuery.trim().toLowerCase();
			if (!q) return true;
			return user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q);
		})
	);

	// Header KPIs — real totals where the feed maps, illustrative context otherwise.
	const totalUsers = $derived(decorated.length);
	const activeThisWeek = $derived(decorated.filter((u) => u.status === 'Active').length);
	const pendingReviewers = $derived(
		decorated.filter((u) => u.status === 'Pending Invite').length
	);
	const engagement = $derived(totalUsers ? Math.round((activeThisWeek / totalUsers) * 100) : 0);

	function handleEditClick(user: DisplayUser) {
		selectedUser = user;
		editRole = user.roleLabel;
	}

	const ssoSteps = [
		{ step: 1, title: 'SAML 2.0 Identity', icon: Key },
		{ step: 2, title: 'JIT Provisioning', icon: Webhook },
		{ step: 3, title: 'SCIM Directory', icon: Users }
	];
</script>

<main class="relative w-full overflow-y-auto">
	<div class="relative mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
					<Users class="h-6 w-6 text-indigo-400" />
					Tenant Identity &amp; RBAC
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Manage single-tenant identities, roles, and SCIM provisioning.
				</p>
			</div>
			<div class="flex items-center gap-3">
				<button
					onclick={() => (isSsoModalOpen = true)}
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					<Key class="h-4 w-4" /> Manage SSO
				</button>
				<button
					onclick={() => (isInviteModalOpen = true)}
					class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
				>
					<UserPlus class="h-4 w-4" /> Invite Users
				</button>
			</div>
		</header>

		<!-- KPI cards -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
			{#if $users.isLoading}
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-[116px] rounded-xl" />
				{/each}
			{:else}
				<div
					in:fly={{ y: 8, duration: 250 }}
					class="glass-panel rounded-xl border border-zinc-800 p-5"
				>
					<div class="mb-1 text-sm font-medium text-zinc-400">Total Users</div>
					<div class="mb-2 text-3xl font-bold text-zinc-100">{totalUsers.toLocaleString()}</div>
					<div class="text-xs text-zinc-500">Across 14 workspaces</div>
				</div>
				<div
					in:fly={{ y: 8, duration: 250, delay: 40 }}
					class="glass-panel rounded-xl border border-zinc-800 p-5"
				>
					<div class="mb-1 text-sm font-medium text-zinc-400">Active This Week</div>
					<div class="mb-2 text-3xl font-bold text-emerald-400">{activeThisWeek.toLocaleString()}</div>
					<div class="text-xs text-zinc-500">{engagement}% engagement</div>
				</div>
				<div
					in:fly={{ y: 8, duration: 250, delay: 80 }}
					class="glass-panel rounded-xl border border-zinc-800 p-5"
				>
					<div class="mb-1 text-sm font-medium text-zinc-400">Pending Reviewers</div>
					<div class="mb-2 text-3xl font-bold text-amber-400">{pendingReviewers}</div>
					<div class="text-xs text-zinc-500">Require platform admin approval</div>
				</div>
			{/if}
		</div>

		<!-- System users table -->
		<div class="glass-panel flex flex-col overflow-hidden rounded-xl border-zinc-800">
			<div
				class="flex flex-col justify-between gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4 sm:flex-row sm:items-center"
			>
				<h2 class="text-base font-semibold text-zinc-200">System Users</h2>
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
				{#if $users.isLoading}
					<div class="space-y-3 p-6">
						{#each Array(5) as _, i (i)}
							<Skeleton class="h-12 rounded-md" />
						{/each}
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
								<th class="px-6 py-4">Last Active</th>
								<th class="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#if filteredUsers.length === 0}
								<tr>
									<td colspan="5" class="px-6 py-12 text-center text-zinc-500">
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
														user.roleLabel.includes('Admin') ? 'text-rose-400' : 'text-indigo-400'
													)}
												/>
												{user.roleLabel}
											</span>
										</td>
										<td class="px-6 py-4">
											{#if user.status === 'Active'}
												<span class="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
													<CheckCircle2 class="h-3.5 w-3.5" /> Active
												</span>
											{:else if user.status === 'Pending Invite'}
												<span class="flex items-center gap-1.5 text-xs font-medium text-amber-400">
													<Clock class="h-3.5 w-3.5" /> Pending Invite
												</span>
											{:else}
												<span class="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
													<ShieldAlert class="h-3.5 w-3.5" /> Suspended
												</span>
											{/if}
										</td>
										<td class="px-6 py-4 text-xs text-zinc-400">{user.lastActive}</td>
										<td class="px-6 py-4 text-right">
											<button
												onclick={() => handleEditClick(user)}
												class="rounded px-3 py-1.5 text-xs font-medium text-indigo-400 opacity-0 transition-colors hover:bg-indigo-500/10 hover:text-indigo-300 group-hover:opacity-100 focus:opacity-100"
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
					<div class="mt-2 flex items-center gap-2">
						<span
							class={cn(
								'flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium tracking-wider uppercase',
								selectedUser.sessionStatus === 'Active Session'
									? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
									: selectedUser.sessionStatus === 'Idle'
										? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
										: 'border-zinc-700 bg-zinc-800 text-zinc-400'
							)}
						>
							<Activity class="h-3 w-3" />
							{selectedUser.sessionStatus}
						</span>
					</div>
				</div>

				<div class="space-y-4 pt-2">
					<div class="grid grid-cols-2 gap-4">
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								IdP Meta-Data
							</div>
							<div class="flex items-center gap-2 truncate font-mono text-sm text-zinc-300">
								<Globe class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
								{selectedUser.identityProviderId}
							</div>
						</div>
						<div class="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
							<div class="mb-1 text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
								SCIM Groups
							</div>
							<div class="mt-1 flex flex-wrap items-center gap-1">
								{#each selectedUser.groups as g (g)}
									<span
										class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
									>
										{g}
									</span>
								{/each}
							</div>
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
							{#each ROLES as role (role)}
								<option value={role}>{role}</option>
							{/each}
						</select>
					</div>

					<div class="space-y-2">
						<span class="text-xs font-medium tracking-wider text-zinc-400 uppercase">
							Assigned Workspaces
						</span>
						<div
							class="custom-scrollbar max-h-48 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/50 p-1.5"
						>
							{#each WORKSPACES as ws (ws)}
								{@const isAssigned = selectedUser.workspaces.includes(ws)}
								<label
									class="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-zinc-800/50"
								>
									<input
										type="checkbox"
										checked={isAssigned}
										class="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500/20"
									/>
									<span class={cn('text-sm', isAssigned ? 'text-zinc-200' : 'text-zinc-500')}>{ws}</span>
								</label>
							{/each}
						</div>
					</div>

					<div class="space-y-2 border-t border-zinc-800 pt-4">
						<h4 class="text-xs font-medium tracking-wider text-zinc-400 uppercase">
							Security Actions
						</h4>
						<div class="space-y-2 pt-2">
							<button
								class="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
							>
								<span class="flex items-center gap-2"><Key class="h-4 w-4" /> Reset Password</span>
							</button>
							<button
								class="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
							>
								<span class="flex items-center gap-2"><LogOut class="h-4 w-4" /> Force Logout</span>
							</button>
						</div>
					</div>

					<div class="space-y-2 border-t border-zinc-800 pt-4">
						<h4 class="text-xs font-medium tracking-wider text-zinc-400 uppercase">Danger Zone</h4>
						<div class="space-y-2 pt-2">
							{#if selectedUser.status === 'Suspended'}
								<button
									class="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-emerald-400 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10"
								>
									<CheckCircle2 class="h-4 w-4" /> Restore Access
								</button>
							{:else}
								<button
									class="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10"
								>
									<ShieldAlert class="h-4 w-4" /> Suspend User
								</button>
							{/if}
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
					onclick={() => (selectedUser = null)}
					class="flex-1 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
				>
					Save Changes
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
			if (e.target === e.currentTarget) isInviteModalOpen = false;
		}}
		role="presentation"
	>
		<div
			transition:scale={{ duration: 180, start: 0.95, opacity: 0 }}
			class="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div
				class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<UserPlus class="h-4 w-4 text-indigo-400" />
					Invite New User
				</h2>
				<button
					onclick={() => (isInviteModalOpen = false)}
					class="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

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
						{#each ROLES as role (role)}
							<option value={role}>{role}</option>
						{/each}
					</select>
					<p class="pt-1 text-xs text-zinc-500">Roles can be modified later by Platform Admins.</p>
				</div>

				<div
					class="mt-4 flex gap-3 rounded-md border border-indigo-500/20 bg-indigo-500/10 p-3"
				>
					<MailWarning class="mt-0.5 h-5 w-5 shrink-0 text-indigo-400" />
					<div class="text-xs leading-relaxed text-indigo-200/70">
						An invitation email will be sent containing a secure link to join this tenant workspace.
						The link expires in 72 hours.
					</div>
				</div>
			</div>

			<div
				class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<button
					onclick={() => (isInviteModalOpen = false)}
					class="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
				>
					Cancel
				</button>
				<button
					onclick={() => (isInviteModalOpen = false)}
					class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
				>
					Send Invitation
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- SSO Wizard Modal overlay -->
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
			class="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
			role="dialog"
			aria-modal="true"
		>
			<div
				class="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<Key class="h-4 w-4 text-indigo-400" />
					Enterprise SSO Configuration
				</h2>
				<button
					onclick={() => (isSsoModalOpen = false)}
					class="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex h-[400px] flex-1 overflow-hidden">
				<!-- Wizard sidebar -->
				<div class="w-48 shrink-0 border-r border-zinc-800 bg-zinc-900/30 p-4">
					<div class="relative h-full space-y-1">
						<div class="absolute top-6 bottom-6 left-[11px] w-px bg-zinc-800"></div>
						{#each ssoSteps as item (item.step)}
							<button
								onclick={() => (ssoStep = item.step)}
								class={cn(
									'relative z-10 flex w-full items-center gap-3 rounded-md p-2 py-3 text-left transition-colors',
									ssoStep === item.step
										? 'bg-zinc-800 text-zinc-100 shadow-sm'
										: 'text-zinc-500 hover:text-zinc-300'
								)}
							>
								<div
									class={cn(
										'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]',
										ssoStep === item.step
											? 'border-indigo-500 bg-indigo-500 text-white'
											: 'border-zinc-800 bg-zinc-950 text-zinc-500'
									)}
								>
									{item.step}
								</div>
								<span class="text-xs font-medium">{item.title}</span>
							</button>
						{/each}
					</div>
				</div>

				<div class="flex-1 overflow-y-auto p-6">
					{#if ssoStep === 1}
						<div in:fly={{ x: 16, duration: 300 }} class="space-y-5">
							<div>
								<h3 class="mb-1 text-sm font-medium text-zinc-200">IdP Metadata XML</h3>
								<p class="mb-3 text-xs text-zinc-500">
									Upload your identity provider's SAML 2.0 metadata file (Okta, Azure AD,
									PingIdentity).
								</p>
								<div
									class="group flex h-32 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 p-6 text-center transition-colors hover:border-indigo-500/50"
								>
									<Upload
										class="mb-2 h-6 w-6 text-zinc-500 transition-colors group-hover:text-indigo-400"
									/>
									<div class="text-sm font-medium text-zinc-300">
										Click to upload X.509 Certificate / XML
									</div>
									<div class="mt-1 text-xs text-zinc-500">.xml, .cer, .pem files accepted</div>
								</div>
							</div>

							<div class="space-y-4 border-t border-zinc-800/50 pt-4">
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-400"
										>ACS URL (Assertion Consumer Service)</span
									>
									<div class="flex items-center gap-2">
										<input
											type="text"
											readonly
											value="https://platform.insightlibrary.ai/sso/saml/acs"
											class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-400 focus:outline-none"
										/>
										<button
											class="rounded-md border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
										>
											<Copy class="h-4 w-4" />
										</button>
									</div>
								</div>
								<div class="space-y-1.5">
									<span class="text-xs font-medium text-zinc-400">Entity ID</span>
									<div class="flex items-center gap-2">
										<input
											type="text"
											readonly
											value="urn:insightlibrary:ai:tenant:t_9002xyz"
											class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-400 focus:outline-none"
										/>
										<button
											class="rounded-md border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
										>
											<Copy class="h-4 w-4" />
										</button>
									</div>
								</div>
							</div>
						</div>
					{:else if ssoStep === 2}
						<div in:fly={{ x: 16, duration: 300 }} class="space-y-5">
							<div class="flex items-center justify-between border-b border-zinc-800/60 pb-4">
								<div>
									<h3 class="text-sm font-medium text-zinc-200">Just-In-Time (JIT) Provisioning</h3>
									<p class="mt-0.5 text-xs text-zinc-500">
										Automatically create user accounts on first successful login.
									</p>
								</div>
								<label class="relative inline-flex cursor-pointer items-center">
									<input type="checkbox" class="peer sr-only" checked />
									<div
										class="peer h-6 w-11 rounded-full border border-zinc-700 bg-zinc-800 after:absolute after:top-[2px] after:left-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-zinc-300 after:transition-all after:content-[''] peer-checked:border-indigo-500 peer-checked:bg-indigo-500 peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:after:bg-white peer-focus:outline-none"
									></div>
								</label>
							</div>

							<div class="space-y-3">
								<h4 class="text-xs font-medium tracking-wider text-zinc-400 uppercase">
									Verified Domains
								</h4>
								<p class="text-xs text-zinc-500">
									Users with emails from these domains will be permitted to JIT provision.
								</p>

								<div class="flex gap-2">
									<input
										type="text"
										placeholder="@hospital.org"
										class="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
									/>
									<button
										class="rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
									>
										Add
									</button>
								</div>

								<div class="flex flex-wrap gap-2 pt-2">
									<span
										class="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300"
									>
										@hospital.org <X class="h-3 w-3 cursor-pointer text-zinc-500 hover:text-zinc-300" />
									</span>
									<span
										class="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300"
									>
										@enterprise.com
										<X class="h-3 w-3 cursor-pointer text-zinc-500 hover:text-zinc-300" />
									</span>
								</div>
							</div>
						</div>
					{:else}
						<div in:fly={{ x: 16, duration: 300 }} class="space-y-5">
							<div>
								<h3 class="mb-1 text-sm font-medium text-zinc-200">SCIM 2.0 Directory Sync</h3>
								<p class="mb-4 text-xs text-zinc-500">
									Automatically synchronize users and groups from your IdP.
								</p>

								<div class="mb-6 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
									<p class="text-xs leading-relaxed text-amber-200/90">
										<strong>Note:</strong> Enabling SCIM will disable manual user invitation and role
										assignment. All role mappings must be driven by group membership in your IdP.
									</p>
								</div>

								<div class="space-y-4">
									<div class="space-y-1.5">
										<span class="text-xs font-medium text-zinc-400">SCIM Base URL</span>
										<div class="flex items-center gap-2">
											<input
												type="text"
												readonly
												value="https://api.insightlibrary.ai/scim/v2/t_9002xyz"
												class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-400 focus:outline-none"
											/>
											<button
												class="rounded-md border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
											>
												<Copy class="h-4 w-4" />
											</button>
										</div>
									</div>
									<div class="space-y-1.5">
										<div class="flex items-center justify-between text-xs font-medium text-zinc-400">
											OAuth Bearer Token
											<button
												class="flex items-center gap-1 text-[10px] text-indigo-400 uppercase transition-colors hover:text-indigo-300"
											>
												<RefreshCcw class="h-3 w-3" /> Rotate
											</button>
										</div>
										<div class="flex items-center gap-2">
											<input
												type="password"
												readonly
												value="scim_tok_847294827492abcdef"
												class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-400 focus:outline-none"
											/>
											<button
												class="rounded-md border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
											>
												<Copy class="h-4 w-4" />
											</button>
										</div>
									</div>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>

			<div
				class="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<div>
					{#if ssoStep > 1}
						<button
							onclick={() => (ssoStep -= 1)}
							class="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
						>
							Back
						</button>
					{/if}
				</div>
				<div class="flex gap-3">
					<button
						onclick={() => (isSsoModalOpen = false)}
						class="px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
					>
						Cancel
					</button>
					{#if ssoStep < 3}
						<button
							onclick={() => (ssoStep += 1)}
							class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
						>
							Next Step
						</button>
					{:else}
						<button
							onclick={() => (isSsoModalOpen = false)}
							class="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 transition-colors hover:bg-emerald-500"
						>
							<CheckCircle2 class="h-4 w-4" /> Finalize Setup
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}
